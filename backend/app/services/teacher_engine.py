from __future__ import annotations

import json
import re
import sys
import time
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path

from app.core.config import model_settings
from app.schemas.models import Project, Question, QuestionOption, WorkshopMessage

ENGINE_ROOT = Path(__file__).resolve().parents[2] / "teacher_source"
MIN_REVIEW_SCORE = 80
INTAKE_AGENT_ATTEMPTS = 3


class TeacherEngineError(RuntimeError):
    def __init__(self, message: str, *, code: str = "teacher_engine_error", status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _retryable_provider_error(exc: BaseException) -> bool:
    """只重试临时网络或服务端失败，保留参数和 schema 错误的原始失败。"""
    text = str(exc)
    return (
        "接口返回 429" in text
        or re.search(r"接口返回 5\d\d", text) is not None
        or "连不上接口" in text
        or "timed out" in text.lower()
    )


class _RetryingMessages:
    """给老师原始 Runner 加一层临时错误重试，不改 teacher_source。"""

    def __init__(self, messages, attempts: int = 3):
        self._messages = messages
        self._attempts = attempts

    def create(self, **kwargs):
        last_error = None
        for attempt in range(self._attempts):
            try:
                return self._messages.create(**kwargs)
            except Exception as exc:  # noqa: BLE001 - 原始客户端使用 ValueError 表示 HTTP 错误
                last_error = exc
                if attempt + 1 >= self._attempts or not _retryable_provider_error(exc):
                    raise
                time.sleep(1.0 * (attempt + 1))
        raise last_error


class _RetryingClient:
    def __init__(self, client):
        self._client = client
        self.messages = _RetryingMessages(client.messages)


def _load_engine() -> None:
    root = str(ENGINE_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


@contextmanager
def _runner(*, chat: bool = False):
    _load_engine()
    from anthropic import Anthropic
    from blueprint.llm import AnthropicRunner, Budget
    from blueprint.openai_compat import OpenAICompatClient

    settings = model_settings()
    if not settings.api_key:
        raise TeacherEngineError("请先在模型设置里配置 API Key", code="model_not_configured", status_code=503)
    budget = Budget(max_calls=6 if chat else 40, max_tokens=100_000 if chat else 1_500_000)
    native = settings.base_url == "https://api.anthropic.com/v1" or settings.base_url.endswith("/anthropic")
    if native:
        base = settings.base_url.removesuffix("/v1") if settings.base_url == "https://api.anthropic.com/v1" else settings.base_url
        with Anthropic(api_key=settings.api_key, base_url=base, timeout=max(120, settings.timeout_seconds), max_retries=0) as client:
            yield AnthropicRunner(model=settings.model, budget=budget, client=client)
    else:
        client = OpenAICompatClient(settings.api_key, settings.base_url, timeout=max(120, settings.timeout_seconds))
        try:
            runner = AnthropicRunner(model=settings.model, budget=budget, client=_RetryingClient(client))
            runner.name = "openai"
            yield runner
        finally:
            client._http.close()


def _chat_model(runner):
    from blueprint.chat import AnthropicChat

    class WorkshopChat(AnthropicChat):
        def stream(self, prompt):
            if hasattr(self.runner.client.messages, "stream"):
                yield from super().stream(prompt)
            else:
                self.runner.budget.check()
                reply = self.runner.client.messages.create(
                    model=self.runner.model, max_tokens=self.runner.max_tokens, system=self.system,
                    messages=[{"role": "user", "content": prompt}],
                )
                self.runner.budget.record_usage("chat", reply.usage)
                yield from (block.text for block in reply.content if block.type == "text")

    return WorkshopChat(runner)


def _question(question_id: str, prompt: str, options: list[str]) -> Question:
    return Question(
        id=question_id,
        text=prompt,
        hint="可直接选择，也可以用自己的话回答",
        options=[QuestionOption(id=letter, label=value, recommended=index == 0)
                 for index, (letter, value) in enumerate(zip("ABC", options))],
    )


def _run_intake_agent(transcript_text: str, rounds_asked: int, user_wants_draft: bool) -> dict:
    """保留老师 Agent 的交卷规则，对一次模型格式波动重新开一轮 Runner。"""
    _load_engine()
    from blueprint.agent import AgentFailed
    from blueprint.intake_agent import run_intake_agent as teacher_run_intake_agent

    last_error: Exception | None = None
    for attempt in range(INTAKE_AGENT_ATTEMPTS):
        try:
            with _runner(chat=True) as runner:
                return teacher_run_intake_agent(
                    transcript_text,
                    rounds_asked=rounds_asked,
                    user_wants_draft=user_wants_draft,
                    runner=runner,
                    agent_max_turns=6,
                    log=lambda _: None,
                )
        except AgentFailed as exc:
            last_error = exc
            if attempt + 1 >= INTAKE_AGENT_ATTEMPTS:
                raise
    raise last_error or RuntimeError("需求澄清 Agent 未返回结果")


def _options(model, prd: str, question: str) -> list[str]:
    from blueprint.chat import HELP, Message, answer_events

    events = answer_events([question], [Message("user", HELP)], prd, model)
    reply = "".join(event["delta"] for event in events if event["type"] == "text")
    return [
        re.split(r"\s*(?:——|--|—)\s*", match, maxsplit=1)[0].strip()
        for match in re.findall(r"(?m)^\s*\*{0,2}[A-C][.．、:：]\s*(.+?)\s*$", reply)
    ][:3]



def intake(project: Project) -> Question | None:
    _load_engine()
    from blueprint.chat import FINISH_INTAKE, parse_messages, transcript

    try:
        messages = parse_messages([message.model_dump() for message in project.workshop.transcript])
        user_messages = [message.text.strip() for message in messages if message.role == "user"]
        result = _run_intake_agent(
            transcript(messages, skip=(FINISH_INTAKE,)),
            rounds_asked=sum(1 for message in messages if message.role == "assistant"),
            user_wants_draft=bool(user_messages and user_messages[-1] == FINISH_INTAKE),
        )
        if result["action"] == "draft":
            project.workshop.name = result["name"].strip()[:40]
            project.workshop.draft = result["idea"].strip()
            return None
        prompt = str(result.get("question") or "").strip()
        options = [str(value).strip() for value in result.get("suggestions") or [] if str(value).strip()][:3]
    except TeacherEngineError:
        raise
    except Exception as exc:
        detail = str(exc).strip().replace("\n", " ")[:1000]
        message = "真实 Agent 追问失败，已停止，不再退回固定三轮"
        if detail:
            message += f"。原始错误：{detail}"
        raise TeacherEngineError(message) from exc
    if not prompt:
        raise TeacherEngineError("模型没有返回需求问题，请重试")
    project.workshop.transcript.append(WorkshopMessage(role="assistant", text=prompt))
    return _question(f"workshop_{project.discovery_round}", prompt, options)


def fill_options(project: Project, question: Question) -> Question:
    with _runner(chat=True) as runner:
        options = _options(_chat_model(runner), project.workshop.draft, question.text)
    if not options:
        raise TeacherEngineError("模型没有返回可读的回答选项，请重试或直接填写")
    return question.model_copy(update={"options": _question(question.id, question.text, options).options})


def intake_chat(project: Project, messages: list[WorkshopMessage]) -> list[dict]:
    """直接复用老师 intake agent，返回老师网页使用的 text/tool/suggestions 事件。"""
    _load_engine()
    from blueprint.chat import DRAFT_INTRO, FINISH_INTAKE, parse_messages, transcript

    parsed = parse_messages([message.model_dump() for message in messages])
    user_messages = [message.text.strip() for message in parsed if message.role == "user"]
    try:
        result = _run_intake_agent(
            transcript(parsed, skip=(FINISH_INTAKE,)),
            rounds_asked=sum(1 for message in parsed if message.role == "assistant"),
            user_wants_draft=bool(user_messages and user_messages[-1] == FINISH_INTAKE),
        )
    except TeacherEngineError:
        raise
    except Exception as exc:
        detail = str(exc).strip().replace("\n", " ")[:1000]
        message = "真实 Agent 追问失败，已停止，不再退回固定三轮"
        if detail:
            message += f"。原始错误：{detail}"
        raise TeacherEngineError(message) from exc

    if result["action"] == "draft":
        return [
            {"type": "text", "delta": DRAFT_INTRO},
            {"type": "tool", "name": "confirm_product", "args": {
                "name": result["name"].strip()[:40],
                "idea": result["idea"].strip(),
            }},
        ]
    question = str(result.get("question") or "").strip()
    if not question:
        raise TeacherEngineError("模型没有返回需求问题，请重试")
    events = [{"type": "text", "delta": question}]
    suggestions = [str(value).strip()[:80] for value in result.get("suggestions") or [] if str(value).strip()][:3]
    events.append({"type": "suggestions", "items": suggestions + ["不确定，先跳过", FINISH_INTAKE]})
    return events


def answer_chat(project: Project, messages: list[WorkshopMessage]) -> list[dict]:
    """直接调用老师 blueprint.chat.answer_events，不把问题转换成题卡。"""
    _load_engine()
    from blueprint.chat import answer_events, parse_messages

    if not project.workshop:
        raise TeacherEngineError("这份方案没有待确认问题", code="no_open_questions", status_code=409)
    questions = list(project.workshop.answer_questions)
    if not questions and project.plan:
        questions = [str(item).strip() for item in project.plan.open_questions if str(item).strip()]
        project.workshop.answer_questions = questions
    if not questions:
        raise TeacherEngineError("这份方案没有待确认问题", code="no_open_questions", status_code=409)
    workspace = Path(project.plan.teacher_workspace_path) if project.plan and project.plan.teacher_workspace_path else None
    prd = ""
    if workspace:
        path = workspace / "PRD.md"
        if path.is_file():
            prd = path.read_text(encoding="utf-8")
    try:
        with _runner(chat=True) as runner:
            model = _chat_model(runner)
            return list(answer_events(
                questions,
                parse_messages([message.model_dump() for message in messages]),
                prd,
                model,
            ))
    except TeacherEngineError:
        raise
    except Exception as exc:
        detail = str(exc).strip().replace("\n", " ")[:1000]
        message = "老师方案问答失败，已停止，请重试"
        if detail:
            message += f"。原始错误：{detail}"
        raise TeacherEngineError(message) from exc


def development_chat(project: Project, messages: list[WorkshopMessage]) -> list[dict]:
    """阶段开发前的自然语言产品经理对话；不执行代码，只确认本阶段决策。"""
    if not project.backend or not project.backend.kit_task:
        raise TeacherEngineError("当前阶段还没有老师任务", code="stage_task_missing", status_code=409)
    _load_engine()
    transcript = "\n".join(f"{'产品经理' if item.role == 'user' else '阶段 Agent'}：{item.text}" for item in messages[-20:])
    schema = {
        "type": "object",
        "required": ["action", "message"],
        "properties": {
            "action": {"type": "string", "enum": ["ask", "ready"]},
            "message": {"type": "string"},
            "suggestions": {"type": "array", "items": {"type": "string"}},
        },
    }
    post_build = project.backend.status in {"kit_self_check_failed", "kit_self_check_passed"}
    post_rule = "本阶段代码和自检结果已经产生。请用产品语言解释结果并逐项向产品经理确认；只有产品经理明确说‘验收通过’时才返回 action=ready。" if post_build else "先用自然语言向产品经理提问，产品经理回答并明确确认后，才能开始本阶段开发；每次最多问 5 个必须决定的问题，并给出推荐方向。"
    result_context = f"\n本阶段自检结果：\n{project.backend.kit_last_output[-6000:]}" if post_build and project.backend.kit_last_output else ""
    prompt = f"""
你是 idea-to-launch-kit 的阶段产品经理 Agent。现在只处理 {project.backend.kit_stage or '当前阶段'}，不要写代码、不要运行命令、不要声称执行了未提供的工具。

根目录手册要求：{post_rule}

本阶段任务：
{project.backend.kit_task}

已有对话：
{transcript or '（还没有对话）'}
{result_context}

如果仍缺产品经理决定，返回 action=ask，message 用产品语言提问，suggestions 给 2 到 3 个可直接选择的方向。
只有产品经理已经明确说“确认、按推荐开始、可以开始开发”等（开发前），或明确说“验收通过”（开发后），才返回 action=ready。
""".strip()
    try:
        with _runner(chat=True) as runner:
            result = _chat_model(runner).complete_json("development_stage_chat", prompt, schema)
    except Exception as exc:
        detail = str(exc).strip().replace("\n", " ")[:1000]
        message = "阶段自然语言对话失败，已停止，不会直接开始开发"
        if detail:
            message += f"。原始错误：{detail}"
        raise TeacherEngineError(message) from exc
    action = str(result.get("action") or "ask").strip()
    text = str(result.get("message") or "").strip()
    if not text:
        raise TeacherEngineError("阶段 Agent 没有返回可读消息，请重试")
    suggestions = [str(item).strip()[:120] for item in result.get("suggestions") or [] if str(item).strip()][:3]
    events = [{"type": "text", "delta": text}, {"type": "suggestions", "items": suggestions}]
    if action == "ready":
        events.append({"type": "tool", "name": "confirm_stage", "args": {"message": text}})
    return events


def answer_intro(project: Project) -> str:
    _load_engine()
    from blueprint.chat import answer_intro as source_answer_intro

    questions = project.workshop.answer_questions if project.workshop else []
    return source_answer_intro(questions) if questions else ""


def generate_plan(project: Project, workspace_root: Path) -> dict:
    _load_engine()
    from blueprint.forward import run_plan
    from blueprint.handoff import build_handoff, handoff_filename
    from blueprint.pipeline import atomic_write
    from blueprint.plain import plain_questions
    from blueprint.usage import record_usage
    from blueprint.web.server import fill_prd_sections, rewrite_plain
    from blueprint.workspace import init_workspace, log_plan, read_prd, record_answers

    workshop = project.workshop
    plan_decisions = workshop.decisions
    inputs = json.dumps([workshop.draft, project.idea, project.change_request, project.answers,
                         plan_decisions, [m.model_dump() for m in workshop.transcript]], ensure_ascii=False, sort_keys=True)
    key = sha256(inputs.encode()).hexdigest()[:16]
    output = workspace_root / project.id / key
    name = workshop.name or project.idea[:40]
    workspace = None
    try:
        with _runner() as runner:
            from blueprint.workspace import slugify

            workspace = output / slugify(name)
            if not (workspace / "PRD.md").is_file():
                transcript = "\n\n".join(f"{'提问' if m.role == 'assistant' else '用户'}：{m.text}" for m in workshop.transcript)
                original = f"{project.idea}\n\n{workshop.draft}\n\n### 澄清原文\n\n{transcript}"
                if project.change_request:
                    original += f"\n\n### 版本新增需求\n\n{project.change_request}"
                workspace = init_workspace(output, name, original)
            if plan_decisions:
                record_answers(workspace, list(plan_decisions.items()))
            try:
                plan, document = run_plan(read_prd(workspace), runner, workspace, resume=True, log=lambda _: None)
                log_plan(workspace, plan, document)
                rewrite_plain(workspace, runner, lambda _: None)
                fill_prd_sections(workspace, runner, lambda _: None)
            finally:
                record_usage(workspace, "plan", runner.budget)
        data = plan.to_dict()
        users, developer = plain_questions(data, workspace)
        data["developer_notes"] = developer
        # 老师页面的待确认列表直接来自 plain_questions(plan)。
        # 不额外拼接 FACT_KEYS，避免把需求事实维度改造成另一套题卡。
        filename = handoff_filename(workspace)
        handoff = workspace / "handoff.zip"
        handoff.write_bytes(build_handoff(workspace))
        return {"data": data, "users": users, "workspace": str(workspace), "document": str(document),
                "handoff": str(handoff), "filename": filename}
    except TeacherEngineError:
        raise
    except Exception as exc:
        detail = str(exc).strip().replace("\\n", " ")[:240]
        message = "方案推导或独立审稿暂时失败，请重试。"
        if detail:
            message += f" 原始错误：{detail}"
        raise TeacherEngineError(message) from exc
