from __future__ import annotations

import json
from difflib import SequenceMatcher
from hashlib import sha256
from datetime import datetime, timezone
from pathlib import Path
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
    QuestionOption,
    Trial,
    Task,
    Workshop,
    WorkshopMessage,
)
from app.services import teacher_engine
from app.services.launch_handoff import deliver_handoff
from app.services.kit_development import advance_kit, development_snapshot, launch_kit_root, read_kit_state, run_development, verify_kit
from app.services.store import Store


V2_AFFECTED_AREA_OPTIONS = [
    QuestionOption(id="A", label="需求和流程", description="改变用户目标、步骤或判断方式", recommended=True),
    QuestionOption(id="B", label="方案和后端", description="改变功能、接口或数据结构"),
    QuestionOption(id="C", label="预览和体验", description="主要改变界面、展示或试用方式"),
]


def now() -> datetime:
    return datetime.now(timezone.utc)


def transition(
    project: Project,
    next_status: ProjectStatus,
    *,
    actor: str = "system",
    evidence: list[str] | None = None,
    pending: list[str] | None = None,
) -> None:
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


def _sync_development_status(project: Project) -> dict[str, object]:
    """Read the external kit stage without treating an AgentRun as coding work."""
    return development_snapshot(project.backend) if project.backend else {"status": "not_started", "task": None, "run": None}

def start_backend_development(store: Store, project_id: str, execution_mode: str = "real") -> tuple[Project, dict[str, object]]:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.BACKEND_BUILDING or project.backend is None:
        raise ValueError("只有已经完成方案确认的项目才能开始后端开发")
    project.backend, snapshot = run_development(project.backend, execution_mode=execution_mode)
    project.backend.status = str(snapshot.get("status") or project.backend.status)
    project = store.upsert_project(project)
    return project, snapshot


def verify_backend_development(store: Store, project_id: str) -> tuple[Project, dict[str, object]]:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.BACKEND_BUILDING or project.backend is None:
        raise ValueError("只有开发中的项目才能执行老师工具包自检")
    if project.backend.status not in {"awaiting_external_coding", "kit_self_check_failed", "kit_self_check_passed", "stage_advanced"}:
        raise ValueError("请先运行原始 kit.sh 任务并完成外部编码工具阶段")
    # 原始 kit.sh 的自检由外部编码工具完成后运行。工作台不创建内部
    # AgentRun，也不把模型文本结果当成代码开发完成信号。
    result = verify_kit(project.backend, launch_kit_root())
    project.backend.status = "kit_self_check_passed" if result["ok"] else "kit_self_check_failed"
    project = store.upsert_project(project)
    return project, result


def accept_backend_stage(store: Store, project_id: str, passed: bool, next_stage: str | None = None, note: str = "") -> tuple[Project, dict[str, object]]:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.BACKEND_BUILDING or project.backend is None:
        raise ValueError("当前项目还不在老师开发阶段")
    if not passed:
        project.backend.kit_status = "rejected"
        project.backend.status = "kit_self_check_failed"
        project = store.upsert_project(project)
        return project, {"ok": False, "message": note.strip() or "本阶段验收未通过，留在当前阶段"}
    result = advance_kit(project.backend, launch_kit_root(), next_stage=next_stage)
    if not result["ok"]:
        project = store.upsert_project(project)
        return project, result
    stage = str(result.get("stage") or "")
    if stage.startswith("阶段3") or stage == "完成":
        project.backend.status = "backend_verified"
        project.confirmations.acceptance = False
        transition(project, ProjectStatus.BACKEND_VERIFIED, actor="user", evidence=["老师工具包阶段 0-2 已按原顺序通过"], pending=["user_acceptance"])
    else:
        project.backend.status = "stage_advanced"
    project = store.upsert_project(project)
    return project, result


def development_status(store: Store, project_id: str) -> tuple[Project, dict[str, object]]:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    snapshot = _sync_development_status(project)
    if project.backend and project.backend.launch_project:
        try:
            kit_stage, kit_status = read_kit_state(launch_kit_root(), project.backend.launch_project)
        except (OSError, ValueError):
            kit_stage, kit_status = None, None
        if kit_stage:
            project.backend.kit_stage = kit_stage
        if kit_stage == "完成":
            project.backend.kit_status = "completed"
        elif kit_status:
            project.backend.kit_status = kit_status
    return project, snapshot


