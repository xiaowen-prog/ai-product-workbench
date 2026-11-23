from io import BytesIO
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.models import BackendBuild
from app.services import teacher_engine
from app.services.kit_development import advance_kit
from app.services.workbench import _limit_plan_questions


def setup_workflow(tmp_path, monkeypatch, score=86, pending=False, severity=None, review_ok=True):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "kit.sh").write_text(
        '''#!/usr/bin/env bash
set -eu
if [ "$1" = "任务" ]; then
  test -f "projects/$2/docs/PRD/PRD.md"
  mkdir -p "projects/$2/docs"
  printf '阶段=阶段0\\n状态=做中\\n' > "projects/$2/docs/流程状态.txt"
  printf '# 本阶段任务\\n\\n请完成阶段 0 的 PRD 体检。\\n' > "projects/$2/docs/本阶段任务.md"
  exit 0
fi
if [ "$1" = "自检" ]; then exit 0; fi
if [ "$1" = "通过" ]; then
  printf '阶段=完成\n状态=待开工\n' > "projects/$2/docs/流程状态.txt"
  exit 0
fi
exit 1
''', encoding="utf-8"
    )
    (kit / "verify.sh").touch()
    monkeypatch.setenv("IDEA_TO_LAUNCH_KIT_ROOT", str(kit))

    def intake_chat(project, messages):
        user_messages = [message.text for message in messages if message.role == "user"]
        if len(user_messages) <= 1:
            return [{"type": "text", "delta": "先确认目标用户和核心结果。"}, {"type": "suggestions", "items": ["个人编辑", "信息够了，帮我整理"]}]
        return [
            {"type": "text", "delta": "好，我把你说的整理成了一份需求草稿。"},
            {"type": "tool", "name": "confirm_product", "args": {"name": "播客提纲", "idea": "单人编辑粘贴一份访谈文本，经人工确认后导出。"}},
        ]

    def answer_chat(project, messages):
        last = messages[-1].text if messages else ""
        if last in {"跳过这题", "帮我想想"}:
            return [{"type": "text", "delta": "跳过。\n\n第 1 / 1 题：如何核对引用？"}, {"type": "suggestions", "items": ["跳过这题", "先保存已回答的"]}]
        return [
            {"type": "text", "delta": "都问完了。这是你的回答，确认后写回需求文档并重新推导方案："},
            {"type": "tool", "name": "confirm_answers", "args": {"answers": [{"question": "如何判断引用来自访谈？", "answer": last}] }},
        ]

    def plan(project, workspace_root):
        workspace = workspace_root / project.id / "test"
        workspace.mkdir(parents=True, exist_ok=True)
        for name, text in {"PRD.md": project.workshop.draft, "方案.md": "已审核的方案", "plan.json": "{}", "迭代记录.md": "V1"}.items():
            (workspace / name).write_text(text, encoding="utf-8")
        handoff = workspace / "handoff.zip"
        with ZipFile(handoff, "w") as archive:
            archive.write(workspace / "PRD.md", "PRD.md")
        return {
            "data": {"title": "播客提纲", "one_liner": "整理访谈", "components": [], "design": {},
                     "review": {"score": score, "ok": review_ok, "issues": [{"severity": severity}] if severity else []}},
            "users": (
                [{"text": "如何判断引用来自访谈？", "original": "如何核对引用？"}]
                if pending and not project.workshop.decisions
                else ([{"text": "改写后的引用核对问题？", "original": "如何核对引用？"}] if pending else [])
            ),
            "workspace": str(workspace), "document": str(workspace / "方案.md"), "handoff": str(handoff), "filename": "交接包.zip",
        }

    monkeypatch.setattr(teacher_engine, "intake_chat", intake_chat)
    monkeypatch.setattr(teacher_engine, "answer_chat", answer_chat)
    monkeypatch.setattr(teacher_engine, "generate_plan", plan)
    client = TestClient(create_app(tmp_path / "workbench.json", require_model=False))
    created = client.post("/api/v1/projects", json={"idea": "帮编辑整理一段播客访谈"})
    assert created.status_code == 201
    path = "/api/v1/projects/" + created.json()["project"]["id"]
    assert created.json()["project"]["questions"] == []
    assert client.post(path + "/workshop-resume").status_code == 200
    project = client.get(path).json()["project"]
    messages = project["workshop"]["transcript"] + [{"role": "user", "text": "编辑人工确认"}]
    assert client.post(path + "/workshop-chat", json={"stage": "intake", "messages": messages}).status_code == 200
    assert client.post(path + "/confirm-intent", json={"confirmed": True}).status_code == 200
    return client, path, kit


@pytest.mark.parametrize("score,severity", [(78, None), (90, "high")])
def test_teacher_review_blocks_development(tmp_path, monkeypatch, score, severity):
    client, path, kit = setup_workflow(tmp_path, monkeypatch, score=score, severity=severity)
    project = client.get(path).json()["project"]
    assert project["plan"]["review_score"] == score
    assert client.post(path + "/confirm-plan", json={"confirmed": True}).status_code == 409
    assert client.post(path + "/build").status_code == 422
    assert not (kit / "projects").exists()


