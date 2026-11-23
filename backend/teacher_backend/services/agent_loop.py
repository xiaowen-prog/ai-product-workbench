from __future__ import annotations

import json
import uuid
from dataclasses import replace
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from teacher_backend.core.errors import ApiError
from teacher_backend.models import AgentRun, AgentStep, Task
from teacher_backend.services.model_provider import ModelProviderError, ModelSettings, get_model_client
from teacher_backend.services.tasks import _event


LOOP_STEPS = [
    "理解任务并创建 Todo",
    "选择最小工具集合",
    "执行工作区操作",
    "验证中间结果",
    "整理产物并交付",
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _active_run(session: Session, task: Task) -> AgentRun | None:
    return session.scalar(
        select(AgentRun)
        .where(AgentRun.task_id == task.id, AgentRun.status.in_(["running", "recovering", "paused"]))
        .order_by(AgentRun.created_at.desc())
    )


def create_agent_run(
    session: Session,
    task: Task,
    failure_mode: str = "none",
    max_steps: int = 5,
    max_retries: int = 2,
    pause_after_step: int | None = None,
    execution_mode: str = "mock",
    provider: str | None = None,
    model: str | None = None,
) -> AgentRun:
    if failure_mode not in {"none", "fail_once", "timeout"}:
        raise ApiError("invalid_failure_mode", "不支持的 mock Agent 失败模式", 422)
    if execution_mode not in {"mock", "real"}:
        raise ApiError("invalid_execution_mode", "execution_mode 只能是 mock 或 real", 422)
    effective_provider = provider
    effective_model = model
    if execution_mode == "real":
        settings = ModelSettings.from_env()
        if provider:
            settings = replace(settings, provider=provider)
        if model:
            settings = replace(settings, model=model)
        if not settings.configured:
            missing = ", ".join(settings.missing_fields())
            raise ApiError("model_not_configured", f"真实模型尚未配置（缺少：{missing}）。设置 AGENT_MODEL_API_KEY 或 OPENAI_API_KEY 后再重试。", 503)
        # Persist the resolved provider/model so a run remains auditable even
        # when the request relied on environment defaults.
        provider = settings.provider
        model = settings.model
        effective_provider = settings.provider
        effective_model = settings.model
    if _active_run(session, task):
        raise ApiError("agent_run_active", "这个任务已有可恢复的 Agent 运行", 409)
    run = AgentRun(
        id=str(uuid.uuid4()),
        task_id=task.id,
        status="running",
        current_step=1,
        max_steps=max_steps,
        max_retries=max_retries,
        failure_mode=failure_mode,
        execution_mode=execution_mode,
        provider=effective_provider,
        model=effective_model,
        pause_after_step=pause_after_step,
    )
    session.add(run)
    session.flush()
    for position in range(1, max_steps + 1):
        title = LOOP_STEPS[position - 1] if position <= len(LOOP_STEPS) else f"执行扩展步骤 {position}"
        session.add(
            AgentStep(
                id=str(uuid.uuid4()),
                run_id=run.id,
                position=position,
                title=title,
                status="queued",
                max_attempts=max_retries + 1,
            )
        )
    task.status = "running"
    _event(session, task, "agent_run_started", "Agent 循环已启动", {"run_id": run.id, "max_steps": max_steps, "execution_mode": execution_mode, "provider": effective_provider, "model": effective_model})
    session.commit()
    session.refresh(run)
    return run


def get_agent_run(session: Session, task: Task, run_id: str) -> AgentRun:
    run = session.scalar(select(AgentRun).where(AgentRun.id == run_id, AgentRun.task_id == task.id))
    if run is None:
        raise ApiError("agent_run_not_found", "找不到这个 Agent 运行", 404)
    return run


def pause_agent_run(session: Session, task: Task, run: AgentRun) -> AgentRun:
    """Persist a user-requested pause for a run that is not terminal."""

    if run.status in {"completed", "failed"}:
        raise ApiError("agent_run_not_paused", "已结束的 Agent 运行不能暂停", 409)
    if run.status != "paused":
        run.status = "paused"
        task.status = "paused"
        _event(session, task, "agent_run_paused", "Agent 循环已暂停并保存恢复点", {"run_id": run.id, "current_step": run.current_step})
        session.commit()
        session.refresh(run)
    return run


def _fail_step(session: Session, task: Task, run: AgentRun, step: AgentStep, error_code: str) -> bool:
    step.error_code = error_code
    run.last_error = error_code
    _event(session, task, "agent_step_error", f"步骤失败：{step.title}", {"run_id": run.id, "step": step.position, "attempt": step.attempts, "error": error_code})
    if step.attempts < step.max_attempts:
        step.status = "recovering"
        run.status = "recovering"
        _event(session, task, "agent_step_retry", f"步骤将重试：{step.title}", {"run_id": run.id, "step": step.position, "next_attempt": step.attempts + 1})
        session.commit()
        return True
    step.status = "failed"
    run.status = "failed"
    task.status = "failed"
    _event(session, task, "agent_run_failed", "Agent 循环超过重试次数后失败", {"run_id": run.id, "step": step.position, "error": error_code})
    session.commit()
    return False


def _continue_mock_agent_run(session: Session, task: Task, run: AgentRun) -> AgentRun:
    if run.status == "completed":
        return run
    if run.status == "failed":
        raise ApiError("agent_run_failed", "这个 Agent 运行已经失败，请新建任务重试", 409)
    run.status = "recovering" if run.status in {"paused", "recovering"} else "running"
    session.commit()
    for step in run.steps:
        if step.position < run.current_step or step.status == "completed":
            continue
        run.current_step = step.position
        while step.attempts < step.max_attempts:
            step.status = "running"
            step.started_at = step.started_at or _now()
            step.attempts += 1
            _event(session, task, "agent_step_started", f"开始步骤：{step.title}", {"run_id": run.id, "step": step.position, "attempt": step.attempts})
            should_fail = (run.failure_mode == "timeout") or (run.failure_mode == "fail_once" and step.position == 2 and step.attempts == 1)
            if should_fail:
                error_code = "mock_timeout" if run.failure_mode == "timeout" else "mock_transient_error"
                if _fail_step(session, task, run, step, error_code):
                    continue
                return run
            step.status = "completed"
            step.error_code = None
            step.result_json = json.dumps({"ok": True, "runner": "mock", "step": step.position}, ensure_ascii=False)
            step.completed_at = _now()
            run.last_error = None
            _event(session, task, "agent_step_completed", f"完成步骤：{step.title}", {"run_id": run.id, "step": step.position, "attempt": step.attempts})
            run.current_step = step.position + 1
            session.commit()
            break
        if step.status != "completed":
            return run
        if run.pause_after_step == step.position and step.position < run.max_steps:
            run.status = "paused"
            task.status = "paused"
            _event(session, task, "agent_run_paused", "Agent 循环已保存，可继续恢复", {"run_id": run.id, "current_step": run.current_step})
            session.commit()
            return run
    run.status = "completed"
    task.status = "completed"
    run.completed_at = _now()
    run.last_error = None
    _event(session, task, "agent_run_completed", "Agent 循环完成并保存恢复点", {"run_id": run.id, "steps": run.max_steps})
    session.commit()
    session.refresh(run)
    return run



def _real_messages(task: Task, run: AgentRun, step: AgentStep) -> list[dict[str, str]]:
    previous: list[str] = []
    for item in run.steps:
        if item.position >= step.position or item.status != "completed":
            continue
        try:
            result = json.loads(item.result_json or "{}")
        except json.JSONDecodeError:
            result = {}
        content = result.get("content") if isinstance(result, dict) else None
        if isinstance(content, str) and content:
            previous.append(f"步骤 {item.position}：{content[-2500:]}")
    context = "\n\n".join(previous[-3:]) or "（这是第一个步骤，暂无前序结果。）"
    return [
        {
            "role": "system",
            "content": "你是 Signal Agent 工作台里的执行 Agent。请只处理当前步骤，给出可复核、简洁的结果；不要声称执行了未提供的工具或写入。",
        },
        {
            "role": "user",
            "content": f"任务目标：{task.brief}\n当前步骤：{step.title}\n前序结果：{context}\n请完成当前步骤，并用中文输出结论、依据和下一步。",
        },
    ]


def _continue_real_agent_run(session: Session, task: Task, run: AgentRun) -> AgentRun:
    run.status = "recovering" if run.status in {"paused", "recovering"} else "running"
    session.commit()
    settings = ModelSettings.from_env()
    if run.provider:
        settings = replace(settings, provider=run.provider)
    if run.model:
        settings = replace(settings, model=run.model)
    client = get_model_client()
    # Keep per-run overrides while sharing the same adapter implementation.
    client.settings = settings
    for step in run.steps:
        if step.position < run.current_step or step.status == "completed":
            continue
        run.current_step = step.position
        while step.attempts < step.max_attempts:
            step.status = "running"
            step.started_at = step.started_at or _now()
            step.attempts += 1
            _event(session, task, "agent_step_started", f"开始真实模型步骤：{step.title}", {"run_id": run.id, "step": step.position, "attempt": step.attempts, "execution_mode": "real", "provider": settings.provider, "model": settings.model})
            session.commit()
            try:
                completion = client.complete(_real_messages(task, run, step))
            except ModelProviderError as exc:
                if _fail_step(session, task, run, step, exc.code):
                    continue
                return run
            step.status = "completed"
            step.error_code = None
            step.result_json = json.dumps(
                {
                    "ok": True,
                    "runner": "real",
                    "execution_mode": "real",
                    "provider": completion.provider,
                    "model": completion.model,
                    "content": completion.content[:20_000],
                    "usage": completion.usage,
                    "request_id": completion.request_id,
                },
                ensure_ascii=False,
            )
            step.completed_at = _now()
            run.last_error = None
            _event(session, task, "agent_step_completed", f"真实模型完成步骤：{step.title}", {"run_id": run.id, "step": step.position, "attempt": step.attempts, "execution_mode": "real", "provider": completion.provider, "model": completion.model, "usage": completion.usage})
            run.current_step = step.position + 1
            session.commit()
            break
        if step.status != "completed":
            return run
        if run.pause_after_step == step.position and step.position < run.max_steps:
            run.status = "paused"
            task.status = "paused"
            _event(session, task, "agent_run_paused", "Agent 循环已保存，可继续恢复", {"run_id": run.id, "current_step": run.current_step, "execution_mode": "real"})
            session.commit()
            return run
    run.status = "completed"
    task.status = "completed"
    run.completed_at = _now()
    run.last_error = None
    _event(session, task, "agent_run_completed", "真实模型 Agent 循环完成并保存恢复点", {"run_id": run.id, "steps": run.max_steps, "execution_mode": "real", "provider": settings.provider, "model": settings.model})
    session.commit()
    session.refresh(run)
    return run


def continue_agent_run(session: Session, task: Task, run: AgentRun) -> AgentRun:
    if run.status == "completed":
        return run
    if run.status == "failed":
        raise ApiError("agent_run_failed", "这个 Agent 运行已经失败，请新建任务重试", 409)
    if getattr(run, "execution_mode", "mock") == "real":
        return _continue_real_agent_run(session, task, run)
    return _continue_mock_agent_run(session, task, run)
