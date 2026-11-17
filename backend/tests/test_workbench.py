from __future__ import annotations

from pathlib import Path

from app.main import create_app
from fastapi.testclient import TestClient


VALUES = {
    "target_user": "第一次接单的自由职业者",
    "problem": "客户需求分散且难以估价",
    "desired_outcome": "快速生成可发送的报价单",
    "current_workaround": "手工复制到表格",
    "constraints": "只做本地单用户，不接支付",
    "intent_correction": "目标用户先聚焦第一次接单的自由职业者",
    "plan_correction": "先做网页，不做登录",
}


def create_pending(client: TestClient) -> dict:
    response = client.post("/api/v1/projects", json={"idea": "做一个帮助自由职业者整理客户需求的工具"})
    assert response.status_code == 201
    return response.json()["project"]


def complete_discovery(client: TestClient, project: dict) -> dict:
    for _ in range(5):
        if project["status"] != "needs_discovery":
            break
        answers = {question["id"]: VALUES[question["id"]] for question in project["questions"]}
        response = client.post(f"/api/v1/projects/{project['id']}/discovery-answers", json={"answers": answers})
        assert response.status_code == 200
        project = response.json()["project"]
    assert project["status"] == "needs_intent_confirmation"
    return project


def complete_to_backend_verified(client: TestClient, project: dict) -> dict:
    project = complete_discovery(client, project)
    response = client.post(f"/api/v1/projects/{project['id']}/confirm-intent", json={"confirmed": True})
    assert response.status_code == 200
    project = response.json()["project"]
    assert project["status"] == "needs_plan_confirmation"
    response = client.post(f"/api/v1/projects/{project['id']}/confirm-plan", json={"confirmed": True})
    assert response.status_code == 200
    project = response.json()["project"]
    assert project["status"] == "backend_verified"
    return project


def test_health_and_static_home(client: TestClient):
    assert client.get("/health").json() == {"status": "ok", "mode": "mock+real-adapter"}
    home = client.get("/")
    assert home.status_code == 200
    assert "把一个想法" in home.text
    assert client.get("/app.js").status_code == 200
    assert client.get("/app.css").status_code == 200


def test_create_requires_non_blank_idea(client: TestClient):
    response = client.post("/api/v1/projects", json={"idea": "  "})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_discovery_is_dynamic_and_can_take_multiple_rounds(client: TestClient):
    project = create_pending(client)
    assert project["status"] == "needs_discovery"
    assert 1 <= len(project["questions"]) <= 3
    first_ids = {question["id"] for question in project["questions"]}
    response = client.post(
        f"/api/v1/projects/{project['id']}/answers",
        json={"answers": {question_id: VALUES[question_id] for question_id in first_ids}},
    )
    assert response.status_code == 200
    next_project = response.json()["project"]
    assert next_project["status"] == "needs_discovery"
    assert len(next_project["questions"]) < len(project["questions"])
    next_ids = {question["id"] for question in next_project["questions"]}
    response = client.post(
        f"/api/v1/projects/{project['id']}/discovery-answers",
        json={"answers": {question_id: VALUES[question_id] for question_id in next_ids}},
    )
    assert response.status_code == 200
    assert response.json()["project"]["status"] == "needs_intent_confirmation"


def test_full_fusion_lifecycle_requires_confirmations(client: TestClient):
    project = complete_to_backend_verified(client, create_pending(client))
    assert project["backend"]["api_contract"]
    assert project["backend"]["test_plan"]
    assert client.get(f"/api/v1/projects/{project['id']}/preview").status_code == 409
    acceptance = client.post(f"/api/v1/projects/{project['id']}/acceptance", json={"passed": True, "note": "本地验收"})
    assert acceptance.status_code == 200
    accepted = acceptance.json()["project"]
    assert accepted["status"] == "preview_ready"
    assert accepted["confirmations"]["acceptance"] is True
    preview = client.get(f"/api/v1/projects/{project['id']}/preview").json()["preview"]
    assert preview["badge"] == "mock方案 · 本地运行时预览"
    assert preview["status"] == "unverified"
    assert client.get(preview["url"].replace("http://testserver", "")).status_code == 200