def _discovery(project: Project) -> Discovery:
    answers = project.answers
    evidence = [
        Evidence(kind="原始想法", text=project.idea),
        *[Evidence(kind="用户回答", text=f"{key}: {value}") for key, value in answers.items()],
    ]
    return Discovery(
        problem=answers.get("problem", "待确认"),
        desired_outcome=answers.get("desired_outcome", "待确认"),
        current_workaround=answers.get("current_workaround", "待确认"),
        evidence=evidence,
        hypotheses=[],
        red_flags=[],
        recommendation="继续澄清",
    )


def _make_intent(project: Project) -> Intent:
    workshop = project.workshop
    draft = workshop.draft if workshop else project.idea
    return Intent(
        goal=draft[:500],
        target_user="见需求草稿",
        core_loop="按需求草稿确认用户输入、Agent 行为、交付物和人工确认点",
        scope=["需求澄清", "PRD", "方案审稿", "后端开发交接"],
        acceptance=[
            "需求事实和待确认项可回读",
            "独立审稿达到 80 分后才允许确认方案",
            "确认后的 PRD 和方案进入开发项目",
        ],
        constraints=["敏感、外发和破坏性动作需要人工确认"],
        risks=list(workshop.decisions.values()) if workshop else [],
    )


def _teacher_fact_value(facts: dict[str, object], key: str, fallback: str = "待确认") -> str:
    value = facts.get(key, "") if isinstance(facts, dict) else ""
    if isinstance(value, dict):
        value = value.get("value") or value.get("text") or ""
    text = str(value or "").strip()
    return text or fallback


def _intent_from_teacher_plan(project: Project, data: dict[str, object]) -> Intent:
    facts = data.get("facts") if isinstance(data, dict) else {}
    facts = facts if isinstance(facts, dict) else {}
    design = data.get("design") if isinstance(data, dict) else {}
    design = design if isinstance(design, dict) else {}
    constraints = [_teacher_fact_value(facts, "constraints"), _teacher_fact_value(facts, "boundaries")]
    constraints = [item for item in constraints if item != "待确认"]
    risks = [str(item).strip() for item in design.get("security_and_degradation", []) if str(item).strip()]
    return Intent(
        goal=_teacher_fact_value(facts, "goal", project.workshop.draft if project.workshop else project.idea),
        target_user=_teacher_fact_value(facts, "users"),
        core_loop=_teacher_fact_value(facts, "core_loop"),
        scope=[str(item.get("name") or "").strip() for item in data.get("components", [])
               if isinstance(item, dict) and str(item.get("decision")) == "必选" and str(item.get("name") or "").strip()],
        acceptance=[str(item).strip() for item in design.get("acceptance", []) if str(item).strip()],
        constraints=constraints or ["按老师方案中的权限和安全边界执行"],
        risks=risks,
    )


def _advance_workshop(project: Project) -> None:
    """Ask the teacher intake agent and keep its full message protocol."""
    workshop = project.workshop
    if workshop is None:
        raise ValueError("请先进入老师需求澄清流程")
    events = teacher_engine.intake_chat(project, workshop.transcript)
    text = "".join(str(event.get("delta") or "") for event in events if event.get("type") == "text").strip()
    if text:
        workshop.transcript.append(WorkshopMessage(role="assistant", text=text))
    workshop.intake_suggestions = [
        str(item).strip() for event in events if event.get("type") == "suggestions"
        for item in event.get("items") or [] if str(item).strip()
    ]
    confirm = next((event for event in events if event.get("type") == "tool" and event.get("name") == "confirm_product"), None)
    project.questions = []
    if confirm:
        args = confirm.get("args") or {}
        workshop.name = str(args.get("name") or "").strip()[:40]
        workshop.draft = str(args.get("idea") or "").strip()
        project.discovery = _discovery(project)
        project.intent = _make_intent(project)
        transition(project, ProjectStatus.NEEDS_INTENT_CONFIRMATION)
    else:
        transition(project, ProjectStatus.NEEDS_DISCOVERY, pending=["teacher_intake"])
    project.updated_at = now()


