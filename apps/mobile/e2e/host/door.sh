#!/usr/bin/env bash
# The isolated browser door. reset = a door that has never seen this phone:
# its cookie becomes unknown, so the next page load is a 401 (re-pair).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../../../.." && pwd)
# shellcheck source=scripts/safe-wipe.sh
source "$APP/scripts/safe-wipe.sh"   # the only recursive delete scripts may use
source "$HERE/host.env"
source "$HERE/own-pid.sh"

start() {
  if lsof -nP -iTCP:28813 -sTCP:LISTEN >/dev/null 2>&1; then echo "port 28813 is busy" >&2; exit 1; fi
  mkdir -p "$HERE/companion-data"
  cd "$APP"
  env -i HOME="$DATA" TMPDIR="$DATA/tmp" PATH=/usr/bin:/bin MURAGE_PORT=28799 MURAGE_WEBHOOK_PORT=28800 \
    MURAGE_COMPANION_PORT=28810 MURAGE_COMPANION_BIND=off MURAGE_CONTROL_PORT=28811 \
    MURAGE_BROWSER_PORT=28813 MURAGE_BROWSER_BIND=loopback MURAGE_COMPANION_DIR="$HERE/companion-data" \
    MURAGE_COMPANION_NAME="E2E Murage" MURAGE_COMPANION_TOKEN="$COMPANION_TOKEN" E2E_TS_HOST="$TS_HOST" \
    "$(command -v node)" --require "$HERE/fake-serve-preload.cjs" --experimental-strip-types companion/src/index.ts >> "$HERE/companion.log" 2>&1 &
  echo $! > "$HERE/door.pid"
  for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:28813/healthz && return 0; sleep 0.5; done
  echo "door did not start; see companion.log" >&2
  exit 1
}

stop() {
  if [[ -f "$HERE/door.pid" ]]; then
    kill_own "$(cat "$HERE/door.pid")" 28813 companion/src/index.ts "$HERE/fake-serve-preload.cjs" || true
    rm -f "$HERE/door.pid"
  fi
  for _ in $(seq 1 40); do lsof -nP -iTCP:28813 -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.25; done
  echo "door still listening on 28813" >&2
  return 1
}

case ${1:?start|stop|reset} in
  start) start ;;
  stop) stop ;;
  reset) stop; SAFE_WIPE_WITHIN="$HERE" safe_wipe "$HERE/companion-data"; start ;;
esac
