from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teacher_backend.core.config import ARTIFACT_ROOT, get_owner_id
from teacher_backend.core.errors import ApiError
from teacher_backend.models import Artifact, Task, TaskEvent, Todo
from teacher_backend.schemas import TaskCreate


PLAN = [
    "理解任务并创建 Todo",
    "确认工作区与执行边界",
    "准备交付结构",
    "验证产物可打开",
    "交付预览与文件",
]


def _event(session: Session, task: Task, event_type: str, message: str, payload: dict) -> TaskEvent:
    current_max = session.scalar(select(func.max(TaskEvent.sequence)).where(TaskEvent.task_id == task.id)) or 0
    sequence = int(current_max) + 1
    item = TaskEvent(
        id=str(uuid.uuid4()),
        task_id=task.id,
        sequence=sequence,
        event_type=event_type,
        message=message,
        payload_json=json.dumps(payload, ensure_ascii=False),
    )
    task.events.append(item)
    session.add(item)
    session.flush()
    return item


def create_task(session: Session, data: TaskCreate) -> Task:
    task = Task(id=str(uuid.uuid4()), owner_id=get_owner_id(), title=data.title.strip(), brief=data.brief.strip(), status="draft")
    session.add(task)
    session.flush()
    _event(session, task, "task_created", "任务已创建，等待 Agent 运行", {"status": "draft"})
    session.commit()
    session.refresh(task)
    return task


def get_task(session: Session, task_id: str) -> Task:
    task = session.scalar(select(Task).where(Task.id == task_id, Task.owner_id == get_owner_id()))
    if task is None:
        raise ApiError("task_not_found", "找不到这个任务", 404)
    return task


def list_events(session: Session, task_id: str) -> list[TaskEvent]:
    task = get_task(session, task_id)
    return list(task.events)


def run_mock(session: Session, task_id: str) -> Task:
    task = get_task(session, task_id)
    if task.status == "completed":
        raise ApiError("task_already_completed", "这个任务已经完成，不能重复运行", 409)
    task.status = "running"
    _event(session, task, "run_started", "Agent 开始执行任务", {"runner": "mock"})
    for position, title in enumerate(PLAN, start=1):
        todo = Todo(id=str(uuid.uuid4()), task_id=task.id, position=position, title=title, status="running" if position == 1 else "queued")
        session.add(todo)
    session.flush()
    _event(session, task, "plan_created", "Agent 已创建执行计划", {"steps": len(PLAN)})
    for todo in task.todos:
        todo.status = "done"
        _event(session, task, "step_completed", f"已完成：{todo.title}", {"todo_id": todo.id, "position": todo.position})
    artifact_path = ARTIFACT_ROOT / f"{task.id}-preview.md"
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(
        f"# {task.title}\n\n{task.brief}\n\n- runner: mock\n- status: completed\n",
        encoding="utf-8",
    )
    artifact = Artifact(
        id=str(uuid.uuid4()),
        task_id=task.id,
        name=f"{task.title} preview",
        kind="markdown",
        path=str(artifact_path),
        status="ready",
    )
    session.add(artifact)
    _event(session, task, "artifact_ready", "预览产物已生成", {"artifact_id": artifact.id, "path": str(artifact_path)})
    task.status = "completed"
    _event(session, task, "run_completed", "任务完成，可以查看产物", {"status": "completed"})
    session.commit()
    session.refresh(task)
    return task