def test_plan_question_batch_is_capped_at_eighteen():
    questions = [f"方案待确认问题 {index}" for index in range(21)]
    assert _limit_plan_questions([], questions) == questions[:18]
    review = ["审稿追问：用户边界", "审稿追问：验收标准"]
    assert _limit_plan_questions(review, questions)[:2] == review
    assert len(_limit_plan_questions(review, questions)) == 18


def test_review_score_and_high_severity_are_the_plan_gate(tmp_path, monkeypatch):
    client, path, kit = setup_workflow(tmp_path, monkeypatch, score=86, severity="medium", review_ok=False)
    confirmed = client.post(path + "/confirm-plan", json={"confirmed": True})
    assert confirmed.status_code == 200
    assert confirmed.json()["project"]["status"] == "backend_building"
    assert (kit / "projects").exists()


def test_skipping_keeps_question_unresolved_until_replan(tmp_path, monkeypatch):
    client, path, _ = setup_workflow(tmp_path, monkeypatch, pending=True)
    project = client.get(path).json()["project"]
    questions = project["workshop"]["answer_questions"]
    assert questions
    messages = project["workshop"]["answer_transcript"] + [{"role": "user", "text": "跳过这题"}]
    skipped = client.post(path + "/workshop-chat", json={"stage": "answers", "messages": messages})
    assert skipped.status_code == 200
    assert skipped.json()["project"]["questions"] == []
    assert client.post(path + "/workshop-chat/save", json={"answers": []}).status_code == 409
    assert client.post(path + "/replan").status_code == 200
    replanned = client.get(path).json()["project"]
    assert replanned["workshop"]["answer_questions"]
    assert client.post(path + "/confirm-plan", json={"confirmed": True}).status_code == 409


def test_low_review_creates_followup_chat_question(tmp_path, monkeypatch):
    client, path, _ = setup_workflow(tmp_path, monkeypatch, score=78)
    project = client.get(path).json()["project"]
    assert project["workshop"]["answer_questions"]
    assert project["workshop"]["answer_questions"][0].startswith("审稿追问：")
    assert client.post(path + "/confirm-plan", json={"confirmed": True}).status_code == 409


def test_replan_after_answered_batch_only_keeps_review_gap_questions(tmp_path, monkeypatch):
    client, path, _ = setup_workflow(tmp_path, monkeypatch, score=78, pending=True)
    project = client.get(path).json()["project"]
    question = project["workshop"]["answer_questions"][0]
    messages = project["workshop"]["answer_transcript"] + [{"role": "user", "text": "逐条附原文位置"}]
    answered = client.post(path + "/workshop-chat", json={"stage": "answers", "messages": messages})
    draft = answered.json()["project"]["workshop"]["answer_draft"]
    assert draft and draft[0]["question"] == question
    saved = client.post(path + "/workshop-chat/save", json={"answers": draft})
    assert saved.status_code == 200
    follow_up = saved.json()["project"]["workshop"]["answer_questions"]
    assert follow_up == ["审稿追问：请补充一条会改变方案判断的事实、边界或验收标准。"]


def test_teacher_handoff_requires_answers_review_and_explicit_confirmation(tmp_path, monkeypatch):
    client, path, kit = setup_workflow(tmp_path, monkeypatch, pending=True)
    project = client.get(path).json()["project"]
    assert client.post(path + "/confirm-plan", json={"confirmed": True}).status_code == 409
    assert client.get(path + "/handoff").status_code == 404
    question = project["workshop"]["answer_questions"][0]
    messages = project["workshop"]["answer_transcript"] + [{"role": "user", "text": "逐条附原文位置"}]
    answered = client.post(path + "/workshop-chat", json={"stage": "answers", "messages": messages})
    assert answered.status_code == 200
    draft = answered.json()["project"]["workshop"]["answer_draft"]
    assert draft and draft[0]["question"] == question
    assert client.post(path + "/workshop-chat/save", json={"answers": draft}).status_code == 200
    project = client.post(path + "/confirm-plan", json={"confirmed": True}).json()["project"]
    assert project["backend"]["status"] == "stage_task_ready"
    kit_prd = kit / "projects" / project["backend"]["launch_project"] / "docs" / "PRD" / "PRD.md"
    with ZipFile(BytesIO(client.get(path + "/handoff").content)) as archive:
        assert kit_prd.read_bytes() == archive.read("PRD.md")
    assert client.get(path).json()["project"]["backend"]["launch_project"] == project["backend"]["launch_project"]
    assert client.post(path + "/acceptance", json={"passed": True}).status_code == 409
    assert client.post(path + "/preview/verify").status_code == 409


