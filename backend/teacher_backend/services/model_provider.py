from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse

import httpx

from teacher_backend.core.config import load_model_settings


class ModelProviderError(Exception):
    """A provider failure that can be persisted as a safe run error code."""

    code = "model_request_error"
    retryable = True

    def __init__(self, message: str, *, code: str | None = None, retryable: bool | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if retryable is not None:
            self.retryable = retryable


class ModelNotConfiguredError(ModelProviderError):
    code = "model_not_configured"
    retryable = False


class ModelResponseError(ModelProviderError):
    code = "model_invalid_response"
    retryable = False


@dataclass(frozen=True)
class ModelSettings:
    provider: str
    base_url: str
    api_key: str
    model: str
    timeout_seconds: float = 45.0

    @classmethod
    def from_env(cls) -> "ModelSettings":
        values = load_model_settings()
        return cls(
            provider=str(values.get("provider") or "openai-compatible"),
            base_url=str(values.get("base_url") or ""),
            api_key=str(values.get("api_key") or ""),
            model=str(values.get("model") or ""),
            timeout_seconds=float(values.get("timeout_seconds") or 45),
        )

    @property
    def configured(self) -> bool:
        parsed = urlparse(self.base_url)
        provider_ready = self.provider.strip().lower() not in {"mock", "fallback"}
        return bool(provider_ready and self.api_key and self.model and parsed.scheme in {"http", "https"} and parsed.netloc)

    def missing_fields(self) -> list[str]:
        missing: list[str] = []
        if self.provider.strip().lower() in {"mock", "fallback"}:
            missing.append("provider")
        if not self.api_key:
            missing.append("api_key")
        if not self.model:
            missing.append("model")
        parsed = urlparse(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            missing.append("base_url")
        return missing


@dataclass(frozen=True)
class ModelCompletion:
    content: str
    model: str
    provider: str
    usage: dict[str, Any]
    request_id: str | None = None


class OpenAICompatibleClient:
    """Small HTTP adapter for OpenAI-compatible ``chat/completions`` APIs.

    The adapter intentionally has no provider SDK dependency.  Any provider
    exposing the OpenAI request/response shape can be selected by changing the
    base URL and model through environment variables.
    """

    def __init__(self, settings: ModelSettings | None = None, *, client: Any | None = None) -> None:
        self.settings = settings or ModelSettings.from_env()
        self._client = client

    def status(self) -> dict[str, Any]:
        missing = self.settings.missing_fields()
        return {
            "provider": self.settings.provider,
            "model": self.settings.model or None,
            "base_url": self.settings.base_url or None,
            "configured": not missing,
            "missing": missing,
        }

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1200,
    ) -> ModelCompletion:
        if not self.settings.configured:
            missing = ", ".join(self.settings.missing_fields())
            raise ModelNotConfiguredError(
                f"真实模型未配置，请设置 AGENT_MODEL_API_KEY/OPENAI_API_KEY、AGENT_MODEL 和有效的 AGENT_MODEL_BASE_URL（缺少：{missing}）"
            )

        endpoint = self.settings.base_url.rstrip("/")
        if not endpoint.endswith("/chat/completions"):
            endpoint = f"{endpoint}/chat/completions"
        payload = {
            "model": self.settings.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {"Authorization": f"Bearer {self.settings.api_key}", "Content-Type": "application/json"}
        owned_client = self._client is None
        client = self._client or httpx.Client(timeout=self.settings.timeout_seconds)
        try:
            try:
                response = client.post(endpoint, headers=headers, json=payload)
            except httpx.TimeoutException as exc:
                raise ModelProviderError("真实模型请求超时", code="model_timeout") from exc
            except httpx.RequestError as exc:
                raise ModelProviderError("真实模型网络请求失败", code="model_network_error") from exc
            if response.status_code >= 400:
                detail = _safe_error_detail(response)
                if self.settings.api_key:
                    detail = detail.replace(self.settings.api_key, "[redacted]")
                retryable = response.status_code == 429 or response.status_code >= 500
                raise ModelProviderError(
                    f"真实模型返回 HTTP {response.status_code}{(': ' + detail) if detail else ''}",
                    code="model_rate_limited" if response.status_code == 429 else "model_http_error",
                    retryable=retryable,
                )
            try:
                data = response.json()
            except (ValueError, TypeError) as exc:
                raise ModelResponseError("真实模型响应不是有效 JSON") from exc
            content = _extract_content(data)
            if not content:
                raise ModelResponseError("真实模型响应缺少 choices[0].message.content")
            usage = data.get("usage") if isinstance(data, Mapping) else {}
            if not isinstance(usage, dict):
                usage = {}
            return ModelCompletion(
                content=content,
                model=str(data.get("model") or self.settings.model),
                provider=self.settings.provider,
                usage=usage,
                request_id=response.headers.get("x-request-id") or response.headers.get("request-id"),
            )
        finally:
            if owned_client:
                client.close()


def _extract_content(data: Any) -> str:
    if not isinstance(data, Mapping):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, Mapping):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, Mapping) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts).strip()
    return ""


def _safe_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except (ValueError, TypeError):
        return response.text[:300].replace("\n", " ")
    if isinstance(payload, Mapping):
        error = payload.get("error")
        if isinstance(error, Mapping):
            message = error.get("message")
            if isinstance(message, str):
                return message[:300]
        message = payload.get("message")
        if isinstance(message, str):
            return message[:300]
    return ""


def get_model_client() -> OpenAICompatibleClient:
    return OpenAICompatibleClient(ModelSettings.from_env())
