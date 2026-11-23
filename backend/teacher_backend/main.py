from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.requests import Request
from starlette.middleware.cors import CORSMiddleware

from teacher_backend.api.routes.tasks import router as tasks_router
from teacher_backend.api.routes.runtime import router as runtime_router
from teacher_backend.api.routes.auth import router as auth_router
from teacher_backend.core.errors import ApiError
from teacher_backend.core.config import reset_request_owner, set_request_owner
from teacher_backend.services.auth import SESSION_COOKIE, get_auth_settings, read_session
from teacher_backend.services.cloudbase_rest import CloudBaseStorageError
from teacher_backend.db import init_db


def create_app() -> FastAPI:
    app = FastAPI(title="自主 Agent 工作台 API", version="0.1.0")
    configured_origins = [
        origin.strip()
        for origin in os.getenv("AGENT_CORS_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000").split(",")
        if origin.strip()
    ]
    # Keep local development usable while requiring an explicit origin list in
    # production. Wildcard origins cannot be combined with credentials.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=configured_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    init_db()

    @app.middleware("http")
    async def bind_owner_and_auth(request: Request, call_next):
        settings = get_auth_settings()
        public = request.url.path in {"/health", "/api/v1/runtime"} or request.url.path.startswith("/api/v1/auth/")
        owner = "local"
        if settings.require_login and request.url.path.startswith("/api/v1") and not public:
            owner = read_session(settings, request.cookies.get(SESSION_COOKIE))
            if owner is None:
                return JSONResponse(status_code=401, content={"error": {"code": "unauthorized", "message": "请先输入邀请码登录"}})
        token = set_request_owner(owner or "local")
        try:
            return await call_next(request)
        finally:
            reset_request_owner(token)

    @app.exception_handler(ApiError)
    async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(CloudBaseStorageError)
    async def cloudbase_error_handler(_: Request, exc: CloudBaseStorageError) -> JSONResponse:
        # Keep gateway details and credentials out of the public response.
        code = exc.args[0] if exc.args and exc.args[0] in {"db_unavailable", "db_error"} else "db_unavailable"
        status_code = 502 if code == "db_error" else 503
        message = "数据读写失败，请稍后重试" if code == "db_error" else "数据库暂时连不上，请稍后重试"
        return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "请求参数不符合要求", "details": exc.errors()}},
        )

    app.include_router(tasks_router, prefix="/api/v1")
    app.include_router(runtime_router, prefix="/api/v1")
    app.include_router(auth_router, prefix="/api/v1")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
