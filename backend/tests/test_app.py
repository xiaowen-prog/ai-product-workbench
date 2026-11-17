import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def test_project_flow_persists_and_creates_iteration(tmp_path: Path):
    data = tmp_path / "projects.json"
    client = TestClient(create_app(data, require_model=False))

    created = client.post("/api/v1/projects", json={"idea": "做一个整理访谈的工具"})
    assert created.status_code == 201
    project = created.json()["project"]
    assert project["status"] == "needs_discovery"

    answers = {
        "target_user": "个人创作者",
        "problem": "记录很多",
        "desired_outcome": "得到方案",
        "current_workaround": "手工整理",
    }
    response = client.post(f"/api/v1/projects/{project['id']}/answers", json={"answers": answers})
    assert response.status_code == 200
    project = response.json()["project"]
    assert project["status"] == "needs_intent_confirmation"

    response = client.post(f"/api/v1/projects/{project['id']}/confirm-intent", json={"confirmed": True})
    assert response.json()["project"]["status"] == "needs_plan_confirmation"
    response = client.post(f"/api/v1/projects/{project['id']}/confirm-plan", json={"confirmed": True})
    assert response.json()["project"]["status"] == "backend_verified"
    response = client.post(f"/api/v1/projects/{project['id']}/acceptance", json={"passed": True})
    assert response.json()["project"]["status"] == "preview_ready"
    runtime = client.get(f"/api/v1/projects/{project['id']}/preview")
    assert runtime.status_code == 200
    preview = runtime.json()["preview"]
    assert preview["kind"] == "runtime"
    assert client.get(preview["url"].replace("http://testserver", "")).status_code == 200
    assert client.get(preview["health_url"].replace("http://testserver", "")).json()["status"] == "ok"
    action = client.post(preview["action_url"].replace("http://testserver", ""), json={"input": "客户需要报价单\n两周交付"})
    assert action.status_code == 200
    assert action.json()["result"]["deliverables"]
    verified = client.post(f"/api/v1/projects/{project['id']}/preview/verify")
    assert verified.status_code == 200
    assert verified.json()["preview"]["status"] == "verified"
    assert {check["status"] for check in verified.json()["preview"]["checks"]} == {"passed"}

    trial = client.post(f"/api/v1/projects/{project['id']}/trial")
    assert trial.status_code == 200
    assert trial.json()["project"]["status"] == "trial"
    feedback = client.post(
        f"/api/v1/projects/{project['id']}/trial-feedback",
        json={"feedback": "导入入口的方向清楚，可以继续下一版", "outcome": "works"},
    )
    assert feedback.status_code == 200
    assert feedback.json()["project"]["trial"]["feedback"]
    reloaded = TestClient(create_app(data, require_model=False))
    persisted = reloaded.get(f"/api/v1/projects/{project['id']}").json()["project"]
    assert persisted["status"] == "trial"
    assert persisted["trial"]["feedback"] == ["导入入口的方向清楚，可以继续下一版"]

    next_response = client.post(f"/api/v1/projects/{project['id']}/iterations", json={"change_request": "新增导入入口"})
    assert next_response.status_code == 200
    next_project = next_response.json()["project"]
    assert next_project["version"] == 2
    assert next_project["parent_id"] == project["id"]
    assert next_project["status"] == "needs_discovery"
    assert next_project["questions"][0]["id"] == "affected_area"
    assert data.exists()
    assert json.loads(data.read_text(encoding="utf-8"))["projects"][0]["id"] == next_project["id"]


def test_compatibility_routes_keep_user_in_confirmation_stages(client: TestClient):
    created = client.post("/api/v1/projects", json={"idea": "做一个整理访谈的工具"})
    project = created.json()["project"]
    answers = {
        question["id"]: {
            "target_user": "个人创作者",
            "problem": "记录很多",
            "desired_outcome": "得到方案",
            "current_workaround": "手工整理",
        }[question["id"]]
        for question in project["questions"]
    }
    # Fill the remaining discovery questions in one request, as the UI does.
    answers.update({"problem": "记录很多", "desired_outcome": "得到方案", "current_workaround": "手工整理"})
    project = client.post(f"/api/v1/projects/{project['id']}/answers", json={"answers": answers}).json()["project"]
    assert project["status"] == "needs_intent_confirmation"
    supplement = client.post(f"/api/v1/projects/{project['id']}/supplement", json={"text": "必须支持导入原始记录"})
    assert supplement.status_code == 200
    assert supplement.json()["project"]["status"] == "needs_intent_confirmation"
    project = client.post(f"/api/v1/projects/{project['id']}/confirm-intent", json={"confirmed": True}).json()["project"]
    rejected_plan = client.post(f"/api/v1/projects/{project['id']}/confirm-plan", json={"confirmed": False}).json()["project"]
    assert rejected_plan["status"] == "needs_plan_confirmation"
    assert rejected_plan["plan_revision"]["status"] == "needs_input"
    modified = client.post(f"/api/v1/projects/{project['id']}/modify-plan", json={"note": "先做网页，不做登录"})
    assert modified.status_code == 200
    assert "先做网页" in modified.json()["project"]["plan"]["summary"]
    assert modified.json()["project"]["plan_revision"]["status"] == "applied"
    confirmed = client.post(f"/api/v1/projects/{project['id']}/confirm-plan", json={"confirmed": True}).json()["project"]
    assert confirmed["status"] == "backend_verified"
    blocked = client.post(f"/api/v1/projects/{project['id']}/iterations", json={"change_request": "过早迭代"})
    assert blocked.status_code == 409


def test_project_creation_requires_model_key_when_gate_enabled(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    client = TestClient(create_app(tmp_path / "gated.json", require_model=True))
    status = client.get("/api/v1/model/status")
    assert status.json()["required"] is True
    assert status.json()["can_build"] is False
    response = client.post("/api/v1/projects", json={"idea": "做一个整理访谈的工具"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "model_not_configured"

    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    allowed = client.post("/api/v1/projects", json={"idea": "做一个整理访谈的工具"})
    assert allowed.status_code == 201
