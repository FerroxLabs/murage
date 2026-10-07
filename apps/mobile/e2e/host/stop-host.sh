#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../../../.." && pwd)
# shellcheck source=scripts/safe-wipe.sh
source "$APP/scripts/safe-wipe.sh"   # the only recursive delete scripts may use
# No host.env: nothing to stop, but a lock our caller holds (a start that was
# killed before it wrote host.env) is released. Anyone else's lock stays.
if [[ ! -f "$HERE/host.env" ]]; then
  [[ -f "$HERE/host.lock/pid" && "$(cat "$HERE/host.lock/pid")" == "${E2E_LOCK_OWNER:-$PPID}" ]] && SAFE_WIPE_WITHIN="$HERE" safe_wipe "$HERE/host.lock"
  exit 0
fi
source "$HERE/host.env"
source "$HERE/own-pid.sh"
"$HERE/door.sh" stop
[[ -n "${SERVER_PID:-}" ]] && kill_own "$SERVER_PID" 28799 server/index.ts
for _ in $(seq 1 40); do lsof -nP -iTCP:28799 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
busy=0
for port in 28799 28800 28810 28811 28813; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $port still in use" >&2; busy=1; }
done
# Keep host.env (the PIDs) and the data while anything still runs, for a retry.
[[ $busy == 0 ]] || { echo "isolated host NOT fully stopped; host.env kept" >&2; exit 1; }
# Only ever the throwaway directory run-host.sh made.
case "$DATA" in
  *..*) echo "refusing to delete unexpected DATA=$DATA" >&2 ;;
  /tmp/murage-e2e-data-*|/private/tmp/murage-e2e-data-*) safe_wipe "$DATA" ;;
  *) echo "refusing to delete unexpected DATA=$DATA" >&2 ;;
esac
SAFE_WIPE_WITHIN="$HERE" safe_wipe "$HERE/companion-data"
rm -f "$HERE/host.env"  # one file, not a tree: safe_wipe would refuse it under a symlinked TMPDIR (/var -> /private/var)
SAFE_WIPE_WITHIN="$HERE" safe_wipe "$HERE/host.lock"
echo "isolated host stopped"
