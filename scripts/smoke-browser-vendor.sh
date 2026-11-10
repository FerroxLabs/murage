#!/bin/bash
# smoke-browser-vendor.sh <engine-binary>: run on the runner that matches the target, never on a developer machine.
# Fresh 64-hex token in env. Stream port /api/status: no header 401, wrong bearer 401, right bearer 200;
# WebSocket upgrade: no header 401, wrong 401, right 101. Then close and confirm the daemon exited (exact pid).
set -u
BIN=${1:?usage: smoke-browser-vendor.sh <engine-binary> <set> <target>}
SET=${2:?usage: smoke-browser-vendor.sh <engine-binary> <set> <target>}
TARGET=${3:?usage: smoke-browser-vendor.sh <engine-binary> <set> <target>}
REPO=$(cd "$(dirname "$0")/.." && pwd)
# The real version gate first: run the engine and apply Murage's own launch comparison against the pinned asset version.
# (node needs a native path for a Windows .exe; cygpath gives it under Git Bash.)
NBIN=$(cygpath -w "$BIN" 2>/dev/null || echo "$BIN")
node "$REPO/scripts/check-vendor-engine-version.mjs" "$NBIN" "$SET" "$TARGET" || { echo "SMOKE FAIL: engine version check"; exit 1; }
D=$(mktemp -d)
mkdir -p "$D/sock" "$D/home"; chmod 700 "$D/sock"
TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
WRONG=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
export AGENT_BROWSER_CONTROL_TOKEN=$TOKEN AGENT_BROWSER_SOCKET_DIR=$D/sock HOME=$D/home AGENT_BROWSER_SESSION=smoke
cd "$D" || exit 1
fail=0
"$BIN" --version 2>&1 | head -1
"$BIN" stream status 2>&1 | head -5
PORT=$(cat "$D/sock/smoke.stream" 2>/dev/null)
DPID=$(cat "$D/sock/smoke.pid" 2>/dev/null)
echo "stream port ${PORT:-none}, daemon pid ${DPID:-none}"
[ -n "${PORT:-}" ] || { echo "SMOKE FAIL: no stream port"; exit 1; }
case "${DPID:-}" in ""|*[!0-9]*) echo "SMOKE FAIL: no valid daemon pid"; exit 1;; esac
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) alive() { tasklist //FI "PID eq $1" //NH 2>/dev/null | grep -q "[[:space:]]$1[[:space:]]"; }; stopit() { taskkill //PID "$1" //F >/dev/null 2>&1 || true; } ;;
  *) alive() { kill -0 "$1" 2>/dev/null; }; stopit() { kill "$1" 2>/dev/null || true; } ;;
esac
alive "$DPID" || { echo "SMOKE FAIL: daemon pid $DPID is not running after start"; exit 1; }
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$@"; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1 $2"; else echo "FAIL $1 got $2 want $3"; fail=1; fi; }
check "status no header" "$(code http://127.0.0.1:$PORT/api/status)" 401
check "status wrong bearer" "$(code -H "Authorization: Bearer $WRONG" http://127.0.0.1:$PORT/api/status)" 401
check "status right bearer" "$(code -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status)" 200
UP=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
check "ws no header" "$(code "${UP[@]}" http://127.0.0.1:$PORT/)" 401
check "ws wrong bearer" "$(code "${UP[@]}" -H "Authorization: Bearer $WRONG" http://127.0.0.1:$PORT/)" 401
check "ws right bearer" "$(code --max-time 3 "${UP[@]}" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/ || true)" 101
"$BIN" close > "$D/close.out" 2>&1; crc=$?
head -3 "$D/close.out"
[ "$crc" -eq 0 ] || { echo "FAIL close exited $crc"; fail=1; }
for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$DPID" || break; sleep 1; done
if alive "$DPID"; then echo "FAIL daemon $DPID still running"; stopit "$DPID"; fail=1; else echo "ok   daemon exited"; fi
exit $fail
