#!/usr/bin/env bash
# Sync this dev build into Foundry's installed modules folder.
#
# Foundry only ever loads modules from its Data folder — editing this repo
# alone changes nothing on screen. Run this after changing anything here,
# then reload the world in Foundry (or press F5 in the app).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/"
DEST="$HOME/Library/Application Support/FoundryVTT/Data/modules/foundry-game-music/"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude 'lrclib-db-dump-*.sqlite3.gz' \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'tests/' \
  "$SRC" "$DEST"
echo "Bardic Dice synced: $SRC -> $DEST"
echo "Now reload Foundry so it loads the new build."
