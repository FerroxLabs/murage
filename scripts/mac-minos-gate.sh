#!/usr/bin/env bash
# The minimum macOS of a packaged Murage.app must not rise. Reads bytes only, launches nothing.
# Usage: mac-minos-gate.sh <Murage.app> <evidence.json>
#  - A binary above the app's LSMinimumSystemVersion fails unless it lives in a component listed here.
#  - Those components are capped too: nothing above 14.8 except the prebuilt cloudflared (15.0).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$1"; out="$2"
known='^Contents/Resources/(backup-tools|browser-engine|cua-driver|cua-sdk|server|gepa-worker|cloudflared)(/|$)'
node "$here/mac-minos-report.mjs" "$app" --allow "$known" > "$out"
node "$here/mac-minos-report.mjs" "$app" --limit 14.8 --allow '^Contents/Resources/cloudflared/cloudflared$' > "${out%.json}-cap.json"
node "$here/mac-minos-report.mjs" "$app" --limit 15.0 > "${out%.json}-top.json"
