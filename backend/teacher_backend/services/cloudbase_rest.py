"""CloudBase PostgreSQL REST persistence for the existing SQLAlchemy services.

The application services intentionally keep their SQLAlchemy models and session
contracts.  In ``DATA_BACKEND=cloudbase_rest`` mode this module mirrors ORM row
changes to the CloudBase PostgREST-compatible gateway and hydrates the local
SQLite cache during startup.  This keeps the change small while ensuring a
recycled container can recover tasks, runs, events, steps, jobs, tool calls,
knowledge entries and artifact metadata from CloudBase.

Only the server-side API key is used here.  It never leaves this module and is
never included in error messages or logs.
"""
from __future__ import annotations

import contextlib
import json
import logging
import threading
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from typing import Any, Iterable, Iterator

import httpx
from sqlalchemy import delete, event, inspect as sa_inspect
from sqlalchemy.orm import Session

from teacher_backend.core.config import StorageSettings

logger = logging.getLogger("app.cloudbase_rest")
logging.getLogger("httpx").setLevel(logging.WARNING)

TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=5.0)
GET_RETRIES = 1
_UPSERT_ORDER = {
    "tool_definitions": 0,
    "knowledge_entries": 1,
    "tasks": 2,
    "agent_runs": 3,
    "task_events": 4,
    "todos": 4,
    "artifacts": 4,
    "tool_calls": 4,
    "jobs": 4,
    "agent_steps": 5,
}

# The SQLAlchemy table names are deliberately kept as the default.  A product
# can set CLOUDBASE_TABLE_PREFIX when sharing an environment.
_SYNC_DISABLED: ContextVar[bool] = ContextVar("cloudbase_sync_disabled", default=False)


class CloudBaseStorageError(RuntimeError):
    """A CloudBase request failed without exposing credentials or row contents."""


class CloudBaseConfigError(RuntimeError):
    """CloudBase mode was requested without a safe endpoint or key."""


@dataclass(frozen=True)
class RestRow:
    table: str
    data: dict[str, Any]


def _storage_error(code: str = "db_unavailable") -> CloudBaseStorageError:
    return CloudBaseStorageError(code)


def _parse_datetime(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        if isinstance(value, datetime) and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _table_name(model: type, prefix: str) -> str:
    return f"{prefix}{model.__tablename__}"


class CloudBaseRestClient:
    """Small PostgREST client with read retries and safe error mapping."""

    def __init__(self, settings: StorageSettings, transport: httpx.BaseTransport | None = None) -> None:
        if not settings.cloudbase_api_key:
            raise CloudBaseConfigError("CLOUDBASE_API_KEY is required")
        if not settings.cloudbase_rest_url:
            raise CloudBaseConfigError("CLOUDBASE_ENV_ID or CLOUDBASE_REST_URL is required")
        if not settings.cloudbase_rest_url.startswith("https://"):
            raise CloudBaseConfigError("CLOUDBASE_REST_URL must use https://")
        self.prefix = _safe_prefix(settings.cloudbase_table_prefix)
        self._client = httpx.Client(
            base_url=settings.cloudbase_rest_url.rstrip("/") + "/",
            timeout=TIMEOUT,
            transport=transport,
            follow_redirects=False,
            headers={"Authorization": f"Bearer {settings.cloudbase_api_key}", "Accept": "application/json"},
        )

    def close(self) -> None:
        self._client.close()

    def table(self, model_or_name: type | str) -> str:
        name = model_or_name if isinstance(model_or_name, str) else model_or_name.__tablename__
        return f"{self.prefix}{name}"

    def request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
        prefer: str | None = None,
    ) -> httpx.Response:
        attempts = 1 + (GET_RETRIES if method == "GET" else 0)
        for attempt in range(attempts):
            try:
                response = self._client.request(
                    method,
                    self.table(table),
                    params=params,
                    json=payload,
                    headers={"Prefer": prefer} if prefer else None,
                )
            except (httpx.ConnectError, httpx.ConnectTimeout):
                if attempt + 1 < attempts:
                    continue
                raise _storage_error() from None
            except httpx.HTTPError:
                raise _storage_error() from None
            if response.status_code >= 500 and attempt + 1 < attempts:
                continue
            return response
        raise _storage_error()

    @staticmethod
    def check(response: httpx.Response, ok: tuple[int, ...] = (200, 201, 204)) -> None:
        if response.status_code in ok:
            return
        # Keep only bounded provider metadata in logs.  Body messages can carry
        # request data and are never sent to the caller.
        code = ""
        request_id = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                code = str(body.get("code", ""))[:64]
                request_id = str(body.get("requestId", ""))[:64]
        except ValueError:
            pass
        logger.error("cloudbase request failed status=%s code=%s request_id=%s", response.status_code, code, request_id)
        raise _storage_error("db_unavailable" if response.status_code in {401, 403} or response.status_code >= 500 else "db_error")

    @staticmethod
    def rows(response: httpx.Response) -> list[dict[str, Any]]:
        try:
            value = response.json()
        except ValueError:
            raise _storage_error("db_error") from None
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise _storage_error("db_error")
        return value

    def list_rows(self, table: str, *, limit: int = 1000) -> list[dict[str, Any]]:
        all_rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            response = self.request("GET", table, params={"select": "*", "limit": str(limit), "offset": str(offset)})
            self.check(response)
            page = self.rows(response)
            all_rows.extend(page)
            if len(page) < limit:
                return all_rows
            offset += limit

    def upsert_row(self, table: str, primary_key: str, value: Any, row: dict[str, Any]) -> None:
        # PATCH first makes updates idempotent.  If no matching row exists,
        # POST the complete row.  A concurrent insert can return 409, in which
        # case PATCH once more to converge the row.
        selector = {primary_key: f"eq.{_query_value(value)}"}
        response = self.request("PATCH", table, params=selector, payload=row, prefer="return=representation")
        self.check(response)
        if self.rows(response):
            return
        response = self.request("POST", table, payload=row, prefer="return=minimal")
        if response.status_code == 409:
            response = self.request("PATCH", table, params=selector, payload=row, prefer="return=representation")
        self.check(response)

    def delete_row(self, table: str, primary_key: str, value: Any) -> None:
        response = self.request("DELETE", table, params={primary_key: f"eq.{_query_value(value)}"})
        self.check(response)


