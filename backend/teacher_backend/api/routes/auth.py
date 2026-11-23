from __future__ import annotations

from fastapi import APIRouter, Cookie, Request, Response
from pydantic import BaseModel, Field

from teacher_backend.core.errors import ApiError
from teacher_backend.services.auth import SESSION_COOKIE, get_auth_settings, make_session, match_invite_code, read_session

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    code: str = Field(min_length=1, max_length=128)


class AuthState(BaseModel):
    require_login: bool
    configured: bool
    logged_in: bool
    user: str | None = None


@router.get("/me", response_model=AuthState)
def me(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> AuthState:
    settings = get_auth_settings()
    label = read_session(settings, session)
    return AuthState(require_login=settings.require_login, configured=settings.configured, logged_in=label is not None, user=label)


@router.post("/login", response_model=AuthState)
def login(body: LoginRequest, response: Response) -> AuthState:
    settings = get_auth_settings()
    if not settings.require_login:
        return AuthState(require_login=False, configured=settings.configured, logged_in=True, user="local")
    if not settings.configured:
        raise ApiError("auth_not_configured", "登录功能尚未配置", 503)
    label = match_invite_code(settings, body.code.strip())
    if label is None:
        raise ApiError("invalid_invite_code", "邀请码不正确", 401)
    response.set_cookie(SESSION_COOKIE, make_session(settings, label, body.code.strip()), max_age=settings.session_max_age_seconds, httponly=True, secure=settings.cookie_secure, samesite="lax", path="/")
    return AuthState(require_login=True, configured=True, logged_in=True, user=label)


@router.post("/logout")
def logout(response: Response) -> dict[str, bool]:
    settings = get_auth_settings()
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=settings.cookie_secure, samesite="lax", path="/")
    return {"ok": True}


def current_owner(request: Request) -> str:
    settings = get_auth_settings()
    if not settings.require_login:
        return "local"
    label = read_session(settings, request.cookies.get(SESSION_COOKIE))
    if label is None:
        raise ApiError("unauthorized", "请先输入邀请码登录", 401)
    return label
