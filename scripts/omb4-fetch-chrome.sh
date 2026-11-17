#!/usr/bin/env bash
# Fetch the pinned Chrome for Testing headless shell (build input D039) for the
# OMB4 real-Chromium ownership witness. Fails closed: any fetch, size, hash or
# launch failure exits non-zero and prints no path.
# usage: scripts/omb4-fetch-chrome.sh OUTPUT_DIR   (prints the executable path)
set -euo pipefail
out=${1:?usage: omb4-fetch-chrome.sh OUTPUT_DIR}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$out"
zip="$out/chrome-headless-shell-linux64.zip"
rm -f "${zip:?}"
node "$root/scripts/fetch-build-input.mjs" D039 "$zip" >&2
want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).D039.sha256)' "$root/scripts/build-inputs.json")
printf '%s  %s\n' "$want" "$zip" | sha256sum -c - >&2
unzip -q -o "$zip" -d "$out" >&2
chrome="$out/chrome-headless-shell-linux64/chrome-headless-shell"
test -x "$chrome"
"$chrome" --version >&2
printf '%s\n' "$chrome"
