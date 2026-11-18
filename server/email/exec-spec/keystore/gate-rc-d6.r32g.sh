#!/bin/bash
# RC gate: exhaustive d6. FAILS unless BOTH Flux profiles (ci, ci-276) show truncated=false AND violations=0 (and reducerFailures=0, cycles=0)
# at DEPTH=6 with STATE_CAP=0 (unlimited). Runs one container at a time, --network none, via runbig-r3.sh. Exit 0 = gate passed.
# usage: /root/fuigo-builds/exec-spec-keystore/gate-rc-d6.sh [logtag]     (default tag: rc)
set -u
L=/root/fuigo-builds/exec-spec-keystore
TAG=${1:-rc}
K=server/email/exec-spec/keystore
rc=0
for P in ci ci-276; do
  LOG=gate-d6-$TAG-$P
  "$L/runbig-r3.sh" "$LOG" 10000 14 "DEPTH=6 STATE_CAP=0 PROFILES=$P npx vitest run $K/iter.test.ts"
  LINE=$(grep "CHECK SUMMARY" "$L/$LOG.log" | tail -1)
  echo "[$P] $LINE"
  if echo "$LINE" | grep -q "profile=$P depth=6 violations=0 \[\] reducerFailures=0 cycles=0 truncated=false" && grep -q "^rc=0" "$L/$LOG.log"; then echo "[$P] PASS"; else echo "[$P] FAIL"; rc=1; fi
done
[ $rc = 0 ] && echo "RC GATE exhaustive d6: PASS" || echo "RC GATE exhaustive d6: FAIL"
exit $rc
