#!/usr/bin/env bash
set -euo pipefail

WORKBENCH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_NUMBER="${PORT:-8770}"
PYTHON_BIN="${PYTHON_BIN:-${WORKBENCH_ROOT}/.venv/bin/python}"

if [ ! -x "${PYTHON_BIN}" ]; then
  PYTHON_BIN="python3"
fi

if [ -f "${WORKBENCH_ROOT}/backend/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${WORKBENCH_ROOT}/backend/.env"
  set +a
fi

# 复用此前已经配置在本机老师引擎里的 DeepSeek Key，不复制到前端或仓库。
if [ -z "${MODEL_API_KEY:-}" ] && [ -f "${WORKBENCH_ROOT}/.local/teacher-engine/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${WORKBENCH_ROOT}/.local/teacher-engine/.env"
  set +a
  # 老师源码的 DeepSeek 配置是 Anthropic Messages 兼容地址；保留原地址和 MODEL_ID，
  # 不把它强行改成 OpenAI /v1，否则 deepseek-v4-flash 会收到错误协议并返回 502。
  export MODEL_API_KEY="${MODEL_API_KEY:-${ANTHROPIC_API_KEY:-${OPENAI_API_KEY:-}}}"
  export MODEL_BASE_URL="${MODEL_BASE_URL:-${ANTHROPIC_BASE_URL:-${OPENAI_BASE_URL:-https://api.deepseek.com/v1}}}"
  export MODEL_NAME="${MODEL_NAME:-${MODEL_ID:-${OPENAI_MODEL:-deepseek-chat}}}"
fi

# 老师开发项目的原有 Task adapter 使用 AGENT_MODEL_* 命名。若没有单独的
# OpenAI 兼容配置，保留它原来的 /v1 默认值；老师 Agent 自己使用上面的
# MODEL_BASE_URL / MODEL_NAME。
export AGENT_MODEL_PROVIDER="${AGENT_MODEL_PROVIDER:-openai-compatible}"
export AGENT_MODEL_API_KEY="${AGENT_MODEL_API_KEY:-${MODEL_API_KEY:-}}"
export AGENT_MODEL_BASE_URL="${AGENT_MODEL_BASE_URL:-${OPENAI_BASE_URL:-https://api.deepseek.com/v1}}"
export AGENT_MODEL="${AGENT_MODEL:-${OPENAI_MODEL:-deepseek-chat}}"
export AGENT_MODEL_TIMEOUT_SECONDS="${AGENT_MODEL_TIMEOUT_SECONDS:-${MODEL_TIMEOUT_SECONDS:-45}}"

# 只有显式配置 OpenAI 格式时才使用 OpenAI；老师源码默认走 Anthropic 兼容协议。
export API_FORMAT="${API_FORMAT:-anthropic}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-${AGENT_MODEL_API_KEY:-}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${AGENT_MODEL_BASE_URL:-}}"
export MODEL_ID="${MODEL_ID:-${MODEL_NAME:-${AGENT_MODEL:-}}}"
export BLUEPRINT_TIMEOUT="${BLUEPRINT_TIMEOUT:-120}"

cd "${WORKBENCH_ROOT}"
export IDEA_TO_LAUNCH_KIT_ROOT="${IDEA_TO_LAUNCH_KIT_ROOT:-${WORKBENCH_ROOT}/.local/teacher-dev/launch-kit}"
export DATA_BACKEND=sql
exec "${PYTHON_BIN}" -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port "${PORT_NUMBER}"
