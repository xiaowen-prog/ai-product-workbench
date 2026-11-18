from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.schemas.models import (
    AnswerRequest,
    BackendBuild,
    Confirmation,
    Discovery,
    Evidence,
    Intent,
    ProductPlan,
    Project,
    ProjectEvent,
    ProjectStatus,
    Question,
    Trial,
    Task,
)
from app.services.model_client import ModelClient, ModelClientError
from app.services.store import Store


def now() -> datetime:
    return datetime.now(timezone.utc)


def transition(project: Project, next_status: ProjectStatus, *, actor: str = "system", evidence: list[str] | None = None, pending: list[str] | None = None) -> None:
    current = project.status.value if isinstance(project.status, ProjectStatus) else str(project.status)
    project.events.append(
        ProjectEvent(
            id=f"evt_{uuid4().hex[:10]}",
            from_status=current,
            to_status=next_status.value,
            actor=actor,
            input_version=project.version,
            output_version=project.version,
            evidence=evidence or [],
            pending=pending or [],
            at=now(),
        )
    )
    project.status = next_status


def _question_catalog(idea: str) -> dict[str, Question]:
    focus = "这个想法"
    if any(word in idea for word in ("学习", "课程", "练习")):
        focus = "学习场景"
    elif any(word in idea for word in ("家长", "家庭", "孩子")):
        focus = "家庭场景"
    elif any(word in idea for word in ("团队", "公司", "客户")):
        focus = "工作场景"
    return {
        "target_user": Question(id="target_user", text=f"{focus}最先服务哪一类人？", hint="例如：第一次做产品的个人创作者"),
        "problem": Question(id="problem", text="这类人现在遇到的具体问题是什么？", hint="描述一个真实场景，不用写解决方案"),
        "desired_outcome": Question(id="desired_outcome", text="用户完成一次使用后，最希望得到什么结果？", hint="用结果描述，例如：得到一份可直接使用的报价"),
        "current_workaround": Question(id="current_workaround", text="用户现在用什么办法解决？为什么还不够好？", hint="没有现成办法可以填：目前没有"),
        "constraints": Question(id="constraints", text="有没有必须遵守的范围、数据或发布限制？", hint="没有可以填：暂时没有"),
        "affected_area": Question(id="affected_area", text="这次新增会改变原产品的哪一段？", hint="例如：只影响预览，不改变需求确认", reason="只重算受影响链路"),
        "intent_correction": Question(id="intent_correction", text="刚才的需求摘要哪里不准确？请直接说要改成什么。", hint="例如：目标用户不是个人，而是小团队"),
        "plan_correction": Question(id="plan_correction", text="方案哪里需要调整？请说最重要的一处变化。", hint="例如：先做网页，不做登录"),
    }


def _questions(idea: str, answers: dict[str, str] | None = None, change_request: str = "") -> list[Question]:
    answers = answers or {}
    catalog = _question_catalog(idea)
    # 每轮只呈现当前缺口：首轮最多三个，后续轮次按剩余缺口缩短；总轮数不固定。
    required = ("target_user", "problem", "desired_outcome", "current_workaround")
    missing = [key for key in required if not answers.get(key)]
    if change_request and not answers.get("affected_area"):
        missing.insert(0, "affected_area")
    if not missing and any(word in idea for word in ("支付", "医疗", "健康", "儿童", "隐私", "数据")) and not answers.get("constraints"):
        missing = ["constraints"]
    limit = min(3, len(missing))
    return [catalog[key] for key in missing[:limit]]


def _known_question_ids(idea: str) -> set[str]:
    return set(_question_catalog(idea))


