#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_DIR="${RESTART_CHECK_DIR:-$ROOT_DIR/.restart-check}"
PORT="${AGENT_RESTART_PORT:-8791}"
PID_FILE="$CHECK_DIR/server.pid"

mkdir -p "$CHECK_DIR"
export AGENT_DATA_DIR="$CHECK_DIR/data"
export AGENT_DB_PATH="$CHECK_DIR/data/restart.sqlite3"
export AGENT_ARTIFACT_DIR="$CHECK_DIR/data/artifacts"

case "${1:-}" in
  start)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "restart-check server already running" >&2
      exit 1
    fi
    cd "$ROOT_DIR/backend"
    nohup "$ROOT_DIR/backend/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$PORT" >"$CHECK_DIR/server.log" 2>&1 &
    pid=$!
    echo "$pid" > "$PID_FILE"
    for _ in $(seq 1 50); do
      if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo "$pid"
        exit 0
      fi
      sleep 0.1
    done
    echo "restart-check server did not become ready" >&2
    kill "$pid" 2>/dev/null || true
    exit 1
    ;;
  write)
    marker="${2:?marker is required}"
    response=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/tasks" -H 'Content-Type: application/json' -d "{\"title\":\"restart-check\",\"brief\":\"$marker\"}")
    python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$response"
    ;;
  read)
    id="${2:?id is required}"
    curl -fsS "http://127.0.0.1:$PORT/api/v1/tasks/$id" | python3 -c 'import json,sys; print(json.load(sys.stdin)["brief"])'
    ;;
  stop)
    if [[ -f "$PID_FILE" ]]; then
      pid=$(cat "$PID_FILE")
      kill "$pid" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    ;;
  *)
    echo "usage: $0 start|write <marker>|read <id>|stop" >&2
    exit 2
    ;;
esac