def test_acceptance_cannot_skip_requirements_or_plan(client: TestClient):
    project = create_pending(client)
    response = client.post(f"/api/v1/projects/{project['id']}/acceptance", json={"passed": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "backend_not_ready"


def test_trial_feedback_is_required_before_iteration(client: TestClient):
    project = complete_to_backend_verified(client, create_pending(client))
    accepted = client.post(f"/api/v1/projects/{project['id']}/acceptance", json={"passed": True}).json()["project"]
    direct = client.post(f"/api/v1/projects/{accepted['id']}/iterations", json={"change_request": "绕过试用直接迭代"})
    assert direct.status_code == 409
    not_verified = client.post(f"/api/v1/projects/{accepted['id']}/trial")
    assert not_verified.status_code == 409
    verified = client.post(f"/api/v1/projects/{accepted['id']}/preview/verify")
    assert verified.status_code == 200
    started = client.post(f"/api/v1/projects/{accepted['id']}/trial")
    assert started.status_code == 200
    blocked = client.post(f"/api/v1/projects/{accepted['id']}/iterations", json={"change_request": "没有反馈就迭代"})
    assert blocked.status_code == 409
    feedback = client.post(f"/api/v1/projects/{accepted['id']}/trial-feedback", json={"feedback": "核心流程可以继续", "outcome": "works"})
    assert feedback.status_code == 200
    next_version = client.post(f"/api/v1/projects/{accepted['id']}/iterations", json={"change_request": "新增导入入口"})
    assert next_version.status_code == 200
    assert next_version.json()["project"]["version"] == 2


def test_answers_reject_unknown_question_but_allow_partial_round(client: TestClient):
    project = create_pending(client)
    unknown = client.post(
        f"/api/v1/projects/{project['id']}/answers",
        json={"answers": {"not_a_real_question": "越界"}},
    )
    assert unknown.status_code == 422
    assert "未知问题" in unknown.json()["error"]["message"]
    partial = client.post(
        f"/api/v1/projects/{project['id']}/answers",
        json={"answers": {project["questions"][0]["id"]: "个人创作者"}},
    )
    assert partial.status_code == 200
    assert partial.json()["project"]["status"] == "needs_discovery"


def test_rejected_intent_returns_to_clarification(client: TestClient):
    project = complete_discovery(client, create_pending(client))
    response = client.post(f"/api/v1/projects/{project['id']}/confirm-intent", json={"confirmed": False, "note": "用户要调整目标"})
    assert response.status_code == 200
    correction = response.json()["project"]
    assert correction["status"] == "needs_discovery"
    assert correction["questions"][0]["id"] == "intent_correction"
    response = client.post(f"/api/v1/projects/{project['id']}/answers", json={"answers": {"intent_correction": VALUES["intent_correction"]}})
    assert response.status_code == 200
    assert response.json()["project"]["status"] == "needs_intent_confirmation"


def test_project_persists_after_new_app_instance(tmp_path: Path):
    store_path = tmp_path / "restart" / "workbench.json"
    first_app = create_app(store_path, require_model=False)
    with TestClient(first_app) as first_client:
        project = complete_to_backend_verified(first_client, create_pending(first_client))
        accepted = first_client.post(f"/api/v1/projects/{project['id']}/acceptance", json={"passed": True})
        assert accepted.status_code == 200
        verified = first_client.post(f"/api/v1/projects/{project['id']}/preview/verify")
        assert verified.status_code == 200
        assert verified.json()["preview"]["status"] == "verified"

    second_app = create_app(store_path, require_model=False)
    with TestClient(second_app) as second_client:
        restored = second_client.get(f"/api/v1/projects/{project['id']}")
        runtime = second_client.get(f"/api/v1/projects/{project['id']}/preview")
        assert runtime.status_code == 200
        runtime_payload = runtime.json()["preview"]
        assert runtime_payload["status"] == "verified"
        assert second_client.get(runtime_payload["url"].replace("http://testserver", "")).status_code == 200
        assert second_client.get(runtime_payload["health_url"].replace("http://testserver", "")).json()["status"] == "ok"
        action = second_client.post(runtime_payload["action_url"].replace("http://testserver", ""), json={"input": "客户需要一份报价单"})
        assert action.status_code == 200
        assert action.json()["result"]["title"]
    assert restored.status_code == 200
    assert restored.json()["project"]["status"] == "preview_ready"
    assert restored.json()["project"]["backend"]["status"] == "verified"


def test_model_status_never_exposes_key(client, monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "secret-value")
    response = client.get("/api/v1/model/status")
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert "secret-value" not in response.text


def test_real_plan_without_key_returns_structured_error(client, monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    project = complete_discovery(client, create_pending(client))
    intent = client.post(f"/api/v1/projects/{project['id']}/confirm-intent", json={"confirmed": True})
    assert intent.status_code == 200
    response = client.post(f"/api/v1/projects/{project['id']}/real-plan", json={"answers": project["answers"]})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "model_not_configured"
    saved = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    assert saved["tasks"][-1]["status"] == "failed"
