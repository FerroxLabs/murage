"""busyloop_check.py: runs busyloop_spec over every row of busyloop_expected.tsv.

    python3 -I busyloop_check.py <flux-prod-429 dir>

Fails (exit 1) on: any expectation mismatch; a fixture leaf (top dir, siblings/, target-654/)
with no row; a fixture row with no leaf; two rows with identical bytes but different expectations;
a resp row where the Fuigo data.upstream path disagrees with the raw-bytes answer; a witness trace
that does not reproduce; a mutant that the check does not kill.
"""
import glob
import hashlib
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EPS = {"/v1/chat/completions": "chat", "/v1/responses": "resp", "/v1/messages": "msg"}


def load_spec():
    sp = importlib.util.spec_from_file_location("busyloop_spec", os.path.join(HERE, "busyloop_spec.py"))
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


def leaves(j):
    out = []
    if "body" in j or "headers" in j:
        out.append((EPS[j["endpoint"]], {k: v for k, v in j.items() if k != "per_endpoint"}))
    def walk(o, pre):
        for k, v in o.items():
            if not isinstance(v, dict):
                continue
            lab = EPS.get(k, k)
            if "status" in v and ("body" in v or "headers" in v):
                out.append((pre + lab, v))
            else:
                walk(v, pre + k.replace("_variant", "") + "/")
    walk(j.get("per_endpoint", {}), "")
    return out


def fixture_leaves(d):
    got = {}
    for sub, pat in (("", "[0-9]*.json"), ("siblings", "D*.json"), ("target-654", "*.json")):
        for f in sorted(glob.glob(os.path.join(d, sub, pat))):
            base = os.path.basename(f)
            if base.startswith("._") or base == "PROVENANCE.json":
                continue
            j = json.load(open(f))
            if j.get("not_reachable_in_prod"):
                continue                      # carried as a "homegate" row instead
            stem = base.split("-")[0]
            pre = "t654:" if sub == "target-654" else ""
            for leaf, r in leaves(j):
                got[f"{pre}{stem}.{leaf}"] = r
    return got


def ep_of(leaf_id):
    return leaf_id.split("/")[-1].split(".")[-1].split("_")[-1]


def load_rows(path):
    lines = open(path).read().splitlines()
    hdr = lines[0].split("\t")
    return [dict(zip(hdr, l.split("\t"))) for l in lines[1:] if l.strip()]


def _dict(v):
    return v if isinstance(v, dict) else {}


def norm_wait(w):
    return str(w)


def run(spec, rows, fx, verbose):
    """Returns a list of failure strings."""
    fails = []
    inputs = {}
    for r in rows:
        if r["status"] == "fixture":
            leaf = fx.get(r["id"])
            if leaf is None:
                fails.append(f"ROW WITHOUT LEAF {r['id']}")
                continue
            if ep_of(r["id"]) != r["endpoint"]:
                fails.append(f"ENDPOINT {r['id']} {r['endpoint']}")
            inputs[r["id"]] = (r["endpoint"], leaf["status"], leaf.get("headers") or {}, leaf.get("body"))
        else:
            inputs[r["id"]] = (r["endpoint"], int(r["status"]), json.loads(r["headers"]), json.loads(r["body"]))
    for lid in fx:
        if lid not in inputs:
            fails.append(f"LEAF WITHOUT ROW {lid}")
    classes = {}
    seen_revoked = []
    for r in rows:
        if r["id"] not in inputs:
            continue
        ep, st, h, b = inputs[r["id"]]
        exp = (r["reason"], r["action"], r["wait"])
        got = spec.classify(ep, st, h, b)
        got = (got[0], got[1], norm_wait(got[2]))
        if got != exp:
            fails.append(f"MISMATCH {r['id']}: expected {exp} got {got}")
        hl = {k.lower(): v for k, v in h.items()}
        canon = json.dumps([ep, st, {k: hl[k] for k in ("retry-after", "x-flux-hold-reason") if k in hl}, b], sort_keys=True)
        k = hashlib.sha256(canon.encode()).hexdigest()[:8]
        if k in classes and classes[k][1] != exp:
            fails.append(f"IDENTICAL BYTES, DIFFERENT EXPECTATION {r['id']} vs {classes[k][0]}")
        classes.setdefault(k, (r["id"], exp))
        if ep == "resp":   # port parity: Fuigo data.upstream + capped data.message -> Murage decide()
            u = spec.fuigo_upstream(st, h, b)
            via = spec.decide(spec.signals_from_upstream(u, spec.fuigo_display_text(st, b)))
            via = (via[0], via[1], norm_wait(via[2]))
            if via != exp:
                fails.append(f"UPSTREAM PARITY {r['id']}: expected {exp} via upstream {via} u={u}")
            raw_codes = spec.extract(ep, st, h, b).codes     # A2.2: conflicting codes survive the projection
            via_codes = spec.signals_from_upstream(u, spec.fuigo_display_text(st, b)).codes
            if raw_codes != via_codes:
                fails.append(f"UPSTREAM CODES {r['id']}: raw {raw_codes} via upstream {via_codes} u={u}")
            be = _dict(_dict(b).get("error"))
            want_reset = None
            for src in (be, _dict(be.get("provider_specific_fields"))):
                v = src.get("resets_at")
                if isinstance(v, str) and spec.RFC3339Z.fullmatch(v):
                    want_reset = v; break
            if u.get("resets_at") != want_reset:
                fails.append(f"UPSTREAM RESETS_AT {r['id']}: raw body has {want_reset} upstream has {u.get('resets_at')}")
        mark = spec.key_rejected_mark(exp[0])
        if mark != (exp[0] == "keyRevoked"):
            fails.append(f"KEY_REJECTED_MARK {r['id']}: reason {exp[0]} marked {mark}")
        if exp[0] == "keyRevoked":
            seen_revoked.append(r["id"])
    if not seen_revoked:
        fails.append("KEY_REJECTED_MARK: no keyRevoked row, the mark is untested")
    for rid, want in spec.PROJECTION_REQUIRED.items():
        if rid not in inputs:
            fails.append(f"PROJECTION_REQUIRED row {rid} missing"); continue
        ep, st, h, b = inputs[rid]
        u = spec.fuigo_upstream(st, h, b)
        for k, v in want.items():
            if u.get(k) != v:
                fails.append(f"PROJECTION_REQUIRED {rid}: upstream[{k}] expected {v} got {u.get(k)}")
    def resolve(rid):
        ep, st, h, b = inputs[rid]
        return st, spec.classify(ep, st, h, b)
    for name, refreshable, events, expected in spec.WITNESS_TRACES:
        try:
            got = spec.run_trace(refreshable, events, resolve)
        except Exception as e:  # noqa: BLE001
            got = ("error", repr(e))
        if tuple(got) != tuple(expected):
            fails.append(f"TRACE {name}: expected {expected} got {got}")
    shared = sum(1 for _ in classes)
    if verbose:
        print(f"rows={len(rows)} leaves={len(fx)} byte_classes={shared} traces={len(spec.WITNESS_TRACES)}")
    return fails


