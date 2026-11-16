from __future__ import annotations

import json
from dataclasses import replace

import httpx
import pytest

from app.core.config import ModelSettings
from app.services.model_client import ModelClient, ModelOutputError, ModelNotConfiguredError


VALID = {
    "title": "自由职业者报价助手",
    "summary": "帮助自由职业者把客户需求整理成报价单。",
    "target_user": "第一次接单的自由职业者",
    "goal": "快速产出一份可发送的报价单",
    "core_loop": "输入需求 → 提取范围 → 生成报价单 → 人工确认",
    "scope": ["需求整理", "报价单预览"],
    "acceptance": ["能看到需求摘要", "能看到报价单预览"],
    "constraints": ["首版本地单用户"],
    "risks": ["需求描述不完整时需要人工补充"],
    "user_journey": ["说出想法", "回答问题", "查看报价单"],
    "mvp_features": ["一句话输入", "需求整理", "报价单预览"],
    "generated_stack": ["FastAPI", "JSON"],
    "preview_label": "报价单预览已就绪",
    "open_questions": ["是否需要导出 PDF？"],
}


def settings(**kwargs) -> ModelSettings:
    base = ModelSettings(api_key="test-key", base_url="https://model.test/v1", model="test-model", timeout_seconds=1, max_retries=2)
    return replace(base, **kwargs)


def response(payload: dict, status_code: int = 200) -> httpx.Response:
    return httpx.Response(status_code, json=payload, request=httpx.Request("POST", "https://model.test/v1/chat/completions"))


def test_no_key_is_explicit(monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    client = ModelClient(settings=ModelSettings(api_key="", base_url="https://model.test/v1", model="test-model", timeout_seconds=1, max_retries=0))
    with pytest.raises(ModelNotConfiguredError) as error:
        client.generate_plan("做个工具", {"target_user": "个人", "core_action": "整理"})
    assert error.value.code == "model_not_configured"


def test_parses_json_code_fence(monkeypatch):
    payload = {"choices": [{"message": {"content": f"```json\n{json.dumps(VALID, ensure_ascii=False)}\n```"}}], "id": "req_1"}
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: response(payload))
    result, meta = ModelClient(settings=settings(max_retries=0)).generate_plan("做个工具", {"target_user": "个人", "core_action": "整理"})
    assert result.title == "自由职业者报价助手"
    assert meta.attempts == 1
    assert meta.request_id == "req_1"


def test_retries_transient_error_then_succeeds(monkeypatch):
    calls = []
    payload = {"choices": [{"message": {"content": json.dumps(VALID, ensure_ascii=False)}}]}

    def fake_post(*args, **kwargs):
        calls.append(kwargs)
        return response({"error": "busy"}, 503) if len(calls) == 1 else response(payload)

    monkeypatch.setattr(httpx, "post", fake_post)
    result, meta = ModelClient(settings=settings(max_retries=1)).generate_plan("做个工具", {"target_user": "个人", "core_action": "整理"})
    assert result.goal.startswith("快速")
    assert meta.attempts == 2
    assert len(calls) == 2
    assert calls[0]["headers"]["Authorization"] == "Bearer test-key"


def test_invalid_structured_output_is_rejected(monkeypatch):
    payload = {"choices": [{"message": {"content": json.dumps({"title": "缺字段"})}}]}
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: response(payload))
    with pytest.raises(ModelOutputError):
        ModelClient(settings=settings(max_retries=0)).generate_plan("做个工具", {"target_user": "个人", "core_action": "整理"})
