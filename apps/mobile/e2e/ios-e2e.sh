#!/usr/bin/env bash
# Plan 2 E2E on the iOS simulator. One build at a time (golden rule), always
# into -derivedDataPath /private/tmp/mm-plan2-dd.
#
# It brings up the isolated host (host/run-host.sh + host/serve.sh up) and
# always takes it down again (serve.sh down, then stop-host.sh), even on a
# failure. E2E_HOST=external uses a host that is already up and leaves it.
# SKIP_BUILD=1 installs the app and runner already in the derived data.
# E2E_SHOTS=<dir> keeps the simulator screenshots there (default out/ios/shots).
#
# The simulator reaches the host the way a phone does: the Mac's tailnet name
# on :8444. Page scripts run through the simulator's Web Inspector (wir.py);
# the launcher's WebView is not inspectable, so launcher screens are checked
# by the UI tests.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MOBILE=$(cd "$HERE/.." && pwd)
APP=$(cd "$MOBILE/../.." && pwd)
# shellcheck source=scripts/safe-wipe.sh
source "$APP/scripts/safe-wipe.sh"   # the only recursive delete scripts may use
OUT="$HERE/out/ios"
SHOTS=${E2E_SHOTS:-$OUT/shots}
DD=/private/tmp/mm-plan2-dd
SIM=${SIM:-iPhone 17 Pro}
PKG=com.murage.mobile
RUNNER="$MOBILE/ios/App/MobileUITests/Runner.xcodeproj"
SAFE_WIPE_WITHIN="$HERE" safe_wipe "$OUT"; mkdir -p "$OUT" "$SHOTS"