# ------------------------------------------------------------------ mutants
def mutants():
    def m_swap_text_transient(s):
        st = list(s.ACTION_STEPS); st.remove(s.step_terminal_text)
        st.insert(st.index(s.step_transient) + 1, s.step_terminal_text); s.ACTION_STEPS = st
    def m_drop_401(s): s.TERMINAL_STATUS = {402, 403}
    def m_credit_unresolved_retry(s):
        s.FLUX_FINAL = s.FLUX_FINAL - {"credit_unresolved"}; s.TRANSIENT_CODES = s.TRANSIENT_CODES | {"credit_unresolved"}
    def m_drop_d12(s):
        tr = list(s.TEXT_RULES); kb = [x for x in tr if x[1] == "keyBudget"][0]
        tr.remove(kb); tr.insert([i for i, x in enumerate(tr) if x[1] == "botBudget"][0], kb); s.TEXT_RULES = tr
    def m_ignore_limit(s): s.LIMIT_SUBTYPE = {}
    def m_drop_known_wait(s): s.ACTION_STEPS = [x for x in s.ACTION_STEPS if x is not s.step_429_known_wait]
    def m_drop_pause(s): s.ACTION_STEPS = [x for x in s.ACTION_STEPS if x is not s.step_429_unknown]
    def m_drop_terminal_text(s): s.ACTION_STEPS = [x for x in s.ACTION_STEPS if x is not s.step_terminal_text]
    def m_drop_mislabel(s): s.mislabel = lambda sig: False
    def m_mislabel_ignores_header(s): s.mislabel = lambda sig: sig.endpoint == "chat" and "free_tier_exhausted" in sig.codes
    def m_transient_names_stop(s): s.FINAL_ORDER = [("concurrency", "hold"), ("batch_concurrency", "busy")] + s.FINAL_ORDER
    def m_bool_is_int(s): s.is_int = lambda v: isinstance(v, int)
    def m_override_after_codes(s):
        s.TEXT_RULES = s.OVERRIDE_TEXT + s.TEXT_RULES; s.OVERRIDE_TEXT = []
    def m_fuigo_drops_limit(s):
        orig = s.fuigo_upstream
        def f(st, h, b):
            u = orig(st, h, b); u.pop("limit", None); return u
        s.fuigo_upstream = f
    def m_no_refresh_exception(s): s.refresh_eligible = lambda *a: False
    def m_refresh_on_403(s):
        s.refresh_eligible = lambda st, res, rf: rf and st in (401, 403) and res == ("keyRefused", s.STOP, "-")
    def m_two_refreshes(s):    # A2.2: a refused resubmit reopens a second refresh (finality removed for STOP)
        s.MAX_REFRESHES = 2
        orig = s.PromptSM.respond
        def r(self, kind, status, result):
            orig(self, kind, status, result)
            if kind == "refresh_resubmit" and result is not None and s.refresh_eligible(status, result, self.refreshable):
                self.state = s.AUTH_REFRESH
        s.PromptSM.respond = r
    def m_hash_invariant(s):
        orig = s.PromptSM.dispatch
        def d(self, kind, key=None):
            seen = self.__dict__.setdefault("_keys", set())
            if self.state == s.TERMINAL and key not in seen:   # (model, body) uniqueness only
                self.dispatches += 1; seen.add(key); return
            seen.add(key); return orig(self, kind, key)
        s.PromptSM.dispatch = d
    def m_side_exempt(s):
        orig = s.PromptSM.dispatch
        def d(self, kind, key=None):
            if kind == "side" and self.state == s.TERMINAL:
                self.dispatches += 1; return
            return orig(self, kind, key)
        s.PromptSM.dispatch = d
    def m_drop_403(s): s.TERMINAL_STATUS = {401, 402}
    def m_drop_resets_at(s):
        orig = s.fuigo_upstream
        def f(st, h, b):
            u = orig(st, h, b); u.pop("resets_at", None); return u
        s.fuigo_upstream = f
    def m_wrong_key_rejected_mark(s): s.key_rejected_mark = lambda r: r.startswith("key")
    def m_fuigo_first_code_only(s):
        orig = s.fuigo_upstream
        def f(st, h, b):
            u = orig(st, h, b); u.pop("codes", None); return u
        s.fuigo_upstream = f
    def m_resubmit_transient_open(s):
        orig = s.PromptSM.respond
        def r(self, kind, status, result):
            orig(self, kind, status, result)
            if kind == "refresh_resubmit" and result is not None and result[1] in (s.BACKOFF, s.RETRY_ONCE, s.PASS):
                self.state = s.REFRESHED
        s.PromptSM.respond = r
    return [(n[2:], f) for n, f in sorted(locals().items()) if n.startswith("m_")]


