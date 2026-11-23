from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from teacher_backend.core.config import load_auth_settings

SESSION_COOKIE = "agent_workbench_session"


@dataclass(frozen=True)
class AuthSettings:
    require_login: bool
    invite_codes: dict[str, str]
    session_secret: str
    session_max_age_seconds: int
    cookie_secure: bool
    proxy_shared_secret: str
    client_ip_header: str
    proxy_hops: int

    @property
    def configured(self) -> bool:
        return bool(self.invite_codes and len(self.session_secret) >= 16)


def get_auth_settings() -> AuthSettings:
    return AuthSettings(**load_auth_settings())


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session(settings: AuthSettings, label: str, code: str, now: float | None = None) -> str:
    issued = time.time() if now is None else now
    payload = _encode(json.dumps({"label": label, "code": hashlib.sha256(code.encode()).hexdigest()[:24], "exp": int(issued) + settings.session_max_age_seconds}, separators=(",", ":")).encode())
    return f"{payload}.{_sign(settings.session_secret, payload)}"


def read_session(settings: AuthSettings, token: str | None, now: float | None = None) -> str | None:
    if not token or not settings.configured or token.count(".") != 1:
        return None
    payload, signature = token.split(".", 1)
    if not hmac.compare_digest(_sign(settings.session_secret, payload), signature):
        return None
    try:
        data = json.loads(_decode(payload))
        label = str(data["label"])
        fingerprint = str(data["code"])
        expiry = int(data["exp"])
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        return None
    if expiry < (time.time() if now is None else now):
        return None
    for code, known_label in settings.invite_codes.items():
        if known_label == label and hmac.compare_digest(hashlib.sha256(code.encode()).hexdigest()[:24], fingerprint):
            return label
    return None


def match_invite_code(settings: AuthSettings, code: str) -> str | None:
    for known, label in settings.invite_codes.items():
        if hmac.compare_digest(known.encode(), code.encode()):
            return label
    return None
