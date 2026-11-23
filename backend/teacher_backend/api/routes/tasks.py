from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from teacher_backend.db import get_session
from teacher_backend.models import ToolCall
from teacher_backend.schemas import AgentRunCreate, AgentRunOut, AgentStepOut, EventOut, JobCreate, JobOut, KnowledgeInject, KnowledgeOut, TaskCreate, TaskOut, ToolCallCreate, ToolCallOut, ToolOut
from teacher_backend.services.catalog import get_tool, list_tools, permission_status, validate_arguments
from teacher_backend.services.jobs import create_job, get_job, run_job
from teacher_backend.services.knowledge import inject_knowledge, search_knowledge
from teacher_backend.services.mcp import search_mcp
from teacher_backend.services.agent_loop import continue_agent_run, create_agent_run, get_agent_run, pause_agent_run
from teacher_backend.services.tasks import _event, create_task, get_task, list_events, run_mock

router = APIRouter(tags=["tasks"])


def _event_payload(event) -> EventOut:
    return EventOut(id=event.id, sequence=event.sequence, event_type=event.event_type, message=event.message, payload=json.loads(event.payload_json or "{}"), created_at=event.created_at)


def _tool_payload(tool) -> ToolOut:
    return ToolOut(name=tool.name, description=tool.description, permission=tool.permission, enabled=tool.enabled, arguments=json.loads(tool.arguments_json or "{}"))


def _tool_call_payload(call) -> ToolCallOut:
    return ToolCallOut(id=call.id, tool_name=call.tool_name, permission=call.permission, status=call.status, attempt=call.attempt, max_attempts=call.max_attempts, arguments=json.loads(call.arguments_json or "{}"), result=json.loads(call.result_json or "{}"), error_code=call.error_code, created_at=call.created_at)


def _job_payload(job) -> JobOut:
    return JobOut(id=job.id, kind=job.kind, status=job.status, attempts=job.attempts, max_attempts=job.max_attempts, mode=job.mode, timeout_seconds=job.timeout_seconds, payload=json.loads(job.payload_json or "{}"), result=json.loads(job.result_json or "{}"), last_error=job.last_error, created_at=job.created_at)


def _knowledge_payload(item) -> KnowledgeOut:
    return KnowledgeOut(id=item.id, title=item.title, content=item.content, tags=json.loads(item.tags_json or "[]"), source=item.source, created_at=item.created_at)


def _agent_run_payload(run) -> AgentRunOut:
    return AgentRunOut(
        id=run.id,
        task_id=run.task_id,
        execution_mode=getattr(run, "execution_mode", "mock"),
        provider=getattr(run, "provider", None),
        model=getattr(run, "model", None),
        status=run.status,
        current_step=run.current_step,
        max_steps=run.max_steps,
        max_retries=run.max_retries,
        failure_mode=run.failure_mode,
        pause_after_step=run.pause_after_step,
        last_error=run.last_error,
        created_at=run.created_at,
        updated_at=run.updated_at,
        completed_at=run.completed_at,
        steps=[
            AgentStepOut(
                id=step.id,
                position=step.position,
                title=step.title,
                status=step.status,
                attempts=step.attempts,
                max_attempts=step.max_attempts,
                error_code=step.error_code,
                result=json.loads(step.result_json or "{}"),
                started_at=step.started_at,
                completed_at=step.completed_at,
            )
            for step in run.steps
        ],
    )


def _task_payload(task) -> TaskOut:
    return TaskOut(id=task.id, owner_id=task.owner_id, title=task.title, brief=task.brief, status=task.status, created_at=task.created_at, updated_at=task.updated_at, todos=task.todos, events=[_event_payload(event) for event in task.events], artifacts=task.artifacts, tool_calls=[_tool_call_payload(item) for item in task.tool_calls], jobs=[_job_payload(item) for item in task.jobs], agent_runs=[_agent_run_payload(item) for item in task.agent_runs])


@router.post("/tasks", response_model=TaskOut, status_code=201)
def post_task(data: TaskCreate, session: Session = Depends(get_session)) -> TaskOut:
    return _task_payload(create_task(session, data))


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task_route(task_id: str, session: Session = Depends(get_session)) -> TaskOut:
    return _task_payload(get_task(session, task_id))


