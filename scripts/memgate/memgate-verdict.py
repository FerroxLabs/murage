#!/usr/bin/env python3
"""q1024-memgate verdict: python3 -I memgate-verdict.py <result.json> <sha10> <vitest-rc> -> one MEMGATE-1024 line (counts and codes only)."""
import json, sys
def verdict(r, sha, rc, store="real"):
    f = []
    b = r.get("budgets", {}); sb = b.get("searchMs", 5000); vb = b.get("saveMs", 30000)
    rows = r.get("save", {}).get("rows", [])
    codes = {}
    for x in rows: codes[x["code"]] = codes.get(x["code"], 0) + 1
    refused = sum(n for c, n in codes.items() if c != "ok")
    if len(rows) != 3: f.append("save-rows=%d" % len(rows))
    if refused: f.append("save-refused(%s)" % ",".join("%s=%d" % kv for kv in sorted(codes.items()) if kv[0] != "ok"))
    if any(x["code"] == "ok" and (x.get("state") != "active" or x.get("pendingReview") is not False) for x in rows): f.append("save-not-active")
    if any(x["ms"] > vb for x in rows): f.append("save-slow")
    t1, t2 = r.get("turn1", {}), r.get("turn2", {})
    if t1.get("cards", 0) or t2.get("cards", 0): f.append("approval-card=%d" % (t1.get("cards", 0) + t2.get("cards", 0)))
    if not t1.get("ended") or t1.get("stopped"): f.append("turn1-not-completed")
    if not t2.get("ended") or t2.get("stopped"): f.append("turn2-not-completed")
    s1, s2 = r.get("start1", {}), r.get("start2", {})
    # MAIN rulings L: the server (and its capture worker) must stop cleanly on SIGTERM: any exit but 0 (a -9 = the rig had to SIGKILL it) fails
    if s1.get("exit") != 0 or s2.get("exit") != 0: f.append("server-exit=%s/%s" % (s1.get("exit"), s2.get("exit")))
    if s1.get("holdCodes", 0) or s2.get("holdCodes", 0): f.append("own-write-hold-lines=%d" % (s1.get("holdCodes", 0) + s2.get("holdCodes", 0)))
    if s1.get("fatal", 0): f.append("fatal=%d" % s1["fatal"])
    mx = 0; found = {}; kw = 0; late = 0
    for k in ("recall1", "recall2"):
        rr = r.get(k, [])
        found[k] = sum(1 for x in rr if x.get("fullAfterMs") is not None)
        kw += sum(1 for x in rr if x.get("keywordFirst"))
        if len(rr) != 3 or found[k] != 3: f.append("%s-full-search=%d/3" % (k, found[k]))
        if any(x.get("error") for x in rr): f.append("%s-error" % k)
        if any((x.get("fullAfterMs") or 0) > b.get("recallMs", 30000) for x in rr): f.append("%s-full-after-deadline" % k)
        if any(x.get("maxMs", 0) > sb for x in rr): f.append("%s-call-over-budget" % k)
        mx = max([mx] + [x.get("maxMs", 0) for x in rr])
    d = s2.get("dispatch", [])
    # MAIN memsweep J: the "turn dispatch recall=" log line is NOT gated (recorded only); the answer and the search outcomes are
    for k, t in (("turn1", t1), ("turn2", t2)):
        if t.get("answerFacts", 0) != 3: f.append("%s-answer-facts=%d/3" % (k, t.get("answerFacts", 0)))
    if str(rc) not in ("0", "None") and not f: f.append("vitest-rc=%s" % rc)
    # a synthetic store is a rig smoke test, never a gate result: its pass can never match the real PASS line (review pass 3)
    status = ("PASS" if store == "real" else "SYNTH-PASS") if not f else "FAIL"
    first = [x for x in rows if x["code"] != "ok"]
    return "MEMGATE-1024 %s %s store=%s saved=%d/3 refused=%d cards=%d recall1=%s/3 recall2=%s/3 keywordFirst=%d maxSearchMs=%d pendingCaptureAtSave=%s%s" % (
        sha, status, store, len(rows) - refused, refused, t1.get("cards", 0) + t2.get("cards", 0), found.get("recall1", 0), found.get("recall2", 0), kw, mx,
        r.get("save", {}).get("pendingCaptureAtSave"), (" fails=" + ";".join(f)) if f else "")
if __name__ == "__main__":
    print(verdict(json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None, sys.argv[4] if len(sys.argv) > 4 else "real"))
