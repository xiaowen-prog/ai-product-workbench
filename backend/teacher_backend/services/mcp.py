from __future__ import annotations

from typing import Any


MOCK_MCP_TOOLS: list[dict[str, Any]] = [
    {"name": "webdev.init_project", "description": "初始化一个 WebDev 工作区", "server": "webdev", "required": ["name"]},
    {"name": "webdev.run_build", "description": "运行前端构建并返回诊断", "server": "webdev", "required": ["project_id"]},
    {"name": "browser.open_preview", "description": "打开一个本地预览地址", "server": "browser", "required": ["url"]},
    {"name": "browser.inspect", "description": "检查页面关键交互和路由", "server": "browser", "required": ["url"]},
    {"name": "research.search", "description": "搜索公开资料并整理来源", "server": "research", "required": ["query"]},
    {"name": "files.export", "description": "将结果导出为受控文件", "server": "files", "required": ["format"]},
]


def search_mcp(query: str, limit: int = 5) -> list[dict[str, Any]]:
    terms = [part for part in query.strip().lower().split() if part]
    if not terms:
        return MOCK_MCP_TOOLS[:limit]
    matches: list[tuple[int, dict[str, Any]]] = []
    for item in MOCK_MCP_TOOLS:
        haystack = f"{item['name']} {item['description']} {item['server']}".lower()
        score = sum(term in haystack for term in terms)
        if score:
            matches.append((score, item))
    matches.sort(key=lambda pair: (-pair[0], pair[1]["name"]))
    return [item for _, item in matches[:limit]]
