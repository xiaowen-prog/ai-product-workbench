from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Any

from app.schemas.models import Project, StorePayload


CURRENT_SCHEMA_VERSION = 2

_STATUS_MIGRATIONS = {
    "idea": "needs_discovery",
    "needs_clarification": "needs_discovery",
    "requirements_confirmed": "needs_plan_confirmation",
    "plan_draft": "needs_plan_confirmation",
    "plan_ready": "needs_plan_confirmation",
    "accepted": "preview_ready",
}


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    result: list[str] = []
    for item in values:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            text = str(item.get("text") or item.get("message") or item.get("label") or "").strip()
        else:
            text = str(item).strip()
        if text:
            result.append(text)
    return result


def _evidence_list(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    result: list[dict[str, str]] = []
    for item in values:
        if isinstance(item, dict):
            text = item.get("text") or item.get("message") or item.get("value")
            if text is None:
                text = ", ".join(f"{key}: {value}" for key, value in item.items() if key not in {"kind", "source", "confidence"})
            text = str(text).strip()
            if not text:
                continue
            result.append(
                {
                    "kind": str(item.get("kind") or "历史资料"),
                    "text": text,
                    "source": str(item.get("source") or "legacy"),
                    "confidence": str(item.get("confidence") or "imported"),
                }
            )
        else:
            text = str(item).strip()
            if text:
                result.append({"kind": "历史资料", "text": text, "source": "legacy", "confidence": "imported"})
    return result


def _migrate_backend(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    return {
        "status": str(value.get("status") or "pending"),
        **{key: value[key] for key in ("teacher_task_id", "teacher_run_id", "execution_mode", "launch_project", "kit_stage", "kit_status", "kit_task_path", "kit_task", "kit_last_output") if key in value},
        "api_contract": _string_list(value.get("api_contract", value.get("api"))),
        "data_model": _string_list(value.get("data_model", value.get("data_model_items"))),
        "test_plan": _string_list(value.get("test_plan", value.get("tests"))),
        "checks": _string_list(value.get("checks", value.get("verification"))),
        "acceptance": _string_list(value.get("acceptance")),
    }


def _migrate_discovery(value: Any, legacy_evidence: Any) -> Any:
    if not isinstance(value, dict):
        return value
    migrated = dict(value)
    migrated.setdefault("problem", "待确认")
    migrated.setdefault("desired_outcome", "待确认")
    migrated.setdefault("current_workaround", "待确认")
    migrated["evidence"] = _evidence_list(migrated.get("evidence", migrated.get("facts", legacy_evidence)))
    migrated["hypotheses"] = _string_list(migrated.get("hypotheses"))
    migrated["red_flags"] = _string_list(migrated.get("red_flags")) + _string_list(migrated.get("open_questions"))
    migrated.setdefault("recommendation", "继续澄清")
    migrated.pop("facts", None)
    migrated.pop("open_questions", None)
    return migrated


def _migrate_events(value: Any, fallback_at: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    events: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        event = dict(item)
        event["from_status"] = event.get("from_status", event.pop("from", "unknown"))
        event["to_status"] = event.get("to_status", event.pop("to", "unknown"))
        event.setdefault("at", fallback_at)
        event.setdefault("actor", "legacy")
        event.setdefault("input_version", 1)
        event.setdefault("output_version", event["input_version"])
        event["evidence"] = _string_list(event.get("evidence"))
        event["pending"] = _string_list(event.get("pending"))
        events.append(event)
    return events


def _migrate_project(project: Any) -> tuple[dict[str, Any], bool]:
    if not isinstance(project, dict):
        return project, False

    migrated = dict(project)
    changed = False

    status = str(migrated.get("status", "needs_discovery"))
    canonical_status = _STATUS_MIGRATIONS.get(status, status)
    if canonical_status != status:
        migrated["status"] = canonical_status
        changed = True
    if migrated.get("accepted") is True and canonical_status == "needs_discovery":
        migrated["status"] = "preview_ready"
        changed = True

    if "discovery_round" not in migrated and isinstance(migrated.get("round"), int):
        migrated["discovery_round"] = max(0, migrated["round"])
        changed = True
    if "round" in migrated:
        migrated.pop("round", None)
        changed = True

    legacy_evidence = migrated.get("evidence")
    if isinstance(legacy_evidence, dict):
        migrated["evidence"] = _evidence_list(legacy_evidence.get("evidence", legacy_evidence.get("facts")))
        changed = True
    else:
        normalized_evidence = _evidence_list(legacy_evidence)
        if normalized_evidence != legacy_evidence:
            migrated["evidence"] = normalized_evidence
            changed = True

    if "discovery" in migrated:
        normalized_discovery = _migrate_discovery(migrated.get("discovery"), legacy_evidence)
        if normalized_discovery != migrated.get("discovery"):
            migrated["discovery"] = normalized_discovery
            changed = True
    elif isinstance(legacy_evidence, dict):
        migrated["discovery"] = _migrate_discovery(legacy_evidence, legacy_evidence)
        changed = True

    if "backend" not in migrated and "engineering" in migrated:
        migrated["backend"] = _migrate_backend(migrated.get("engineering"))
        changed = True
    if "backend" in migrated:
        normalized_backend = _migrate_backend(migrated.get("backend"))
        if normalized_backend != migrated.get("backend"):
            migrated["backend"] = normalized_backend
            changed = True
    if "engineering" in migrated:
        migrated.pop("engineering", None)
        changed = True

    fallback_at = migrated.get("updated_at") or migrated.get("created_at")
    if "events" in migrated:
        normalized_events = _migrate_events(migrated.get("events"), fallback_at)
        if normalized_events != migrated.get("events"):
            migrated["events"] = normalized_events
            changed = True

    for legacy_key in ("accepted", "new_requirement_draft", "requirement_supplement"):
        if legacy_key in migrated:
            migrated.pop(legacy_key, None)
            changed = True

    return migrated, changed


def _migrate_payload(raw: Any) -> tuple[dict[str, Any], bool]:
    if not isinstance(raw, dict):
        raise ValueError("工作区数据格式不正确")
    schema_version = raw.get("schema_version", 1)
    if not isinstance(schema_version, int) or schema_version > CURRENT_SCHEMA_VERSION:
        raise ValueError("工作区数据版本高于当前运行时")
    projects = raw.get("projects", [])
    if not isinstance(projects, list):
        raise ValueError("工作区项目列表格式不正确")
    migrated_projects: list[Any] = []
    changed = schema_version != CURRENT_SCHEMA_VERSION
    for project in projects:
        migrated_project, project_changed = _migrate_project(project)
        migrated_projects.append(migrated_project)
        changed = changed or project_changed
    payload = dict(raw)
    payload["schema_version"] = CURRENT_SCHEMA_VERSION
    payload["projects"] = migrated_projects
    return payload, changed


class Store:
    """带 schema 版本和原子替换的本地 JSON repository。"""

    def __init__(self, path: Path):
        self.path = path
        self._lock = RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> StorePayload:
        with self._lock:
            if not self.path.exists():
                return StorePayload()
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                migrated_raw, migrated = _migrate_payload(raw)
                payload = StorePayload.model_validate(migrated_raw)
                for project in payload.projects:
                    if project.workshop is None and project.questions and project.status in {
                        "needs_discovery",
                        "needs_intent_confirmation",
                        "needs_plan_confirmation",
                    }:
                        # 历史版本的固定题不能继续进入老师流程。
                        # 保留已有 answers、intent 和 plan，重新从老师入口恢复。
                        project.questions = []
                        migrated = True
                if migrated:
                    self.save(payload)
                return payload
            except (OSError, ValueError) as exc:
                raise RuntimeError("本地工作区数据损坏，请保留文件后再恢复") from exc

    def save(self, payload: StorePayload) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix="workbench-", suffix=".json", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload.model_dump(mode="json"), handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, self.path)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)

    def list_projects(self) -> list[Project]:
        return self.load().projects

    def get_project(self, project_id: str) -> Project | None:
        return next((project for project in self.list_projects() if project.id == project_id), None)

    def upsert_project(self, project: Project) -> Project:
        with self._lock:
            payload = self.load()
            for index, existing in enumerate(payload.projects):
                if existing.id == project.id:
                    payload.projects[index] = project
                    break
            else:
                payload.projects.insert(0, project)
            self.save(payload)
        return project
