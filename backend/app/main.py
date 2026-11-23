from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.exceptions import HTTPException as FastAPIHTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router, runtime_router
from app.core.config import STATIC_DIR, STORE_PATH, model_required
from app.services.store import Store
from app.services.teacher_engine import TeacherEngineError
from teacher_backend.main import create_app as create_teacher_app


def create_app(store_path: Path | None = None, require_model: bool | None = None) -> FastAPI:
    # 老师第二个项目提供正式后端运行时和原有 /api/v1/tasks 契约。
    # 当前工作台只在这个 app 上增加 v29 所需的需求链路适配，不复制或替换老师路由。
    app = create_teacher_app()
    app.state.store = Store(store_path or STORE_PATH)
    app.state.require_model = model_required() if require_model is None else require_model
    app.include_router(router)
    app.include_router(runtime_router)
    teacher_validation_handler = app.exception_handlers[RequestValidationError]
    teacher_http_handler = app.exception_handlers.get(FastAPIHTTPException)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        if not request.url.path.startswith(("/api/v1/projects", "/api/v1/model/", "/api/v1/runtime/")):
            return await teacher_validation_handler(request, exc)
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "请求格式不正确"}})

    @app.exception_handler(TeacherEngineError)
    async def teacher_engine_error(_: Request, exc: TeacherEngineError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": str(exc)}})

    @app.exception_handler(FastAPIHTTPException)
    async def http_error(request: Request, exc: FastAPIHTTPException) -> JSONResponse:
        if not request.url.path.startswith(("/api/v1/projects", "/api/v1/model/", "/api/v1/runtime/")):
            if teacher_http_handler is not None:
                return await teacher_http_handler(request, exc)
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
        error = detail if "code" in detail and "message" in detail else {"code": "http_error", "message": str(detail)}
        return JSONResponse(status_code=exc.status_code, content={"error": error})

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        if not request.url.path.startswith(("/api/v1/projects", "/api/v1/model/", "/api/v1/runtime/")):
            raise exc
        return JSONResponse(status_code=500, content={"error": {"code": "internal_error", "message": "服务暂时无法完成这一步"}})

    if STATIC_DIR.exists() and not any(getattr(route, "path", "") == "/" for route in app.routes):
        # Keep the selected paper UI and the API on the same origin. The
        # root mount serves the index and its sibling app.js/app.css files.
        @app.get("/", include_in_schema=False)
        def index() -> FileResponse:
            return FileResponse(STATIC_DIR / "index.html")

        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="workspace")

    return app


app = create_app()
