from __future__ import annotations

import pytest
from contextlib import contextmanager

from app.services.teacher_engine import _RetryingMessages, _load_engine, _run_intake_agent


class _FlakyMessages:
    def __init__(self, failures: list[Exception]):
        self.failures = failures
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        return {"ok": True, "kwargs": kwargs}


def test_retryable_502_is_retried_and_then_succeeds(monkeypatch):
    messages = _FlakyMessages([RuntimeError("接口返回 502：upstream temporarily unavailable")])
    sleeps: list[float] = []
    monkeypatch.setattr("app.services.teacher_engine.time.sleep", sleeps.append)

    result = _RetryingMessages(messages, attempts=3).create(model="test")

    assert result["ok"] is True
    assert messages.calls == 2
    assert sleeps == [1.0]


def test_non_retryable_error_keeps_provider_detail():
    messages = _FlakyMessages([RuntimeError("接口返回 400：invalid schema")])

    with pytest.raises(RuntimeError, match="接口返回 400：invalid schema"):
        _RetryingMessages(messages, attempts=3).create(model="test")

    assert messages.calls == 1


def test_intake_agent_protocol_failure_gets_three_bounded_attempts(monkeypatch):
    _load_engine()
    from blueprint.agent import AgentFailed

    calls = {"count": 0, "agent_max_turns": []}

    @contextmanager
    def fake_runner(*, chat=False):
        assert chat is True
        yield object()

    def flaky_run(*args, **kwargs):
        calls["count"] += 1
        calls["agent_max_turns"].append(kwargs.get("agent_max_turns"))
        if calls["count"] < 3:
            raise AgentFailed("交卷连续 3 次不合格")
        return {"action": "ask", "question": "给谁用？", "suggestions": []}

    monkeypatch.setattr("app.services.teacher_engine._runner", fake_runner)
    monkeypatch.setattr("blueprint.intake_agent.run_intake_agent", flaky_run)

    result = _run_intake_agent("用户：我有一个想法", 0, False)

    assert result["action"] == "ask"
    assert calls["count"] == 3
    assert calls["agent_max_turns"] == [6, 6, 6]
