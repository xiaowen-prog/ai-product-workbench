from __future__ import annotations

import os
import contextvars
from dataclasses import dataclass
from pathlib import Path


def _load_local_env() -> None:
    """Load an untracked backend/.env without overriding process variables."""

    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_local_env()

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_ROOT = Path(os.getenv("AGENT_DATA_DIR", str(PROJECT_ROOT / "data")))
DB_PATH = Path(os.getenv("AGENT_DB_PATH", str(DATA_ROOT / "agent_workbench.sqlite3")))
ARTIFACT_ROOT = Path(os.getenv("AGENT_ARTIFACT_DIR", str(DATA_ROOT / "artifacts")))
OWNER_ID = os.getenv("AGENT_OWNER_ID", "default-owner")
_request_owner: contextvars.ContextVar[str] = contextvars.ContextVar("request_owner", default=OWNER_ID)


def set_request_owner(owner_id: str) -> contextvars.Token[str]:
    return _request_owner.set(owner_id)


def reset_request_owner(token: contextvars.Token[str]) -> None:
    _request_owner.reset(token)


def get_owner_id() -> str:
    return _request_owner.get()


def load_auth_settings() -> dict[str, object]:
    """Read auth settings without ever logging their values."""

    raw_codes = os.getenv("INVITE_CODES", "")
    invite_codes: dict[str, str] = {}
    for item in raw_codes.split(","):
        if ":" not in item:
            continue
        code, label = item.split(":", 1)
        if code.strip() and label.strip():
            invite_codes[code.strip()] = label.strip()[:128]
    try:
        max_age = max(300, min(int(os.getenv("SESSION_MAX_AGE_SECONDS", str(60 * 60 * 24 * 30))), 60 * 60 * 24 * 365))
    except ValueError:
        max_age = 60 * 60 * 24 * 30
    secret = os.getenv("SESSION_SECRET", "").strip()
    return {
        "require_login": os.getenv("REQUIRE_LOGIN", "0").strip().lower() in {"1", "true", "yes"},
        "invite_codes": invite_codes,
        "session_secret": secret,
        "session_max_age_seconds": max_age,
        "cookie_secure": os.getenv("COOKIE_SECURE", "0").strip().lower() in {"1", "true", "yes"},
        "proxy_shared_secret": os.getenv("PROXY_SHARED_SECRET", "").strip(),
        "client_ip_header": os.getenv("CLIENT_IP_HEADER", "x-envoy-external-address").strip(),
        "proxy_hops": max(0, int(os.getenv("PROXY_HOPS", "0") or "0")),
    }


@dataclass(frozen=True)
class StorageSettings:
    """Non-secret storage configuration shared by startup and readiness checks.

    The application uses SQLite for local ORM work and a CloudBase REST
    mirror when ``data_backend`` is ``cloudbase_rest``. Keeping the switch
    explicit prevents a deployment from silently falling back to local-only
    persistence.
    """

    data_backend: str
    cloudbase_env_id: str
    cloudbase_api_key: str
    cloudbase_rest_url: str
    cloudbase_table_prefix: str = "agent_workbench_"

    @property
    def is_cloudbase(self) -> bool:
        return self.data_backend == "cloudbase_rest"


def get_storage_settings() -> StorageSettings:
    """Read storage settings at runtime without exposing secrets."""

    data_backend = os.getenv("DATA_BACKEND", "sql").strip().lower() or "sql"
    cloudbase_env_id = os.getenv("CLOUDBASE_ENV_ID", "").strip()
    cloudbase_api_key = os.getenv("CLOUDBASE_API_KEY", "").strip()
    cloudbase_rest_url = os.getenv("CLOUDBASE_REST_URL", "").strip()
    if not cloudbase_rest_url and cloudbase_env_id:
        cloudbase_rest_url = f"https://{cloudbase_env_id}.api.tcloudbasegateway.com/v1/rdb/rest"
    return StorageSettings(
        data_backend=data_backend,
        cloudbase_env_id=cloudbase_env_id,
        cloudbase_api_key=cloudbase_api_key,
        cloudbase_rest_url=cloudbase_rest_url,
        cloudbase_table_prefix=os.getenv("CLOUDBASE_TABLE_PREFIX", "agent_workbench_").strip(),
    )


def validate_storage_settings() -> StorageSettings:
    """Validate deployment storage settings before the app opens a database.

    CloudBase mode is intentionally fail-fast when its endpoint or server key
    is missing. This is safer than starting with SQLite and losing data after
    a CloudRun instance is recycled.
    """

    settings = get_storage_settings()
    if settings.data_backend not in {"sql", "cloudbase_rest"}:
        raise RuntimeError("DATA_BACKEND must be 'sql' or 'cloudbase_rest'")
    if not settings.is_cloudbase:
        return settings
    missing = []
    if not settings.cloudbase_env_id and not settings.cloudbase_rest_url:
        missing.append("CLOUDBASE_ENV_ID")
    if not settings.cloudbase_api_key:
        missing.append("CLOUDBASE_API_KEY")
    if missing:
        raise RuntimeError(
            "DATA_BACKEND=cloudbase_rest requires " + ", ".join(missing)
        )
    if not settings.cloudbase_rest_url.startswith("https://"):
        raise RuntimeError("CLOUDBASE_REST_URL must use https://")
    return settings


# Read model settings at request time so secrets stay in the environment and
# provider changes do not require editing source files.
def load_model_settings() -> dict[str, str | float | None]:
    """Return the OpenAI-compatible model configuration from environment vars."""

    provider = os.getenv("AGENT_MODEL_PROVIDER", os.getenv("MODEL_PROVIDER", "openai-compatible")).strip() or "openai-compatible"
    base_url = os.getenv("AGENT_MODEL_BASE_URL", os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")).strip()
    api_key = os.getenv("AGENT_MODEL_API_KEY", os.getenv("OPENAI_API_KEY", "")).strip()
    model = os.getenv("AGENT_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")).strip()
    try:
        timeout_seconds = float(os.getenv("AGENT_MODEL_TIMEOUT_SECONDS", "45"))
    except ValueError:
        timeout_seconds = 45.0
    return {
        "provider": provider,
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
        "timeout_seconds": max(1.0, min(timeout_seconds, 300.0)),
    }
