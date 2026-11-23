from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    brief: str = Field(min_length=1, max_length=20_000)


class TodoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    position: int
    title: str
    status: str


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    sequence: int
    event_type: str
    message: str
    payload: dict[str, Any]
    created_at: datetime


class ArtifactOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    kind: str
    path: str
    status: str
    created_at: datetime


class ToolOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    description: str
    permission: str
    enabled: bool
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolCallCreate(BaseModel):
    tool_name: str = Field(min_length=1, max_length=64)
    arguments: dict[str, Any] = Field(default_factory=dict)
    confirmed: bool = False


class ToolCallOut(BaseModel):
    id: str
    tool_name: str
    permission: str
    status: str
    attempt: int
    max_attempts: int
    arguments: dict[str, Any]
    result: dict[str, Any]
    error_code: str | None = None
    created_at: datetime


class KnowledgeOut(BaseModel):
    id: str
    title: str
    content: str
    tags: list[str]
    source: str
    created_at: datetime


class KnowledgeInject(BaseModel):
    query: str = Field(min_length=1, max_length=500)


class JobCreate(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    mode: str = Field(default="success", pattern="^(success|fail_once|timeout|fail)$")
    max_attempts: int = Field(default=3, ge=1, le=5)
    timeout_seconds: float = Field(default=1.0, gt=0, le=30)


class JobOut(BaseModel):
    id: str
    kind: str
    status: str
    attempts: int
    max_attempts: int
    mode: str
    timeout_seconds: float
    payload: dict[str, Any]
    result: dict[str, Any]
    last_error: str | None = None
    created_at: datetime


class AgentRunCreate(BaseModel):
    failure_mode: str = Field(default="none", pattern="^(none|fail_once|timeout)$")
    execution_mode: str = Field(default="mock", pattern="^(mock|real)$")
    # ``mode`` is accepted as a short alias for API clients that use the
    # runner terminology.  The route normalizes it to execution_mode.
    mode: str | None = Field(default=None, pattern="^(mock|real)$")
    provider: str | None = Field(default=None, min_length=1, max_length=64)
    model: str | None = Field(default=None, min_length=1, max_length=128)
    max_steps: int = Field(default=5, ge=1, le=10)
    max_retries: int = Field(default=2, ge=0, le=5)
    pause_after_step: int | None = Field(default=None, ge=1, le=10)


class AgentStepOut(BaseModel):
    id: str
    position: int
    title: str
    status: str
    attempts: int
    max_attempts: int
    error_code: str | None = None
    result: dict[str, Any]
    started_at: datetime | None = None
    completed_at: datetime | None = None


class AgentRunOut(BaseModel):
    id: str
    execution_mode: str
    provider: str | None = None
    model: str | None = None
    task_id: str
    status: str
    current_step: int
    max_steps: int
    max_retries: int
    failure_mode: str
    pause_after_step: int | None = None
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    steps: list[AgentStepOut] = Field(default_factory=list)


class TaskOut(BaseModel):
    id: str
    owner_id: str
    title: str
    brief: str
    status: str
    created_at: datetime
    updated_at: datetime
    todos: list[TodoOut]
    events: list[EventOut]
    artifacts: list[ArtifactOut]
    tool_calls: list[ToolCallOut] = Field(default_factory=list)
    jobs: list[JobOut] = Field(default_factory=list)
    agent_runs: list[AgentRunOut] = Field(default_factory=list)