def _discovery(project: Project) -> Discovery:
    answers = project.answers
    evidence = [
        Evidence(kind="原始想法", text=project.idea),
        *[Evidence(kind="用户回答", text=f"{key}: {value}") for key, value in answers.items()],
    ]
    red_flags: list[str] = []
    if any(word in project.idea for word in ("医疗", "健康", "支付", "儿童")):
        red_flags.append("涉及高风险或敏感场景，需要在发布前补充人工审核与合规边界")
    return Discovery(
        problem=answers.get("problem", "待确认"),
        desired_outcome=answers.get("desired_outcome", "待确认"),
        current_workaround=answers.get("current_workaround", "待确认"),
        evidence=evidence,
        hypotheses=[f"{answers.get('target_user', '目标用户')}愿意尝试更直接的解决方式"],
        red_flags=red_flags,
        recommendation="继续" if not red_flags else "继续并先确认风险边界",
    )


def _make_intent(project: Project) -> Intent:
    answers = project.answers
    target_user = answers.get("target_user", "第一次做产品的个人创作者")
    outcome = answers.get("desired_outcome", "把想法变成可预览的最小产品")
    problem = answers.get("problem", "用户还没有清晰、可执行的解决路径")
    goal = f"为{target_user}解决{problem}，帮助用户{outcome}。"
    return Intent(
        goal=goal,
        target_user=target_user,
        core_loop=f"输入需求 → 澄清问题 → {outcome} → 查看结果并确认",
        scope=["需求发现与证据摘要", "需求确认", "最小方案", "后端 API 与数据契约", "本地预览与验收"],
        acceptance=["需求摘要保留用户原话并标记待确认项", "用户确认后才进入方案和开发", "后端任务有 API、数据模型和测试记录", "通过验收后才能打开预览"],
        constraints=[answers.get("constraints", "首版本地单用户，默认不自动发布或外发")],
        risks=["需求证据不足时可能生成方向偏差", "真实用户验证仍需要人工进行"],
    )


def _make_plan(project: Project) -> Project:
    intent = project.intent or _make_intent(project)
    project.intent = intent
    project.plan = ProductPlan(
        title=project.idea[:32],
        summary=intent.goal,
        user_journey=["说出想法", "补齐需求证据", "确认需求", "确认方案", "生成后端骨架", "测试并验收", "打开预览"],
        mvp_features=["自适应需求补问", "需求证据与红灯提示", "内部需求摘要", "方案确认闸门", "API 与数据契约", "测试和预览"],
        generated_stack=["FastAPI API", "Pydantic 数据契约", "版本化 JSON 持久化", "可恢复任务状态", "pytest 验收检查"],
        preview_label="后端验收通过后可预览",
        open_questions=["真实模型接入后，是否需要导入访谈记录或外部链接？"],
    )
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="generate_plan", status="succeeded", progress=100, message="方案草稿已生成，等待确认", created_at=now(), updated_at=now()))
    transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, pending=project.plan.open_questions)
    project.updated_at = now()
    return project


def _make_backend(project: Project) -> Project:
    project.backend = BackendBuild(
        status="verified",
        api_contract=["POST /projects", "POST /projects/{id}/answers", "POST /projects/{id}/confirm-intent", "POST /projects/{id}/confirm-plan", "POST /projects/{id}/acceptance", "GET /projects/{id}/preview"],
        data_model=["Project", "Evidence", "Intent", "ProductPlan", "BackendBuild", "Task", "Confirmation"],
        test_plan=["需求缺口会继续追问", "未确认需求不能生成开发任务", "方案确认后生成后端任务", "验收前不能打开预览", "重启后状态可恢复"],
        checks=["结构化状态可持久化", "错误返回统一 code/message", "不把模型密钥写入前端或日志"],
        acceptance=["接口契约已生成", "数据模型已生成", "测试计划已生成", "预览闸门已开启"],
    )
    running = next((task for task in reversed(project.tasks) if task.kind == "backend_build" and task.status == "running"), None)
    if running is not None:
        running.status = "succeeded"
        running.progress = 100
        running.message = "后端开发任务和验收检查已完成"
        running.updated_at = now()
    else:
        project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="backend_build", status="succeeded", progress=100, message="后端开发任务和验收检查已完成", created_at=now(), updated_at=now()))
    transition(project, ProjectStatus.BACKEND_VERIFIED, pending=project.backend.acceptance)
    project.updated_at = now()
    return project


