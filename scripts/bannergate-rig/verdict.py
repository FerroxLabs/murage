#!/usr/bin/env python3
# q1023-bannergate verdict (owner: q1023-bannergate). usage: verdict.py <result.json> <sha10> [<vitest rc>]
# Prints one board line: BANNERGATE <sha> <PASS|FAIL> <counts> [fails=...]. Reads codes and counts only. Fail-closed: a missing
# number, a runner failure or an unexplained non-full recall is a FAIL. Each fail token names its own line (receipts.tsv).
# MAIN-RULING 2026-11-26T21:02:14Z LEAKCHK (owner: MAIN; scorer: q1023-gatescore): owner-only replies are shown or masked in place;
# HELD = the REPLY_WITHHELD sentence only (any on an owner turn is a FAIL); masked is counted apart; leaked is scored only on the
# shared-room case (result.shared). --rescore <old result.json> re-scores a run made before the shared case existed (no "shared"
# key): a held verdict in a turn with no [owner-held] log line is read as masked (the run's own log shows option B writes none), the
# shared case is reported "not-run" (not a pass of it), and the printed line says RESCORE.
import json, sys
RESCORE = "--rescore" in sys.argv
if RESCORE: sys.argv.remove("--rescore")
sha = sys.argv[2]
rc = int(sys.argv[3]) if len(sys.argv) > 3 else 0
fails = []
def fail(token):
    fails.append(f"{token}@verdict.py:{sys._getframe(1).f_lineno}")
try:
    r = json.load(open(sys.argv[1]))
    rows = [json.loads(l) for l in open(sys.argv[1].replace("result.json", "turns.ndjson")) if l.strip()]
except Exception as error:
    print(f"BANNERGATE {sha} FAIL rig-error result unreadable ({type(error).__name__}) rc={rc}"); sys.exit(0)
meta0 = (r.get("before") or {}).get("meta")
stored = meta0.get("mode") if isinstance(meta0, dict) else None
resume = r.get("resume")
num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
if rc != 0: fail(f"runner-rc={rc}")
if resume is not None and (resume.get("status") != 200 or resume.get("mode") != "active"): fail(f"resume-failed={resume.get('status')}/{resume.get('mode')}")
# legacy result (before the shared case): derive the new counters from the per-turn rows; anything else must carry them itself
legacy = "shared" not in r
if legacy and RESCORE:
    withheld = sum(row["verdicts"].count("held") for row in rows if row.get("held"))
    r["falseHeld"] = withheld
    r["masked"] = sum(row["verdicts"].count("held") for row in rows if not row.get("held")) + sum(row["verdicts"].count("masked") for row in rows)
    r["heldLogVsTrue"] = sum(1 for row in rows if len(row.get("held") or []) > (row["verdicts"].count("held") if row.get("held") else 0))
    r["leaked"] = 0
elif legacy:
    fail("shared=missing")
else:
    sh = r["shared"]
    if sh.get("posted") != 202 or not sh.get("ended") or not sh.get("shapeOk"): fail(f"shared-case=posted{sh.get('posted')}/ended{sh.get('ended')}/shape{sh.get('shapeOk')}")
    if sh.get("heldMissing"): fail(f"shared-heldMissing={sh.get('heldMissing')}")
turns = r.get("turns", 0)
if turns < 12: fail(f"turns={turns}<12")
# recall: every dispatch of every turn full; a non-full one passes only with an allowed reason (MAIN: not memory-paused/pending-check)
not_full = []
for row in rows:
    # r4: each dispatch is judged with the reasons logged before IT (rows from r3 and older fall back to the turn's shared list)
    items = [(d["mode"], d["why"]) for d in row["dispatches"]] if row.get("dispatches") else [(m, row.get("recallReasons") or []) for m in (row.get("recall") or [])]
    for mode, why in items or [("none", [])]:
        if mode == "full": continue
        # off is the owner's own choice only when the STORE said off/capture before start 1, nothing resumed it, and the server
        # reported off/capture on both sides of the turn (exact match: a candidate that rewrites a paused store to off is a FAIL)
        if mode == "off": ok = resume is None and stored in ("off", "capture") and any(w in [f"mode:{a}/{b}" for a in ("off", "capture") for b in ("off", "capture")] for w in why)
        elif mode in ("held", "withheld"): ok = bool(why) and not any(("pending" in w or "checking" in w or "paused" in w) for w in why)
        else: ok = False
        if not ok: not_full.append(f"t{row['n']}:{mode}:{','.join(why) or 'no-reason'}")
if not_full: fail("recall-not-full=" + "|".join(sorted(set(not_full))))
# the left-out banner counted from both sides: a note row in the transcript (leftOutNotes) and the server's own fence line with
# omitted>0 for this thread (fail-closed: the note may reach the owner by another surface than the transcript)
left_log = [f"t{row['n']}:{','.join(row['leftOutWhy'])}" for row in rows if row.get("leftOutWhy")]
if any("leftOutWhy" not in row for row in rows): fail("leftOutLog=missing")
elif left_log: fail("left-out-log=" + "|".join(left_log))
for key in ("leftOutNotes", "falseHeld", "masked", "leaked", "unanswered", "unknownText", "shapeMismatch", "heldLogVsTrue", "memoryPausedLines", "stallsOver2s"):
    v = r.get(key)
    if not num(v): fail(f"{key}=missing")
    elif v and key != "masked": fail(f"{key}={v}")
