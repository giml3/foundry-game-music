#!/usr/bin/env bash
# Keep the Bardic Dice local LLM (Ollama) running in the foreground.
# Run setup-llm.sh once first. Ctrl-C stops it.
set -euo pipefail
HOST_PORT="${OLLAMA_HOST:-127.0.0.1:11434}"
if curl -fsS --max-time 3 "http://${HOST_PORT}/api/tags" >/dev/null 2>&1; then
  echo "Ollama is already running on http://${HOST_PORT} — nothing to do."
  exit 0
fi
command -v ollama >/dev/null 2>&1 || { echo "Ollama not installed. Run ./setup-llm.sh first." >&2; exit 1; }
export OLLAMA_HOST="${HOST_PORT}"
exec ollama serve