def create_project(store: Store, idea: str) -> Project:
    timestamp = now()
    project_id = f"p_{uuid4().hex[:10]}"
    project = Project(
        id=project_id,
        idea=idea,
        version=1,
        root_id=project_id,
        status=ProjectStatus.NEEDS_DISCOVERY,
        questions=_questions(idea),
        created_at=timestamp,
        updated_at=timestamp,
    )
    project.events.append(ProjectEvent(
        id=f"evt_{uuid4().hex[:10]}",
        from_status="idea",
        to_status=ProjectStatus.NEEDS_DISCOVERY.value,
        actor="user",
        input_version=1,
        output_version=1,
        pending=[question.id for question in project.questions],
        at=timestamp,
    ))
    return store.upsert_project(project)


def add_supplement(store: Store, project_id: str, text: str) -> Project:
    """Record extra context while keeping the user at requirement confirmation."""
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_INTENT_CONFIRMATION:
        raise ValueError("只有在需求确认阶段才能补充信息")
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("补充内容不能为空")
    project.answers["additional_context"] = (
        f"{project.answers['additional_context']}\n{cleaned}"
        if project.answers.get("additional_context")
        else cleaned
    )
    project.evidence.append(Evidence(kind="补充信息", text=cleaned))
    if project.discovery is None:
        project.discovery = _discovery(project)
    project.discovery.evidence.append(Evidence(kind="补充信息", text=cleaned))
    transition(project, ProjectStatus.NEEDS_INTENT_CONFIRMATION, actor="user", evidence=[cleaned])
    project.updated_at = now()
    return store.upsert_project(project)


def modify_plan(store: Store, project_id: str, text: str) -> Project:
    """Apply a small plan correction without reopening discovery."""
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION or project.plan is None:
        raise ValueError("只有在方案确认阶段才能修改方案")
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("方案修改内容不能为空")
    project.plan.summary = f"{project.plan.summary}（用户补充调整：{cleaned}）"
    project.plan.open_questions = [question for question in project.plan.open_questions if question != cleaned]
    project.plan_revision = {"status": "applied", "note": cleaned, "applied_at": now()}
    transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, actor="user", evidence=[cleaned])
    project.updated_at = now()
    return store.upsert_project(project)


def create_iteration(store: Store, project_id: str, change_request: str) -> Project:
    """Create an independent next version after a recorded trial result."""
    parent = store.get_project(project_id)
    if parent is None:
        raise KeyError(project_id)
    if parent.status != ProjectStatus.TRIAL:
        raise ValueError("请先开始试用并记录一次结果，再开启下一版")
    if parent.trial is None or not parent.trial.feedback:
        raise ValueError("请先记录一次试用结果，再开启下一版")
    cleaned = change_request.strip()
    if not cleaned:
        raise ValueError("新增需求不能为空")
    timestamp = now()
    project_id = f"p_{uuid4().hex[:10]}"
    root_id = parent.root_id or parent.id
    project = Project(
        id=project_id,
        idea=parent.idea,
        version=parent.version + 1,
        parent_id=parent.id,
        root_id=root_id,
        change_request=cleaned,
        status=ProjectStatus.NEEDS_DISCOVERY,
        answers={"change_request": cleaned},
        questions=_questions(parent.idea, {"change_request": cleaned}, change_request=cleaned),
        created_at=timestamp,
        updated_at=timestamp,
    )
    project.events.append(ProjectEvent(
        id=f"evt_{uuid4().hex[:10]}",
        from_status=parent.status.value,
        to_status=ProjectStatus.NEEDS_DISCOVERY.value,
        actor="user",
        input_version=parent.version,
        output_version=project.version,
        evidence=[cleaned],
        pending=[question.id for question in project.questions],
        at=timestamp,
    ))
    return store.upsert_project(project)