def _prepare_workshop(project: Project, inherited_context: str = "") -> None:
    text = project.idea
    if inherited_context.strip():
        text += f"\n\n原产品已确认的上下文：\n{inherited_context.strip()}"
    if project.answers:
        facts = "\n".join(f"- {key}：{value}" for key, value in project.answers.items())
        text += f"\n\n此前已经记录的回答：\n{facts}"
    project.workshop = Workshop(transcript=[WorkshopMessage(role="user", text=text)])
    project.questions = []
    project.plan = None
    project.backend = None
    project.intent = None
    project.confirmations = Confirmation()
    if project.version > 1 and "affected_area" not in project.answers:
        project.workshop.transcript.append(WorkshopMessage(role="assistant", text="这次新增会改变原产品的哪一段？"))
        project.workshop.intake_suggestions = [option.label for option in V2_AFFECTED_AREA_OPTIONS]
        project.updated_at = now()
        return
    _advance_workshop(project)


def resume_workshop(store: Store, project_id: str) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.workshop is not None:
        if project.status == ProjectStatus.NEEDS_PLAN_CONFIRMATION and project.plan and not project.workshop.answer_questions:
            project.workshop.answer_questions = [
                str(item).strip() for item in (project.plan.open_questions or []) if str(item).strip()
            ]
            if not project.workshop.answer_questions and project.workshop.pending:
                project.workshop.answer_questions = [item.text for item in project.workshop.pending if item.text.strip()]
            project.workshop.answer_intro = teacher_engine.answer_intro(project) if project.workshop.answer_questions else ""
            project.questions = []
            return store.upsert_project(project)
        return project
    if project.status not in {
        ProjectStatus.NEEDS_DISCOVERY,
        ProjectStatus.NEEDS_INTENT_CONFIRMATION,
        ProjectStatus.NEEDS_PLAN_CONFIRMATION,
    }:
        raise ValueError("当前项目不在需求澄清阶段")
    inherited_context = ""
    if project.version > 1 and project.parent_id:
        parent = store.get_project(project.parent_id)
        if parent and parent.intent:
            inherited_context = "\n".join([
                f"目标用户：{parent.intent.target_user}",
                f"核心闭环：{parent.intent.core_loop}",
                f"边界：{'；'.join(parent.intent.constraints)}",
            ])
    _prepare_workshop(project, inherited_context)
    return store.upsert_project(project)


def _event_text(events: list[dict]) -> str:
    return "".join(str(event.get("delta") or "") for event in events if event.get("type") == "text").strip()


def _event_suggestions(events: list[dict]) -> list[str]:
    return [
        str(item).strip()
        for event in events if event.get("type") == "suggestions"
        for item in event.get("items") or [] if str(item).strip()
    ]


