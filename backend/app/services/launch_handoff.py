from __future__ import annotations

import os
import subprocess
from pathlib import Path

from app.schemas.models import BackendBuild, Project
from app.services.teacher_engine import TeacherEngineError, _load_engine
from app.services.kit_development import create_development_task, read_kit_task


def deliver_handoff(project: Project, data_root: Path) -> BackendBuild:
    """Stage 0 starts with the original PRD and plan, using the original kit gate."""
    kit_path = os.getenv("IDEA_TO_LAUNCH_KIT_ROOT")
    if not kit_path:
        raise TeacherEngineError("未配置本地 Idea to Launch 工具包", code="launch_kit_missing", status_code=503)
    kit = Path(kit_path).resolve()
    if not (kit / "kit.sh").is_file() or not (kit / "verify.sh").is_file():
        raise TeacherEngineError("开发工具包缺少 kit.sh 或 verify.sh", code="launch_kit_missing", status_code=503)

    workspace = Path(project.plan.teacher_workspace_path).resolve()
    if not workspace.is_relative_to((data_root / "teacher-workspaces" / project.id).resolve()):
        raise TeacherEngineError("找不到已审核方案的工作区")
    _load_engine()
    from blueprint.pipeline import atomic_write
    from blueprint.workspace import slugify

    product = f"{slugify(project.workshop.name)[:24]}-{project.id}-v{project.version}"
    project_dir = kit / "projects" / product
    incoming = project_dir / "docs" / "PRD"
    incoming.mkdir(parents=True, exist_ok=True)
    try:
        for name in ("PRD.md", "方案.md", "plan.json", "迭代记录.md"):
            content = (workspace / name).read_text(encoding="utf-8")
            target = incoming / name
            if target.exists() and target.read_text(encoding="utf-8") != content:
                raise TeacherEngineError("开发项目已有不同版本的交接文件，请先核对现有文件", code="handoff_conflict", status_code=409)
            if not target.exists():
                atomic_write(target, content)
        result = subprocess.run(
            ["bash", str(kit / "kit.sh"), "任务", product],
            cwd=kit, capture_output=True, text=True, timeout=15, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise TeacherEngineError("交接未完成，无法读取开发阶段任务，请重试") from exc

    if result.returncode != 0:
        output = (result.stdout + result.stderr).strip()[-2000:]
        detail = f"：{output}" if output else ""
        raise TeacherEngineError(
            f"交接未完成，kit.sh 任务失败{detail}",
            code="launch_kit_task_failed",
            status_code=502,
        )
    try:
        # The kit command must materialize the stage task before the teacher
        # Task is created.  A printed placeholder is not a valid handoff.
        read_kit_task(kit, product)
    except ValueError as exc:
        raise TeacherEngineError(
            str(exc),
            code="launch_kit_task_missing",
            status_code=502,
        ) from exc

    build = create_development_task(project, product, incoming, kit)
    return build