def start_trial(store: Store, project_id: str) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.PREVIEW_READY:
        raise ValueError("只有验收完成的版本才能开始试用")
    if project.preview is None or project.preview.status != "verified":
        raise ValueError("请先验证可运行预览，再开始试用")
    timestamp = now()
    project.trial = Trial(started_at=timestamp, updated_at=timestamp)
    transition(project, ProjectStatus.TRIAL, actor="user", pending=["trial_feedback"])
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="trial", status="running", progress=10, message="试用已开始，等待用户记录一次真实反馈", created_at=timestamp, updated_at=timestamp))
    project.updated_at = timestamp
    return store.upsert_project(project)


def record_trial_feedback(store: Store, project_id: str, feedback: str, outcome: str) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.TRIAL or project.trial is None:
        raise ValueError("请先开始试用")
    cleaned = feedback.strip()
    if not cleaned:
        raise ValueError("试用反馈不能为空")
    timestamp = now()
    project.trial.feedback.append(cleaned)
    project.trial.outcome = outcome.strip() or "needs_change"
    project.trial.updated_at = timestamp
    transition(project, ProjectStatus.TRIAL, actor="user", evidence=[cleaned], pending=[])
    for task in reversed(project.tasks):
        if task.kind == "trial" and task.status == "running":
            task.status = "succeeded"
            task.progress = 100
            task.message = "已记录一次试用反馈"
            task.updated_at = timestamp
            break
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="trial_feedback", status="succeeded", progress=100, message="试用反馈已记录", created_at=timestamp, updated_at=timestamp, meta={"outcome": project.trial.outcome}))
    project.updated_at = timestamp
    return store.upsert_project(project)


def _validate_answers(project: Project, answers: AnswerRequest) -> None:
    unknown = set(answers.answers) - _known_question_ids(project.idea)
    if unknown:
        raise ValueError(f"未知问题：{', '.join(sorted(unknown))}")


def answer_project(store: Store, project_id: str, answers: AnswerRequest) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if "plan_correction" in answers.answers:
        if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION or project.plan is None:
            raise ValueError("当前不在方案确认阶段")
    elif project.status != ProjectStatus.NEEDS_DISCOVERY:
        raise ValueError("当前不在需求发现阶段")
    _validate_answers(project, answers)
    project.answers.update(answers.answers)
    if "intent_correction" in answers.answers:
        project.intent = _make_intent(project)
        project.discovery = _discovery(project)
        project.questions = []
        transition(project, ProjectStatus.NEEDS_INTENT_CONFIRMATION, evidence=[answers.answers["intent_correction"]])
        project.updated_at = now()
        return store.upsert_project(project)
    if "plan_correction" in answers.answers:
        if project.plan is not None:
            correction = answers.answers["plan_correction"]
            project.plan.summary = f"{project.plan.summary}（用户补充调整：{correction}）"
            project.plan_revision = {"status": "applied", "note": correction, "applied_at": now()}
        project.questions = []
        transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, evidence=[correction])
        project.updated_at = now()
        return store.upsert_project(project)
    project.discovery_round += 1
    project.questions = _questions(project.idea, project.answers, project.change_request)
    project.evidence = _discovery(project).evidence
    if project.questions:
        transition(project, ProjectStatus.NEEDS_DISCOVERY, pending=[question.id for question in project.questions])
        project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="discovery_round", status="succeeded", progress=100, message=f"第 {project.discovery_round} 轮需求澄清完成，还需要确认关键缺口", created_at=now(), updated_at=now()))
    else:
        project.discovery = _discovery(project)
        project.intent = _make_intent(project)
        transition(project, ProjectStatus.NEEDS_INTENT_CONFIRMATION, pending=[])
        project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="discovery_complete", status="succeeded", progress=100, message="需求发现完成，等待用户确认需求摘要", created_at=now(), updated_at=now()))
    project.updated_at = now()
    return store.upsert_project(project)


