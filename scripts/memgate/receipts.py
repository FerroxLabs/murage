import subprocess, sys, re
J = sys.argv[1]; V = "memgate-verdict.py"; S = "memgate-selfcheck.py"
src = open(V).read(); sc = open(S).read().split("\n")
def target(fn):
    for i, l in enumerate(sc, 1):
        if l.startswith(f"need(run({fn})"): return i
    raise SystemExit("no target " + fn)
M = [
 ("M-refusal-ignored", 'if refused: f.append("save-refused', 'if False: f.append("save-refused', "refused"),
 ("M-notactive-ignored", 'f.append("save-not-active")', 'pass', "inactive"),
 ("M-slow-ignored", 'f.append("save-slow")', 'pass', "slow"),
 ("M-card-ignored", 'if t1.get("cards", 0) or t2.get("cards", 0): f.append', 'if False: f.append', "card"),
 ("M-stop-ignored", 'if not t1.get("ended") or t1.get("stopped"): f.append("turn1-not-completed")', 'pass', "stopped"),
 ("M-holdline-ignored", 'f.append("own-write-hold-lines=%d"', 'pass; _x=("%d"', "holdline"),
 ("M-keyword-counts-as-full", 'found[k] = sum(1 for x in rr if x.get("fullAfterMs") is not None)', 'found[k] = sum(1 for x in rr if x.get("hit"))', "keyword1"),
 ("M-deadline-ignored", 'if any((x.get("fullAfterMs") or 0) > b.get("recallMs", 30000) for x in rr): f.append', 'if False: f.append', "late"),
 ("M-budget-ignored", 'if any(x.get("maxMs", 0) > sb for x in rr): f.append("%s-call-over-budget" % k)', 'pass', "overbudget"),
 ("M-exit-ignored", 'if s1.get("exit") != 0 or s2.get("exit") != 0: f.append', 'if False: f.append', "exitcode"),
 ("M-answer-ignored", 'if t.get("answerFacts", 0) != 3: f.append', 'if False: f.append', "answer"),
]
rows = ["mutant\ttargeted_file:line\terror_class\tobserved_file:line\tlog"]
for name, old, new, fn in M:
    assert old in src, name
    open(f"{J}/v-{name}.py", "w").write(src.replace(old, new, 1))
    p = subprocess.run([sys.executable, "-I", S, f"{J}/v-{name}.py"], capture_output=True, text=True)
    log = f"{J}/{name}.log"; open(log, "w").write(p.stdout + p.stderr)
    cls = (re.findall(r"^(\w*Error)", p.stderr, re.M) or ["NONE"])[-1]
    fr = re.findall(r'File "[^"]*memgate-selfcheck.py", line (\d+)', p.stderr)
    obs = f"memgate-selfcheck.py:{fr[-2]}" if len(fr) >= 2 else "none"
    rows.append(f"{name}\tmemgate-selfcheck.py:{target(fn)}\t{cls}\t{obs}\t{log}")
open(f"{J}/receipts.tsv", "w").write("\n".join(rows) + "\n")
bad = 0
for l in rows[1:]:
    m, t, c, o, _ = l.split("\t"); ok = c == "AssertionError" and o == t; bad += not ok
    print(("OK  " if ok else "BAD ") + m, t, c, o)
print("RECEIPT-CHECK", "PASS 11/11" if not bad else f"FAIL {bad}")