def workshop_chat(store: Store, project_id: str, stage: str, messages: list[WorkshopMessage]) -> tuple[Project, list[dict]]:
    """Run the teacher source chat against the full transcript supplied by the UI."""
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    workshop = project.workshop
    if workshop is None:
        raise ValueError("请先点击继续需求澄清，进入老师原始流程")
    if stage not in {"intake", "answers"}:
        raise ValueError("不支持的老师对话阶段")
    if stage == "intake":
        if project.status != ProjectStatus.NEEDS_DISCOVERY:
            raise ValueError("当前不在需求澄清对话阶段")
        if project.version > 1 and "affected_area" not in project.answers:
            user_messages = [message.text.strip() for message in messages if message.role == "user" and message.text.strip()]
            if len(user_messages) >= 2:
                project.answers["affected_area"] = user_messages[-1]
                project.evidence.append(Evidence(kind="版本影响范围", text=user_messages[-1]))
        events = teacher_engine.intake_chat(project, messages)
        workshop.transcript = list(messages)
        text = _event_text(events)
        if text:
            workshop.transcript.append(WorkshopMessage(role="assistant", text=text))
        workshop.intake_suggestions = _event_suggestions(events)
        confirm = next((event for event in events if event.get("type") == "tool" and event.get("name") == "confirm_product"), None)
        if confirm:
            args = confirm.get("args") or {}
            workshop.name = str(args.get("name") or "").strip()[:40]
            workshop.draft = str(args.get("idea") or "").strip()
            project.discovery = _discovery(project)
            project.intent = _make_intent(project)
            project.questions = []
            transition(project, ProjectStatus.NEEDS_INTENT_CONFIRMATION)
        else:
            project.questions = []
            transition(project, ProjectStatus.NEEDS_DISCOVERY, pending=["teacher_intake"])
    else:
        if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION:
            raise ValueError("当前没有可回答的方案待确认问题")
        if not workshop.answer_questions and project.plan:
            workshop.answer_questions = [str(item).strip() for item in project.plan.open_questions if str(item).strip()]
        if not workshop.answer_questions:
            raise ValueError("当前没有可回答的方案待确认问题")
        events = teacher_engine.answer_chat(project, messages)
        workshop.answer_transcript = list(messages)
        text = _event_text(events)
        if text:
            workshop.answer_transcript.append(WorkshopMessage(role="assistant", text=text))
        workshop.answer_suggestions = _event_suggestions(events)
        confirm = next((event for event in events if event.get("type") == "tool" and event.get("name") == "confirm_answers"), None)
        if confirm:
            args = confirm.get("args") or {}
            workshop.answer_draft = [
                {"question": str(item.get("question") or ""), "answer": str(item.get("answer") or "")}
                for item in args.get("answers") or []
                if str(item.get("question") or "").strip() and str(item.get("answer") or "").strip()
            ]
        project.questions = []
        transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, pending=workshop.answer_questions)
    project.updated_at = now()
    return store.upsert_project(project), events


def save_workshop_answers(store: Store, project_id: str, answers: list[dict[str, str]]) -> Project:
    """Persist a teacher confirm_answers tool payload, then rerun plan and review."""
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    workshop = project.workshop
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION or workshop is None:
        raise ValueError("当前还不能保存方案回答")
    rows = answers or workshop.answer_draft
    if not rows:
        raise ValueError("请先回答至少一个待确认问题")
    if not workshop.answer_questions and project.plan:
        workshop.answer_questions = [str(item).strip() for item in project.plan.open_questions if str(item).strip()]
    allowed = set(workshop.answer_questions)
    for item in rows:
        question = str(item.get("question") or "").strip()
        answer = str(item.get("answer") or "").strip()
        canonical = workshop.originals.get(question, question)
        if question and answer and (
            not allowed
            or question in allowed
            or canonical in allowed
            or question.startswith("审稿追问：")
        ):
            # Keep the visible wording in the teacher transcript, but use the
            # teacher source's original wording as the decision identity. This
            # prevents a rewritten duplicate question from reopening a
            # decision that was already answered.
            workshop.decisions[canonical] = answer
            workshop.originals[question] = canonical
            if question in workshop.skipped:
                workshop.skipped.remove(question)
    workshop.answer_draft = []
    _plan_workshop(store, project)
    return store.upsert_project(project)


