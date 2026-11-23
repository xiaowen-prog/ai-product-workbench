from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProjectStatus(str, Enum):
    NEEDS_DISCOVERY = "needs_discovery"
    NEEDS_INTENT_CONFIRMATION = "needs_intent_confirmation"
    NEEDS_PLAN_CONFIRMATION = "needs_plan_confirmation"
    BACKEND_BUILDING = "backend_building"
    BACKEND_VERIFIED = "backend_verified"
    PREVIEW_READY = "preview_ready"
    TRIAL = "trial"


# 用户视角一次只处理这一批方案待确认问题；原始老师工作区仍保留完整清单。
MAX_PLAN_QUESTIONS = 18


class QuestionOption(BaseModel):
    id: str
    label: str
    description: str = ""
    recommended: bool = False


class Question(BaseModel):
    id: str
    text: str
    hint: str
    reason: str = "这会影响需求、范围或验收"
    options: list[QuestionOption] = Field(default_factory=list)


class WorkshopMessage(BaseModel):
    role: str
    text: str


class Workshop(BaseModel):
    transcript: list[WorkshopMessage] = Field(default_factory=list)
    name: str = ""
    draft: str = ""
    decisions: dict[str, str] = Field(default_factory=dict)
    skipped: list[str] = Field(default_factory=list)
    answer_transcript: list[WorkshopMessage] = Field(default_factory=list)
    answer_questions: list[str] = Field(default_factory=list)
    answer_intro: str = ""
    intake_suggestions: list[str] = Field(default_factory=list)
    answer_suggestions: list[str] = Field(default_factory=list)
    answer_draft: list[dict[str, str]] = Field(default_factory=list)
    pending: list[Question] = Field(default_factory=list)
    originals: dict[str, str] = Field(default_factory=dict)


class Intent(BaseModel):
    goal: str
    target_user: str
    core_loop: str
    scope: list[str]
    acceptance: list[str]
    constraints: list[str]
    risks: list[str]


class ProductPlan(BaseModel):
    title: str
    summary: str
    user_journey: list[str]
    mvp_features: list[str]
    generated_stack: list[str]
    preview_label: str
    open_questions: list[str]
    review_score: int = Field(default=0, ge=0, le=100)
    review_ok: bool = False
    review_issues: list[str] = Field(default_factory=list)
    review_summary: str = "独立审稿尚未完成。"
    teacher_workspace_path: str | None = None
    teacher_plan_path: str | None = None
    teacher_handoff_path: str | None = None
    teacher_handoff_name: str | None = None
    teacher_plan: dict[str, Any] = Field(default_factory=dict)


class Evidence(BaseModel):
    kind: str
    text: str
    source: str = "user"
    confidence: str = "stated"


class Discovery(BaseModel):
    problem: str
    desired_outcome: str
    current_workaround: str = "待确认"
    evidence: list[Evidence] = Field(default_factory=list)
    hypotheses: list[str] = Field(default_factory=list)
    red_flags: list[str] = Field(default_factory=list)
    recommendation: str = "继续澄清"


class BackendBuild(BaseModel):
    status: str
    launch_project: str | None = None
    teacher_task_id: str | None = None
    teacher_run_id: str | None = None
    execution_mode: str = "real"
    kit_stage: str | None = None
    kit_status: str | None = None
    kit_task_path: str | None = None
    kit_task: str = ""
    kit_last_output: str = ""
    api_contract: list[str] = Field(default_factory=list)
    data_model: list[str] = Field(default_factory=list)
    test_plan: list[str] = Field(default_factory=list)
    checks: list[str] = Field(default_factory=list)
    acceptance: list[str] = Field(default_factory=list)
    stage_transcript: list[WorkshopMessage] = Field(default_factory=list)
    stage_suggestions: list[str] = Field(default_factory=list)
    stage_confirmed: bool = False


class Confirmation(BaseModel):
    intent: bool = False
    plan: bool = False
    acceptance: bool = False
    note: str = ""


class Task(BaseModel):
    id: str
    kind: str
    status: str
    progress: int = Field(ge=0, le=100)
    message: str
    created_at: datetime
    updated_at: datetime
    meta: dict[str, Any] = Field(default_factory=dict)


