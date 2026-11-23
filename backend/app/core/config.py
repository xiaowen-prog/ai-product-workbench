from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PRODUCT_ROOT = Path(__file__).resolve().parents[3]


def data_dir() -> Path:
    configured = os.getenv("AI_WORKBENCH_DATA_DIR")
    if configured:
        path = Path(configured)
        return path if path.is_absolute() else (PRODUCT_ROOT / path).resolve()
    return PRODUCT_ROOT / "data"


STORE_PATH = data_dir() / "workbench.json"
# The paper workspace is the only UI for this project. Serving it from the
# same FastAPI process keeps local-mode API calls same-origin and avoids a
# second stale copy of the interface.
STATIC_DIR = PRODUCT_ROOT / "dist"


@dataclass(frozen=True)
class ModelSettings:
    api_key: str
    base_url: str
    model: str
    timeout_seconds: float
    max_retries: int


def model_settings() -> ModelSettings:
    """从后端环境读取模型配置；不向前端暴露密钥。"""
    try:
        timeout = max(1.0, float(os.getenv("MODEL_TIMEOUT_SECONDS") or os.getenv("AGENT_MODEL_TIMEOUT_SECONDS", "45")))
    except ValueError:
        timeout = 45.0
    try:
        retries = max(0, min(4, int(os.getenv("MODEL_MAX_RETRIES", "2"))))
    except ValueError:
        retries = 2
    base_url = (os.getenv("MODEL_BASE_URL") or os.getenv("AGENT_MODEL_BASE_URL") or os.getenv("OPENAI_BASE_URL") or "https://api.deepseek.com/v1").strip().rstrip("/") or "https://api.deepseek.com/v1"
    model = (os.getenv("MODEL_NAME") or os.getenv("AGENT_MODEL") or os.getenv("OPENAI_MODEL") or "deepseek-chat").strip() or "deepseek-chat"
    return ModelSettings(
        api_key=(os.getenv("MODEL_API_KEY") or os.getenv("AGENT_MODEL_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip(),
        base_url=base_url,
        model=model,
        timeout_seconds=timeout,
        max_retries=retries,
    )


def model_required() -> bool:
    """本地 API 默认要求先配置模型 Key；离线示例不经过这个后端门禁。"""
    return os.getenv("AI_WORKBENCH_REQUIRE_MODEL", "true").strip().lower() not in {"0", "false", "no", "off"}