def _plan_workshop(store: Store, project: Project) -> None:
    workspace_root = store.path.parent / "teacher-workspaces"
    try:
        result = teacher_engine.generate_plan(project, workspace_root)
    except teacher_engine.TeacherEngineError as exc:
        if getattr(exc, "code", "") != "teacher_engine_error":
            raise
        result = teacher_engine.generate_plan(project, workspace_root)
    data = result["data"]
    review = data.get("review") or {}
    score = review.get("score")
    workshop = project.workshop
    if workshop is None:
        raise ValueError("请先进入老师需求澄清流程")

    # Keep the teacher source's order and wording metadata. The visible plain
    # question can change after a replan, while ``original`` and ``merged``
    # identify the decision it represents. The adapter must reconcile those
    # identities instead of treating every rewritten sentence as a new user
    # decision.
    previous_originals = dict(workshop.originals)
    question_items = [
        item for item in result.get("users", [])
        if isinstance(item, dict) and str(item.get("text") or "").strip()
    ]
    questions: list[str] = []
    current_originals: dict[str, str] = {}
    for item in question_items:
        display = str(item.get("text") or "").strip()
        canonical = str(item.get("original") or display).strip() or display
        merged = item.get("merged") if isinstance(item.get("merged"), list) else []
        aliases = [canonical, *[str(value).strip() for value in merged if str(value).strip()]]
        for alias in aliases:
            current_originals[alias] = canonical
        current_originals[display] = canonical
        if _question_has_decision(workshop, aliases, previous_originals):
            continue
        questions.append(display)

    # Preserve old display-to-original mappings so projects created before
    # this reconciliation logic can still match their existing decisions.
    workshop.originals = {**previous_originals, **current_originals}
    review_ok = (
        isinstance(score, int)
        and score >= teacher_engine.MIN_REVIEW_SCORE
        and not any(str(item.get("severity") or "").lower() == "high" for item in review.get("issues", []))
    )
    if not questions and not review_ok:
        for issue in review.get("issues", []):
            section = str(issue.get("section") or "方案审稿").strip()
            problem = str(issue.get("problem") or "审稿指出一处待补充内容").strip()
            questions.append(f"审稿追问（{section}）：{problem}")
        if not questions:
            questions.append("审稿追问：请补充一条会改变方案判断的事实、边界或验收标准。")

    workshop.answer_questions = questions
    workshop.answer_intro = teacher_engine.answer_intro(project) if questions else ""
    workshop.answer_transcript = []
    workshop.answer_suggestions = []
    workshop.answer_draft = []
    # Keep legacy fields empty for new projects.  They are read only by the
    # compatibility /answers route for old persisted projects.
    workshop.pending = []
    project.questions = []

    project.plan = ProductPlan(
        title=data["title"],
        summary=data["one_liner"],
        user_journey=["需求拆解", "领域建模", "组件选型", "架构设计", "独立审稿"],
        mvp_features=[item["name"] for item in data["components"] if item["decision"] == "必选"],
        generated_stack=[data["design"].get("tech_stack_and_deployment", "")],
        preview_label="等待开发与验收",
        open_questions=questions,
        review_score=score if isinstance(score, int) else 0,
        review_ok=review_ok,
        review_summary=review.get("summary", ""),
        review_issues=[
            f"[{item.get('severity', '')}] {item.get('section', '')} · {item.get('problem', '')}"
            for item in review.get("issues", [])
        ],
        teacher_workspace_path=result["workspace"],
        teacher_plan_path=result["document"],
        teacher_handoff_path=result["handoff"],
        teacher_handoff_name=result["filename"],
        teacher_plan=data,
    )
    project.intent = _intent_from_teacher_plan(project, data)
    project.plan_revision = None
    project.confirmations.plan = False
    transition(project, ProjectStatus.NEEDS_PLAN_CONFIRMATION, pending=questions)
    project.updated_at = now()


def _question_has_decision(workshop: Workshop, aliases: list[str], previous_originals: dict[str, str]) -> bool:
    """Return whether a teacher question or one of its merged aliases is answered."""

    decision_keys = set(aliases)
    for key in list(workshop.decisions):
        canonical = previous_originals.get(key, workshop.originals.get(key, key))
        if canonical in decision_keys and str(workshop.decisions.get(key) or "").strip():
            return True
        if str(workshop.decisions.get(key) or "").strip() and any(
            _question_is_near_duplicate(alias, key, mature=len(workshop.decisions) >= 20)
            for alias in aliases
        ):
            return True
        if len(workshop.decisions) >= 20 and str(workshop.decisions.get(key) or "").strip() and any(
            _question_topics_match(alias, key, str(workshop.decisions.get(key) or "")) for alias in aliases
        ):
            return True
    return False


def _question_is_near_duplicate(current: str, previous: str, *, mature: bool = False) -> bool:
    """Only collapse a very close rewrite. New detail questions remain visible."""
    normalize = lambda value: "".join(str(value).split())
    current_text = normalize(current)
    previous_text = normalize(previous)
    if len(current_text) < 16 or len(previous_text) < 16:
        return False
    threshold = 0.55 if mature else 0.84
    return SequenceMatcher(None, current_text, previous_text).ratio() >= threshold


_QUESTION_TOPICS = (
    "登录", "操作人", "负责人", "备份", "恢复", "线索", "敏感", "身份证", "银行卡", "密码",
    "三千条", "两秒", "V2", "模型", "待办", "来源", "跟进", "阶段", "本地网页", "代号",
    "真名", "真实身份", "修改", "时间", "覆盖", "提示", "确认",
)


