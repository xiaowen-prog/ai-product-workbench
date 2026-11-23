from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from teacher_backend.core.config import get_storage_settings
from teacher_backend.services.auth import get_auth_settings
from teacher_backend.services.model_provider import get_model_client


router = APIRouter(tags=["runtime"])


@router.get("/runtime")
def runtime_status() -> dict[str, Any]:
    """Return non-secret readiness information for deploy checks and clients."""

    storage = get_storage_settings()
    storage_payload: dict[str, Any] = {"database": "sqlite" if storage.data_backend == "sql" else storage.data_backend, "artifacts": "local"}
    if storage.data_backend == "cloudbase_rest":
        storage_payload.update({"artifacts": "local_cache", "table_prefix": storage.cloudbase_table_prefix, "cache": "sqlite_hydrated"})
    return {
        "model": get_model_client().status(),
        "execution_modes": ["mock", "real"],
        "storage": storage_payload,
        "auth": {
            "required": get_auth_settings().require_login,
        },
    }
