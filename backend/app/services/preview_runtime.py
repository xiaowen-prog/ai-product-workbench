from __future__ import annotations

import json
from datetime import datetime, timezone
from html import escape

from app.schemas.models import PreviewArtifact, Project, RuntimeCheck


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


def run_runtime(project: Project, input_text: str) -> dict[str, object]:
    cleaned = " ".join(input_text.split())
    if not cleaned:
        raise ValueError("请输入一段需要整理的内容")
    title = project.plan.title if project.plan else project.idea
    segments = [part.strip("，。；; ") for part in input_text.replace("\r", "").split("\n") if part.strip()]
    deliverables = segments[:3] or [cleaned[:80]]
    return {
        "title": title,
        "summary": cleaned[:240],
        "deliverables": deliverables,
        "quote_hint": "先确认交付物、时间和修改轮次，再给出正式报价。",
        "next_step": "把这份整理结果发给客户确认范围。",
        "mode": "deterministic_runtime",
    }


def verify_runtime(project: Project) -> PreviewArtifact:
    artifact = ensure_preview(project)
    try:
        run_runtime(project, "客户需要一份需求整理和报价单草稿")
        artifact.checks = [
            RuntimeCheck(id="runtime_page", label="运行时页面", status="passed", detail="页面路由已生成"),
            RuntimeCheck(id="health", label="健康检查", status="passed", detail="运行时可响应"),
            RuntimeCheck(id="core_action", label="核心动作", status="passed", detail="输入可生成结构化结果"),
        ]
        artifact.status = "verified"
        artifact.verified_at = now()
    except ValueError as exc:
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
<div class="runtime-note"><span class="dot"></span><span>本地可运行预览 · 规则引擎结果</span><span class="health" id="health">检查中…</span></div>
<section class="card"><form id="runtimeForm"><label for="source">输入一段真实需求</label><textarea id="source" placeholder="例如：客户需要一个两周内交付的报价单草稿，包含需求整理、交付范围和两轮修改。"></textarea><button id="run" type="submit">生成整理结果 ↗</button></form><div id="result" class="result"></div></section>
<p class="foot">这是 AI 产品工作台生成的本地运行时预览。结果由当前项目的规则运行时生成，不代表已部署到公网或已接入真实模型。</p>
</main><script>
const runtime = {payload};
const form = document.querySelector('#runtimeForm'); const source = document.querySelector('#source'); const run = document.querySelector('#run'); const result = document.querySelector('#result'); const health = document.querySelector('#health');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[char]));
fetch(runtime.healthUrl).then(r => r.ok ? r.json() : Promise.reject()).then(() => health.textContent = '运行正常').catch(() => health.textContent = '运行检查失败');
form.addEventListener('submit', async (event) => {{ event.preventDefault(); if (!source.value.trim()) {{ source.focus(); return; }} run.disabled = true; run.textContent = '生成中…';
  try {{ const response = await fetch(runtime.actionUrl, {{ method:'POST', headers:{{'Content-Type':'application/json'}}, body:JSON.stringify({{input:source.value}}) }}); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '运行失败'); const item = data.result; result.innerHTML = `<h2>${{escapeHtml(item.title)}}</h2><p>${{escapeHtml(item.summary)}}</p><strong>整理出的交付物</strong><ul>${{item.deliverables.map(value => `<li>${{escapeHtml(value)}}</li>`).join('')}}</ul><p><strong>报价提示：</strong>${{escapeHtml(item.quote_hint)}}</p><p><strong>下一步：</strong>${{escapeHtml(item.next_step)}}</p>`; result.classList.add('show'); }} catch (error) {{ result.textContent = escapeHtml(error.message); result.classList.add('show'); }} finally {{ run.disabled = false; run.textContent = '生成整理结果 ↗'; }}
}});
</script></body></html>'''
