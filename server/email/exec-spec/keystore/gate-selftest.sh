#!/bin/bash
# Self-test of the RC gate against a STUB runbig-r3.sh in a temp dir (no docker, no build, no network). Every case states the expected gate verdict.
# usage: gate-selftest.sh [gate-script]   Prints "SELFTEST SUMMARY: cases=N passed=P failed=F"; exit 0 only when failed=0.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GATE=${1:-$HERE/gate-rc-d6.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
sed "s#^L=.*#L=$T#" "$GATE" > "$T/gate.sh"; chmod +x "$T/gate.sh"
cat > "$T/runbig-r3.sh" <<'STUB'
#!/bin/bash
# stub: $1 log, $4 cmd. Behaviour per profile from STUB_<mode> env: STUB_MODE (default good), STUB_BAD_PROFILE (the profile that misbehaves)
L=$(cd "$(dirname "$0")" && pwd)
NONCE=$(echo "$4" | sed -n 's/.*GATE_NONCE=\([^ ]*\).*/\1/p'); P=$(echo "$4" | sed -n 's/.*PROFILES=\([^ ]*\).*/\1/p')
mode=${STUB_MODE:-good}; [ "${STUB_BAD_PROFILE:-all}" != all ] && [ "${STUB_BAD_PROFILE}" != "$P" ] && mode=good
[ "$mode" = noexit ] && exit 1
[ "$mode" = nolog ] && exit 0
n=$NONCE; trunc=false; viol=0; fr=0; st=832382; stall=20
[ "$mode" = wrongnonce ] && n=other
[ "$mode" = trunc ] && trunc=true
[ "$mode" = freeze ] && fr=1
[ "$mode" = tiny ] && st=12
[ "$mode" = nostall ] && stall=0
{ echo "CHECK SUMMARY: nonce=$n profile=$P depth=6 violations=$viol [] reducerFailures=0 cycles=0 freezes=$fr truncated=$trunc states=$st transitions=2304870 stalledCloseTransitions=$stall"
  [ "$mode" != notests ] && echo "      Tests  1 passed (1)"
  echo "rc=0"; } > "$L/$1.log"
exit 0
STUB
chmod +x "$T/runbig-r3.sh"
cases=0; ok=0; bad=0
t() { # name expected(PASS|FAIL) [env...]
  local name=$1 exp=$2; shift 2
  env "$@" "$T/gate.sh" st >"$T/out.txt" 2>&1; local rc=$?
  local got=FAIL; [ $rc = 0 ] && got=PASS
  cases=$((cases+1)); if [ "$got" = "$exp" ]; then ok=$((ok+1)); echo "case $name: expected $exp got $got OK"; else bad=$((bad+1)); echo "case $name: expected $exp got $got WRONG"; fi
}
GOOD='{ echo "CHECK SUMMARY: nonce=old profile=ci depth=6 violations=0 [] reducerFailures=0 cycles=0 freezes=0 truncated=false states=832382 transitions=1 stalledCloseTransitions=20"; echo "      Tests  1 passed (1)"; echo rc=0; }'
for P in ci ci-276; do eval "$GOOD" | sed "s/profile=ci /profile=$P /" > "$T/gate-d6-st-$P.log"; done   # stale logs of an earlier PASS, old name shape
t a-stale-good-log-runner-exits-1-writes-nothing FAIL STUB_MODE=noexit
rm -f "$T/runbig-r3.sh.bak"
mv "$T/runbig-r3.sh" "$T/runbig-r3.sh.off"; t b-runner-missing FAIL; mv "$T/runbig-r3.sh.off" "$T/runbig-r3.sh"
t c-wrong-nonce FAIL STUB_MODE=wrongnonce
t d-only-ci-passes FAIL STUB_MODE=trunc STUB_BAD_PROFILE=ci-276
t e-truncated FAIL STUB_MODE=trunc
t f-freezes FAIL STUB_MODE=freeze
t h-tiny-state-count FAIL STUB_MODE=tiny
t i-no-tests-passed-line FAIL STUB_MODE=notests
t j-no-stalled-close FAIL STUB_MODE=nostall
t k-runner-exits-0-writes-no-log FAIL STUB_MODE=nolog
t g-both-profiles-good PASS
echo "SELFTEST SUMMARY: cases=$cases passed=$ok failed=$bad"
[ $bad = 0 ]