def _safe_prefix(configured: str | None = None) -> str:
    import os

    prefix = (configured if configured is not None else os.getenv("CLOUDBASE_TABLE_PREFIX", "")).strip()
    if not prefix:
        return ""
    if len(prefix) > 32 or not prefix.replace("_", "").isalnum() or not prefix[0].isalpha():
        raise CloudBaseConfigError("CLOUDBASE_TABLE_PREFIX must start with a letter and contain only letters, digits or _")
    return prefix


def _query_value(value: Any) -> str:
    return str(_json_value(value)).replace(" ", "%20")


def _row_from_model(instance: Any) -> RestRow | None:
    mapper = sa_inspect(instance).mapper
    if not mapper:
        return None
    data: dict[str, Any] = {}
    for column in mapper.columns:
        value = getattr(instance, column.key)
        data[column.key] = _json_value(value)
    return RestRow(mapper.class_.__tablename__, data)


def _primary_key(model: type) -> str:
    columns = list(sa_inspect(model).primary_key)
    if len(columns) != 1:
        raise CloudBaseStorageError("db_schema_error")
    return columns[0].key


_client: CloudBaseRestClient | None = None
_client_lock = threading.Lock()


def init_client(settings: StorageSettings, transport: httpx.BaseTransport | None = None) -> CloudBaseRestClient:
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
        _client = CloudBaseRestClient(settings, transport=transport)
    return _client


def get_client() -> CloudBaseRestClient:
    if _client is None:
        raise CloudBaseConfigError("CloudBase REST client is not initialized")
    return _client


def reset_client() -> None:
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
        _client = None


@contextlib.contextmanager
def disabled() -> Iterator[None]:
    token = _SYNC_DISABLED.set(True)
    try:
        yield
    finally:
        _SYNC_DISABLED.reset(token)


