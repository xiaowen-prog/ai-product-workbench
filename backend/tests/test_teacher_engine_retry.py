from __future__ import annotations

import pytest

from app.services.teacher_engine import _RetryingMessages


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
