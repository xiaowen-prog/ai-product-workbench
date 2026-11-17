#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f backend/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . backend/.env
  set +a
fi
PYTHON_BIN="${AI_WORKBENCH_PYTHON:-$ROOT/.venv/bin/python}"
if [ -x "$ROOT/backend/.venv/bin/python" ]; then
  PYTHON_BIN="$ROOT/backend/.venv/bin/python"
fi
HOST="${AI_WORKBENCH_HOST:-0.0.0.0}"
PORT="${PORT:-${AI_WORKBENCH_PORT:-8766}}"
exec "$PYTHON_BIN" -m uvicorn app.main:app --app-dir backend --host "$HOST" --port "$PORT"
