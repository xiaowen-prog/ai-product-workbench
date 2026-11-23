from __future__ import annotations

import json
from datetime import datetime, timezone
from html import escape
from contextlib import contextmanager
from pathlib import Path

from app.schemas.models import PreviewArtifact, Project, RuntimeCheck, WorkshopMessage
from app.services import teacher_engine
from teacher_backend.services.model_provider import ModelProviderError


def now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_preview(project: Project) -> PreviewArtifact:
    if project.preview is None:
        project.preview = PreviewArtifact(
            path=f"/runtime/{project.id}/",
            health_path=f"/runtime/{project.id}/health",
            action_path=f"/api/v1/runtime/{project.id}/run",
            started_at=now(),
        )
    return project.preview


@contextmanager
def _play_model():
    """Build the teacher playground model with the same real runner as intake and plan."""
    teacher_engine._load_engine()
    from blueprint.chat import AnthropicChat
    with teacher_engine._runner(chat=False) as runner:
        yield runner, AnthropicChat(runner)


def _teacher_plan(project: Project) -> tuple[dict, Path, str]:
    if not project.plan or not project.plan.teacher_plan:
        raise ValueError("方案里还没有老师方案，先完成方案推导")
    workspace = Path(project.plan.teacher_workspace_path or "")
    prd_path = workspace / "PRD.md"
    if not prd_path.is_file():
        raise ValueError("找不到老师方案的 PRD 工作区")
    return project.plan.teacher_plan, workspace, prd_path.read_text(encoding="utf-8")


def _play_result(events: list[dict], title: str, runner) -> dict[str, object]:
    text = "".join(str(item.get("delta") or "") for item in events if item.get("type") == "text").strip()
    steps = [item.get("data") for item in events if item.get("type") == "data" and item.get("name") == "play_step"]
    deliverables = []
    for step in steps:
        if isinstance(step, dict):
            wire = str(step.get("wire") or "").strip()
            if wire:
                deliverables.append(wire)
    if not deliverables and text:
        deliverables = [line.strip() for line in text.splitlines() if line.strip()][:3]
    return {
        "title": title,
        "summary": text,
        "deliverables": deliverables,
        "quote_hint": "",
        "next_step": "如果结果和预期不一致，请记录反馈并带入下一版需求。",
        "mode": "teacher_playground",
        "model": getattr(runner, "model", ""),
        "usage": runner.budget.summary() if getattr(runner, "budget", None) else {},
        "events": events,
        "steps": steps,
    }


def run_runtime(project: Project, input_text: str, messages: list[WorkshopMessage] | None = None) -> dict[str, object]:
    cleaned = " ".join(input_text.split())
    if not cleaned:
        raise ValueError("请输入一段要试用的内容")
    teacher_engine._load_engine()
    from blueprint import chat, playground

    plan, workspace, prd = _teacher_plan(project)
    title = project.plan.title if project.plan else project.idea
    with _play_model() as (runner, model):
        # The teacher playground caches the role intro by plan fingerprint.
        intro = playground.play_intro(plan, workspace, model)
        transcript = [chat.Message(role=item.role, text=item.text) for item in (messages or [])]
        if not any(item.role == "user" and item.text.strip() == cleaned for item in transcript):
            transcript.append(chat.Message(role="user", text=cleaned))
        events = list(playground.play_events(plan, transcript, prd, model))
        result = _play_result(events, title, runner)
        result["intro"] = {**intro, "text": playground.intro_text(intro["role"])}
        return result


def verify_runtime(project: Project) -> PreviewArtifact:
    artifact = ensure_preview(project)
    try:
        result = run_runtime(project, "请按方案处理一条真实用户请求")
        if not result.get("summary"):
            raise ValueError("老师试玩没有返回可用回复")
        artifact.checks = [
            RuntimeCheck(id="runtime_page", label="运行时页面", status="passed", detail="页面路由已生成"),
            RuntimeCheck(id="health", label="健康检查", status="passed", detail="运行时可响应"),
            RuntimeCheck(id="core_action", label="核心动作", status="passed", detail=f"老师 playground 已返回回复 {result.get('model', '')}"),
        ]
        artifact.status = "verified"
        artifact.verified_at = now()
    except (ModelProviderError, ValueError) as exc:
        artifact.checks = [RuntimeCheck(id="core_action", label="核心动作", status="failed", detail=str(exc))]
        artifact.status = "failed"
        artifact.verified_at = None
    return artifact


