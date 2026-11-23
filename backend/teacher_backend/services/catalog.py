from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from teacher_backend.core.errors import ApiError
from teacher_backend.models import ToolDefinition


TOOL_SPECS: list[dict[str, Any]] = [
    {"name": "read", "description": "读取工作区文件", "permission": "allow", "required": ["path"]},
    {"name": "write", "description": "写入工作区文件", "permission": "ask", "required": ["path", "content"]},
    {"name": "edit", "description": "修改工作区文件", "permission": "ask", "required": ["path", "patch"]},
    {"name": "exec", "description": "执行受控命令", "permission": "ask", "required": ["command"]},
    {"name": "search", "description": "搜索工作区内容", "permission": "allow", "required": ["query"]},
    {"name": "fetch", "description": "读取已允许的网页内容", "permission": "allow", "required": ["url"]},
    {"name": "todo", "description": "创建或更新任务步骤", "permission": "allow", "required": ["action"]},
    {"name": "job", "description": "提交后台任务", "permission": "allow", "required": ["kind"]},
    {"name": "agent", "description": "启动受控子任务", "permission": "ask", "required": ["brief"]},
    {"name": "ask", "description": "向用户请求必要信息", "permission": "allow", "required": ["question"]},
    {"name": "mcp", "description": "搜索并调用 MCP 工具定义", "permission": "allow", "required": ["query"]},
]


def seed_catalog(session: Session) -> None:
    existing = {item.name for item in session.scalars(select(ToolDefinition)).all()}
    for spec in TOOL_SPECS:
        if spec["name"] in existing:
            continue
        session.add(
            ToolDefinition(
                name=spec["name"],
                description=spec["description"],
                permission=spec["permission"],
                arguments_json=json.dumps({"required": spec["required"]}),
            )
        )
    session.commit()


def list_tools(session: Session) -> list[ToolDefinition]:
    seed_catalog(session)
    return list(session.scalars(select(ToolDefinition).order_by(ToolDefinition.name)).all())


def get_tool(session: Session, name: str) -> ToolDefinition:
    seed_catalog(session)
    tool = session.get(ToolDefinition, name)
    if tool is None or not tool.enabled:
        raise ApiError("tool_not_found", "找不到这个工具", 404)
    return tool


def validate_arguments(tool: ToolDefinition, arguments: dict[str, Any]) -> None:
    required = json.loads(tool.arguments_json or "{}").get("required", [])
    missing = [key for key in required if key not in arguments or arguments[key] in (None, "")]
    if missing:
        raise ApiError("invalid_tool_arguments", f"缺少工具参数：{', '.join(missing)}", 422)


def permission_status(tool: ToolDefinition, confirmed: bool) -> str:
    if tool.permission == "deny":
        raise ApiError("tool_denied", "这个工具被策略禁止执行", 403)
    if tool.permission == "ask" and not confirmed:
        return "awaiting_confirmation"
    return "allowed"
