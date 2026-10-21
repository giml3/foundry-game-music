#!/usr/bin/env bash
# Start the Bardic Dice services: local LLM (background) + parody core
# writer (background) + ACE-Step (foreground). Every service logs to a
# file under sidecar/logs/ so failures can be inspected after the fact:
#   logs/bardic-ollama.log · logs/bardic-parody.log · logs/bardic-ace.log
# Usage: ACE_STEP_HOME=/path/to/ACE-Step-1.5 ./start-all.sh
# Ctrl-C stops ACE-Step; the background services keep running (stop them
# with pkill -f "ollama serve" / pkill -f parody-writer).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${BARDIC_LOG_DIR:-${DIR}/logs}"
mkdir -p "${LOG_DIR}"
HOST_PORT="${OLLAMA_HOST:-127.0.0.1:11434}"
if curl -fsS --max-time 3 "http://${HOST_PORT}/api/tags" >/dev/null 2>&1; then
  echo "==> Local LLM already running on http://${HOST_PORT}"
elif command -v ollama >/dev/null 2>&1; then
  echo "==> Starting local LLM in the background (log: ${LOG_DIR}/bardic-ollama.log)…"
  { echo "=== ollama serve started $(date) ==="; OLLAMA_HOST="${HOST_PORT}" ollama serve; } >>"${LOG_DIR}/bardic-ollama.log" 2>&1 &
else
  echo "!! Ollama not installed — run ./setup-llm.sh once. Continuing without the LLM recap writer." >&2
fi
# Parody core writer — the module's primary lyric writer for every song.
PARODY_PORT_NUM="${PARODY_PORT:-8123}"
PARODY_DB_PATH="${PARODY_DB:-${DIR}/../lrclib.sqlite3}"
if curl -fsS --max-time 3 "http://127.0.0.1:${PARODY_PORT_NUM}/health" >/dev/null 2>&1; then
  echo "==> Parody writer already running on http://127.0.0.1:${PARODY_PORT_NUM}"
elif [ -f "${PARODY_DB_PATH}" ] && command -v node >/dev/null 2>&1; then
  echo "==> Starting parody writer in the background (log: ${LOG_DIR}/bardic-parody.log)…"
  nohup node "${DIR}/parody-writer.mjs" --db "${PARODY_DB_PATH}" --port "${PARODY_PORT_NUM}" >>"${LOG_DIR}/bardic-parody.log" 2>&1 &
else
  echo "!! LRCLIB database not found at ${PARODY_DB_PATH} (or node missing) — parody core writer not started; songs will use the fallback writers." >&2
fi
echo "==> Starting ACE-Step (foreground, log: ${LOG_DIR}/bardic-ace.log)…"
echo "=== ACE-Step started $(date) ===" >>"${LOG_DIR}/bardic-ace.log"
case "$(uname -s)" in
  Darwin) "${DIR}/start-api-macos.sh" 2>&1 | tee -a "${LOG_DIR}/bardic-ace.log" ;;
  *)      "${DIR}/start-api.sh" 2>&1 | tee -a "${LOG_DIR}/bardic-ace.log" ;;
esac