def test_external_kit_stage_requires_self_check_and_acceptance(tmp_path, monkeypatch):
    client, path, kit = setup_workflow(tmp_path, monkeypatch)
    project = client.post(path + "/confirm-plan", json={"confirmed": True}).json()["project"]
    assert project["status"] == "backend_building"
    waiting = client.post(path + "/development/verify")
    assert waiting.status_code == 409

    built = client.post(path + "/build")
    assert built.status_code == 200
    backend = built.json()["project"]["backend"]
    assert backend["status"] == "awaiting_external_coding"
    assert backend["execution_mode"] == "original_kit"
    assert backend["kit_stage"] == "阶段0"
    assert backend["kit_status"] == "做中"
    assert built.json()["development"]["run_status"] == "external_tool_required"

    checked = client.post(path + "/development/verify")
    assert checked.status_code == 200
    assert checked.json()["verification"]["ok"] is True
    assert checked.json()["project"]["backend"]["kit_status"] == "passed"

    accepted = client.post(path + "/development/accept", json={"passed": True, "next_stage": "阶段1"})
    assert accepted.status_code == 200
    assert accepted.json()["stage"]["stage"] == "完成"
    assert accepted.json()["project"]["backend"]["kit_status"] == "completed"
    assert accepted.json()["project"]["status"] == "backend_verified"


def test_handoff_rejects_kit_that_does_not_materialize_stage_task(tmp_path, monkeypatch):
    client, path, kit = setup_workflow(tmp_path, monkeypatch)
    (kit / "kit.sh").write_text(
        "#!/usr/bin/env bash\nset -eu\nif [ \"$1\" = \"任务\" ]; then exit 0; fi\nexit 1\n",
        encoding="utf-8",
    )
    (kit / "kit.sh").chmod(0o755)

    response = client.post(path + "/confirm-plan", json={"confirmed": True})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "launch_kit_task_missing"


def test_kit_advance_generates_the_next_stage_task(tmp_path):
    kit = tmp_path / "kit"
    product = "demo"
    (kit / "projects" / product / "docs").mkdir(parents=True)
    (kit / "projects" / product / "docs" / "流程状态.txt").write_text("阶段=阶段0\n状态=等验收\n", encoding="utf-8")
    (kit / "projects" / product / "docs" / "本阶段任务.md").write_text("# 阶段0任务\n", encoding="utf-8")
    (kit / "kit.sh").write_text(
        '''#!/usr/bin/env bash
set -eu
if [ "$1" = "通过" ]; then
  printf '阶段=阶段1\n状态=待开工\n' > "projects/$2/docs/流程状态.txt"
  exit 0
fi
if [ "$1" = "任务" ]; then
  printf '# 阶段1任务\n' > "projects/$2/docs/本阶段任务.md"
  printf '阶段=阶段1\n状态=做中\n' > "projects/$2/docs/流程状态.txt"
  exit 0
fi
exit 1
''', encoding="utf-8"
    )
    (kit / "kit.sh").chmod(0o755)
    (kit / "verify.sh").touch()

    backend = BackendBuild(status="kit_self_check_passed", launch_project=product, kit_stage="阶段0", kit_status="passed")
    result = advance_kit(backend, kit, next_stage="阶段1")
    assert result["ok"] is True
    assert result["stage"] == "阶段1"
    assert result["status"] == "做中"
    assert result["task"] == "# 阶段1任务"


def test_launch_workbench_keeps_teacher_swagger_api(tmp_path):
    client = TestClient(create_app(tmp_path / "workbench.json", require_model=False))
    assert client.get("/docs").status_code == 200
    schema = client.get("/openapi.json").json()
    assert schema["paths"]["/api/v1/tasks"]["post"]["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/TaskCreate"
    }
    assert "/api/v1/tasks/{task_id}/agent-runs/{run_id}/stream" in schema["paths"]
    assert client.post("/api/v1/tasks", json={}).json()["error"]["details"]


def test_new_project_has_no_legacy_question_list(tmp_path, monkeypatch):
    client = TestClient(create_app(tmp_path / "workbench.json", require_model=False))
    project = client.post("/api/v1/projects", json={"idea": "整理访谈"}).json()["project"]
    assert project["questions"] == []
    rejected = client.post(f"/api/v1/projects/{project['id']}/answers", json={"answers": {"target_user": "个人"}})
    assert rejected.status_code == 409
    monkeypatch.setattr(teacher_engine, "intake_chat", lambda project, messages: [{"type": "text", "delta": "老师的第一道动态问题"}, {"type": "suggestions", "items": ["信息够了，帮我整理"]}])
    resumed = client.post(f"/api/v1/projects/{project['id']}/workshop-resume")
    assert resumed.status_code == 200
    assert resumed.json()["project"]["questions"] == []
    assert resumed.json()["project"]["workshop"]["transcript"][-1]["text"] == "老师的第一道动态问题"


def test_legacy_questions_are_removed_on_load(tmp_path):
    path = tmp_path / "workbench.json"
    path.write_text(
        '{"schema_version": 2, "projects": [{"id": "p_old", "idea": "旧项目", '
        '"status": "needs_discovery", "questions": [{"id": "target_user", "text": "旧题", '
        '"hint": "旧题", "options": []}], "created_at": "2026-11-21T00:00:00Z", '
        '"updated_at": "2026-11-21T00:00:00Z"}]}',
        encoding="utf-8",
    )
    client = TestClient(create_app(path, require_model=False))
    project = client.get("/api/v1/projects/p_old").json()["project"]
    assert project["questions"] == []