class Trial(BaseModel):
    status: str = "active"
    outcome: str = ""
    feedback: list[str] = Field(default_factory=list)
    started_at: datetime
    updated_at: datetime


class RuntimeCheck(BaseModel):
    id: str
    label: str
    status: str
    detail: str = ""


class PreviewArtifact(BaseModel):
    kind: str = "runtime"
    status: str = "unverified"
    path: str
    health_path: str
    action_path: str
    checks: list[RuntimeCheck] = Field(default_factory=list)
    started_at: datetime
    verified_at: datetime | None = None


class ProjectEvent(BaseModel):
    id: str
    from_status: str
    to_status: str
    actor: str = "system"
    input_version: int = 1
    output_version: int = 1
    evidence: list[str] = Field(default_factory=list)
    pending: list[str] = Field(default_factory=list)
    at: datetime


class Project(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    idea: str
    version: int = Field(default=1, ge=1)
    parent_id: str | None = None
    root_id: str | None = None
    change_request: str = ""
    status: ProjectStatus
    questions: list[Question] = Field(default_factory=list)
    answers: dict[str, str] = Field(default_factory=dict)
    discovery_round: int = 0
    workshop: Workshop | None = None
    evidence: list[Evidence] = Field(default_factory=list)
    discovery: Discovery | None = None
    intent: Intent | None = None
    plan: ProductPlan | None = None
    backend: BackendBuild | None = None
    trial: Trial | None = None
    preview: PreviewArtifact | None = None
    plan_revision: dict[str, Any] | None = None
    confirmations: Confirmation = Field(default_factory=Confirmation)
    tasks: list[Task] = Field(default_factory=list)
    events: list[ProjectEvent] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class StorePayload(BaseModel):
    schema_version: int = 2
    projects: list[Project] = Field(default_factory=list)


class CreateProjectRequest(BaseModel):
    idea: str = Field(min_length=3, max_length=500)

    @field_validator("idea")
    @classmethod
    def idea_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("idea 不能是空白")
        return value


class WorkshopChatRequest(BaseModel):
    stage: Literal["intake", "answers"]
    messages: list[WorkshopMessage] = Field(default_factory=list)


class DevelopmentChatRequest(BaseModel):
    messages: list[WorkshopMessage] = Field(default_factory=list)


class WorkshopChatSaveRequest(BaseModel):
    answers: list[dict[str, str]] = Field(default_factory=list)


class AnswerRequest(BaseModel):
    # 一次提交可以带回前几轮答案；轮数和总问题数由需求缺口决定，不在契约中固定为 2/3。
    answers: dict[str, str] = Field(min_length=1)

    @field_validator("answers")
    @classmethod
    def answers_not_blank(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned = {key.strip(): answer.strip() for key, answer in value.items()}
        if any(not key or not answer for key, answer in cleaned.items()):
            raise ValueError("每个回答都需要有内容")
        return cleaned


class ConfirmationRequest(BaseModel):
    confirmed: bool
    note: str = Field(default="", max_length=500)


class IntentConfirmationRequest(ConfirmationRequest):
    draft: str | None = Field(default=None, max_length=26000)


class AcceptanceRequest(BaseModel):
    passed: bool
    note: str = Field(default="", max_length=500)


class TrialFeedbackRequest(BaseModel):
    feedback: str = Field(min_length=1, max_length=2000)
    outcome: str = Field(default="needs_change", max_length=40)


class RuntimeActionRequest(BaseModel):
    input: str = Field(min_length=1, max_length=5000)
    messages: list[WorkshopMessage] = Field(default_factory=list)


class ProjectListResponse(BaseModel):
    projects: list[Project]


def public_project(project: Project) -> dict[str, Any]:
    data = project.model_dump(mode="json")
    workshop = data.get("workshop") or {}
    if workshop.get("answer_questions"):
        workshop["answer_questions"] = workshop["answer_questions"][:MAX_PLAN_QUESTIONS]
    plan = data.get("plan") or {}
    if plan.get("review_ok") is True and workshop.get("decisions") and not workshop.get("answer_draft"):
        # 复审已经通过时，列表和恢复入口都应显示方案确认，而不是旧的
        # open_questions 快照。数据库里的原始老师工作区仍完整保留。
        workshop["answer_questions"] = []
        plan["open_questions"] = []
    return data
