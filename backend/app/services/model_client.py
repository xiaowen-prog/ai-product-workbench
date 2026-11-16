from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.core.config import ModelSettings, model_settings


class ModelClientError(Exception):
    code = "model_error"

    def __init__(self, message: str, *, attempts: int = 0, retryable: bool = False):
        super().__init__(message)
        self.message = message
        self.attempts = attempts
        self.retryable = retryable


class ModelNotConfiguredError(ModelClientError):
    code = "model_not_configured"


class ModelRequestError(ModelClientError):
    code = "model_unavailable"


class ModelOutputError(ModelClientError):
    code = "model_invalid_output"


class ModelPlanOutput(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    summary: str = Field(min_length=1, max_length=500)
    target_user: str = Field(min_length=1, max_length=160)
    goal: str = Field(min_length=1, max_length=300)
    core_loop: str = Field(min_length=1, max_length=300)
    scope: list[str] = Field(min_length=1, max_length=8)
    acceptance: list[str] = Field(min_length=1, max_length=8)
    constraints: list[str] = Field(min_length=1, max_length=8)
    risks: list[str] = Field(min_length=1, max_length=8)
    user_journey: list[str] = Field(min_length=1, max_length=8)
    mvp_features: list[str] = Field(min_length=1, max_length=10)
    generated_stack: list[str] = Field(min_length=1, max_length=8)
    preview_label: str = Field(min_length=1, max_length=80)
    open_questions: list[str] = Field(default_factory=list, max_length=8)


@dataclass(frozen=True)
class ModelCallMeta:
    provider: str
    model: str
    attempts: int
    duration_ms: int
    request_id: str | None = None
    usage: dict[str, int] | None = None


def _system_prompt() -> str:
    return """你是 AI 产品工作台的产品方案编译器。根据用户的一句话想法和经过需求发现阶段收集的全部回答，输出一个可执行的最小产品方案。回答数量不固定，必须尊重用户原话，不能自行补造事实。只返回一个 JSON 对象，不要 Markdown、不要解释、不要代码块。字段必须完整且使用中文：title, summary, target_user, goal, core_loop, scope, acceptance, constraints, risks, user_journey, mvp_features, generated_stack, preview_label, open_questions。scope、acceptance、constraints、risks、user_journey、mvp_features、generated_stack、open_questions 都是字符串数组。内容要具体、短、可验收；首版默认本地单用户，不自动发布、不自动外发。"""


def _user_prompt(idea: str, answers: dict[str, str]) -> str:
    return json.dumps({"idea": idea, "answers": answers}, ensure_ascii=False)


def _extract_content(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        raise ModelOutputError("模型没有返回可读取的方案内容")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ModelOutputError("模型返回的方案内容为空")
    return content.strip()


def _parse_json(content: str) -> ModelPlanOutput:
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    try:
        raw = json.loads(cleaned.strip())
        return ModelPlanOutput.model_validate(raw)
    except (json.JSONDecodeError, ValidationError, TypeError) as exc:
        raise ModelOutputError("模型输出不是符合约定的结构化方案") from exc


class ModelClient:
    def __init__(self, settings: ModelSettings | None = None):
        self.settings = settings or model_settings()

    @property
    def configured(self) -> bool:
        return bool(self.settings.api_key)

    def generate_plan(self, idea: str, answers: dict[str, str]) -> tuple[ModelPlanOutput, ModelCallMeta]:
        if not self.configured:
            raise ModelNotConfiguredError("后端尚未配置 MODEL_API_KEY")
        payload = {
            "model": self.settings.model,
            "messages": [
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": _user_prompt(idea, answers)},
            ],
            "temperature": 0.2,
        }
        headers = {"Authorization": f"Bearer {self.settings.api_key}", "Content-Type": "application/json"}
        attempts = 0
        started = time.perf_counter()
        last_error: ModelClientError | None = None
        for attempt in range(1, self.settings.max_retries + 2):
            attempts = attempt
            try:
                response = httpx.post(
                    f"{self.settings.base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                    timeout=self.settings.timeout_seconds,
                )
                if response.status_code in {429, 500, 502, 503, 504}:
                    raise ModelRequestError(f"模型暂时不可用（HTTP {response.status_code}）", attempts=attempt, retryable=True)
                if response.status_code >= 400:
                    raise ModelRequestError(f"模型请求被拒绝（HTTP {response.status_code}）", attempts=attempt)
                try:
                    data = response.json()
                except (ValueError, TypeError) as exc:
                    raise ModelOutputError("模型响应不是可读取的 JSON") from exc
                result = _parse_json(_extract_content(data))
                elapsed = int((time.perf_counter() - started) * 1000)
                usage = data.get("usage") if isinstance(data.get("usage"), dict) else None
                usage_clean = None
                if usage:
                    usage_clean = {key: int(value) for key, value in usage.items() if key in {"prompt_tokens", "completion_tokens", "total_tokens"} and isinstance(value, int)}
                return result, ModelCallMeta(
                    provider=self.settings.base_url,
                    model=self.settings.model,
                    attempts=attempt,
                    duration_ms=elapsed,
                    request_id=data.get("id") if isinstance(data.get("id"), str) else None,
                    usage=usage_clean,
                )
            except ModelOutputError as exc:
                last_error = exc
            except ModelRequestError as exc:
                last_error = exc
                if not exc.retryable:
                    break
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
                last_error = ModelRequestError("模型请求超时或网络不可用", attempts=attempt, retryable=True)
                if attempt >= self.settings.max_retries + 1:
                    raise last_error from exc
            if attempt <= self.settings.max_retries:
                time.sleep(min(0.25 * (2 ** (attempt - 1)), 1.0))
        if last_error is not None:
            last_error.attempts = attempts
            raise last_error
        raise ModelRequestError("模型请求未完成", attempts=attempts)
