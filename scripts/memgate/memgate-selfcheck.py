#!/usr/bin/env python3
"""q1024-memgate: self-check of memgate-verdict.py. Each case edits a PASSing result.json in one way and the verdict must FAIL with that case's own token
(an AssertionError at that case's own line). python3 -I memgate-selfcheck.py [verdict.py path]"""
import copy, importlib.util, sys
path = sys.argv[1] if len(sys.argv) > 1 else __file__.replace("memgate-selfcheck.py", "memgate-verdict.py")
spec = importlib.util.spec_from_file_location("v", path); v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
full = lambda: {"f": "kes", "ms": 50, "maxMs": 900, "attempts": 1, "keywordFirst": False, "fullAfterMs": 40, "error": None, "hit": True, "partial": False, "recallMode": None, "missed": False}
GOOD = {"budgets": {"searchMs": 5000, "saveMs": 30000, "recallMs": 30000}, "save": {"pendingCaptureAtSave": 100, "rows": [{"n": i, "code": "ok", "ms": 80, "state": "active", "pendingReview": False} for i in range(3)]},
        "turn1": {"ended": True, "cards": 0, "stopped": False, "answerFacts": 3}, "turn2": {"ended": True, "cards": 0, "stopped": False, "answerFacts": 3},
        "start1": {"holdCodes": 0, "fatal": 0, "exit": 0}, "start2": {"holdCodes": 0, "dispatch": ["full"], "exit": 0}, "recall1": [full() for _ in range(3)], "recall2": [full() for _ in range(3)]}
def run(edit, rc=0):
    r = copy.deepcopy(GOOD); edit(r); return v.verdict(r, "abcdef0123", rc)
def need(line, token):
    assert token in line, f"expected {token!r} in {line!r}"
assert " PASS store=real " in run(lambda r: None), "the unedited good result must PASS"
assert " PASS " not in v.verdict(copy.deepcopy(GOOD), "abcdef0123", 0, "synth") and "SYNTH-PASS" in v.verdict(copy.deepcopy(GOOD), "abcdef0123", 0, "synth"), "a synthetic store never yields PASS"
def refused(r): r["save"]["rows"][0]["code"] = "CAPTURE_PENDING"
need(run(refused), "save-refused(CAPTURE_PENDING=1)")
def holdabort(r): r["save"]["rows"][1]["code"] = "HOLD_ABORT"
need(run(holdabort), "save-refused(HOLD_ABORT=1)")
def inactive(r): r["save"]["rows"][2]["state"] = "pending"
need(run(inactive), "save-not-active")
def slow(r): r["save"]["rows"][0]["ms"] = 31000
need(run(slow), "save-slow")
def card(r): r["turn1"]["cards"] = 1
need(run(card), "approval-card=1")
def stopped(r): r["turn1"]["stopped"] = True
need(run(stopped), "turn1-not-completed")
def noreply2(r): r["turn2"]["ended"] = False
need(run(noreply2), "turn2-not-completed")
def holdline(r): r["start1"]["holdCodes"] = 2
need(run(holdline), "own-write-hold-lines=2")
def keyword1(r): r["recall1"][0].update(fullAfterMs=None, partial=True, recallMode="keyword")
need(run(keyword1), "recall1-full-search=2/3")
def keyword2(r): r["recall2"][1].update(fullAfterMs=None, partial=True)
need(run(keyword2), "recall2-full-search=2/3")
def overbudget(r): r["recall1"][0]["maxMs"] = 6000
need(run(overbudget), "recall1-call-over-budget")
def late(r): r["recall2"][0]["fullAfterMs"] = 31000
need(run(late), "recall2-full-after-deadline")
def toolerr(r): r["recall1"][0]["error"] = "OTHER_REFUSAL"
need(run(toolerr), "recall1-error")
def dispatch(r): r["start2"]["dispatch"] = ["off"]
assert " PASS " in run(dispatch), "the dispatch log line is not gated (MAIN memsweep J)"
def answer(r): r["turn2"]["answerFacts"] = 2
need(run(answer), "turn2-answer-facts=2/3")
def exitcode(r): r["start1"]["exit"] = -9
need(run(exitcode), "server-exit=-9/0")
def fatal(r): r["start1"]["fatal"] = 1
need(run(fatal), "fatal=1")
need(run(lambda r: None, rc=1), "vitest-rc=1")
def threerows(r): r["save"]["rows"].pop()
need(run(threerows), "save-rows=2")
print("MEMGATE-SELFCHECK PASS 19 cases")