# r4: the budget is process-level bytes (server + its workers, as the q1022 rigs measured); the container cgroup figure (block
# layer incl. journal/fsync amplification, ~3x) is printed as an upper bound only
# q1024-capcounter: a server whose /proc entries the rig cannot read (no sampler reading) must not leave the field missing: the always-readable
# container figure (an upper bound, ~3x) stands in for that minute, the line says so (src=cgroup), and only a run with neither source fails.
after = [m for m in (r.get("minutes") or []) if num(m.get("min")) and m["min"] > 3]
src = []
def minute_w(m):
    if num(m.get("writtenMiB")): return m["writtenMiB"]
    if num(m.get("cgroupMiB")): src.append("written"); return m["cgroupMiB"]
    return None
mw = [minute_w(m) for m in after]
w = max(mw) if after and all(v is not None for v in mw) else (None if after else r.get("writtenMiBPerMinMaxAfterWarm"))
w_cg = max([m["cgroupMiB"] for m in after if num(m.get("cgroupMiB"))], default=None)
if not num(w): fail("written=missing")
elif w > 50: fail(f"written={w}MiB/min>50")
# the live collector must emit its container figures (the fallback's only source); an absent key (not null) is a rig that never read them
for key in ("idleCgroupMiB", "idleCgroupCpuPct"):
    if key not in r and not RESCORE: fail(f"rig-emit={key}")
for key, alt in (("idleCpuPct", "idleCgroupCpuPct"), ("idleWrittenMiB", "idleCgroupMiB"), ("probeMaxMs", None)):
    if num(r.get(key)): continue
    if alt and num(r.get(alt)): r[key] = r[alt]; src.append(key); continue
    fail(f"{key}=missing")
for s in ("start1", "start2"):
    st = r.get(s) or {}
    if st.get("exit") != 0 or st.get("fatal", 1): fail(f"{s}=exit{st.get('exit')}/fatal{st.get('fatal')}")
    for h in (st.get("health"), st.get("health2")):
        if h is None: continue
        lock = h.get("admissionLock") or {}
        if h.get("error") or h.get("decisionRecoveryFailed") is not None or h.get("memoryIntegrityHold") is not None or lock.get("poisoned") or lock.get("lockTimeouts"):
            fail(f"{s}-health=" + json.dumps({k: h.get(k) for k in ("error", "decisionRecoveryFailed", "memoryIntegrityHold")} | {"lock": lock}, separators=(",", ":"))[:160])
# q1023-wstart (MAIN-RULING 2026-11-27T08:44:34Z (3)): delta > 0 = the capture helper saved after resume = RECOVERS
cd = r.get("captureDelta")
if not num(cd): fail("capture-delta=missing")
elif cd <= 0: fail("capture-delta=0")
sh = r.get("shared")
shared_txt = f"replies{sh.get('replies')}/{''.join(v[0] for v in sh.get('verdicts', []))}/leaked{sh.get('leaked')}" if isinstance(sh, dict) else "not-run"
held = ",".join(f"{k}:{v}" for k, v in sorted((r.get("ownerHeld") or {}).items())) or "0"
recall = ",".join(f"{k}:{v}" for k, v in sorted((r.get("recall") or {}).items()))
meta = (r.get("before") or {}).get("meta")
counts = (f"turns={turns} recall={recall} owner-held={held} withheld={r.get('falseHeld')} masked={r.get('masked')} shared-leaked={r.get('leaked')} shared={shared_txt} "
          f"memory-paused={r.get('memoryPausedLines')} written-max={w}MiB/min cgroup-max={w_cg}MiB/min stalls>2s={r.get('stallsOver2s')} "
          f"probe-max={r.get('probeMaxMs')}ms idle-cpu={r.get('idleCpuPct')}% idle-written={r.get('idleWrittenMiB')}MiB "
          f"start1={(r.get('start1') or {}).get('listenMs')}ms/exit{(r.get('start1') or {}).get('exit')} start2={(r.get('start2') or {}).get('listenMs')}ms/exit{(r.get('start2') or {}).get('exit')} "
          f"store-mode-before={meta.get('mode') if isinstance(meta, dict) else meta} capture-delta={r.get('captureDelta')}")
counts += f" src=cgroup:{','.join(sorted(set(src)))}" if src else ""
label = ("RESCORE " if legacy and RESCORE else "") + ("resume-active " if resume is not None else "")
counts += f" left-out-notes={r.get('leftOutNotes')} left-out-log={sum(1 for row in rows if row.get('leftOutWhy'))} changed-notes={r.get('changedNotes')}" + (f" resume={resume.get('status')}/{resume.get('mode')}" if resume is not None else "")
print(f"BANNERGATE {label}{sha} {'PASS' if not fails else 'FAIL'} {counts}" + (f" fails={' ; '.join(fails)}" if fails else ""))
