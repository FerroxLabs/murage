#!/bin/bash
# smoke-browser-vendor.sh <engine-binary>: run on the runner that matches the target, never on a developer machine.
# Fresh 64-hex token in env. Stream port /api/status: no header 401, wrong bearer 401, right bearer 200;
# WebSocket upgrade: no header 401, wrong 401, right 101. Then close and confirm the daemon exited (exact pid).
set -u
BIN=${1:?usage: smoke-browser-vendor.sh <engine-binary>}
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
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$@"; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1 $2"; else echo "FAIL $1 got $2 want $3"; fail=1; fi; }
check "status no header" "$(code http://127.0.0.1:$PORT/api/status)" 401
check "status wrong bearer" "$(code -H "Authorization: Bearer $WRONG" http://127.0.0.1:$PORT/api/status)" 401
check "status right bearer" "$(code -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status)" 200
UP=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
check "ws no header" "$(code "${UP[@]}" http://127.0.0.1:$PORT/)" 401
check "ws wrong bearer" "$(code "${UP[@]}" -H "Authorization: Bearer $WRONG" http://127.0.0.1:$PORT/)" 401
check "ws right bearer" "$(code --max-time 3 "${UP[@]}" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/ || true)" 101
"$BIN" close 2>&1 | head -3
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$DPID" 2>/dev/null || break; sleep 1; done
if [ -n "${DPID:-}" ] && kill -0 "$DPID" 2>/dev/null; then echo "FAIL daemon $DPID still running"; kill "$DPID" 2>/dev/null; fail=1; else echo "ok   daemon exited"; fi
exit $fail
