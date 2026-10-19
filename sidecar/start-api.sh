#!/usr/bin/env bash
# Start the ACE-Step 1.5 API sidecar for Bardic Dice (Linux / CUDA; macOS: use start-api-macos.sh).
# Usage: ACE_STEP_HOME=/path/to/ACE-Step-1.5 ./start-api.sh
set -euo pipefail
ACE_STEP_HOME="${ACE_STEP_HOME:-$HOME/ACE-Step-1.5}"
export ACESTEP_API_HOST="${ACESTEP_API_HOST:-127.0.0.1}"
export ACESTEP_API_PORT="${ACESTEP_API_PORT:-8001}"
export ACESTEP_CONFIG_PATH="${ACESTEP_CONFIG_PATH:-acestep-v15-turbo}"
cd "$ACE_STEP_HOME"
if command -v uv >/dev/null 2>&1; then
  exec uv run python -m acestep.api_server
else
  exec python -m acestep.api_server
fi
