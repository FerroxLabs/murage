#!/usr/bin/env python3
# Loads reader_expected.tsv and compares judge(identity, payload, mode) -> "card:<class>" | "run". Exit 1 on a mismatch.
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import judge as J
from reader_faults import inject
def run(path, quiet=False, mod=J):
    with open(os.path.join(os.path.dirname(os.path.abspath(path)), "judge_faults.json"), encoding="utf-8") as fh:
        faults = json.load(fh)
    rows = mism = 0
    ids = []
    for i, line in enumerate(open(path, encoding="utf-8")):
        if i == 0: continue
        fields = line.rstrip("\n").split("\t")
        id_, ident, mode, payload, exp, reason = fields[:6]
        # This executable remains the historical parser oracle, not permission.
        if len(fields) > 6: exp = fields[6]
        rows += 1
        with inject(mod, faults.get(id_)):
            v = mod.judge(ident, json.loads(payload), mode)
        got = "card:" + v.cls if v.verdict == "card" else "run"
        if got != exp:
            mism += 1
            ids.append((id_, exp))
            if not quiet: print("MISMATCH %s %s expected=%s got=%s why=%s" % (id_, ident, exp, got, v.why[:160]))
    return (rows, mism, ids) if quiet else (rows, mism)
if __name__ == "__main__":
    r, m = run(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "reader_expected.tsv"))
    print("judge rows=%d mismatches=%d" % (r, m)); sys.exit(1 if m else 0)
