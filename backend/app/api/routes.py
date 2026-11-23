from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from typing import Literal
from fastapi.responses import FileResponse, HTMLResponse
from pathlib import Path

from app.core.config import model_settings
from pydantic import BaseModel, Field

from app.schemas.models import AcceptanceRequest, AnswerRequest, ConfirmationRequest, CreateProjectRequest, DevelopmentChatRequest, IntentConfirmationRequest, Project, ProjectListResponse, RuntimeActionRequest, TrialFeedbackRequest, WorkshopChatRequest, WorkshopChatSaveRequest, public_project
from app.services.preview_runtime import ensure_preview, now as runtime_now, render_runtime_page, run_runtime, verify_runtime
from teacher_backend.services.model_provider import ModelProviderError
from app.services import teacher_engine
from app.services.store import Store
from app.services.workbench import accept_backend_stage, add_supplement, answer_project, confirm_intent, confirm_plan, create_iteration, create_project, development_chat, development_status, fill_workshop_options, generate_real_plan, modify_plan, plan_progress, record_acceptance, record_trial_feedback, resume_workshop, start_backend_development, start_trial, verify_backend_development, workshop_chat, save_workshop_answers


router = APIRouter(prefix="/api/v1")
runtime_router = APIRouter()


class TextRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    note: str = Field(default="", max_length=2000)


class IterationRequest(BaseModel):
    change_request: str = Field(min_length=1, max_length=500)


class BuildRequest(BaseModel):
    execution_mode: Literal["real"] = "real"


class DevelopmentAcceptRequest(BaseModel):
    passed: bool
    next_stage: str | None = Field(default=None, pattern="^阶段[0-9]+(?:-[0-9]+)?$|^完成$")
    note: str = Field(default="", max_length=2000)


def external_url(request: Request, route_name: str, **path_params: str) -> str:
    """在云托管反向代理后保留用户实际访问的 HTTPS 协议。"""
    url = str(request.url_for(route_name, **path_params))
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    if request.url.scheme == "https" or forwarded_proto == "https":
        return url.replace("http://", "https://", 1)
    return url


def get_store(request: Request) -> Store:
    return request.app.state.store


def ensure_model_configured(request: Request) -> None:
    if request.app.state.require_model and not model_settings().api_key:
        raise HTTPException(status_code=503, detail={"code": "model_not_configured", "message": "开始搭建前，请先在 backend/.env 配置 MODEL_API_KEY"})


@router.get("/model/status")
def get_model_status(request: Request) -> dict[str, object]:
    settings = model_settings()
    required = bool(request.app.state.require_model)
    provider = "anthropic-compatible" if settings.base_url.endswith("/anthropic") else "openai-compatible"
    return {
        "configured": bool(settings.api_key),
        "required": required,
        "teacher_workflow": True,
        "can_build": bool(settings.api_key) or not required,
        "provider": provider,
        "base_url": settings.base_url,
        "model": settings.model,
        "max_retries": settings.max_retries,
        "key_masked": f"{settings.api_key[:4]}…{settings.api_key[-4:]}" if len(settings.api_key) > 12 else ("已填写" if settings.api_key else ""),
        "providers": [
            {"key": "deepseek", "name": "DeepSeek（推荐）", "model": "deepseek-chat", "base_url": "https://api.deepseek.com/v1", "key_page": "https://platform.deepseek.com"},
            {"key": "glm", "name": "智谱 GLM", "model": "glm-4.5", "base_url": "https://open.bigmodel.cn/api/paas/v4", "key_page": "https://open.bigmodel.cn"},
            {"key": "kimi", "name": "Kimi 月之暗面", "model": "kimi-k2-0711-preview", "base_url": "https://api.moonshot.cn/v1", "key_page": "https://platform.moonshot.cn"},
            {"key": "anthropic", "name": "Anthropic 官方", "model": "claude-sonnet-4-5", "base_url": "https://api.anthropic.com/v1", "key_page": "https://console.anthropic.com"},
        ],
    }


@router.get("/projects", response_model=ProjectListResponse)
def list_projects(store: Store = Depends(get_store)) -> ProjectListResponse:
    # 列表也走 public_project，确保旧项目里超过用户批次上限的待确认题
    # 不会在首页恢复时重新全部展示；原始工作区和数据库内容不被删改。
    return ProjectListResponse(
        projects=[Project.model_validate(public_project(project)) for project in store.list_projects()]
    )


@router.post("/projects", status_code=status.HTTP_201_CREATED)
def create(request: CreateProjectRequest, http_request: Request, store: Store = Depends(get_store)) -> dict:
    ensure_model_configured(http_request)
    return {"project": public_project(create_project(store, request.idea))}


@router.get("/projects/{project_id}")
def get(project_id: str, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    # 读取旧项目时同步一次已通过复审的状态迁移，避免历史遗留的
    # open_questions 把用户重新挡回方案问答阶段。
    if project.status.value == "needs_plan_confirmation" and project.workshop and project.plan:
        project = resume_workshop(store, project_id)
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/workshop-resume")
def restore_workshop(project_id: str, store: Store = Depends(get_store)) -> dict:
    return _workshop_edit(resume_workshop, store, project_id)


@router.post("/projects/{project_id}/questions/{question_id}/options", include_in_schema=False)
def question_options(project_id: str, question_id: str, store: Store = Depends(get_store)) -> dict:
    return _workshop_edit(fill_workshop_options, store, project_id, question_id)

@router.post("/projects/{project_id}/workshop-chat")
def workshop_chat_route(project_id: str, request: WorkshopChatRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project, events = workshop_chat(store, project_id, request.stage, request.messages)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    except teacher_engine.TeacherEngineError as exc:
        raise HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}) from exc
    return {"project": public_project(project), "events": events}


