#!/usr/bin/env bash
# Bardic Dice — local LLM setup (macOS / Linux).
# Installs Ollama if needed, makes sure its server is running on
# 127.0.0.1:11434, pulls the recap-writer model, and smoke-tests the
# OpenAI-compatible endpoint the Foundry module talks to.
# Idempotent: safe to run again at any time.
#   ./setup-llm.sh                 # model llama3.1
#   BARDIC_LLM_MODEL=qwen2.5:7b ./setup-llm.sh
set -euo pipefail

MODEL="${BARDIC_LLM_MODEL:-llama3.1}"
HOST_PORT="${OLLAMA_HOST:-127.0.0.1:11434}"
BASE="http://${HOST_PORT}"
LOG_FILE="${TMPDIR:-/tmp}/bardic-ollama.log"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }

ollama_up() { curl -fsS --max-time 3 "${BASE}/api/tags" >/dev/null 2>&1; }

# 1. Install Ollama if missing ------------------------------------------------
if command -v ollama >/dev/null 2>&1; then
  say "Ollama found: $(ollama --version 2>/dev/null || echo '(version unknown)')"
else
  say "Installing Ollama…"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install ollama
      else
        warn "Homebrew not found; using the official installer from ollama.com."
        curl -fsSL https://ollama.com/install.sh | sh
      fi
      ;;
    Linux)
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    *)
      warn "Unsupported OS for this script. On Windows use setup-llm.bat."
      exit 1
      ;;
  esac
  command -v ollama >/dev/null 2>&1 || { warn "Ollama install did not put 'ollama' on PATH. Open a new terminal and re-run."; exit 1; }
fi

# 2. Make sure the server is running -----------------------------------------
if ollama_up; then
  say "Ollama server already answering on ${BASE}"
else
  say "Starting Ollama server (log: ${LOG_FILE})…"
  OLLAMA_HOST="${HOST_PORT}" nohup ollama serve >"${LOG_FILE}" 2>&1 &
  for i in $(seq 1 30); do
    if ollama_up; then break; fi
    if [ "$i" -eq 30 ]; then
      warn "Ollama did not come up on ${BASE}. Last log lines:"
      tail -n 20 "${LOG_FILE}" >&2 || true
      exit 1
    fi
    sleep 1
  done
  say "Ollama server is up on ${BASE}"
fi

# 3. Pull the recap-writer model (no-op if already downloaded) ---------------
say "Pulling model '${MODEL}' (first run downloads a few GB)…"
OLLAMA_HOST="${HOST_PORT}" ollama pull "${MODEL}"

# 4. Smoke-test the OpenAI-compatible endpoint Foundry will use --------------
say "Smoke-testing ${BASE}/v1/chat/completions…"
REPLY="$(curl -fsS --max-time 120 "${BASE}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: ready\"}]}")"
printf '%s' "${REPLY}" | grep -qi 'ready' || { warn "Unexpected smoke-test reply: ${REPLY}"; exit 1; }

cat <<EOF

Local LLM is running. In Foundry (Module Settings → Bardic Dice) set:
  Enable External LLM Recap Writer : on
  Summarizer API URL               : ${BASE}/v1
  Summarizer Model                 : ${MODEL}
  Summarizer API Key               : (leave blank)

Keep it running each session with ./start-llm.sh, or start both sidecars
(ACE-Step + LLM) with ./start-all.sh. Stop a background server started by
this script with:  pkill -f "ollama serve"
EOF
