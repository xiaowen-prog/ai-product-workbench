from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse

from app.core.config import model_settings
from pydantic import BaseModel, Field

from app.schemas.models import AcceptanceRequest, AnswerRequest, ConfirmationRequest, CreateProjectRequest, ProjectListResponse, RuntimeActionRequest, TrialFeedbackRequest, public_project
from app.services.model_client import ModelClientError
from app.services.preview_runtime import ensure_preview, now as runtime_now, render_runtime_page, run_runtime, verify_runtime
from app.services.store import Store
from app.services.workbench import add_supplement, answer_project, confirm_intent, confirm_plan, create_iteration, create_project, generate_real_plan, modify_plan, record_acceptance, record_trial_feedback, start_trial


router = APIRouter(prefix="/api/v1")
runtime_router = APIRouter()


class TextRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    note: str = Field(default="", max_length=2000)


class IterationRequest(BaseModel):
    change_request: str = Field(min_length=1, max_length=500)


def get_store(request: Request) -> Store:
    return request.app.state.store


def ensure_model_configured(request: Request) -> None:
    if request.app.state.require_model and not model_settings().api_key:
        raise HTTPException(status_code=503, detail={"code": "model_not_configured", "message": "开始搭建前，请先在 backend/.env 配置 MODEL_API_KEY"})


@router.get("/model/status")
def get_model_status(request: Request) -> dict[str, object]:
    settings = model_settings()
    required = bool(request.app.state.require_model)
    return {
        "configured": bool(settings.api_key),
        "required": required,
        "can_build": bool(settings.api_key) or not required,
        "provider": "openai-compatible",
        "base_url": settings.base_url,
        "model": settings.model,
        "max_retries": settings.max_retries,
    }


@router.get("/projects", response_model=ProjectListResponse)
def list_projects(store: Store = Depends(get_store)) -> ProjectListResponse:
    return ProjectListResponse(projects=store.list_projects())


@router.post("/projects", status_code=status.HTTP_201_CREATED)
def create(request: CreateProjectRequest, http_request: Request, store: Store = Depends(get_store)) -> dict:
    ensure_model_configured(http_request)
    return {"project": public_project(create_project(store, request.idea))}


