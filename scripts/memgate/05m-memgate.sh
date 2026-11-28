#!/bin/bash
# 05m-memgate.sh <F> [--dry-run]   REAL-DATA MEMORY GATE step (MAIN 2026-11-27, q1024-memgate).
# Owners: rig + verdict (_small/memgate.sh, _small/bannergate-rig/memgate-1024.test.ts, memgate-verdict.py) = lane q1024-memgate; the fix it gates = q1024-memsave;
#   Sean's data snapshot (seandb-1126) = MAIN; waiver = MAIN. This kit owns only the wrapper.
# On hz, on a COPY of Sean's real store (never the live one), with the normal start-up work running: a real engine turn SAVES 3 memories through the bot's own mounted
# memory_save tool (zero refusals, no approval card, turn not stopped), recalls them by FULL memory_search (no keyword fallback) within budget, and again after a restart.
# Exit 0 and "MEMGATE-GATE PASS F=<S12>" only when the rig prints "MEMGATE-1024 <sha10> PASS". FAIL, a rig error, or no line = gate FAIL. Waiver: env WAIVE_05M=MAIN-APPROVED:<ref>.
. "$(dirname "$0")/lib.sh"; parse "$@"; F=${POS[0]:-}; need_sha "$F"; S12=${F:0:12}; S10=${F:0:10}; LD=$OUT/memgate-$S12; mkdir -p "$LD"
RIG=/root/fuigo-builds/swarm-b/_small/memgate.sh
if [ -n "${WAIVE_05M:-}" ]; then
  [[ "$WAIVE_05M" == MAIN-APPROVED:* ]] || die "WAIVE_05M must be MAIN-APPROVED:<ref>"
  echo "MEMGATE-GATE WAIVED $WAIVE_05M" | tee "$LD/verdict.txt"; exit 0; fi
if [ $DRY = 1 ]; then echo "DRY-RUN: ssh hz: $RIG --detach $F (copy of the real store, --network none container, ~10 min); wait on its log for 'MEMGATE-1024 $S10 PASS|FAIL'; print MEMGATE-GATE PASS|FAIL F=$S12"; exit 0; fi
OUTTXT=$(hz "set -u; test -x $RIG || { echo 'MEMGATE-GATE FAIL rig missing: $RIG'; exit 5; }
  L=\$($RIG --detach $F); echo \"log \$L\"
  # one blocking wait (a seat kills foreground commands at 10 min; the kit has no such limit but the rig is detached the same way)
  timeout 3300 bash -c \"until grep -q -E '^(MEMGATE-1024|MEMGATE-ERR)' \$L; do sleep 15; done\" || { echo 'MEMGATE-GATE FAIL timeout 55 min'; exit 6; }
  grep -E '^(MEMGATE-1024|MEMGATE-ERR)' \$L | head -1" 2>&1); RC=$?
printf '%s\n' "$OUTTXT" | tee "$LD/05m.log"
LINE=$(printf '%s\n' "$OUTTXT" | grep -m1 -E '^(MEMGATE-1024|MEMGATE-ERR)')
if [ $RC = 0 ] && [[ "$LINE" == "MEMGATE-1024 $S10 PASS store=real "* ]]; then echo "MEMGATE-GATE PASS F=$S12 $LINE" | tee "$LD/verdict.txt"; exit 0; fi
echo "MEMGATE-GATE FAIL F=$S12 rc=$RC ${LINE:-no verdict line} (see $LD/05m.log; owner: q1024-memgate rig, q1024-memsave fix)" | tee "$LD/verdict.txt"; exit 1
