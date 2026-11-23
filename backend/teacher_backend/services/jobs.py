from __future__ import annotations

import json
import uuid

from sqlalchemy.orm import Session

from teacher_backend.core.errors import ApiError
from teacher_backend.models import Job, Task
from teacher_backend.services.tasks import _event


def create_job(session: Session, task: Task, kind: str, payload: dict, mode: str = "success", max_attempts: int = 3, timeout_seconds: float = 1.0) -> Job:
    if mode not in {"success", "fail_once", "timeout", "fail"}:
        raise ApiError("invalid_job_mode", "不支持的 mock Job 模式", 422)
    job = Job(id=str(uuid.uuid4()), task_id=task.id, kind=kind, status="queued", attempts=0, max_attempts=max_attempts, mode=mode, timeout_seconds=timeout_seconds, payload_json=json.dumps(payload, ensure_ascii=False))
    session.add(job)
    session.flush()
    _event(session, task, "job_queued", f"后台 Job 已排队：{kind}", {"job_id": job.id, "kind": kind})
    session.commit()
    session.refresh(job)
    return job


def get_job(session: Session, task: Task, job_id: str) -> Job:
    job = session.get(Job, job_id)
    if job is None or job.task_id != task.id:
        raise ApiError("job_not_found", "找不到这个后台 Job", 404)
    return job


def run_job(session: Session, task: Task, job: Job) -> Job:
    if job.status == "completed":
        return job
    if job.status == "running":
        raise ApiError("job_already_running", "这个后台 Job 正在执行", 409)
    job.status = "running"
    session.commit()
    while job.attempts < job.max_attempts:
        job.attempts += 1
        _event(session, task, "job_started", f"后台 Job 第 {job.attempts} 次执行", {"job_id": job.id, "attempt": job.attempts})
        if job.mode == "timeout":
            job.last_error = "mock_timeout"
            if job.attempts < job.max_attempts:
                job.status = "retrying"
                _event(session, task, "job_retry", "后台 Job 超时，准备有限重试", {"job_id": job.id, "attempt": job.attempts})
                session.commit()
                continue
            job.status = "failed"
            _event(session, task, "job_failed", "后台 Job 超过重试次数后失败", {"job_id": job.id, "error": job.last_error})
            session.commit()
            return job
        if job.mode == "fail" or (job.mode == "fail_once" and job.attempts == 1):
            job.last_error = "mock_transient_error"
            if job.attempts < job.max_attempts and job.mode == "fail_once":
                job.status = "retrying"
                _event(session, task, "job_retry", "后台 Job 遇到可恢复错误，准备重试", {"job_id": job.id, "attempt": job.attempts})
                session.commit()
                continue
            job.status = "failed"
            _event(session, task, "job_failed", "后台 Job 失败，已停止继续重试", {"job_id": job.id, "error": job.last_error})
            session.commit()
            return job
        job.status = "completed"
        job.result_json = json.dumps({"ok": True, "kind": job.kind, "attempts": job.attempts}, ensure_ascii=False)
        job.last_error = None
        _event(session, task, "job_completed", "后台 Job 已完成", {"job_id": job.id, "attempts": job.attempts})
        session.commit()
        return job
    job.status = "failed"
    session.commit()
    return job
