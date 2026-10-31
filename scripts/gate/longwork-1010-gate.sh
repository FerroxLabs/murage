#!/usr/bin/env bash
# longwork-1010-gate.sh: real-engine scenarios for 1.0.10 C1 (no false "Context
# changed" after a restart) and C3 (sleep is not silence). Runs against a
# PACKAGED Murage that is already running on the test box, signed in to a real
# engine, on a throwaway data dir. Windows: run it from Git Bash on the rig.
#
#   longwork-1010-gate.sh <scenario> <port> <bot-id> [server-pid]
#   scenarios: S-B1 S-B2 S-D1 S-D2 S-B3   (S-A1/S-A2 are C2, cut from 1.0.10)
#
# S-B1/S-B2/S-B3 kill -9 the SERVER CHILD whose pid you pass (read it from the
# app's log line "server pid" or the crash-relaunch tree walk). Nothing is
# killed by pattern. S-D1/S-D2 put the machine to sleep and wake it by RTC.
# Prints PASS/FAIL per check; exit 1 on any FAIL. It never touches ~/.murage.
set -u
SCEN=${1:?scenario}; PORT=${2:?port}; BOT=${3:?bot id}; SPID=${4:-}
BASE="http://127.0.0.1:$PORT"; OS=$(uname -s); fail=0
case "$OS" in MINGW*|MSYS*|CYGWIN*) OS=Windows ;; esac
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
check() { if eval "$2"; then say "PASS $1"; else say "FAIL $1"; fail=1; fi; }
secret() { curl -s "$BASE/api/desktop-secret" | sed -E 's/.*"secret":"([^"]+)".*/\1/'; }
api() { curl -s -X "$1" "$BASE$2" -H "x-murage-surface: desktop" -H "x-murage-surface-secret: $(secret)" -H "content-type: application/json" ${3:+-d "$3"}; }
thread() { api GET "/api/bots?messages=0" | python3 -c "import json,sys;b=[x for x in json.load(sys.stdin)['bots'] if x['id']=='$BOT'][0];print(b['threadId'])"; }
TH=$(thread)
msgs() { api GET "/api/threads/$TH/messages?limit=200"; }
count() { msgs | python3 -c "import json,sys,re;m=json.load(sys.stdin)['messages'];print(sum(1 for x in m if re.search(r'''$1''',json.dumps(x))))"; }
replies() { msgs | python3 -c "import json,sys;print(sum(1 for x in json.load(sys.stdin)['messages'] if x.get('role')=='bot' and x.get('kind')=='text'))"; }
busy() { api GET "/api/bots?messages=0" | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['bots'] if x['id']=='$BOT'][0].get('busy') is True)"; }
send() { api POST "/api/bots/$BOT/messages" "{\"threadId\":\"$TH\",\"text\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}" >/dev/null; }
until_() { local t0=$SECONDS; while (( SECONDS - t0 < $1 )); do eval "$2" && return 0; sleep 3; done; return 1; }
up() { until_ 180 'curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health" | grep -q 200'; }
killserver() { [[ -n "$SPID" ]] || { say "FAIL need server-pid"; exit 2; }
  if [[ $OS == Windows ]]; then taskkill //F //PID "$SPID" >/dev/null; else kill -9 "$SPID"; fi; }
sleepfor() { local s=$1; say "sleeping the machine for ${s}s"
  case "$OS" in
    Darwin) sudo pmset schedule wake "$(date -v+${s}S '+%m/%d/%Y %H:%M:%S')" && sudo pmset sleepnow ;;
    Linux) sudo rtcwake -m mem -s "$s" ;;
    Windows) powershell.exe -NoProfile -Command "\$t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($s); Register-ScheduledTask -TaskName murage-gate-wake -Trigger \$t -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument '/c exit') -Settings (New-ScheduledTaskSettingsSet -WakeToRun) -Force | Out-Null; rundll32.exe powrprof.dll,SetSuspendState 0,1,0" ;;
  esac
  until_ $((s + 600)) 'curl -s -o /dev/null "$BASE/api/health"'; sleep 20
  [[ $OS == Windows ]] && powershell.exe -NoProfile -Command "Unregister-ScheduledTask -TaskName murage-gate-wake -Confirm:\$false" 2>/dev/null; true; }
CTX='previous attempt may have started'
case "$SCEN" in
  S-B1|S-B3)
    before=$(replies)
    if [[ $SCEN == S-B3 ]]; then send "In the workspace run: npm init -y >/dev/null; then run a build that keeps files open for 3 minutes: node -e \"const f=require('fs').openSync('held.lock','w');setTimeout(()=>{},180000)\". Tell me when it is done."
    else send "Write a 400-line Python module to work/longjob.py in several steps, running it after each step."; fi
    until_ 300 '[[ $(busy) == True ]]' && sleep 40
    killserver; check "server back after kill -9" up
    check "interrupted line shown" '[[ $(count "interrupt|restart") -ge 1 ]]'
    [[ $SCEN == S-B3 && $OS == Windows ]] && check "old run's held file is free (job closed)" 'powershell.exe -NoProfile -Command "try{[IO.File]::Open((Join-Path (Get-Location) \"held.lock\"),\"Open\",\"ReadWrite\",\"None\").Close();exit 0}catch{exit 1}"'
    send "Carry on from where you were."
    check "resend answered" 'until_ 900 "[[ \$(replies) -gt $before && \$(busy) == False ]]"'
    check "no Context changed" '[[ $(count "$CTX") -eq 0 ]]' ;;
  S-B2)
    before=$(replies); send "Summarise what you remember about this project in three lines."
    until_ 300 '[[ $(busy) == True ]]'; killserver; up
    send "And one more line, please."
    check "resend answered within 5 s of health" 'until_ 600 "[[ \$(replies) -gt $before && \$(busy) == False ]]"'
    check "no Context changed" '[[ $(count "$CTX") -eq 0 ]]'
    check "at most one rebuild line" '[[ $(count "re-prepar|rebuil") -le 1 ]]' ;;
  S-D1)
    send "Before anything else, run: echo gate > work/d1.txt (ask me first)."
    check "card open" 'until_ 300 "[[ \$(count \"\\\"kind\\\": \\\"options\\\"\") -ge 1 ]]"'
    sleepfor 1200
    check "card still open after wake" '[[ $(count "\"answered\"") -eq 0 ]]'
    check "turn still waiting" '[[ $(busy) == True ]]'
    say "answer the card Allow in the app now (5 minutes)"; check "answer runs and turn ends" 'until_ 300 "[[ \$(busy) == False ]]"'
    check "no denied-by-timeout line" '[[ $(count "timed out|no answer") -eq 0 ]]' ;;
  S-D2)
    send "Run: sleep 900; echo done   (one command, no output until it ends)."
    until_ 300 '[[ $(busy) == True ]]' && sleep 60
    sleepfor 1500
    check "turn not stopped at wake" '[[ $(busy) == True && $(count "inactive|stalled|stopped") -eq 0 ]]' ;;
  *) say "unknown scenario $SCEN"; exit 2 ;;
esac
if [[ $fail == 0 ]]; then say "$SCEN PASS ($OS)"; else say "$SCEN FAIL ($OS)"; exit 1; fi
