#!/usr/bin/env bash
# Run the Bardic Dice LRCLIB parody writer in the foreground. Ctrl-C stops it.
# One-time: gzip -dc lrclib-db-dump-20261012T090639Z.sqlite3.gz > lrclib.sqlite3
# (check disk space first — the decompressed dump is large). Ollama must be
# running too (./start-llm.sh); the writer uses the same tiny model.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="${PARODY_DB:-${DIR}/lrclib.sqlite3}"
[ -f "${DB}" ] || { echo "LRCLIB database not found at ${DB}. Decompress the dump once:" >&2; echo "  gzip -dc \"${DIR}/lrclib-db-dump-20261012T090639Z.sqlite3.gz\" > \"${DIR}/lrclib.sqlite3\"" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required for the parody writer." >&2; exit 1; }
exec node "${DIR}/sidecar/parody-writer.mjs" --db "${DB}" --port "${PARODY_PORT:-8123}"