REQUIRED = {"swap_text_transient", "drop_401", "credit_unresolved_retry", "drop_d12", "drop_403",
            "drop_resets_at", "wrong_key_rejected_mark", "fuigo_first_code_only", "resubmit_transient_open"}


def selftest_target(spec, rows):
    """A2.2 P2-6: prove the target-654 rule works without target bytes. A temp tree whose
    target-654/ holds one leaf must yield a t654: leaf, and run() must fail it as LEAF WITHOUT ROW."""
    import tempfile
    fails = []
    with tempfile.TemporaryDirectory() as td:
        os.makedirs(os.path.join(td, "target-654"))
        leaf = {"endpoint": "/v1/responses", "status": 402, "headers": {}, "body": {"error": {"error": "credit_exhausted"}}}
        json.dump(leaf, open(os.path.join(td, "target-654", "99-402-selftest.json"), "w"))
        fx = fixture_leaves(td)
        if list(fx) != ["t654:99.resp"]:
            fails.append(f"SELFTEST target-654 leaf not picked up: {list(fx)}")
        elif not any(f.startswith("LEAF WITHOUT ROW t654:99.resp") for f in run(spec, rows, fx, False)):
            fails.append("SELFTEST a target-654 leaf with no row did not fail the check")
    return fails


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    require_target = "--require-target" in sys.argv
    d = args[0]
    fx = fixture_leaves(d)
    rows = load_rows(os.path.join(HERE, "busyloop_expected.tsv"))
    spec0 = load_spec()
    fails = run(spec0, rows, fx, True) + selftest_target(spec0, rows)
    t_leaves = [k for k in fx if k.startswith("t654:")]
    t_rows = [r for r in rows if r["id"].startswith("t654:")]
    if os.path.isdir(os.path.join(d, "target-654")):
        print(f"target-654: PRESENT leaves={len(t_leaves)} rows={len(t_rows)} (every leaf must have a row)")
    else:
        print("target-654: ABSENT. Target acceptance NOT established; GREEN below is current-fixture coverage only.")
        if require_target:
            fails.append("TARGET-654 ABSENT with --require-target: target acceptance cannot be claimed")
    for f in fails:
        print("FAIL", f)
    print(f"mismatches={len(fails)}")
    killed, survived = [], []
    for name, mut in mutants():
        s = load_spec(); mut(s)
        mf = run(s, rows, fx, False)
        (killed if mf else survived).append(name)
        print(f"mutant {name}: {'KILLED' if mf else 'SURVIVED'} ({len(mf)} fails; first: {mf[0] if mf else '-'})")
    print(f"mutants killed={len(killed)}/{len(killed) + len(survived)}")
    missing = REQUIRED - {n for n, _ in mutants()}
    ok = not fails and not survived and not missing
    target = "present" if os.path.isdir(os.path.join(d, "target-654")) else "ABSENT, target acceptance NOT established"
    print("RESULT", ("GREEN (current-fixture coverage; target-654 " + target + ")") if ok else "RED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
