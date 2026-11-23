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
  export MODEL_API_KEY="${ANTHROPIC_API_KEY:-}"
  export MODEL_BASE_URL="${MODEL_BASE_URL:-https://api.deepseek.com/v1}"
  export MODEL_NAME="${MODEL_NAME:-${MODEL_ID:-deepseek-chat}}"
fi

# 老师开发项目的真实 Agent adapter 使用 AGENT_MODEL_* 命名。
# 统一映射到同一份后端运行时配置，不把密钥写进页面或代码。
export AGENT_MODEL_PROVIDER="${AGENT_MODEL_PROVIDER:-openai-compatible}"
export AGENT_MODEL_API_KEY="${AGENT_MODEL_API_KEY:-${MODEL_API_KEY:-}}"
export AGENT_MODEL_BASE_URL="${AGENT_MODEL_BASE_URL:-${MODEL_BASE_URL:-https://api.deepseek.com/v1}}"
export AGENT_MODEL="${AGENT_MODEL:-${MODEL_NAME:-deepseek-chat}}"
export AGENT_MODEL_TIMEOUT_SECONDS="${AGENT_MODEL_TIMEOUT_SECONDS:-${MODEL_TIMEOUT_SECONDS:-45}}"

# Agent 工坊的原始 Runner 走 OpenAI-compatible 分支，继续复用同一后端密钥。
export API_FORMAT="${API_FORMAT:-openai}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-${AGENT_MODEL_API_KEY:-}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${AGENT_MODEL_BASE_URL:-}}"
export MODEL_ID="${MODEL_ID:-${AGENT_MODEL:-}}"
export BLUEPRINT_TIMEOUT="${BLUEPRINT_TIMEOUT:-120}"

cd "${WORKBENCH_ROOT}"
export IDEA_TO_LAUNCH_KIT_ROOT="${IDEA_TO_LAUNCH_KIT_ROOT:-${WORKBENCH_ROOT}/.local/teacher-dev/launch-kit}"
export DATA_BACKEND=sql
exec "${PYTHON_BIN}" -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port "${PORT_NUMBER}"
