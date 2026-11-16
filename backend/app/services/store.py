from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock

from app.schemas.models import Project, StorePayload


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
                payload = json.loads(self.path.read_text(encoding="utf-8"))
                return StorePayload.model_validate(payload)
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
        payload = self.load()
        for index, existing in enumerate(payload.projects):
            if existing.id == project.id:
                payload.projects[index] = project
                break
        else:
            payload.projects.insert(0, project)
        self.save(payload)
        return project