def _question_topics_match(current: str, previous: str, answer: str = "") -> bool:
    reference = f"{previous} {answer}"
    topics = [topic for topic in _QUESTION_TOPICS if topic in str(current) and topic in reference]
    return len(topics) >= 2


def fill_workshop_options(store: Store, project_id: str, question_id: str) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if not project.workshop or not project.questions or project.questions[0].id != question_id:
        raise ValueError("当前问题已经变化，请刷新后继续")
    question = project.questions[0]
    # “帮我想想”是一次新的建议请求，即使 Agent 首轮已经给过选项，
    # 也允许用户重新生成一组更贴合当前方案的方向。
    project.questions = [teacher_engine.fill_options(project, question)]
    project.updated_at = now()
    store.upsert_project(project)
    return project


def _answer_workshop(store: Store, project: Project, answers: AnswerRequest) -> Project:
    workshop = project.workshop
    if workshop is None or not project.questions or set(answers.answers) != {project.questions[0].id}:
        raise ValueError("请回答当前问题，刷新后可继续")
    question = project.questions[0]
    value = answers.answers[question.id]

    if project.status == ProjectStatus.NEEDS_DISCOVERY:
        workshop.transcript.append(WorkshopMessage(role="user", text=value))
        project.discovery_round += 1
        _advance_workshop(project)
    elif project.status == ProjectStatus.NEEDS_PLAN_CONFIRMATION and workshop.pending:
        original = workshop.originals[question.id]
        if value in {"跳过这题", "不确定，先跳过"}:
            if original not in workshop.skipped:
                workshop.skipped.append(original)
        else:
            workshop.decisions[original] = value
            if original in workshop.skipped:
                workshop.skipped.remove(original)
        workshop.pending.pop(0)
        project.questions = workshop.pending[:1]
        if project.plan:
            project.plan_revision = {"status": "needs_replan", "updated_at": now()}
            project.plan.open_questions = [question.text for question in workshop.pending]
            if not project.plan.open_questions:
                project.plan.open_questions = ["已回答待确认问题，请重新推导方案"]
        project.updated_at = now()
    else:
        raise ValueError("当前阶段没有可以回答的问题")
    return store.upsert_project(project)


def create_project(store: Store, idea: str) -> Project:
    timestamp = now()
    project_id = f"p_{uuid4().hex[:10]}"
    project = Project(
        id=project_id,
        idea=idea,
        version=1,
        root_id=project_id,
        status=ProjectStatus.NEEDS_DISCOVERY,
        questions=[],
        created_at=timestamp,
        updated_at=timestamp,
    )
    project.events.append(
        ProjectEvent(
            id=f"evt_{uuid4().hex[:10]}",
            from_status="idea",
            to_status=ProjectStatus.NEEDS_DISCOVERY.value,
            actor="user",
            input_version=1,
            output_version=1,
            pending=["workshop_resume"],
            at=timestamp,
        )
    )
    return store.upsert_project(project)


def add_supplement(store: Store, project_id: str, text: str) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_INTENT_CONFIRMATION or project.workshop is None:
        raise ValueError("只有在需求确认阶段才能补充信息")
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("补充内容不能为空")
    project.workshop.draft = f"{project.workshop.draft}\n\n### 用户补充\n\n{cleaned}"
    project.workshop.transcript.append(WorkshopMessage(role="user", text=cleaned))
    project.evidence.append(Evidence(kind="补充信息", text=cleaned))
    project.updated_at = now()
    return store.upsert_project(project)


def modify_plan(store: Store, project_id: str, text: str) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION or project.workshop is None:
        raise ValueError("只有在方案确认阶段才能修改方案")
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("方案修改内容不能为空")
    project.workshop.decisions["用户要求修改方案"] = cleaned
    _plan_workshop(store, project)
    project.plan_revision = {"status": "applied", "note": cleaned, "applied_at": now()}
    return store.upsert_project(project)


