from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from app.services import preview_runtime, teacher_engine


class _Budget:
    def summary(self):
        return {"calls": 1}


class _Runner:
    model = "test-model"
    budget = _Budget()


class _Model:
    runner = _Runner()


def _project(tmp_path: Path):
    (tmp_path / "PRD.md").write_text("# PRD\n", encoding="utf-8")
    plan = SimpleNamespace(
        title="测试产品",
        summary="测试方案",
        teacher_plan={"design": {"system_prompt": "按方案处理"}},
        teacher_workspace_path=str(tmp_path),
    )
    return SimpleNamespace(id="p_test", plan=plan, idea="测试想法", preview=None)


def test_runtime_delegates_to_teacher_playground(tmp_path, monkeypatch):
    project = _project(tmp_path)

    @contextmanager
    def fake_model():
        yield _Runner(), _Model()

    monkeypatch.setattr(preview_runtime, "_play_model", fake_model)
    teacher_engine._load_engine()
    import blueprint.playground as playground

    monkeypatch.setattr(playground, "play_intro", lambda plan, ws, model: {"role": "用户", "scenarios": [], "fingerprint": "x"})
    monkeypatch.setattr(
        playground,
        "play_events",
        lambda plan, messages, prd, model: iter([
            {"type": "text", "delta": "老师回复"},
            {"type": "data", "name": "play_step", "data": {"wire": "工具步骤"}},
        ]),
    )

    result = preview_runtime.run_runtime(project, "真实请求")

    assert result["mode"] == "teacher_playground"
    assert result["summary"] == "老师回复"
    assert result["events"][1]["name"] == "play_step"
    assert result["deliverables"] == ["工具步骤"]


def test_preview_verification_uses_teacher_playground(tmp_path, monkeypatch):
    project = _project(tmp_path)
    monkeypatch.setattr(preview_runtime, "run_runtime", lambda project, text: {"summary": "老师回复", "model": "test-model"})

    artifact = preview_runtime.verify_runtime(project)

    assert artifact.status == "verified"
    assert [check.id for check in artifact.checks] == ["runtime_page", "health", "core_action"]