@router.post("/projects/{project_id}/workshop-chat/save")
def workshop_chat_save_route(project_id: str, request: WorkshopChatSaveRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = save_workshop_answers(store, project_id, request.answers)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    except teacher_engine.TeacherEngineError as exc:
        raise HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/development-chat")
def development_chat_route(project_id: str, request: DevelopmentChatRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project, events = development_chat(store, project_id, request.messages)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    except teacher_engine.TeacherEngineError as exc:
        raise HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}) from exc
    return {"project": public_project(project), "events": events}



@router.post("/projects/{project_id}/replan")
def replan(project_id: str, store: Store = Depends(get_store)) -> dict:
    return _workshop_edit(generate_real_plan, store, project_id, None)


@router.get("/projects/{project_id}/plan-progress")
def plan_progress_route(project_id: str, store: Store = Depends(get_store)) -> dict:
    try:
        return plan_progress(store, project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc


def _workshop_edit(operation, store: Store, project_id: str, *args) -> dict:
    try:
        return {"project": public_project(operation(store, project_id, *args))}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    except teacher_engine.TeacherEngineError as exc:
        raise HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}) from exc


@router.get("/projects/{project_id}/handoff")
def download_handoff(project_id: str, store: Store = Depends(get_store)) -> FileResponse:
    project = store.get_project(project_id)
    if project is None or not project.confirmations.plan or not project.plan or not project.plan.teacher_handoff_path:
        raise HTTPException(status_code=404, detail={"code": "handoff_not_ready", "message": "方案确认后可下载交接包"})
    path = Path(project.plan.teacher_handoff_path).resolve()
    root = (store.path.parent / "teacher-workspaces" / project.id).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(status_code=404, detail={"code": "handoff_not_found", "message": "找不到交接包"})
    return FileResponse(path, filename=project.plan.teacher_handoff_name or "交接包.zip")


@router.post("/projects/{project_id}/answers", include_in_schema=False)
def answer(project_id: str, request: AnswerRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = answer_project(store, project_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/discovery-answers", include_in_schema=False)
def discovery_answers(project_id: str, request: AnswerRequest, store: Store = Depends(get_store)) -> dict:
    """需求发现的多轮补问入口；/answers 保留为兼容别名。"""
    return answer(project_id, request, store)


@router.post("/projects/{project_id}/confirm-intent")
def intent_confirmation(project_id: str, request: IntentConfirmationRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = confirm_intent(store, project_id, request.confirmed, request.note, draft=request.draft)
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
@router.post("/projects/{project_id}/plan/modify", include_in_schema=False)
def plan_modification(project_id: str, request: TextRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = modify_plan(store, project_id, request.note or request.text)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/iterations")
@router.post("/projects/{project_id}/new-requirement", include_in_schema=False)
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
def build_backend(project_id: str, http_request: Request, request: BuildRequest | None = None, store: Store = Depends(get_store)) -> dict:
    """Prepare the original idea-to-launch-kit stage for its external coding tool."""
    execution_mode = request.execution_mode if request else "real"
    if execution_mode == "real":
        ensure_model_configured(http_request)
    try:
        project, development = start_backend_development(store, project_id, execution_mode)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_plan", "message": str(exc)}) from exc
    return {"project": public_project(project), "development": development}


@router.get("/projects/{project_id}/development")
def development(project_id: str, store: Store = Depends(get_store)) -> dict:
    try:
        project, snapshot = development_status(store, project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    return {"project": public_project(project), "development": snapshot}


@router.post("/projects/{project_id}/development/verify")
def development_verify(project_id: str, store: Store = Depends(get_store)) -> dict:
    try:
        project, verification = verify_backend_development(store, project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project), "verification": verification}


@router.post("/projects/{project_id}/development/accept")
def development_accept(project_id: str, request: DevelopmentAcceptRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project, result = accept_backend_stage(store, project_id, request.passed, request.next_stage, request.note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project), "stage": result}


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
@router.post("/projects/{project_id}/trial/start", include_in_schema=False)
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
    real_backend = bool(project.backend and project.backend.execution_mode == "real")
    source = "真实模型" if real_backend or any(task.kind == "generate_plan_real" and task.status == "succeeded" for task in project.tasks) else "结构化方案"
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
            "url": external_url(request, "runtime_page", project_id=project.id),
            "health_url": external_url(request, "runtime_health", project_id=project.id),
            "action_url": external_url(request, "runtime_action", project_id=project.id),
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
        return {"result": run_runtime(project, request.input, request.messages)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_runtime_input", "message": str(exc)}) from exc
    except ModelProviderError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "message": str(exc)}) from exc


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
        external_url(request, "runtime_action", project_id=project.id),
        external_url(request, "runtime_health", project_id=project.id),
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
