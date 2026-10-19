#!/usr/bin/env bash
# macOS (Apple Silicon / MLX) launcher. Prefer upstream's start_api_server_macos.sh when present.
set -euo pipefail
ACE_STEP_HOME="${ACE_STEP_HOME:-$HOME/ACE-Step-1.5}"
export ACESTEP_API_HOST="${ACESTEP_API_HOST:-127.0.0.1}"
export ACESTEP_API_PORT="${ACESTEP_API_PORT:-8001}"
cd "$ACE_STEP_HOME"
if [ -x ./start_api_server_macos.sh ]; then exec ./start_api_server_macos.sh; fi
if command -v uv >/dev/null 2>&1; then exec uv run python -m acestep.api_server; else exec python -m acestep.api_server; fi