def _json_script(data: dict[str, object]) -> str:
    return json.dumps(data, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def render_runtime_page(project: Project, action_url: str, health_url: str) -> str:
    title = project.plan.title if project.plan else project.idea
    summary = project.plan.summary if project.plan else "把一段输入整理成可继续确认的结果。"
    safe_title = escape(title)
    safe_summary = escape(summary)
    payload = _json_script({"title": title, "summary": summary, "actionUrl": action_url, "healthUrl": health_url})
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{safe_title} · 本地可运行预览</title>
<style>
:root {{ color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background:#f5f4ef; color:#243028; }}
* {{ box-sizing:border-box; }} body {{ margin:0; min-height:100vh; background:radial-gradient(circle at 20% 0%,#fffdf8 0 24%,transparent 54%),#f5f4ef; }}
main {{ width:min(820px,calc(100% - 32px)); margin:0 auto; padding:42px 0 64px; }}
.eyebrow {{ color:#6d7b72; font-size:11px; letter-spacing:.14em; text-transform:uppercase; }}
h1 {{ margin:12px 0 10px; font-size:clamp(28px,5vw,48px); letter-spacing:-.05em; line-height:1.05; }}
.summary {{ max-width:640px; color:#647168; line-height:1.7; }}
.runtime-note {{ display:inline-flex; gap:8px; align-items:center; margin-top:20px; padding:8px 11px; border:1px solid #c7d5c8; border-radius:999px; color:#2f5b3f; background:#edf4ed; font-size:12px; }}
.dot {{ width:7px; height:7px; border-radius:50%; background:#3d8a55; }}
.card {{ margin-top:28px; padding:22px; border:1px solid #d9ddd5; border-radius:14px; background:rgba(255,255,252,.86); box-shadow:0 20px 60px rgba(60,66,54,.08); }}
label {{ display:block; margin-bottom:9px; font-size:13px; font-weight:650; }} textarea {{ width:100%; min-height:150px; resize:vertical; padding:14px; border:1px solid #cbd4ca; border-radius:10px; outline:none; background:#fff; color:#243028; font:inherit; line-height:1.6; }} textarea:focus {{ border-color:#6c9272; box-shadow:0 0 0 3px rgba(83,132,91,.16); }}
button {{ margin-top:14px; padding:11px 15px; border:0; border-radius:8px; color:#fff; background:#2f4f3c; font:inherit; font-size:13px; font-weight:650; cursor:pointer; }} button:disabled {{ opacity:.55; cursor:wait; }}
.health {{ color:#718079; font-size:11px; }} .result {{ display:none; margin-top:20px; padding-top:20px; border-top:1px solid #e0e4dd; }} .result.show {{ display:block; }}
.result h2 {{ margin:0 0 10px; font-size:18px; }} .result p, .result li {{ color:#5e6d63; font-size:13px; line-height:1.7; }} .result ul {{ padding-left:20px; }}
.foot {{ margin-top:22px; color:#89948b; font-size:11px; line-height:1.6; }}
</style></head><body><main>
<div class="eyebrow">LOCAL RUNTIME PREVIEW</div><h1>{safe_title}</h1><p class="summary">{safe_summary}</p>
<div class="runtime-note"><span class="dot"></span><span>本地可运行预览 · 真实模型</span><span class="health" id="health">检查中…</span></div>
<section class="card"><form id="runtimeForm"><label for="source">输入一段真实需求</label><textarea id="source" placeholder="例如：客户需要一个两周内交付的报价单草稿，包含需求整理、交付范围和两轮修改。"></textarea><button id="run" type="submit">生成整理结果 ↗</button></form><div id="result" class="result"></div></section>
<p class="foot">本页面通过本地后端调用已配置的真实模型。失败时显示错误，不用示例结果替代。</p>
</main><script>
const runtime = {payload}; const form = document.querySelector('#runtimeForm'); const source = document.querySelector('#source'); const run = document.querySelector('#run'); const result = document.querySelector('#result'); const health = document.querySelector('#health');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[char]));
fetch(runtime.healthUrl).then(r => r.ok ? r.json() : Promise.reject()).then((payload) => health.textContent = payload.verified ? '运行正常 · 已验收' : '运行正常 · 待验收').catch(() => health.textContent = '运行检查失败');
form.addEventListener('submit', async (event) => {{ event.preventDefault(); if (!source.value.trim()) {{ source.focus(); return; }} run.disabled = true; run.textContent = '生成中…';
  try {{ const response = await fetch(runtime.actionUrl, {{ method:'POST', headers:{{'Content-Type':'application/json'}}, body:JSON.stringify({{input:source.value}}) }}); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || data.detail?.message || '运行失败'); const item = data.result; result.innerHTML = `<h2>${{escapeHtml(item.title)}}</h2><p>${{escapeHtml(item.summary)}}</p><strong>整理出的交付物</strong><ul>${{item.deliverables.map(value => `<li>${{escapeHtml(value)}}</li>`).join('')}}</ul><p><strong>模型：</strong>${{escapeHtml(item.model || '已调用')}}</p><p><strong>下一步：</strong>${{escapeHtml(item.next_step)}}</p>`; result.classList.add('show'); }} catch (error) {{ result.textContent = escapeHtml(error.message); result.classList.add('show'); }} finally {{ run.disabled = false; run.textContent = '生成整理结果 ↗'; }}
}});
</script></body></html>'''
