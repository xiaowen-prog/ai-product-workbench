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
exec "$PYTHON_BIN" -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port "${AI_WORKBENCH_PORT:-8766}"