@router.get("/projects/{project_id}")
def get(project_id: str, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/answers")
def answer(project_id: str, request: AnswerRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = answer_project(store, project_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_answers", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/discovery-answers")
def discovery_answers(project_id: str, request: AnswerRequest, store: Store = Depends(get_store)) -> dict:
    """需求发现的多轮补问入口；/answers 保留为兼容别名。"""
    return answer(project_id, request, store)


@router.post("/projects/{project_id}/confirm-intent")
def intent_confirmation(project_id: str, request: ConfirmationRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = confirm_intent(store, project_id, request.confirmed, request.note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/confirm-plan")
def plan_confirmation(project_id: str, request: ConfirmationRequest, http_request: Request, store: Store = Depends(get_store)) -> dict:
    if request.confirmed:
        ensure_model_configured(http_request)
    try:
        project = confirm_plan(store, project_id, request.confirmed, request.note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/supplement")
def supplement(project_id: str, request: TextRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = add_supplement(store, project_id, request.text or request.note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/modify-plan")
@router.post("/projects/{project_id}/plan/modify")
def plan_modification(project_id: str, request: TextRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = modify_plan(store, project_id, request.note or request.text)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/iterations")
@router.post("/projects/{project_id}/new-requirement")
def iteration(project_id: str, request: IterationRequest, http_request: Request, store: Store = Depends(get_store)) -> dict:
    ensure_model_configured(http_request)
    try:
        project = create_iteration(store, project_id, request.change_request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/build")
def build_backend(project_id: str, http_request: Request, store: Store = Depends(get_store)) -> dict:
    """兼容需要显式 build 按钮的客户端；确认方案后同步生成首版后端交付检查。"""
    ensure_model_configured(http_request)
    try:
        project = confirm_plan(store, project_id, True, "用户确认方案后开始开发")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_plan", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/acceptance")
def acceptance(project_id: str, request: AcceptanceRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = record_acceptance(store, project_id, request.passed, request.note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "backend_not_ready", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/trial")
@router.post("/projects/{project_id}/trial/start")
def trial_start(project_id: str, store: Store = Depends(get_store)) -> dict:
    try:
        project = start_trial(store, project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/trial-feedback")
def trial_feedback(project_id: str, request: TrialFeedbackRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = record_trial_feedback(store, project_id, request.feedback, request.outcome)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/real-plan")
def real_plan(project_id: str, request: AnswerRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = generate_real_plan(store, project_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_answers", "message": str(exc)}) from exc
    except ModelClientError as exc:
        status_code = 503 if exc.code == "model_not_configured" else 502
        raise HTTPException(status_code=status_code, detail={"code": exc.code, "message": exc.message}) from exc
    return {"project": public_project(project)}


@router.get("/projects/{project_id}/preview")
def preview(project_id: str, request: Request, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    if project.plan is None or project.intent is None or project.status not in {"preview_ready", "trial"}:
        raise HTTPException(status_code=409, detail={"code": "preview_not_ready", "message": "先完成需求确认、方案确认和后端验收，再打开预览"})
    ensure_preview(project)
    project = store.upsert_project(project)
    source = "真实模型" if any(task.kind == "generate_plan_real" and task.status == "succeeded" for task in project.tasks) else "mock"
    artifact = project.preview
    return {
        "project_id": project.id,
        "title": project.plan.title,
        "summary": project.plan.summary,
        "preview": {
            "headline": project.plan.title,
            "body": project.plan.summary,
            "primary_action": project.answers.get("desired_outcome", project.answers.get("core_action", "开始体验")),
            "badge": f"{source}方案 · 本地可运行预览" if artifact.status == "verified" else f"{source}方案 · 本地运行时预览",
            "url": str(request.url_for("runtime_page", project_id=project.id)),
            "health_url": str(request.url_for("runtime_health", project_id=project.id)),
            "action_url": str(request.url_for("runtime_action", project_id=project.id)),
            "kind": artifact.kind,
            "status": artifact.status,
            "checks": [check.model_dump(mode="json") for check in artifact.checks],
            "started_at": artifact.started_at,
            "verified_at": artifact.verified_at,
        },
    }


@router.post("/projects/{project_id}/preview/verify")
def preview_verify(project_id: str, request: Request, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    if project.plan is None or project.intent is None or project.status not in {"preview_ready", "trial"}:
        raise HTTPException(status_code=409, detail={"code": "preview_not_ready", "message": "先完成需求确认、方案确认和后端验收，再验证预览"})
    verify_runtime(project)
    project.updated_at = runtime_now()
    project = store.upsert_project(project)
    return {"project": public_project(project), "preview": preview(project_id, request, store)["preview"]}


@router.post("/runtime/{project_id}/run", name="runtime_action")
def runtime_action(project_id: str, request: RuntimeActionRequest, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    if project.plan is None or project.status not in {"preview_ready", "trial"}:
        raise HTTPException(status_code=409, detail={"code": "runtime_not_ready", "message": "先完成后端验收，再运行产品预览"})
    try:
        return {"result": run_runtime(project, request.input)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_runtime_input", "message": str(exc)}) from exc


@runtime_router.get("/runtime/{project_id}/", name="runtime_page", response_class=HTMLResponse)
def runtime_page(project_id: str, request: Request, store: Store = Depends(get_store)) -> HTMLResponse:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    if project.plan is None or project.status not in {"preview_ready", "trial"}:
        raise HTTPException(status_code=409, detail={"code": "runtime_not_ready", "message": "先完成后端验收，再打开产品预览"})
    ensure_preview(project)
    store.upsert_project(project)
    return HTMLResponse(render_runtime_page(
        project,
        str(request.url_for("runtime_action", project_id=project.id)),
        str(request.url_for("runtime_health", project_id=project.id)),
    ))


@runtime_router.get("/runtime/{project_id}/health", name="runtime_health")
def runtime_health(project_id: str, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    if project.plan is None or project.status not in {"preview_ready", "trial"}:
        raise HTTPException(status_code=409, detail={"code": "runtime_not_ready", "message": "运行时尚未准备好"})
    # Keep transport health separate from product acceptance. A page can
    # respond while the preview has not gone through explicit verification.
    artifact = project.preview
    preview_status = artifact.status if artifact is not None else "unverified"
    return {
        "status": "ok",
        "runtime": "local",
        "project_id": project.id,
        "preview_status": preview_status,
        "verified": preview_status == "verified",
    }
