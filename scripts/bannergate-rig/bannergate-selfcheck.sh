#!/bin/bash
# q1024-capcounter (owner: q1024-capcounter; rig only): the bannergate rig must never emit a missing written/idle field.
# usage: bannergate-selfcheck.sh [verdict.py]   exit 0 = every case holds; bannergate.sh runs it before a run and refuses to start on failure.
# Builds synthetic result files (counts only, no store data) in a temp dir and feeds them through the real verdict.py:
#   sampler-blind  = the server's /proc entries unreadable (null per-minute written, null idle) but the container figures present -> no "=missing", PASS
#   no-sources     = container figures gone too -> still FAIL with the missing tokens (fail closed, never a silent pass)
#   oldrig         = a rig that never emits its container idle figures -> FAIL rig-emit (the live collector is witnessed by a real BG_SYNTH run)
#   complete       = all fields present -> PASS, no src=cgroup label
V=${1:-$(dirname "$0")/verdict.py}
T=$(mktemp -d) || exit 2; trap 'rm -rf "${T:?}"' EXIT
python3 -I - "$T" <<'PY'
import json, sys, copy
t = sys.argv[1]
minutes = [{"min": m, "writtenMiB": 10.0, "cpuPct": 1.0, "pids": 3, "cgroupMiB": 30.0} for m in range(1, 7)]
base = {"before": {"meta": {"mode": "active"}}, "resume": {"status": 200, "mode": "active"}, "turns": 12, "recall": {"full": 12}, "ownerHeld": {}, "falseHeld": 0, "masked": 0,
        "leaked": 0, "unknownText": 0, "unanswered": 0, "memoryPausedLines": 0, "shapeMismatch": 0, "leftOutNotes": 0, "changedNotes": 0, "heldLogVsTrue": 0, "stallsOver2s": 0,
        "probeMaxMs": 100, "idleCpuPct": 2.0, "idleWrittenMiB": 5.0, "idleCgroupCpuPct": 3.0, "idleCgroupMiB": 9.0, "captureDelta": 4, "minutes": minutes,
        "shared": {"posted": 202, "ended": True, "shapeOk": True, "replies": 4, "verdicts": ["held"] * 4, "leaked": 0},
        "start1": {"exit": 0, "fatal": 0, "listenMs": 1}, "start2": {"exit": 0, "fatal": 0, "listenMs": 1}}
rows = [{"n": i, "recall": ["full"], "dispatches": [{"mode": "full", "why": []}], "leftOutWhy": [], "verdicts": [], "held": []} for i in range(12)]
def put(name, r):
    import os; os.makedirs(f"{t}/{name}")
    json.dump(r, open(f"{t}/{name}/result.json", "w")); open(f"{t}/{name}/turns.ndjson", "w").write("\n".join(json.dumps(x) for x in rows))
put("complete", base)
blind = copy.deepcopy(base)
for m in blind["minutes"]: m["writtenMiB"] = None; m["cpuPct"] = None
blind["idleCpuPct"] = blind["idleWrittenMiB"] = None
put("blind", blind)
none = copy.deepcopy(blind)
for m in none["minutes"]: m["cgroupMiB"] = None
none["idleCgroupCpuPct"] = none["idleCgroupMiB"] = None
put("nosources", none)
old = copy.deepcopy(base)
del old["idleCgroupMiB"], old["idleCgroupCpuPct"]
put("oldrig", old)
PY
bad=0
chk() { # <case> <want PASS|FAIL> <must-contain regex|-> <must-not-contain regex|->
  L=$(python3 -I "$V" "$T/$1/result.json" selfcheck 0)
  echo "$L" | grep -q " $2 " || { echo "AssertionError bannergate-selfcheck.sh:${BASH_LINENO[0]} SELFCHECK-FAIL $1: want $2: ${L:0:120}"; bad=1; }
  [ "$3" = - ] || echo "$L" | grep -Eq "$3" || { echo "AssertionError bannergate-selfcheck.sh:${BASH_LINENO[0]} SELFCHECK-FAIL $1: missing /$3/"; bad=1; }
  [ "$4" = - ] || ! echo "$L" | grep -Eq "$4" || { echo "AssertionError bannergate-selfcheck.sh:${BASH_LINENO[0]} SELFCHECK-FAIL $1: has /$4/"; bad=1; }
}
chk complete PASS - 'src=cgroup|written=missing|idle[A-Za-z]*=missing'
chk blind PASS 'src=cgroup' 'written=missing|idle[A-Za-z]*=missing'
# q1024-weakfix: the verdict must carry the MEASURED figures, so a hard-coded zero (or any constant) standing in for a missing one cannot pass:
# complete = the server's own figures (10.0 MiB/min, 2.0 % idle cpu, 5.0 MiB idle written); blind = the container figures that replace them
# (30.0, 3.0, 9.0), each distinct from the other source and from zero.
chk complete PASS 'written-max=10\.0MiB/min .*idle-cpu=2\.0% idle-written=5\.0MiB' 'written-max=0|idle-cpu=0|idle-written=0|written-max=30'
chk blind PASS 'written-max=30\.0MiB/min .*idle-cpu=3\.0% idle-written=9\.0MiB' 'written-max=(0|10)|idle-cpu=(0|2)\.|idle-written=(0|5)\.'
chk nosources FAIL 'written=missing' -
chk nosources FAIL 'idleCpuPct=missing' -
chk nosources FAIL 'idleWrittenMiB=missing' -
chk oldrig FAIL 'rig-emit=idleCgroupMiB' -
[ "$bad" = 0 ] && echo "SELFCHECK-OK $V"
exit $bad