def create_iteration(store: Store, project_id: str, change_request: str) -> Project:
    parent = store.get_project(project_id)
    if parent is None:
        raise KeyError(project_id)
    if parent.status != ProjectStatus.TRIAL or parent.trial is None or not parent.trial.feedback:
        raise ValueError("请先开始试用并记录一次结果，再开启下一版")
    cleaned = change_request.strip()
    if not cleaned:
        raise ValueError("新增需求不能为空")
    timestamp = now()
    project_id = f"p_{uuid4().hex[:10]}"
    project = Project(
        id=project_id,
        idea=parent.idea,
        version=parent.version + 1,
        parent_id=parent.id,
        root_id=parent.root_id or parent.id,
        change_request=cleaned,
        status=ProjectStatus.NEEDS_DISCOVERY,
        answers={"change_request": cleaned},
        questions=[],
        created_at=timestamp,
        updated_at=timestamp,
    )
    project.events.append(
        ProjectEvent(
            id=f"evt_{uuid4().hex[:10]}",
            from_status=parent.status.value,
            to_status=ProjectStatus.NEEDS_DISCOVERY.value,
            actor="user",
            input_version=parent.version,
            output_version=project.version,
            evidence=[cleaned],
            pending=["workshop_resume"],
            at=timestamp,
        )
    )
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
    transition(project, ProjectStatus.TRIAL, actor="user", evidence=[cleaned])
    for task in reversed(project.tasks):
        if task.kind == "trial" and task.status == "running":
            task.status = "succeeded"
            task.progress = 100
            task.message = "已记录一次试用反馈"
            task.updated_at = timestamp
            break
    project.tasks.append(Task(id=f"task_{uuid4().hex[:10]}", kind="trial_feedback", status="succeeded", progress=100, message="试用反馈已记录", created_at=timestamp, updated_at=timestamp, meta={"outcome": project.trial.outcome}))
    return store.upsert_project(project)


def answer_project(store: Store, project_id: str, answers: AnswerRequest) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.workshop is None:
        raise ValueError("请先点击继续需求澄清，进入老师原始流程")
    return _answer_workshop(store, project, answers)


def confirm_intent(store: Store, project_id: str, confirmed: bool, note: str = "", *, draft: str | None = None) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_INTENT_CONFIRMATION or project.workshop is None:
        raise ValueError("当前还不能确认需求")
    if not confirmed:
        project.questions = [Question(id="workshop_correction", text="这份需求草稿哪里需要修改？", hint="写明更正内容")]
        transition(project, ProjectStatus.NEEDS_DISCOVERY, pending=["workshop_correction"])
        return store.upsert_project(project)
    if draft is not None:
        project.workshop.draft = draft.strip()
    if not project.workshop.draft.strip():
        raise ValueError("请先整理需求草稿")
    project.confirmations.intent = True
    _plan_workshop(store, project)
    return store.upsert_project(project)


def confirm_plan(store: Store, project_id: str, confirmed: bool, note: str = "") -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION or project.plan is None or project.workshop is None:
        raise ValueError("当前还不能确认方案")
    if not confirmed:
        project.plan_revision = {"status": "needs_input", "prompt": "方案哪里需要修改？", "requested_at": now()}
        return store.upsert_project(project)
    if not project.confirmations.intent:
        raise ValueError("请先确认需求草稿")
    if project.workshop.answer_questions or project.plan.open_questions or project.workshop.answer_draft:
        raise ValueError("请完成老师方案问答并重新推导方案")
    if project.plan.review_score < teacher_engine.MIN_REVIEW_SCORE or not project.plan.review_ok:
        raise ValueError("独立审稿需要通过且达到 80 分")
    if project.plan_revision:
        raise ValueError("请先完成方案修改和复审")
    project.backend = deliver_handoff(project, store.path.parent)
    project.confirmations.plan = True
    transition(project, ProjectStatus.BACKEND_BUILDING, actor="user", pending=["launch_stage_0"])
    return store.upsert_project(project)


