from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.config import model_settings
from pydantic import BaseModel, Field

from app.schemas.models import AcceptanceRequest, AnswerRequest, ConfirmationRequest, CreateProjectRequest, ProjectListResponse, public_project
from app.services.model_client import ModelClientError
from app.services.store import Store
from app.services.workbench import add_supplement, answer_project, confirm_intent, confirm_plan, create_iteration, create_project, generate_real_plan, modify_plan, record_acceptance


router = APIRouter(prefix="/api/v1")


class TextRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    note: str = Field(default="", max_length=2000)


class IterationRequest(BaseModel):
    change_request: str = Field(min_length=1, max_length=500)


def get_store(request: Request) -> Store:
    return request.app.state.store


@router.get("/model/status")
def get_model_status() -> dict[str, object]:
    settings = model_settings()
    return {
        "configured": bool(settings.api_key),
        "provider": "openai-compatible",
        "base_url": settings.base_url,
        "model": settings.model,
        "max_retries": settings.max_retries,
    }


@router.get("/projects", response_model=ProjectListResponse)
def list_projects(store: Store = Depends(get_store)) -> ProjectListResponse:
    return ProjectListResponse(projects=store.list_projects())


@router.post("/projects", status_code=status.HTTP_201_CREATED)
def create(request: CreateProjectRequest, store: Store = Depends(get_store)) -> dict:
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
def plan_confirmation(project_id: str, request: ConfirmationRequest, store: Store = Depends(get_store)) -> dict:
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
def iteration(project_id: str, request: IterationRequest, store: Store = Depends(get_store)) -> dict:
    try:
        project = create_iteration(store, project_id, request.change_request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": str(exc)}) from exc
    return {"project": public_project(project)}


@router.post("/projects/{project_id}/build")
def build_backend(project_id: str, store: Store = Depends(get_store)) -> dict:
    """兼容需要显式 build 按钮的客户端；确认方案后同步生成首版后端交付检查。"""
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
def preview(project_id: str, store: Store = Depends(get_store)) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "找不到这个项目"})
    if project.plan is None or project.intent is None or project.status != "preview_ready":
        raise HTTPException(status_code=409, detail={"code": "preview_not_ready", "message": "先完成需求确认、方案确认和后端验收，再打开预览"})
    source = "真实模型" if any(task.kind == "generate_plan_real" and task.status == "succeeded" for task in project.tasks) else "mock"
    return {
        "project_id": project.id,
        "title": project.plan.title,
        "summary": project.plan.summary,
        "preview": {
            "headline": project.plan.title,
            "body": project.plan.summary,
            "primary_action": project.answers.get("desired_outcome", project.answers.get("core_action", "开始体验")),
            "badge": f"{source} 预览",
        },
    }
