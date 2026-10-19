#!/usr/bin/env bash
# Start BOTH Bardic Dice sidecars: local LLM (background) + ACE-Step (foreground).
# Usage: ACE_STEP_HOME=/path/to/ACE-Step-1.5 ./start-all.sh
# Ctrl-C stops ACE-Step; the LLM keeps running (stop it with pkill -f "ollama serve").
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PORT="${OLLAMA_HOST:-127.0.0.1:11434}"
if curl -fsS --max-time 3 "http://${HOST_PORT}/api/tags" >/dev/null 2>&1; then
  echo "==> Local LLM already running on http://${HOST_PORT}"
elif command -v ollama >/dev/null 2>&1; then
  echo "==> Starting local LLM in the background (log: ${TMPDIR:-/tmp}/bardic-ollama.log)…"
  OLLAMA_HOST="${HOST_PORT}" nohup ollama serve >"${TMPDIR:-/tmp}/bardic-ollama.log" 2>&1 &
else
  echo "!! Ollama not installed — run ./setup-llm.sh once. Continuing without the LLM recap writer." >&2
fi
echo "==> Starting ACE-Step (foreground)…"
case "$(uname -s)" in
  Darwin) exec "${DIR}/start-api-macos.sh" ;;
  *)      exec "${DIR}/start-api.sh" ;;
esac
