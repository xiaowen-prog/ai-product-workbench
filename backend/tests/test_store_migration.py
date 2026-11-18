from __future__ import annotations

import json
from pathlib import Path

from app.services.store import Store


def test_store_migrates_legacy_status_and_fields_once(tmp_path: Path):
    path = tmp_path / "workbench.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "projects": [
                    {
                        "id": "legacy-project",
                        "idea": "做一个整理访谈的工具",
                        "status": "plan_ready",
                        "round": 2,
                        "evidence": {
                            "problem": "访谈记录分散",
                            "desired_outcome": "得到一份摘要",
                            "facts": ["已有五次访谈"],
                            "red_flags": ["仍需人工验证"],
                        },
                        "engineering": {
                            "status": "verified",
                            "api": ["POST /projects"],
                            "tests": ["接口测试通过"],
                            "verification": ["数据可恢复"],
                        },
                        "created_at": "2026-11-16T00:00:00+00:00",
                        "updated_at": "2026-11-16T00:01:00+00:00",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    project = Store(path).get_project("legacy-project")

    assert project is not None
    assert project.status.value == "needs_plan_confirmation"
    assert project.discovery_round == 2
    assert project.discovery is not None
    assert project.discovery.problem == "访谈记录分散"
    assert project.discovery.evidence[0].text == "已有五次访谈"
    assert project.backend is not None
    assert project.backend.api_contract == ["POST /projects"]
    assert project.backend.test_plan == ["接口测试通过"]
    assert project.backend.checks == ["数据可恢复"]

    migrated = json.loads(path.read_text(encoding="utf-8"))
    assert migrated["schema_version"] == 2
    saved_project = migrated["projects"][0]
    assert "round" not in saved_project
    assert "engineering" not in saved_project
    assert saved_project["status"] == "needs_plan_confirmation"


def test_store_migrates_clarification_status(tmp_path: Path):
    path = tmp_path / "workbench.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "projects": [
                    {
                        "id": "clarification-project",
                        "idea": "做一个小工具",
                        "status": "needs_clarification",
                        "created_at": "2026-11-16T00:00:00+00:00",
                        "updated_at": "2026-11-16T00:00:00+00:00",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    project = Store(path).get_project("clarification-project")

    assert project is not None
    assert project.status.value == "needs_discovery"
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == 2