@router.get("/tasks/{task_id}/events", response_model=list[EventOut])
def get_events_route(task_id: str, session: Session = Depends(get_session)) -> list[EventOut]:
    return [_event_payload(event) for event in list_events(session, task_id)]


@router.post("/tasks/{task_id}/run", response_model=TaskOut)
def run_task_route(task_id: str, session: Session = Depends(get_session)) -> TaskOut:
    return _task_payload(run_mock(session, task_id))


@router.get("/tasks/{task_id}/stream")
async def stream_task_route(task_id: str, session: Session = Depends(get_session)) -> StreamingResponse:
    events = list_events(session, task_id)

    async def event_stream() -> AsyncIterator[str]:
        for event in events:
            payload = _event_payload(event).model_dump(mode="json")
            yield f"event: {event.event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            await asyncio.sleep(0)
        yield "event: done\ndata: {\"status\":\"ok\"}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/tasks/{task_id}/agent-runs/{run_id}/stream")
async def stream_agent_run_route(
    task_id: str,
    run_id: str,
    follow: bool = Query(default=False),
    since: int = Query(default=0, ge=0),
    timeout_seconds: float = Query(default=30.0, gt=0, le=300),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Stream persisted events for one Agent run.

    The normal task stream is a finite replay. This endpoint adds a run-scoped
    replay/follow mode so a real model request can be observed while the worker
    is still writing events. Events stay durable in SQLite; reconnecting with
    ``since=<last sequence>`` does not lose the recovery timeline.
    """
    task = get_task(session, task_id)
    run = get_agent_run(session, task, run_id)
    initial_sequence = since

    def matching_events() -> list[Any]:
        session.expire_all()
        return [
            event
            for event in list_events(session, task_id)
            if event.sequence > initial_sequence
            and json.loads(event.payload_json or "{}").get("run_id") == run_id
        ]

    async def event_stream() -> AsyncIterator[str]:
        next_sequence = initial_sequence
        started = asyncio.get_running_loop().time()
        while True:
            pending = [event for event in matching_events() if event.sequence > next_sequence]
            for event in pending:
                payload = _event_payload(event).model_dump(mode="json")
                next_sequence = event.sequence
                yield f"id: {event.sequence}\nevent: {event.event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

            session.expire_all()
            current = get_agent_run(session, task, run_id)
            # A paused run has a durable recovery point and should end this
            # stream; clients can reconnect with `since` after resume.
            terminal = current.status in {"completed", "failed", "paused"}
            timed_out = asyncio.get_running_loop().time() - started >= timeout_seconds
            if not follow or terminal or timed_out:
                status = current.status if terminal else ("timeout" if timed_out else current.status)
                yield f"event: done\ndata: {json.dumps({'status': status, 'last_sequence': next_sequence}, ensure_ascii=False)}\n\n"
                return
            await asyncio.sleep(0.25)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/tools", response_model=list[ToolOut])
def tools_route(session: Session = Depends(get_session)) -> list[ToolOut]:
    return [_tool_payload(tool) for tool in list_tools(session)]


@router.post("/tasks/{task_id}/tool-calls", response_model=ToolCallOut)
def tool_call_route(task_id: str, data: ToolCallCreate, session: Session = Depends(get_session)) -> ToolCallOut:
    task = get_task(session, task_id)
    tool = get_tool(session, data.tool_name)
    validate_arguments(tool, data.arguments)
    permission = permission_status(tool, data.confirmed)
    status = "awaiting_confirmation" if permission == "awaiting_confirmation" else "completed"
    result: dict[str, Any]
    if status == "awaiting_confirmation":
        result = {"requires_confirmation": True, "message": "该工具动作需要用户确认后才会执行"}
        _event(session, task, "tool_confirmation_required", f"工具 {tool.name} 等待用户确认", {"tool": tool.name})
    else:
        result = {"ok": True, "tool": tool.name, "runner": "mock", "arguments": data.arguments}
        _event(session, task, "tool_completed", f"工具 {tool.name} 已完成（mock）", {"tool": tool.name})
    call = ToolCall(id=str(uuid.uuid4()), task_id=task.id, tool_name=tool.name, permission=tool.permission, status=status, attempt=1, max_attempts=1, arguments_json=json.dumps(data.arguments, ensure_ascii=False), result_json=json.dumps(result, ensure_ascii=False))
    session.add(call)
    session.commit()
    session.refresh(call)
    return _tool_call_payload(call)


@router.get("/tasks/{task_id}/tool-calls", response_model=list[ToolCallOut])
def tool_calls_route(task_id: str, session: Session = Depends(get_session)) -> list[ToolCallOut]:
    task = get_task(session, task_id)
    return [_tool_call_payload(call) for call in task.tool_calls]


@router.get("/mcp/search")
def mcp_search_route(q: str = Query(default="", max_length=200)) -> dict[str, Any]:
    return {"query": q, "source": "mock-mcp-catalog", "tools": search_mcp(q)}


@router.get("/knowledge/search", response_model=list[KnowledgeOut])
def knowledge_search_route(q: str = Query(default="", max_length=500), session: Session = Depends(get_session)) -> list[KnowledgeOut]:
    return [_knowledge_payload(item) for item in search_knowledge(session, q)]


@router.post("/tasks/{task_id}/knowledge/inject", response_model=list[KnowledgeOut])
def knowledge_inject_route(task_id: str, data: KnowledgeInject, session: Session = Depends(get_session)) -> list[KnowledgeOut]:
    task = get_task(session, task_id)
    return [_knowledge_payload(item) for item in inject_knowledge(session, task, data.query)]


@router.post("/tasks/{task_id}/jobs", response_model=JobOut, status_code=201)
def create_job_route(task_id: str, data: JobCreate, session: Session = Depends(get_session)) -> JobOut:
    task = get_task(session, task_id)
    return _job_payload(create_job(session, task, data.kind, data.payload, data.mode, data.max_attempts, data.timeout_seconds))


@router.get("/tasks/{task_id}/jobs/{job_id}", response_model=JobOut)
def get_job_route(task_id: str, job_id: str, session: Session = Depends(get_session)) -> JobOut:
    task = get_task(session, task_id)
    return _job_payload(get_job(session, task, job_id))


@router.post("/tasks/{task_id}/jobs/{job_id}/run", response_model=JobOut)
def run_job_route(task_id: str, job_id: str, session: Session = Depends(get_session)) -> JobOut:
    task = get_task(session, task_id)
    job = get_job(session, task, job_id)
    return _job_payload(run_job(session, task, job))


@router.post("/tasks/{task_id}/agent-runs", response_model=AgentRunOut, status_code=201)
def create_agent_run_route(task_id: str, data: AgentRunCreate, session: Session = Depends(get_session)) -> AgentRunOut:
    task = get_task(session, task_id)
    execution_mode = data.mode or data.execution_mode
    run = create_agent_run(
        session,
        task,
        data.failure_mode,
        data.max_steps,
        data.max_retries,
        data.pause_after_step,
        execution_mode,
        data.provider,
        data.model,
    )
    return _agent_run_payload(continue_agent_run(session, task, run))


@router.get("/tasks/{task_id}/agent-runs", response_model=list[AgentRunOut])
def list_agent_runs_route(task_id: str, session: Session = Depends(get_session)) -> list[AgentRunOut]:
    task = get_task(session, task_id)
    return [_agent_run_payload(run) for run in task.agent_runs]


@router.get("/tasks/{task_id}/agent-runs/{run_id}", response_model=AgentRunOut)
def get_agent_run_route(task_id: str, run_id: str, session: Session = Depends(get_session)) -> AgentRunOut:
    task = get_task(session, task_id)
    return _agent_run_payload(get_agent_run(session, task, run_id))


@router.post("/tasks/{task_id}/agent-runs/{run_id}/resume", response_model=AgentRunOut)
def resume_agent_run_route(task_id: str, run_id: str, session: Session = Depends(get_session)) -> AgentRunOut:
    task = get_task(session, task_id)
    run = get_agent_run(session, task, run_id)
    return _agent_run_payload(continue_agent_run(session, task, run))


@router.post("/tasks/{task_id}/agent-runs/{run_id}/pause", response_model=AgentRunOut)
def pause_agent_run_route(task_id: str, run_id: str, session: Session = Depends(get_session)) -> AgentRunOut:
    task = get_task(session, task_id)
    run = get_agent_run(session, task, run_id)
    return _agent_run_payload(pause_agent_run(session, task, run))