def _sync_session_changes(session: Session) -> None:
    if _SYNC_DISABLED.get() or _client is None:
        return
    pending = session.info.setdefault("_cloudbase_pending_changes", {"upsert": {}, "delete": {}})
    # Capture membership before flush. SQLAlchemy removes ``new`` and
    # ``deleted`` instances from those identity sets during the flush.
    for item in session.new:
        pending["upsert"][id(item)] = item
    for item in session.dirty:
        if session.is_modified(item, include_collections=False):
            pending["upsert"][id(item)] = item
    for item in session.deleted:
        pending["delete"][id(item)] = item
    # Flush must happen before inspecting objects so defaults such as timestamps
    # and generated relationships are present in the outgoing row.
    session.flush()
    new_and_dirty = sorted(
        pending["upsert"].values(),
        key=lambda item: _UPSERT_ORDER.get(type(item).__tablename__, 99),
    )
    deleted = sorted(
        pending["delete"].values(),
        key=lambda item: _UPSERT_ORDER.get(type(item).__tablename__, 99),
        reverse=True,
    )
    client = get_client()
    for item in new_and_dirty:
        row = _row_from_model(item)
        if row is None:
            continue
        client.upsert_row(row.table, _primary_key(type(item)), row.data[_primary_key(type(item))], row.data)
    # SQLAlchemy may mark a parent and its cascade children deleted together.
    # Delete children first so the same ordering works with strict CloudBase
    # foreign-key enforcement and with the ON DELETE CASCADE migration.
    deleted_rows = [(item, _row_from_model(item)) for item in deleted]
    deleted_rows.sort(key=lambda pair: 0 if pair[1] and pair[1].table in {"task_events", "todos", "artifacts", "tool_calls", "jobs", "agent_steps"} else 1)
    for item, row in deleted_rows:
        if row is None:
            continue
        client.delete_row(row.table, _primary_key(type(item)), row.data[_primary_key(type(item))])
    session.info.pop("_cloudbase_pending_changes", None)


def install_session_sync() -> None:
    """Install once, allowing all existing service functions to keep Session APIs."""
    marker = "_cloudbase_sync_installed"
    if getattr(Session, marker, False):
        return

    @event.listens_for(Session, "before_commit")
    def _before_commit(session: Session) -> None:
        _sync_session_changes(session)

    @event.listens_for(Session, "after_flush")
    def _after_flush(session: Session, _: Any) -> None:
        if _SYNC_DISABLED.get() or _client is None:
            return
        pending = session.info.setdefault("_cloudbase_pending_changes", {"upsert": {}, "delete": {}})
        for item in session.new:
            pending["upsert"][id(item)] = item
        for item in session.dirty:
            if session.is_modified(item, include_collections=False):
                pending["upsert"][id(item)] = item
        for item in session.deleted:
            pending["delete"][id(item)] = item

    @event.listens_for(Session, "after_rollback")
    def _after_rollback(session: Session) -> None:
        session.info.pop("_cloudbase_pending_changes", None)

    setattr(Session, marker, True)


def hydrate_session_database(engine: Any, session_factory: Any | None = None) -> None:
    """Rebuild local ORM cache from CloudBase rows after a container restart."""
    from teacher_backend.models import AgentRun, AgentStep, Artifact, Job, KnowledgeEntry, Task, TaskEvent, ToolCall, ToolDefinition, Todo
    from teacher_backend.db import Base, SessionLocal

    if session_factory is None:
        session_factory = SessionLocal

    Base.metadata.create_all(bind=engine)
    models = [ToolDefinition, KnowledgeEntry, Task, AgentRun, AgentStep, TaskEvent, Todo, Job, ToolCall, Artifact]
    with session_factory() as session, disabled():
        # CloudBase is authoritative. Clear the short-lived local cache first
        # so a recycled container cannot serve tasks that were created before a
        # switch from SQLite to CloudBase.
        for model in reversed(models):
            session.execute(delete(model))
        session.commit()
        # Parent rows first, preserving IDs and foreign-key relationships.
        for model in models:
            rows = get_client().list_rows(model.__tablename__)
            if not rows:
                continue
            pk = _primary_key(model)
            for raw in rows:
                values = _coerce_row(model, raw)
                identity = values.get(pk)
                if identity is None:
                    continue
                current = session.get(model, identity)
                if current is None:
                    session.add(model(**values))
                else:
                    for key, value in values.items():
                        if key != pk and hasattr(current, key):
                            setattr(current, key, value)
        session.commit()


def _coerce_row(model: type, raw: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for column in sa_inspect(model).columns:
        if column.key not in raw:
            continue
        value = raw[column.key]
        if column.type.__class__.__name__ == "DateTime":
            value = _parse_datetime(value)
        elif column.type.__class__.__name__ in {"Text", "String"} and isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        values[column.key] = value
    return values


def models_to_migration() -> Iterable[str]:
    """Yield model table names for diagnostics and tests."""
    from teacher_backend.models import AgentRun, AgentStep, Artifact, Job, KnowledgeEntry, Task, TaskEvent, ToolCall, ToolDefinition, Todo

    yield from (item.__tablename__ for item in (Task, TaskEvent, Todo, Artifact, ToolDefinition, ToolCall, KnowledgeEntry, Job, AgentRun, AgentStep))
