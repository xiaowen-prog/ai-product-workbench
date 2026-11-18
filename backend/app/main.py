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


def create_app(store_path: Path | None = None, require_model: bool | None = None) -> FastAPI:
    app = FastAPI(title="AI 产品工作台", version="0.2.0")
    app.state.store = Store(store_path or STORE_PATH)
    app.state.require_model = model_required() if require_model is None else require_model
    app.include_router(router)
    app.include_router(runtime_router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "mode": "mock+real-adapter"}

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "请求格式不正确"}})

    @app.exception_handler(FastAPIHTTPException)
    async def http_error(_: Request, exc: FastAPIHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
        error = detail if "code" in detail and "message" in detail else {"code": "http_error", "message": str(detail)}
        return JSONResponse(status_code=exc.status_code, content={"error": error})

    @app.exception_handler(Exception)
    async def unexpected_error(_: Request, __: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"error": {"code": "internal_error", "message": "服务暂时无法完成这一步"}})

    if STATIC_DIR.exists():
        # Keep the selected paper UI and the API on the same origin. The
        # root mount serves the index and its sibling app.js/app.css files.
        @app.get("/", include_in_schema=False)
        def index() -> FileResponse:
            return FileResponse(STATIC_DIR / "index.html")

        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="workspace")

    return app


app = create_app()
