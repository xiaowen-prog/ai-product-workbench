from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def _verified_project(client: TestClient) -> dict:
    project = client.post("/api/v1/projects", json={"idea": "做一个整理访谈的工具"}).json()["project"]
    answers = {
        "target_user": "个人创作者",
        "problem": "记录很多",
        "desired_outcome": "得到方案",
        "current_workaround": "手工整理",
    }
    project = client.post(f"/api/v1/projects/{project['id']}/answers", json={"answers": answers}).json()["project"]
    project = client.post(f"/api/v1/projects/{project['id']}/confirm-intent", json={"confirmed": True}).json()["project"]
    project = client.post(f"/api/v1/projects/{project['id']}/confirm-plan", json={"confirmed": True}).json()["project"]
    project = client.post(f"/api/v1/projects/{project['id']}/acceptance", json={"passed": True}).json()["project"]
    return project


def test_runtime_health_exposes_verification_state(tmp_path):
    client = TestClient(create_app(tmp_path / "projects.json", require_model=False))
    project = _verified_project(client)
    preview = client.get(f"/api/v1/projects/{project['id']}/preview").json()["preview"]

    health = client.get(preview["health_url"].replace("http://testserver", ""))
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["preview_status"] == "unverified"
    assert health.json()["verified"] is False

    verified = client.post(f"/api/v1/projects/{project['id']}/preview/verify")
    assert verified.status_code == 200
    health = client.get(preview["health_url"].replace("http://testserver", ""))
    assert health.json()["preview_status"] == "verified"
    assert health.json()["verified"] is True
