#!/usr/bin/env bash
# mkhome.sh <fakehome> — create a fake HOME with a fake .murage full of marker
# files, then write <fakehome>.manifest listing them. checkhome.sh reads it.
# The target must carry a scratch marker or live under the OS temp dir; this
# script replaces it.
set -euo pipefail
H=$1
case "$H" in *scratch*|*evidence*|*.e2e*|*repro-homes*|"${TMPDIR:-/tmp}"/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;;
  *) echo "mkhome.sh: refusing $H (not a scratch or temp path)" >&2; exit 2 ;;
esac
rm -rf "$H"
mkdir -p "$H/.murage/events" "$H/.murage/native" "$H/.murage/memory" "$H/.murage/workspaces/bot1" "$H/.murage/attachments" "$H/.murage-companion" "$H/.opengrokbot"
for f in messages.db config.json bots.json groups.json memory/index.db workspaces/bot1/notes.md attachments/a.png events/e1.json native/transcript.ndjson; do echo "MARKER-$f" > "$H/.murage/$f"; done
echo '{"instances":{}}' > "$H/.murage/config.json"
echo "MARKER-companion" > "$H/.murage-companion/devices.json"
echo "MARKER-legacy" > "$H/.opengrokbot/legacy.json"
find "$H" -type f | sort > "$H.manifest"
