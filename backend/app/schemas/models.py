from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProjectStatus(str, Enum):
    NEEDS_DISCOVERY = "needs_discovery"
    NEEDS_INTENT_CONFIRMATION = "needs_intent_confirmation"
    NEEDS_PLAN_CONFIRMATION = "needs_plan_confirmation"
    BACKEND_BUILDING = "backend_building"
    BACKEND_VERIFIED = "backend_verified"
    PREVIEW_READY = "preview_ready"
    TRIAL = "trial"


class Question(BaseModel):
    id: str
    text: str
    hint: str
    reason: str = "这会影响需求、范围或验收"


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
    api_contract: list[str] = Field(default_factory=list)
    data_model: list[str] = Field(default_factory=list)
    test_plan: list[str] = Field(default_factory=list)
    checks: list[str] = Field(default_factory=list)
    acceptance: list[str] = Field(default_factory=list)


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


class AcceptanceRequest(BaseModel):
    passed: bool
    note: str = Field(default="", max_length=500)


class TrialFeedbackRequest(BaseModel):
    feedback: str = Field(min_length=1, max_length=2000)
    outcome: str = Field(default="needs_change", max_length=40)


class RuntimeActionRequest(BaseModel):
    input: str = Field(min_length=1, max_length=5000)


class ProjectListResponse(BaseModel):
    projects: list[Project]


def public_project(project: Project) -> dict[str, Any]:
    return project.model_dump(mode="json")
