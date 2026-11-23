#!/usr/bin/env python3
"""Run one real AgentRun smoke test and append a machine-written record.

The script never prints or stores a model key, prompt, or response body.  It
only writes a record after the backend has accepted a real run, so a missing
credential cannot accidentally look like a passed smoke test.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path
from time import perf_counter
from typing import Any

import httpx


PRODUCT_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = PRODUCT_ROOT / "backend" / ".env"
RECORD_FILE = PRODUCT_ROOT / "docs" / "evidence" / "阶段4" / "冒烟记录.md"


def _read_env_file() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.is_file():
        return values
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _setting(name: str, values: dict[str, str], *aliases: str) -> str:
    for candidate in (name, *aliases):
        value = os.getenv(candidate, values.get(candidate, "")).strip()
        if value:
            return value
    return ""


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except (ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _append_record(*, provider: str, model: str, run: dict[str, Any], duration: float) -> None:
    RECORD_FILE.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# 冒烟记录（冒烟脚本自动写入，不得手填）\n"
        "- 产品：自主Agent工作台\n"
        "- 阶段：阶段4\n"
        f"- 模型：{provider} / {model}\n"
        f"- 写入时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        "| 时间 | 链路 | 请求 ID | 输入 token | 输出 token | 首字耗时 | 总耗时 | 结构校验 | 重试次数 | 结果 |\n"
        "| --- | --- | --- | ---: | ---: | --- | --- | --- | ---: | --- |\n"
    )
    steps = run.get("steps") if isinstance(run.get("steps"), list) else []
    step = steps[0] if steps and isinstance(steps[0], dict) else {}
    result = step.get("result") if isinstance(step.get("result"), dict) else {}
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    status = "通过" if run.get("status") == "completed" else "失败"
    request_id = str(result.get("request_id") or "-").replace("|", "")
    input_tokens = usage.get("prompt_tokens", "-")
    output_tokens = usage.get("completion_tokens", "-")
    retries = max(0, int(step.get("attempts", 1) or 1) - 1)
    line = (
        f"| {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | AgentRun 真实模型步骤 | {request_id} | "
        f"{input_tokens} | {output_tokens} | - | {duration:.2f}s | 结构已校验 | {retries} | {status} |\n"
    )
    if not RECORD_FILE.exists():
        RECORD_FILE.write_text(header + line, encoding="utf-8")
        return
    existing = RECORD_FILE.read_text(encoding="utf-8")
    existing_model = ""
    for existing_line in existing.splitlines():
        if existing_line.startswith("- 模型："):
            existing_model = existing_line.removeprefix("- 模型：").strip()
            break
    current_model = f"{provider} / {model}"
    if existing_model and existing_model != current_model:
        RECORD_FILE.write_text(header + line + "\n" + existing, encoding="utf-8")
        return
    with RECORD_FILE.open("a", encoding="utf-8") as handle:
        handle.write(line)


def main() -> int:
    values = _read_env_file()
    api_key = _setting("AGENT_MODEL_API_KEY", values, "OPENAI_API_KEY")
    base_url = _setting("AGENT_MODEL_BASE_URL", values, "OPENAI_BASE_URL")
    model = _setting("AGENT_MODEL", values, "OPENAI_MODEL")
    provider = _setting("AGENT_MODEL_PROVIDER", values, "MODEL_PROVIDER") or "openai-compatible"
    if not api_key or not base_url or not model:
        print("真实模型冒烟：待验（backend/.env 未配置完整的 AGENT_MODEL_*，未发起模型调用）")
        return 2

    api_base = os.getenv("SMOKE_API_BASE", "http://127.0.0.1:8790").rstrip("/")
    title = f"smoke-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    started = perf_counter()
    try:
        with httpx.Client(timeout=120.0) as client:
            task_response = client.post(
                f"{api_base}/api/v1/tasks",
                json={"title": title, "brief": "用真实模型验证 Agent 工作台的最短可交付链路。"},
            )
            if task_response.status_code != 201:
                print(f"真实模型冒烟：失败（创建任务 HTTP {task_response.status_code}，未进入模型调用）")
                return 1
            task = _json(task_response)
            task_id = task.get("id")
            if not isinstance(task_id, str) or not task_id:
                print("真实模型冒烟：失败（后端未返回任务 ID，未进入模型调用）")
                return 1
            run_response = client.post(
                f"{api_base}/api/v1/tasks/{task_id}/agent-runs",
                json={"execution_mode": "real", "max_steps": 1, "max_retries": 1},
            )
            duration = perf_counter() - started
            if run_response.status_code != 201:
                error = _json(run_response).get("error")
                code = error.get("code") if isinstance(error, dict) else "unknown"
                print(f"真实模型冒烟：失败（AgentRun HTTP {run_response.status_code}，错误码 {code}）")
                return 1
            run = _json(run_response)
            status = run.get("status")
            steps = run.get("steps") if isinstance(run.get("steps"), list) else []
            first_step = steps[0] if steps and isinstance(steps[0], dict) else {}
            result = first_step.get("result") if isinstance(first_step, dict) and isinstance(first_step.get("result"), dict) else {}
            usage = result.get("usage") if isinstance(result, dict) else None
            if status == "completed" and (not isinstance(usage, dict) or not usage.get("prompt_tokens") or not usage.get("completion_tokens")):
                print("真实模型冒烟：失败（后端完成了 real run，但没有返回真实模型 usage，拒绝写入通过记录）")
                return 1
            _append_record(provider=provider, model=model, run=run, duration=duration)
            error_code = first_step.get("error_code") if isinstance(first_step, dict) else None
            detail = f"，错误码 {error_code}" if status != "completed" and error_code else ""
            print(f"真实模型冒烟：{'通过' if status == 'completed' else '失败'}（{provider} / {model}，耗时 {duration:.2f}s{detail}，记录已写入冒烟记录.md）")
            return 0 if status == "completed" else 1
    except httpx.RequestError:
        print(f"真实模型冒烟：待验（无法连接后端 {api_base}，未写入冒烟记录）")
        return 2


if __name__ == "__main__":
    sys.exit(main())