def record_acceptance(store: Store, project_id: str, passed: bool, note: str = "") -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status == ProjectStatus.BACKEND_BUILDING:
        _sync_development_status(project)
    if project.status not in {ProjectStatus.BACKEND_VERIFIED, ProjectStatus.PREVIEW_READY}:
        raise ValueError("后端开发尚未完成，不能验收")
    if project.backend and project.backend.launch_project:
        try:
            kit_stage, kit_status = read_kit_state(launch_kit_root(), project.backend.launch_project)
        except (OSError, ValueError):
            kit_stage, kit_status = None, None
        if kit_stage:
            project.backend.kit_stage = kit_stage
        if kit_stage == "完成":
            project.backend.kit_status = "completed"
        elif kit_status:
            project.backend.kit_status = kit_status
    project.confirmations.acceptance = passed
    project.confirmations.note = note
    transition(project, ProjectStatus.PREVIEW_READY if passed else ProjectStatus.BACKEND_VERIFIED, actor="user", pending=[] if passed else ["acceptance"])
    return store.upsert_project(project)


def generate_real_plan(store: Store, project_id: str, answers: AnswerRequest | None, client=None) -> Project:
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    if project.status != ProjectStatus.NEEDS_PLAN_CONFIRMATION or project.workshop is None:
        raise ValueError("请先完成需求澄清并生成方案")
    if not project.confirmations.intent:
        raise ValueError("请先确认需求草稿")
    _plan_workshop(store, project)
    return store.upsert_project(project)


PLAN_PROGRESS_STAGES = (
    ("extract", "需求拆解", "把想法拆成目标、用户和核心闭环"),
    ("select", "组件选型", "按老师规则确定需要的组件"),
    ("design", "领域建模与架构设计", "整理五要素、工具清单和系统设计"),
    ("review", "独立审稿", "检查方案矛盾、风险和高严重度问题"),
    ("questions", "整理待确认问题", "把方案里的未知项改成可回答的问题"),
    ("documents", "整理 PRD 与交接文档", "写回 PRD、方案和开发交接包"),
)


def plan_progress(store: Store, project_id: str) -> dict[str, object]:
    """Read the teacher workspace stages without mutating the project."""
    project = store.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    root = store.path.parent / "teacher-workspaces" / project.id
    workspace = None
    if project.plan and project.plan.teacher_workspace_path:
        candidate = Path(project.plan.teacher_workspace_path)
        if candidate.is_dir():
            workspace = candidate
    if workspace is None and root.is_dir():
        candidates = sorted(
            (path for path in root.rglob("stages") if path.is_dir()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if candidates:
            workspace = candidates[0].parent

    stage_dir = workspace / "stages" if workspace else None
    files = {path.name for path in stage_dir.iterdir()} if stage_dir and stage_dir.is_dir() else set()
    review_file = next((name for name in ("review_retry.json", "review.json") if name in files), None)
    stage_done = {
        "extract": "extract.json" in files,
        "select": "select.json" in files,
        "design": any(name in files for name in ("design_agent.json", "design_agent_retry.json", "design.json", "design_retry.json")),
        "review": review_file is not None,
        "questions": "plan.json" in files,
        "documents": bool(workspace and (workspace / "PRD.md").is_file() and (workspace / "方案.md").is_file() and (workspace / "handoff.zip").is_file()),
    }
    failed = sorted(name.removesuffix(".failed.json") for name in files if name.endswith(".failed.json"))
    if project.plan and stage_done["documents"]:
        status = "done"
    elif failed:
        status = "failed"
    elif workspace:
        status = "running"
    else:
        status = "pending"
    review = {}
    if workspace and (workspace / "plan.json").is_file():
        try:
            payload = json.loads((workspace / "plan.json").read_text(encoding="utf-8"))
            review = payload.get("review") or {}
        except (OSError, ValueError):
            review = {}
    stages = [
        {"id": stage_id, "label": label, "description": description, "status": "done" if stage_done[stage_id] else "todo"}
        for stage_id, label, description in PLAN_PROGRESS_STAGES
    ]
    current = next((index for index, item in enumerate(stages) if item["status"] == "todo"), len(stages) - 1)
    if status == "running" and stages:
        stages[current]["status"] = "active"
    if status == "failed" and failed:
        failed_id = failed[0].split("_")[0]
        for item in stages:
            if item["id"] == failed_id:
                item["status"] = "failed"
                break
    return {
        "project_id": project.id,
        "status": status,
        "workspace": str(workspace) if workspace else None,
        "stages": stages,
        "review": {
            "score": review.get("score"),
            "ok": review.get("ok"),
            "issues": review.get("issues") or [],
        },
    }
