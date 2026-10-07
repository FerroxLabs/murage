#!/usr/bin/env bash
# An isolated Murage for the phone E2E: fake engine, temp data, ports
# 28799/28800 (server) and 28810/28811/28813 (door). Never the live app's ports.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../../../.." && pwd)
# shellcheck source=scripts/safe-wipe.sh
source "$APP/scripts/safe-wipe.sh"   # the only recursive delete scripts may use
source "$HERE/tailscale-cli.sh"
[[ -f "$HERE/web-dist/index.html" ]] || { echo "run build-web-dist.sh first" >&2; exit 1; }
[[ ! -f "$HERE/host.env" ]] || { echo "host.env exists: an isolated host may be running; run stop-host.sh first" >&2; exit 1; }
# One isolated host at a time, taken atomically, so two E2E runs that both saw
# no host.env cannot both start one. The owner is the process that asked for
# the host (this script's parent: the E2E script, or your shell), recorded in
# host.lock/pid. stop-host.sh releases it; a start that fails before host.env
# is written releases it here. "is busy" is the refusal the E2E scripts
# recognise as someone else's host (they arm no teardown).
LOCK="$HERE/host.lock"
OWNER=${E2E_LOCK_OWNER:-$PPID}
take_lock() { mkdir "$LOCK" 2>/dev/null && echo "$OWNER" > "$LOCK/pid"; }
listening() {
  local port
  for port in 28799 28800 28810 28811 28813; do lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0; done
  return 1
}
if ! take_lock; then
  held=$(cat "$LOCK/pid" 2>/dev/null || true)
  # Stale only when nothing can be using it: no host.env (checked above), its
  # owner is gone (or never wrote its pid), and no isolated port is listening.
  if [[ "$held" =~ ^[0-9]+$ ]] && kill -0 "$held" 2>/dev/null || listening; then
    echo "the isolated host is busy: host.lock is held by another run (pid ${held:-unknown})" >&2; exit 1
  fi
  # Take it over by renaming (atomic, so only one run can win), and only if
  # what was renamed is still the stale lock that was judged.
  aside="$HERE/host.lock.stale.$$"
  mv "$LOCK" "$aside" 2>/dev/null || { echo "the isolated host is busy: host.lock changed hands" >&2; exit 1; }
  if [[ "$(cat "$aside/pid" 2>/dev/null || true)" != "$held" ]]; then
    mv "$aside" "$LOCK" 2>/dev/null
    echo "the isolated host is busy: host.lock changed hands" >&2; exit 1
  fi
  SAFE_WIPE_WITHIN="$HERE" safe_wipe "$aside"
  echo "took over a stale host.lock (owner ${held:-unknown} is gone, no isolated port listening)" >&2
  take_lock || { echo "the isolated host is busy: host.lock is held by another run" >&2; exit 1; }
fi
trap '[[ -f "$HERE/host.env" ]] || { SAFE_WIPE_WITHIN="$HERE" safe_wipe "$LOCK"; }' EXIT
for port in 28799 28800 28810 28811 28813; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is busy" >&2; exit 1; fi
done
TS_HOST=$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[[ -n "$TS_HOST" ]] || { echo "no MagicDNS name from tailscale status" >&2; exit 1; }
NODE=$(command -v node)
DATA=$(mktemp -d /tmp/murage-e2e-data-XXXX)
mkdir -p "$DATA/tmp" "$DATA/finish-fake" "$HERE/companion-data"
cat > "$DATA/config.json" <<J
{"instances":{"verification":{"driver":"claudeAgent","displayName":"Verification fixture","config":{"cli":"$APP/server/testing/fake-claude-cli.ts"}}}}
J
(
  umask 077
  {
    echo "DATA=$DATA"
    echo "TS_HOST=$TS_HOST"
    echo "COMPANION_TOKEN=$(openssl rand -hex 32)"
  } > "$HERE/host.env"
)
chmod 600 "$HERE/host.env"
source "$HERE/host.env"
cd "$APP"
# Push: set PUSH_RELAY=<relay origin> to turn it on (Plan 3b device checks).
# Off otherwise: the host's default is the real relay, and this host is a test.
env -i HOME="$DATA" MURAGE_PUSH_RELAY_URL="${PUSH_RELAY:-off}" TMPDIR="$DATA/tmp" MURAGE_DATA_DIR="$DATA" MURAGE_STATIC_DIR="$HERE/web-dist" \
  MURAGE_ALLOW_DEV_DESKTOP_SECRET=1 MURAGE_PORT=28799 MURAGE_WEBHOOK_PORT=28800 MURAGE_COMPANION_TOKEN="$COMPANION_TOKEN" \
  FAKE_CLAUDE_MODE=happy FAKE_CLAUDE_DUMP="$DATA/fake-dump.json" FAKE_CLAUDE_FINISH_GATE_DIR="$DATA/finish-fake" PATH="" \
  "$NODE" --experimental-strip-types server/index.ts > "$HERE/server.log" 2>&1 &
echo "SERVER_PID=$!" >> "$HERE/host.env"
up=0
for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:28799/ && { up=1; break; }; sleep 0.5; done
[[ $up == 1 ]] || { echo "server did not start; see server.log (run stop-host.sh to clean up)" >&2; exit 1; }
"$HERE/door.sh" start
echo "isolated host up: https://$TS_HOST:8444 (after serve.sh up)"
