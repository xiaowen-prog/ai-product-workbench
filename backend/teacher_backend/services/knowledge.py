from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from teacher_backend.core.errors import ApiError
from teacher_backend.models import KnowledgeEntry, Task
from teacher_backend.services.tasks import _event


KNOWLEDGE_SEEDS = [
    {
        "id": "webdev-loop",
        "title": "WebDev 交付循环",
        "content": "先确认需求和工作区，再规划、执行、验证，最后交付预览和文件。",
        "tags": ["webdev", "delivery", "verification"],
    },
    {
        "id": "tool-retry",
        "title": "工具错误处理",
        "content": "工具超时或参数错误时保留错误事件，有限重试，并说明恢复结果。",
        "tags": ["tools", "retry", "errors"],
    },
    {
        "id": "artifact-handoff",
        "title": "产物交付",
        "content": "文件和预览地址与聊天内容分开展示，交付物使用可复核的链接或受控路径。",
        "tags": ["artifact", "handoff"],
    },
]


def seed_knowledge(session: Session) -> None:
    for item in KNOWLEDGE_SEEDS:
        if session.get(KnowledgeEntry, item["id"]):
            continue
        session.add(
            KnowledgeEntry(
                id=item["id"],
                title=item["title"],
                content=item["content"],
                tags_json=json.dumps(item["tags"], ensure_ascii=False),
                source="stage2-2-mock",
            )
        )
    session.commit()


def search_knowledge(session: Session, query: str, limit: int = 5) -> list[KnowledgeEntry]:
    seed_knowledge(session)
    normalized = query.strip().lower()
    items = list(session.scalars(select(KnowledgeEntry).order_by(KnowledgeEntry.created_at)).all())
    if not normalized:
        return items[:limit]
    terms = normalized.split()
    ranked: list[tuple[int, KnowledgeEntry]] = []
    for item in items:
        haystack = " ".join([item.title, item.content, item.tags_json]).lower()
        score = sum(term in haystack for term in terms)
        if score:
            ranked.append((score, item))
    ranked.sort(key=lambda pair: (-pair[0], pair[1].title))
    return [item for _, item in ranked[:limit]]


def inject_knowledge(session: Session, task: Task, query: str) -> list[KnowledgeEntry]:
    matches = search_knowledge(session, query)
    _event(
        session,
        task,
        "knowledge_injected",
        "已加载与当前任务相关的知识条目",
        {
            "query": query,
            "entry_ids": [item.id for item in matches],
            "titles": [item.title for item in matches],
        },
    )
    session.commit()
    return matches