def confirm_intent(store: Store, project_id: str, confirmed: bool, note: str = "") -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_INTENT_CONFIRMATION:
        raise ValueError("当前还不能确认需求")
    if project.intent is None:
        project.intent = _make_intent(project)
    project.confirmations = Confirmation(**{**project.confirmations.model_dump(), "intent": confirmed, "note": note})
    if confirmed:
        _make_plan(project)
    else:
        project.questions = [_question_catalog(project.idea)["intent_correction"]]
        transition(project, ProjectStatus.NEEDS_DISCOVERY, pending=[question.id for question in project.questions])
        project.updated_at = now()
    return store.upsert_project(project)


def confirm_plan(store: Store, project_id: str, confirmed: bool, note: str = "") -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION:
        raise ValueError("当前还不能确认方案")
    if project.plan is None:
        raise ValueError("请先生成方案")
    project.confirmations = Confirmation(**{**project.confirmations.model_dump(), "plan": confirmed, "note": note})
    if confirmed:
        transition(project, ProjectStatus.BACKEND_BUILDING, pending=["backend_build"])
        project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="backend_build", status="running", progress=10, message="正在生成 API、数据模型和测试验收任务", created_at=now(), updated_at=now()))
        _make_backend(project)
    else:
        project.plan_revision = {"status": "needs_input", "prompt": "方案需要调整哪一处？", "requested_at": now()}
        project.questions = [_question_catalog(project.idea)["plan_correction"]]
        transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, pending=["plan_correction"])
        project.updated_at = now()
    return store.upsert_project(project)


def record_acceptance(store: Store, project_id: str, passed: bool, note: str = "") -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status not in {ProjectStatus.BACKEND_VERIFIED, ProjectStatus.PREVIEW_READY}:
        raise ValueError("后端开发尚未完成，不能验收")
    project.confirmations = Confirmation(**{**project.confirmations.model_dump(), "acceptance": passed, "note": note})
    transition(project, ProjectStatus.PREVIEW_READY if passed else ProjectStatus.BACKEND_VERIFIED, actor="user", pending=[] if passed else ["acceptance"])
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="acceptance", status="succeeded" if passed else "needs_revision", progress=100 if passed else 50, message="人工验收通过" if passed else "人工验收未通过，等待修改", created_at=now(), updated_at=now(), meta={"note": note}))
    project.updated_at = now()
    return store.upsert_project(project)


def _make_real_plan(project: Project, answers: AnswerRequest, client: ModelClient) -> Project:
    result, meta = client.generate_plan(project.idea, {**project.answers, **answers.answers})
    project.answers.update(answers.answers)
    project.intent = Intent(goal=result.goal, target_user=result.target_user, core_loop=result.core_loop, scope=result.scope, acceptance=result.acceptance, constraints=result.constraints, risks=result.risks)
    project.plan = ProductPlan(title=result.title, summary=result.summary, user_journey=result.user_journey, mvp_features=result.mvp_features, generated_stack=result.generated_stack, preview_label=result.preview_label, open_questions=result.open_questions)
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="generate_plan_real", status="succeeded", progress=100, message="真实模型方案已生成，等待用户确认", created_at=now(), updated_at=now(), meta={"provider": meta.provider, "model": meta.model, "attempts": meta.attempts, "duration_ms": meta.duration_ms, **({"request_id": meta.request_id} if meta.request_id else {}), **({"usage": meta.usage} if meta.usage else {})}))
    transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, pending=project.plan.open_questions)
    project.updated_at = now()
    return project


def _record_real_failure(project: Project, error: ModelClientError) -> Project:
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="generate_plan_real", status="failed", progress=0, message=error.message, created_at=now(), updated_at=now(), meta={"attempts": error.attempts, "error_code": error.code}))
    project.updated_at = now()
    return project


def generate_real_plan(store: Store, project_id: str, answers: AnswerRequest, client: ModelClient | None = None) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION:
        raise ValueError("请先完成需求澄清并生成方案")
    model_client = client or ModelClient()
    try:
        generated = _make_real_plan(project, answers, model_client)
    except ModelClientError as exc:
        store.upsert_project(_record_real_failure(project, exc))
        raise
    return store.upsert_project(generated)