HOST_UP=0 SERVE_UP=0 LOG_PID="" TEST_PID="" HANDOFF=""
# The script's own stdout and stderr, for the cleanup: a signal that lands inside
# a shell function called with `>/dev/null` (wir …) runs the trap with that
# redirection still in place, and the "restored exactly" line would be lost.
exec 3>&1 4>&2
# macOS has no timeout(1): an alarm, then exec.
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }
cleanup() {
  local rc=$?
  # Serve comes first and cannot be interrupted: a second Ctrl-C must not
  # leave :8444 on Sean's Tailscale Serve, and nothing slow runs before it.
  trap '' INT TERM HUP
  exec 1>&3 2>&4
  set +e
  if [[ "${E2E_HOST:-}" != external ]]; then
    [[ $SERVE_UP == 1 ]] && "$HERE/host/serve.sh" down
    [[ $HOST_UP == 1 ]] && "$HERE/host/stop-host.sh"
  fi
  [[ -n "$LOG_PID" ]] && kill "$LOG_PID" 2>/dev/null
  if [[ -n "$TEST_PID" ]]; then
    pkill -P "$TEST_PID" 2>/dev/null; kill "$TEST_PID" 2>/dev/null
    for _ in $(seq 1 40); do kill -0 "$TEST_PID" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$TEST_PID" 2>/dev/null
  fi
  # Any xcodebuild this run started and left behind (only ours: its result bundle is under OUT).
  pkill -f "xcodebuild test-without-building .*-resultBundlePath $OUT/" 2>/dev/null
  [[ -n "$HANDOFF" ]] && rm -f "$HANDOFF"
  # Raw xcresult bundles can hold the pairing code in an AX diagnostic (Codex
  # runner README); keep only the summaries, and delete every bundle even when
  # its summary times out.
  for bundle in "$OUT"/*.xcresult; do
    [[ -e "$bundle" ]] || continue
    tmo 30 xcrun xcresulttool get test-results summary --path "$bundle" > "${bundle%.xcresult}.summary.json" 2>/dev/null
    SAFE_WIPE_WITHIN="$OUT" safe_wipe "$bundle"
  done
  exit $rc
}
trap cleanup EXIT

UDID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; name=sys.argv[1]; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"] == name))' "$SIM")
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" >/dev/null

if [[ "${E2E_HOST:-}" != external ]]; then
  # Another run (the Android E2E, a reviewer) may own the host or the :8444
  # cycle. The trap tears down only what this run brought up, so it is never
  # armed over theirs: refuse before arming, and arm each one only once its up
  # has passed the point where it refuses a host or cycle that is already there
  # (the same rule as android-e2e.sh).
  if [[ -e "$HERE/host/host.lock" || -f "$HERE/host/host.env" || -f "$HERE/host/serve-before.json" ]]; then
    echo "the isolated host or Serve :8444 is in use by another run; nothing was changed" >&2
    exit 1
  fi
  [[ -f "$HERE/host/web-dist/index.html" ]] || "$HERE/host/build-web-dist.sh"
  # A refusal (host.lock, someone else's host.env, a busy port) changes nothing,
  # so it arms nothing; any other failure is a half-up of our own.
  if ! "$HERE/host/run-host.sh" 2> "$OUT/run-host.err"; then
    cat "$OUT/run-host.err" >&2
    grep -E "host.env exists|is busy" "$OUT/run-host.err" >/dev/null || HOST_UP=1
    exit 1
  fi
  HOST_UP=1
  if ! "$HERE/host/serve.sh" up 2> "$OUT/serve-up.err"; then
    cat "$OUT/serve-up.err" >&2
    grep "refusing" "$OUT/serve-up.err" >/dev/null || SERVE_UP=1
    exit 1
  fi
  SERVE_UP=1
fi

if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  (cd "$MOBILE" && pnpm build && pnpm sync)
  xcodebuild -project "$MOBILE/ios/App/App.xcodeproj" -scheme App -configuration Debug -destination "id=$UDID" -derivedDataPath "$DD" build | tail -2
  xcodebuild build-for-testing -project "$RUNNER" -scheme MobileUITests -destination "id=$UDID" -derivedDataPath "$DD" CODE_SIGN_IDENTITY=- | tail -2
fi
xcrun simctl terminate "$UDID" "$PKG" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$PKG" || true
# The saved-computer list and install id live in the Keychain, which outlives
# an uninstall; a simulator that has never paired starts from an empty one.
echo "resetting the keychain of simulator $SIM ($UDID): every app's keychain items on that simulator are wiped"
xcrun simctl keychain "$UDID" reset
xcrun simctl install "$UDID" "$DD/Build/Products/Debug-iphonesimulator/App.app"

xcrun simctl spawn "$UDID" log stream --level info --style compact --predicate 'subsystem == "com.murage.mobile"' > "$OUT/shell.log" &
LOG_PID=$!
sleep 2

lines() { wc -l < "$OUT/shell.log" | tr -d ' '; }
# wait_log <pattern> [after-line]: a matching line after the mark (default: anywhere).
wait_log() {
  local from=${2:-0}
  for _ in $(seq 1 180); do
    tail -n +"$((from + 1))" "$OUT/shell.log" | grep -q -- "$1" && return 0
    sleep 0.5
  done
  echo "timed out waiting for: $1" >&2; exit 1
}
seen_after() { tail -n +"$(($2 + 1))" "$OUT/shell.log" | grep -q -- "$1"; }
expect_log() { grep -q -- "$1" "$OUT/shell.log" || { echo "missing log line: $1" >&2; exit 1; }; }
fail() { echo "$*" >&2; exit 1; }
wir() { python3 "$HERE/wir.py" "$UDID" "$@"; }
# simctl may not write to an external volume; it writes to tmp, and the file is moved.
shot() {
  local tmp; tmp=$(mktemp -d /private/tmp/mm-p25-shot.XXXXXX)
  sleep 1
  xcrun simctl io "$UDID" screenshot --type=png "$tmp/shot.png" >/dev/null 2>&1 || { safe_wipe "$tmp"; fail "screenshot $1 failed"; }
  cp "$tmp/shot.png" "$SHOTS/$1.png"; safe_wipe "$tmp"
}
launch() { xcrun simctl launch --terminate-running-process "$UDID" "$PKG" >/dev/null; }
front() { xcrun simctl launch "$UDID" "$PKG" >/dev/null; } # brings the running app forward
alive() { xcrun simctl spawn "$UDID" launchctl list | awk -v app="UIKitApplication:$PKG" 'index($3, app) == 1 && $1 ~ /^[0-9]+$/ { found = 1 } END { exit !found }'; }
saves() { local data; data=$(xcrun simctl get_app_container "$UDID" "$PKG" data); find "$data/tmp/murage-saves" -type f 2>/dev/null || true; }
# The web content pid comes from our own log line; kill it only if it really is one.
webcontent() { [[ "$1" =~ ^[0-9]+$ ]] && ps -p "$1" -o comm= 2>/dev/null | grep -q "WebKit.WebContent"; }

ADDRESS="" CODE=""
mint() {
  # The pairing JSON goes to Python on stdin, never argv (ps shows argv).
  local pair; pair=$("$HERE/host/mint.sh")
  ADDRESS=$(printf '%s' "$pair" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  CODE=$(printf '%s' "$pair" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
}
HANDOFF=/private/tmp/mm-p25-handoff-$$
rm -f "$HANDOFF"
# run <test> [bundle-name]
run() {
  TEST_RUNNER_MURAGE_E2E_ADDRESS="$ADDRESS" TEST_RUNNER_MURAGE_E2E_CODE="$CODE" TEST_RUNNER_MURAGE_E2E_HANDOFF="$HANDOFF" \
  xcodebuild test-without-building -project "$RUNNER" -scheme MobileUITests -destination "id=$UDID" \
    -derivedDataPath "$DD" -parallel-testing-enabled NO -collect-test-diagnostics never \
    -resultBundlePath "$OUT/${2:-$1}.xcresult" -only-testing:"MobileUITests/PairingUITests/$1" | tail -3
  # A name the runner does not have "succeeds" with no tests: exactly one must pass.
  xcrun xcresulttool get test-results summary --path "$OUT/${2:-$1}.xcresult" |
    python3 -c 'import json,sys; s=json.load(sys.stdin); sys.exit(0 if s.get("totalTestCount") == 1 and s.get("passedTests") == 1 else "%s: %s of %s tests passed" % (sys.argv[1], s.get("passedTests"), s.get("totalTestCount")))' "$1"
}

# 1. typed pairing through /enter, then the chat
mint
WS="https://$ADDRESS"
M=$(lines)
run test1TypedPairingReachesChat
expect_log "probe host=.* mode=full"
expect_log "main-document status=200 path=/enter"
expect_log "channel accept method=hello"
expect_log "channel accept method=ready"

# 2. killed and relaunched: still signed in, from the workspace's own data store (Phase 0 Q2)
M=$(lines)
run test2RelaunchStaysSignedIn
seen_after "workspace closed" "$M" && fail "relaunch closed the workspace"

# 3. the web process dies under a running app (Phase 0 Q5). Launched with simctl:
#    an app XCTest launched ends with its test run, so every screenshot is taken
#    of an app simctl launched. hello() lists every method.
M=$(lines)
launch
wait_log "ready ms=" "$M"
sleep 1
shot 01-workspace-chat
wir "$WS" "$HERE/android/hello.js" | python3 -c 'import json,sys; hello=json.load(sys.stdin); methods=json.load(open(sys.argv[1]))["methods"]; sys.exit(0 if hello == {"version": 1, "methods": methods} else "hello() does not list every method of contract/channel.json: %s" % hello)' "$MOBILE/contract/channel.json"
PID=$(tail -n +"$((M + 1))" "$OUT/shell.log" | grep -o 'webcontent pid=[0-9]*' | tail -1 | cut -d= -f2)
webcontent "$PID" || fail "pid $PID is not a WebKit WebContent process"
M=$(lines)
kill -9 "$PID"
wait_log "webcontent terminated; reloading route" "$M"
wait_log "ready ms=" "$M"
alive || fail "the app died with its web process"
run test5StillInChatAfterWebContentDied
shot 02-chat-after-webcontent-killed

# 4. deep link through the pending-open path
run test3OpenMissingThreadSaysSo
xcrun simctl launch --terminate-running-process "$UDID" "$PKG" -murageOpenThread e2e-missing-thread >/dev/null
[[ $(wir "$WS" "$HERE/android/page-has.js" '{"text":"isn'"'"'t available on this device"}') == "true" ]] || fail "the deep link did not say the thread is missing"
shot 03-deep-link-missing-thread

# 5. a form posted to another origin (P26 F1). The door's CSP (form-action
#    'self') stops a form in the page first and the page stays. Every door
#    response is X-Frame-Options DENY, so the check that reaches the native
#    guard goes through a same-origin page without that CSP: the main frame
#    moves to /healthz, and a form there posts to example.com. WebKit asks
#    decidePolicyFor before anything commits, the POST goes out as a Safari
#    navigation, and the WebView stays on its own origin, on that same page.
M=$(lines)
launch
wait_log "ready ms=" "$M"
M=$(lines)
wir "$WS" "$HERE/android/form-post.js" '{"mark":"before-post"}' >/dev/null
sleep 3
[[ $(wir "$WS" "$HERE/android/read-mark.js") == *'"mark": "before-post"'* ]] || fail "the blocked POST replaced the page"
seen_after "navigation external" "$M" && fail "the door's CSP let a foreign POST through"
curl -s -D - -o /dev/null "$WS/healthz" | grep -qi "content-security-policy" && fail "/healthz has a CSP; pick another page for the POST check"
wir "$WS" "$HERE/ios/go.js" '{"path":"/healthz"}' >/dev/null
M=$(lines)
POSTED=$(wir "$WS/healthz" "$HERE/android/form-post.js" '{"mark":"before-native-post"}')
[[ "$POSTED" == '"posting"' ]] || fail "the POST from /healthz did not start: $POSTED"
wait_log "navigation external host=example.com" "$M"
sleep 3
front; sleep 2
[[ $(wir "$WS/healthz" "$HERE/android/read-mark.js") == *'"mark": "before-native-post"'* ]] || fail "the foreign POST replaced the page"
wir --list | python3 -c 'import json,sys; bad=[u for u in json.load(sys.stdin) if not u.startswith(sys.argv[1])]; sys.exit("a foreign page is in the app: %s" % bad if bad else 0)' "$WS"
seen_after "workspace closed" "$M" && fail "the stopped POST closed the workspace"
shot 04-after-stopped-foreign-post

# 6. the workspace closes in the middle of a chunked save: nothing is kept or shared
M=$(lines)
launch
wait_log "ready ms=" "$M"
M=$(lines)
wir "$WS" "$HERE/android/save-then-close.js" '{"filename":"murage-e2e-unfinished.txt"}' >/dev/null
wait_log "workspace closed reason=launcher" "$M"
wait_log "saves cancelled transfers=1" "$M"
sleep 2
LEFT=$(saves)
[[ "$LEFT" == *murage-e2e-unfinished* ]] && fail "an unfinished save was left on disk"
seen_after "save blob bytes" "$M" && fail "an unfinished save was published"
alive || fail "closing mid-save killed the app"
shot 05-launcher-after-close-mid-save

# 7. the channel from inside the page, the safe area, a chunked save to the
#    share sheet, a foreign navigation out to Safari
M=$(lines)
run test4ProbeFromInsideThePage
wait_log "e2e probe " "$M"
python3 "$HERE/check-probe.py" "$OUT/shell.log" ios
seen_after "save blob bytes=5" "$M" || fail "the probe's chunked save did not reach the share sheet"
seen_after "navigation external host=example.com" "$M" || fail "the probe's foreign navigation did not go out"
seen_after "channel drop main=false" "$M" || fail "the subframe's post was not dropped natively"

# 8. signOut() from the page deletes the session cookie: the computer, which
#    was never told (no DELETE /session/device), then answers this app 401
M=$(lines)
launch
wait_log "ready ms=" "$M"
[[ $(wir "$WS" "$HERE/ios/status.js") == *'"status": 200'* ]] || fail "the signed-in page does not get a 200"
M=$(lines)
# The page goes away with the workspace, so its answer may never arrive; the log says what happened.
wir "$WS" "$HERE/ios/sign-out.js" >/dev/null || true
wait_log "workspace closed reason=signOut" "$M"
wait_log "session cookies cleared=" "$M"
CLEARED=$(tail -n +"$((M + 1))" "$OUT/shell.log" | grep -o 'session cookies cleared=[0-9]*' | tail -1 | cut -d= -f2)
[[ "$CLEARED" -ge 1 ]] || fail "sign-out cleared no session cookie"
shot 06-launcher-after-sign-out
mint
M=$(lines)
run test9SignedOutThenTheDoorsPage &
TEST_PID=$!
wait_log "main-document status=200 path=/enter" "$M"
[[ $(wir "$WS/enter" "$HERE/ios/status.js") == *'"status": 401'* ]] || fail "the old session cookie survived sign-out"
shot 07-doors-page-after-sign-out

# 9. a late ready() after signOut(), on the door's page (no ready yet for this
#    load): the computer must not be signed in, so the list stays empty
M=$(lines)
wir "$WS/enter" "$HERE/ios/late-ready.js" >/dev/null || true
wait_log "workspace closed reason=signOut" "$M"
sleep 2
seen_after "channel accept method=ready" "$M" || fail "the late ready() never reached native"
seen_after "ready ms=" "$M" && fail "a late ready() after sign-out was taken"
shot 08-welcome-after-late-ready
touch "$HANDOFF"
wait "$TEST_PID" || fail "test9SignedOutThenTheDoorsPage failed"
TEST_PID=""
rm -f "$HANDOFF"
run test10LateReadyLeftNoComputer

# 10. paired again, then the door stops: can't-reach; it comes back: Try again
mint
run test1TypedPairingReachesChat test1TypedPairingReachesChat-again
"$HERE/host/door.sh" stop
M=$(lines)
run test6UnreachableScreen
wait_log "workspace closed reason=unreachable" "$M"
M=$(lines)
run test7TryAgainAfterTheComputerWakes &
TEST_PID=$!
wait_log "workspace closed reason=unreachable" "$M"
sleep 3
shot 09-cant-reach
"$HERE/host/door.sh" start
M=$(lines)
touch "$HANDOFF"
wait "$TEST_PID" || fail "test7TryAgainAfterTheComputerWakes failed"
TEST_PID=""
rm -f "$HANDOFF"
wait_log "ready ms=" "$M"

# 11. the door forgets this phone: re-pair
"$HERE/host/door.sh" reset
M=$(lines)
run test8RepairScreen
wait_log "main-document status=401" "$M"
wait_log "workspace closed reason=signedOut" "$M"
M=$(lines)
launch
wait_log "workspace closed reason=signedOut" "$M"
sleep 2
shot 10-re-pair

echo "iOS E2E passed"
