#!/bin/bash
# RC gate: exhaustive d6. FAILS unless BOTH Flux profiles (ci, ci-276) show, from THIS invocation, a CHECK SUMMARY line carrying this run's nonce with
# truncated=false violations=0 reducerFailures=0 cycles=0 freezes=0, states >= 100000, stalledCloseTransitions >= 1, a vitest "Tests N passed" line with no
# failures, the runner's exit status 0 and the last "rc=" line of its log exactly rc=0. One container at a time, --network none, via runbig-r3.sh.
# usage: /root/fuigo-builds/exec-spec-keystore/gate-rc-d6.sh [logtag]     (default tag: rc)    Exit 0 = gate passed.
set -u -o pipefail
L=${GATE_LANE:-/root/fuigo-builds/exec-spec-keystore}
TAG=${1:-rc}
K=server/email/exec-spec/keystore
NONCE=$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM
rc=0; pass=0
for P in ci ci-276; do
  LOG=gate-d6-$TAG-$P-$NONCE
  if [ -e "$L/$LOG.log" ]; then echo "[$P] FAIL log already exists"; rc=1; continue; fi
  if [ ! -x "$L/runbig-r3.sh" ]; then echo "[$P] FAIL runner missing"; rc=1; continue; fi
  "$L/runbig-r3.sh" "$LOG" 10000 14 "GATE_NONCE=$NONCE DEPTH=6 STATE_CAP=0 PROFILES=$P npx vitest run $K/iter.test.ts"
  rr=$?
  F="$L/$LOG.log"
  if [ "$rr" != 0 ] || [ ! -f "$F" ]; then echo "[$P] FAIL runner exit $rr or no log"; rc=1; continue; fi
  N=$(grep -Ec "^CHECK SUMMARY: nonce=$NONCE profile=$P depth=6 violations=0 \[\] reducerFailures=0 cycles=0 freezes=0 truncated=false states=[0-9]+ transitions=[0-9]+ stalledCloseTransitions=[1-9][0-9]*$" "$F")
  LINE=$(grep -E "^CHECK SUMMARY: nonce=$NONCE profile=$P " "$F" | tail -1)
  echo "[$P] $LINE"
  ST=$(echo "$LINE" | sed -n 's/.* states=\([0-9]*\) .*/\1/p')
  LASTRC=$(grep '^rc=' "$F" | tail -1)
  TESTS_OK=$(grep -Ec '^ +Tests +[1-9][0-9]* passed' "$F"); TESTS_BAD=$(grep -Ec '^ +Tests .*failed' "$F")
  if [ "$N" = 1 ] && [ "${ST:-0}" -ge 100000 ] && [ "$LASTRC" = "rc=0" ] && [ "$TESTS_OK" -ge 1 ] && [ "$TESTS_BAD" = 0 ]; then echo "[$P] PASS ($F)"; pass=$((pass+1)); else echo "[$P] FAIL ($F) summaryLines=$N states=${ST:-?} last=$LASTRC testsOk=$TESTS_OK testsBad=$TESTS_BAD"; rc=1; fi
done
if [ "$pass" = 2 ] && [ $rc = 0 ]; then echo "RC GATE exhaustive d6: PASS"; exit 0; fi
echo "RC GATE exhaustive d6: FAIL (passed profiles: $pass of 2)"; exit 1
