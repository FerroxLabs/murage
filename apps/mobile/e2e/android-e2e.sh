#!/usr/bin/env bash
# Plan 2 E2E on Android: a real phone over USB, or an emulator already booted.
# The APK is built on the build host (scripts/android-remote.sh); Gradle never runs
# here. The device is ANDROID_SERIAL, else the first one `adb devices` lists.
#
# It brings up the isolated host (host/run-host.sh + host/serve.sh up) and
# always takes it down again (serve.sh down, then stop-host.sh), even on a
# failure. E2E_HOST=external uses a host that is already up and leaves it.
# SKIP_BUILD=1 installs the APK already in build/.
#
# A real phone is a person's phone: this drives com.murage.mobile only (plus
# the browser the foreign-navigation checks hand a URL to), changes no setting
# except dark mode (restored), and deletes from Downloads only the files this
# run saved, by their murage-e2e names.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MOBILE=$(cd "$HERE/.." && pwd)
APP=$(cd "$MOBILE/../.." && pwd)
# shellcheck source=scripts/safe-wipe.sh
source "$APP/scripts/safe-wipe.sh"   # the only recursive delete scripts may use
OUT="$HERE/out/android"
SHOTS=${E2E_SHOTS:-$OUT/shots}
PKG=com.murage.mobile
CDP_PORT=${CDP_PORT:-29333}
export CDP_PORT
ADB_BIN=${ADB:-$(command -v adb || echo /opt/homebrew/bin/adb)}
SERIAL=${ANDROID_SERIAL:-$("$ADB_BIN" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')}
[[ -n "$SERIAL" ]] || { echo "no Android device connected" >&2; exit 1; }
adb() { "$ADB_BIN" -s "$SERIAL" "$@"; }
# Cleanup's phone commands give up after 15 s: a hung adb never holds the trap.
# (macOS has no timeout(1); perl's alarm survives the exec.)
adb_t() { perl -e 'alarm shift; exec @ARGV' 15 "$ADB_BIN" -s "$SERIAL" "$@"; }
SAFE_WIPE_WITHIN="$HERE" safe_wipe "$OUT"; mkdir -p "$OUT" "$SHOTS"

# grep without -q reads to the end: under pipefail an early exit would be a SIGPIPE, not a match.
if adb shell dumpsys window | grep "isKeyguardShowing=true" >/dev/null; then
  echo "the device is locked; unlock it and run again (this script never unlocks a phone)" >&2
  exit 1
fi

# Whatever it was (yes, no, auto, custom…), it is put back as it was.
NIGHT=$(adb shell cmd uimode night | tr -d '\r' | awk '{print $NF}')
HOST_UP=0 SERVE_UP=0 LOG_PID=
# Only the files a run saves: every name starts murage-e2e (the uiautomator dump is ours too).
clear_test_files() {
  adb_t shell 'for f in /sdcard/Download/murage-e2e*; do [ -e "$f" ] && rm -f "$f" && echo "removed test download ${f##*/}"; done; rm -f /data/local/tmp/murage-e2e-ui.xml; true'
  adb_t shell "content delete --uri content://media/external/downloads --where \"_display_name LIKE 'murage-e2e%'\"" >/dev/null 2>&1
}
cleanup() {
  local rc=$?
  # Nothing interrupts the cleanup, and the Mac-only part comes first: Sean's
  # Serve config is restored whatever state the phone or adb is in.
  trap '' INT TERM HUP
  set +e
  if [[ "${E2E_HOST:-}" != external ]]; then
    [[ $SERVE_UP == 1 ]] && "$HERE/host/serve.sh" down
    [[ $HOST_UP == 1 ]] && "$HERE/host/stop-host.sh"
  fi
  [[ -n "$LOG_PID" ]] && kill "$LOG_PID" 2>/dev/null
  adb_t forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1
  [[ -n "$NIGHT" ]] && adb_t shell cmd uimode night "$NIGHT" >/dev/null
  clear_test_files
  exit $rc
}
trap cleanup EXIT

# A run that died without its cleanup (kill -9, the phone unplugged) may have
# left murage-e2e files; they would satisfy this run's Downloads checks.
clear_test_files
[[ -z "$(adb shell 'ls /sdcard/Download/murage-e2e* 2>/dev/null; true' | tr -d '\r')" ]] || { echo "stale murage-e2e files remain in Downloads" >&2; exit 1; }

if [[ "${E2E_HOST:-}" != external ]]; then
  [[ -f "$HERE/host/web-dist/index.html" ]] || "$HERE/host/build-web-dist.sh"
  # Another run (the iOS E2E) may own the host or the :8444 cycle. The trap
  # tears down only what this run brought up, so it must never be armed over
  # theirs: refuse before arming, and arm each one only once its up has passed
  # the point where it refuses a host or cycle that is already there.
  if [[ -e "$HERE/host/host.lock" || -f "$HERE/host/host.env" || -f "$HERE/host/serve-before.json" ]]; then
    echo "the isolated host or Serve :8444 is in use by another run; nothing was changed" >&2
    exit 1
  fi
  # A refusal (someone else's host.env, a busy port, an open cycle) changes
  # nothing, so it arms nothing; any other failure is a half-up of our own.
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
  # The lane is cleaned whether the build worked or not (golden rule).
  built=0
  (cd "$MOBILE" && pnpm build && pnpm sync && scripts/android-remote.sh build) && built=1
  "$MOBILE/scripts/android-remote.sh" clean
  [[ $built == 1 ]] || { echo "the APK build failed" >&2; exit 1; }
fi
adb install -r "$MOBILE/build/app-debug.apk" >/dev/null
adb shell pm clear "$PKG" >/dev/null # a phone that has never paired

adb logcat -c
# adb itself in the background (not the adb() function's subshell), so the kill reaches it.
"$ADB_BIN" -s "$SERIAL" logcat -s MurageShell:I > "$OUT/shell.log" &
LOG_PID=$!

lines() { wc -l < "$OUT/shell.log" | tr -d ' '; }
# wait_log <pattern> [after-line]: a matching line after the mark (default: anywhere).
wait_log() {
  local from=${2:-0}
  for _ in $(seq 1 180); do
    tail -n +"$((from + 1))" "$OUT/shell.log" | grep -- "$1" >/dev/null && return 0
    sleep 0.5
  done
  echo "timed out waiting for: $1" >&2; exit 1
}
seen_after() { tail -n +"$(($2 + 1))" "$OUT/shell.log" | grep -- "$1" >/dev/null; }
forward() {
  local pid; pid=$(adb shell pidof "$PKG" | tr -d '\r')
  adb forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1 || true
  adb forward "tcp:$CDP_PORT" "localabstract:webview_devtools_remote_$pid" >/dev/null
}
cdp() { node "$HERE/cdp.mjs" "$@"; }
# Started the way the home screen starts it (MAIN/LAUNCHER), so a later icon tap
# matches the task's root intent and brings the task back (extras never count).
launch() {
  adb shell am force-stop "$PKG"
  adb shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/.MainActivity" "$@" >/dev/null
  sleep 2; forward
}
resumed() { adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" || true; }
alive() { [[ -n "$(adb shell pidof "$PKG" | tr -d '\r')" ]]; }
shot() { sleep 1; adb exec-out screencap -p > "$SHOTS/$1.png"; }
# on_device <path>: the test on the phone itself (no `ls | grep -q` under pipefail).
on_device() { adb shell "[ -e '$1' ]"; }
main_activities() { adb shell dumpsys activity activities | grep -c "Hist .*$PKG/.MainActivity" || true; }
inset_top() { grep -o "insets top=[0-9]*" "$OUT/shell.log" | tail -1 | cut -d= -f2; }
# tap_links <prefix> <json hrefs>: real taps on fresh links, one straight after the other.
tap_links() {
  local points top
  points=$(cdp "$1" "$HERE/android/anchors.js" "{\"hrefs\":$2}")
  top=$(inset_top)
  # one adb shell for all the taps, so they land back to back
  adb shell "$(python3 -c 'import json,sys; print("; ".join("input tap %d %d" % (x, y + int(sys.argv[2])) for x, y in json.loads(sys.argv[1])))' "$points" "$top")"
}

# The pairing travels on stdin only, never argv (`ps` shows argv).
PAIR=$("$HERE/host/mint.sh")
ADDRESS=$(printf '%s' "$PAIR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
WS="https://$ADDRESS"

# 1. the launcher title sits below the status bar; its renderer dies and it comes back
launch
[[ $(cdp https://localhost "$HERE/android/title-top.js") -ge 48 ]] || { echo "launcher title under the status bar" >&2; exit 1; }
shot 01-launcher-welcome
M=$(lines)
cdp https://localhost --crash >/dev/null
wait_log "launcher renderer gone" "$M"
alive || { echo "the app died with the launcher's renderer" >&2; exit 1; }
forward
[[ $(cdp https://localhost "$HERE/android/page-has.js" '{"text":"Yes, let'"'"'s connect"}') == "true" ]] || { echo "the launcher did not come back" >&2; exit 1; }
shot 02-launcher-after-renderer-crash

# 2. typed pairing through /enter, then the chat. "Yes, let's connect" shows
# Get your code ready, before any scanner: Google's scanner covers the whole
# screen, so where the code is gets said first. Type the code instead is on it.
M=$(lines)
[[ $(cdp https://localhost "$HERE/android/lets-connect.js") == '"tapped"' ]] || { echo "no Yes, let's connect on the welcome" >&2; exit 1; }
[[ $(cdp https://localhost "$HERE/android/page-has.js" '{"text":"Get your code ready"}') == "true" ]] || { echo "Yes, let's connect did not get the code ready" >&2; exit 1; }
[[ $(resumed) == *"$PKG/.MainActivity"* ]] || { echo "something opened over Get your code ready" >&2; exit 1; }
shot 02b-get-your-code-ready
TYPED=$(printf '%s' "$PAIR" | python3 -c 'import json,sys; p=json.load(sys.stdin); print(json.dumps({"address": p["address"], "code": p["code"]}))' |
  cdp https://localhost "$HERE/android/type-pairing.js" -)
[[ $TYPED == '"submitted"' ]] || { echo "typed pairing did not submit: $TYPED" >&2; exit 1; }
unset PAIR
cdp "$WS/enter" "$HERE/android/sign-in.js" >/dev/null
wait_log "channel accept method=ready" "$M"
grep -q "probe host=.* mode=full" "$OUT/shell.log"
grep -q "insets top=[1-9]" "$OUT/shell.log"
[[ $(cdp "$WS" "$HERE/android/hello.js") == *'"version":1'* ]] || { echo "hello() did not resolve" >&2; exit 1; }
shot 03-workspace-chat

# 3. killed and relaunched: still signed in (Phase 0 Q2)
M=$(lines)
launch
wait_log "channel accept method=ready" "$M"
seen_after "workspace closed" "$M" && { echo "relaunch closed the workspace" >&2; exit 1; }

# 4. the renderer dies under the workspace (the launcher's WebView is alive below it,
#    in the same renderer): the app survives and the chat comes back (surprise 1)
M=$(lines)
cdp "$WS" --crash >/dev/null
wait_log "MurageShell: renderer gone crashed=true; recreating" "$M" # not the launcher's line
wait_log "channel accept method=ready" "$M"
alive || { echo "the app died with its renderer" >&2; exit 1; }
forward
[[ $(cdp "$WS" "$HERE/android/page-has.js" '{"text":"Send a message"}') == "true" ]]
shot 04-workspace-after-renderer-crash
# a second death within a minute: no reload loop, the slow panel waits for the person.
# On a slow link the reload above can outlast the minute; then this death reloads
# too, and the next one, straight after it, is the second within a minute.
M=$(lines)
cdp "$WS" --crash >/dev/null
wait_log "MurageShell: renderer gone crashed=true" "$M"
sleep 1
seen_after "renderer gone again" "$M" || cdp "$WS" --crash >/dev/null
wait_log "renderer gone again; waiting for the person" "$M"
alive || { echo "the app died with its renderer (second crash)" >&2; exit 1; }
shot 05-workspace-second-crash-waits
adb shell uiautomator dump /data/local/tmp/murage-e2e-ui.xml >/dev/null
TRY=$(adb shell cat /data/local/tmp/murage-e2e-ui.xml | python3 -c '
import re, sys
for node in re.findall(r"<node [^>]*>", sys.stdin.read()):
    if "text=\"Try again\"" in node:
        a, b, c, d = map(int, re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", node).groups())
        print((a + c) // 2, (b + d) // 2); break')
adb shell rm -f /data/local/tmp/murage-e2e-ui.xml
[[ -n "$TRY" ]] || { echo "no Try again on the slow panel" >&2; exit 1; }
M=$(lines)
adb shell input tap $TRY
wait_log "channel accept method=ready" "$M"

# 5. Back leaves the app; the icon returns to the same workspace (surprise 2)
M=$(lines)
for _ in 1 2 3; do resumed | grep -q "$PKG" || break; adb shell input keyevent KEYCODE_BACK; sleep 1; done
resumed | grep -q "$PKG" && { echo "Back did not leave the app" >&2; exit 1; }
alive || { echo "Back killed the app" >&2; exit 1; }
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2
resumed | grep -q WorkspaceActivity || { echo "the icon did not return to the workspace" >&2; exit 1; }
seen_after "workspace closed" "$M" && { echo "the workspace was closed by Back" >&2; exit 1; }
seen_after "channel accept method=ready" "$M" && { echo "the icon reloaded the workspace instead of returning to it" >&2; exit 1; }

# 5b. the same, for a task the "Switch computer" shortcut started (NEW_TASK|CLEAR_TASK,
#     root intent SWITCH): the icon must not stack a second launcher on the workspace (F2)
adb shell am force-stop "$PKG"
adb shell am start -a com.murage.mobile.SWITCH -f 0x10008000 -n "$PKG/.MainActivity" >/dev/null; sleep 2; forward
M=$(lines)
cdp https://localhost "$HERE/android/open-row.js" >/dev/null
wait_log "channel accept method=ready" "$M"
M=$(lines)
for _ in 1 2 3; do resumed | grep -q "$PKG" || break; adb shell input keyevent KEYCODE_BACK; sleep 1; done
resumed | grep -q "$PKG" && { echo "Back did not leave the app (shortcut task)" >&2; exit 1; }
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 3
resumed | grep -q WorkspaceActivity || { echo "the icon did not return to the workspace (shortcut task)" >&2; exit 1; }
seen_after "channel accept method=ready" "$M" && { echo "the icon reloaded the workspace (shortcut task)" >&2; exit 1; }
seen_after "workspace closed" "$M" && { echo "the workspace was closed (shortcut task)" >&2; exit 1; }
wait_log "launcher re-entry over a live task; finishing" "$M"
[[ $(main_activities) == 1 ]] || { echo "the task holds $(main_activities) launchers, not 1" >&2; exit 1; }
shot 05b-icon-over-shortcut-task

# 6. deep link through the pending-open path
launch --es murage.openThread e2e-missing-thread
[[ $(cdp "$WS" "$HERE/android/page-has.js" '{"text":"isn'"'"'t available on this device"}') == "true" ]]
shot 06-deep-link-missing-thread

# 7. two links tapped quickly, then an attachment link in the main frame: the
#    aborted first load and the download must not close the workspace
EXPORT=$(cdp "$WS" "$HERE/android/export-link.js" '{"name":"murage-e2e-export"}')
EXPORT_NAME=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["filename"])' "$EXPORT")
[[ "$EXPORT_NAME" == murage-e2e-export.md ]] || { echo "unexpected export: $EXPORT" >&2; exit 1; }
M=$(lines)
tap_links "$WS" '["/?p26=one", "/?p26=two"]'
sleep 4
wait_log "channel accept method=ready" "$M"
seen_after "workspace closed" "$M" && { echo "two quick links closed the workspace" >&2; exit 1; }
M=$(lines)
cdp "$WS" "$HERE/android/mark.js" '{"value":"before-export"}' >/dev/null
HREF=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["href"])' "$EXPORT")
tap_links "$WS" "[\"$HREF\"]"
wait_log "save download bytes=" "$M"
sleep 2
seen_after "workspace closed" "$M" && { echo "an attachment link closed the workspace" >&2; exit 1; }
on_device "/sdcard/Download/$EXPORT_NAME" || { echo "the attachment is not in Downloads" >&2; exit 1; }
[[ $(cdp "$WS" "$HERE/android/read-mark.js") == *'"mark":"before-export"'* ]] || { echo "the attachment link replaced the page" >&2; exit 1; }
shot 07-after-attachment-link

# 8. dark mode flips without a reload
M=$(lines)
cdp "$WS" "$HERE/android/mark.js" '{"value":"before-uimode"}' >/dev/null
FLIP=$([[ "$NIGHT" == yes ]] && echo no || echo yes)
adb shell cmd uimode night "$FLIP" >/dev/null; sleep 3
shot "08-uimode-$FLIP"
adb shell cmd uimode night "$NIGHT" >/dev/null; sleep 3
[[ $(cdp "$WS" "$HERE/android/read-mark.js") == *'"mark":"before-uimode"'* ]] || { echo "dark mode reloaded the workspace" >&2; exit 1; }
seen_after "channel accept method=ready" "$M" && { echo "dark mode reloaded the workspace (ready again)" >&2; exit 1; }

# 9. a form posted to another origin: the door's CSP (form-action 'self') stops it
#    first and the page stays; with that CSP set aside (a DevTools reload), the
#    native guard stops it, sends it out, and the workspace is back on its origin
M=$(lines)
cdp "$WS" "$HERE/android/form-post.js" '{"mark":"before-post"}' >/dev/null
sleep 3
[[ $(cdp "$WS" "$HERE/android/read-mark.js") == *'"mark":"before-post"'* ]] || { echo "the blocked POST replaced the page" >&2; exit 1; }
seen_after "main frame left the origin" "$M" && { echo "the door's CSP let a foreign POST through" >&2; exit 1; }
M=$(lines)
CDP_BYPASS_CSP=1 cdp "$WS" "$HERE/android/form-post.js" '{"mark":"before-native-post"}' >/dev/null
wait_log "main frame left the origin; stopped" "$M"
sleep 3
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2
forward
python3 -c 'import json,sys,urllib.request; pages=json.load(urllib.request.urlopen("http://127.0.0.1:%s/json" % sys.argv[1])); bad=[p["url"] for p in pages if p["type"]=="page" and not p["url"].startswith(("https://localhost", sys.argv[2]))]; sys.exit("a foreign page is showing in the app: %s" % bad if bad else 0)' "$CDP_PORT" "$WS"
[[ $(cdp "$WS" "$HERE/android/page-has.js" '{"text":"Ember"}') == "true" ]] || { echo "the workspace did not come back after the stopped POST" >&2; exit 1; }
seen_after "workspace closed" "$M" && { echo "the stopped POST closed the workspace" >&2; exit 1; }
shot 08b-after-stopped-post

# 10. the workspace closes in the middle of a chunked save: nothing reaches Downloads
M=$(lines)
launch
wait_log "channel accept method=ready" "$M"
M=$(lines)
cdp "$WS" "$HERE/android/save-then-close.js" '{"filename":"murage-e2e-unfinished.txt"}' >/dev/null
wait_log "workspace closed reason=launcher" "$M"
wait_log "saves cancelled transfers=1" "$M"
sleep 2
[[ -z "$(adb shell 'ls /sdcard/Download/murage-e2e-unfinished* 2>/dev/null; true' | tr -d '\r')" ]] || { echo "an unfinished save reached Downloads" >&2; exit 1; }
alive || { echo "closing mid-save killed the app" >&2; exit 1; }

# 11. the channel from inside the page, the safe area, a chunked save, a foreign navigation
M=$(lines)
launch --ez murage.e2eProbe true
wait_log "murage-e2e " "$M"
python3 "$HERE/check-probe.py" "$OUT/shell.log" android
wait_log "save blob bytes=5" "$M"
on_device /sdcard/Download/murage-e2e.txt || { echo "the chunked save is not in Downloads" >&2; exit 1; }
wait_log "navigation external host=example.com" "$M"

# 12. the door stops: can't-reach; it comes back: Try again
"$HERE/host/door.sh" stop
M=$(lines)
launch
wait_log "workspace closed reason=unreachable" "$M"
forward
[[ $(cdp https://localhost "$HERE/android/page-has.js" '{"text":"Can'"'"'t reach"}') == "true" ]]
# the launcher title clears the status bar the workspace measured (device px)
[[ $(cdp https://localhost "$HERE/android/title-top-px.js") -ge $(inset_top) ]] || { echo "launcher title under the status bar inset" >&2; exit 1; }
shot 09-cant-reach
"$HERE/host/door.sh" start
M=$(lines)
cdp https://localhost "$HERE/android/click.js" '{"label":"Try again"}' >/dev/null
wait_log "channel accept method=ready" "$M"

# 13. the door forgets this phone: re-pair
"$HERE/host/door.sh" reset
M=$(lines)
launch
wait_log "workspace closed reason=signedOut" "$M"
forward
[[ $(cdp https://localhost "$HERE/android/page-has.js" '{"text":"Scan the code on your computer again"}') == "true" ]]
shot 10-re-pair

echo "Android E2E passed"
