"""busyloop_spec.py: reference classifier for Flux refusals (refusal-contract-A2.1, Murage 1.0.19 T50).

Pure, stdlib only, no I/O. This file IS the spec: the Murage and Fuigo builds port it faithfully.
Their tests load busyloop_expected.tsv directly, and port parity with this file is the acceptance.

    classify(endpoint, status, headers, body, now=FROZEN_NOW) -> (reason, action, wait)

endpoint: "chat" (/v1/chat/completions), "resp" (/v1/responses), "msg" (/v1/messages).
status:   the HTTP status as an int.
headers:  a dict (any key case) or None.
body:     the parsed JSON body, or None when the body was lost (Claude CLI status-only).
wait:     "-" (none), an int of seconds, "ladder" (5, 10, 20 s then the repeat card), or
          "reset+N" (STOP hourly only: the card's reset hint, N seconds from now).

The split is extract() -> Signals -> decide(). Murage's resp path reads Fuigo 1.0.42's
data.upstream instead of the raw body: signals_from_upstream() is that adapter, and
fuigo_upstream() is the Fuigo-side extraction that produces data.upstream. Both ports are
held to decide() giving the same answer as classify() on the raw bytes.

Section 6 holds the P1-3 prompt state machine (refresh exception, terminality, dispatch counts).
"""
import json
import re
from datetime import datetime, timezone

FROZEN_NOW = datetime(2026, 11, 10, 20, 7, 21, tzinfo=timezone.utc)

STOP, PAUSE, BACKOFF, RETRY_ONCE, PASS = "STOP", "PAUSE", "BACKOFF", "RETRY_ONCE", "PASS"

# ---------------------------------------------------------------- 1. vocabulary
# HTTP statuses that are terminal before anything else is read (section 2.2 step 1).
TERMINAL_STATUS = {401, 402, 403}

# FLUX_FINAL in strength order: the first one present names the reason.
# Order: key family, accountCeiling, key-limit family, plan family, credit family, hourly.
FINAL_ORDER = [
    ("key_revoked", "keyRevoked"),
    ("key_not_found", "keyNotFound"),
    ("entitlement_missing", "keyAccess"),
    ("subscription_account_mismatch", "keyAccess"),
    ("authorization_state_unknown", "accessUnknown"),
    ("account_monthly_budget_exhausted", "accountCeiling"),
    ("key_budget_reached", "keyBudget"),          # subtype: see key_budget_subtype()
    ("key_lifetime_cap_exhausted", "keyLifetime"),
    ("free_cap_reached", "freeCap"),
    ("free_tier_exhausted", "freeCredit"),        # chat mislabel rule runs first
    ("builder_auto_bump_eligible", "requestCap"),
    ("cap_reached", "planCap"),
    ("credit_exhausted", "credit"),
    ("credit_hold", "creditHold"),
    ("credit_unresolved", "unresolved"),
    ("monthly_cap", "spendCap"),
    ("daily_cap", "spendCap"),
    ("hourly_burn_limit", "hourly"),
]
FLUX_FINAL = {c for c, _ in FINAL_ORDER}

# Hold: one automatic retry. Transient: backoff. These NEVER name a STOP reason (X1, X3).
HOLD_CODES = {"concurrency"}
TRANSIENT_CODES = {"batch_rate", "batch_concurrency", "billing_system_degraded", "tier_rpm_limit",
                   "key_rate_limit", "model_cooling_down", "provider_rate_limited"}
VOCAB = FLUX_FINAL | HOLD_CODES | TRANSIENT_CODES

# key_budget_reached subtype: the `limit` field decides when present; it is OPTIONAL (P1-2).
LIMIT_SUBTYPE = {"monthly_spend": "keyBudget", "monthly_tokens": "keyTokens",
                 "bot_monthly_spend": "botBudget"}

# Terminal text, in precedence order (most specific first). Any match makes the refusal STOP on
# any status (P1-1), and the first match names the reason when no FLUX_FINAL code does.
# Case-sensitive substrings of Flux's own sentences.
REWRITE_SENTENCE = "Free tier monthly allowance exhausted. Upgrade to Builder"
OVERRIDE_TEXT = [  # beat any code, including a coarse hold header (rows 17, D17, 13)
    ((REWRITE_SENTENCE,), "fluxStop"),
    (("plan allowance", "paused until"), "planAllowance"),
    (("overage cap",), "spendCap"),
    (("$1 free credit is used up",), "freeCredit"),
]
TEXT_RULES = [  # used after the code map; D12: bot before token before key
    (("monthly free-tier token allowance",), "freeCap"),
    (("10M request cap reached",), "requestCap"),
    (("Monthly cap reached",), "planCap"),
    (("API key has been revoked",), "keyRevoked"),
    (("no active Flux entitlement",), "keyAccess"),
    (("does not resolve to this account",), "keyAccess"),
    (("No Flux key record",), "keyNotFound"),
    (("entitlement state could not be interpreted",), "accessUnknown"),
    (("bot has reached its",), "botBudget"),
    (("token monthly limit",), "keyTokens"),
    (("monthly budget",), "keyBudget"),
    (("lifetime spend cap",), "keyLifetime"),
    (("monthly spend ceiling",), "accountCeiling"),
    (("credit balance is exhausted",), "credit"),
    (("Cloud credit is exhausted",), "credit"),
    (("credit is on hold",), "creditHold"),
    (("could not be verified",), "unresolved"),
    (("spend cap is reached",), "spendCap"),
]
# key_budget_reached with no `limit`: the subtype comes from these, else keyBudget.
SUBTYPE_TEXT = ("botBudget", "keyTokens", "keyBudget")

HOLD_TEXT = ("temporarily reserved",)
RATE_TEXT = ("RateLimitError", "Rate limit", "No deployments available", "Limit resets at",
             "retry shortly")
WAIT_PATTERNS = [re.compile(p) for p in (r"Retry in (\d+)s", r"Retry after (\d+) seconds?",
                                         r"[Tt]ry again in (\d+) ?s(?:econds)?")]
RESETS_AT_TEXT = re.compile(r"Limit resets at: (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC")
SLUG = re.compile(r"[a-z0-9_:-]{1,64}")
RFC3339Z = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
WIRE_WAIT_MAX = 7200

# ---------------------------------------------------------------- 2. small helpers
def is_int(v):
    """A JSON integer. JSON true/false are NOT integers (Astra P2-7)."""
    return type(v) is int

def slug(v):
    return v if isinstance(v, str) and SLUG.fullmatch(v) else None

def lower_headers(h):
    return {str(k).lower(): v for k, v in (h or {}).items()}

def text_has(text, needles):
    return all(n in text for n in needles)

def first_text_reason(text, rules):
    for needles, reason in rules:
        if text_has(text, needles):
            return reason
    return None

def wire_wait(v):
    """0..7200 integer seconds, else None."""
    return v if is_int(v) and 0 <= v <= WIRE_WAIT_MAX else None

def header_wait(v):
    return int(v) if isinstance(v, str) and v.isascii() and v.isdigit() and int(v) <= WIRE_WAIT_MAX else None

def text_wait(text, now):
    for p in WAIT_PATTERNS:
        m = p.search(text)
        if m:
            return int(m.group(1))
    m = RESETS_AT_TEXT.search(text)
    if m:
        t = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        d = int((t - now).total_seconds())
        return d if d > 0 else None
    return None

def _dict(v):
    return v if isinstance(v, dict) else {}

# ---------------------------------------------------------------- 3. extract -> Signals
class Signals:
    __slots__ = ("endpoint", "status", "codes", "limit", "text", "wait", "hold_header")

    def __init__(self, endpoint, status, codes, limit, text, wait, hold_header):
        self.endpoint, self.status, self.codes = endpoint, status, codes
        self.limit, self.text, self.wait, self.hold_header = limit, text, wait, hold_header


def extract(endpoint, status, headers, body, now=FROZEN_NOW):
    h = lower_headers(headers)
    e = _dict(_dict(body).get("error"))
    psf = _dict(e.get("provider_specific_fields"))
    pe = psf.get("error")
    ped = _dict(pe)
    codes = []
    def add(v):
        s = slug(v)
        if s and s in VOCAB and s not in codes:
            codes.append(s)
    add(h.get("x-flux-hold-reason"))
    add(e.get("state"))
    add(e.get("error"))
    if isinstance(e.get("code"), str) and not e["code"].isdigit():
        add(e["code"])
    add(e.get("type"))
    add(pe if isinstance(pe, str) else None)
    add(ped.get("state")); add(ped.get("type")); add(ped.get("error"))
    limit = slug(e.get("limit")) or slug(psf.get("limit")) or slug(ped.get("limit"))
    texts = [t for t in (e.get("message"), psf.get("message"), ped.get("message")) if isinstance(t, str)]
    text = "\n".join(texts)
    wait = header_wait(h.get("retry-after"))
    for v in (e.get("retry_after"), psf.get("retry_after"), ped.get("retry_after")):
        if wait is None:
            wait = wire_wait(v)
    if wait is None:
        wait = text_wait(text, now)
    if wait is not None:
        wait = max(1, min(WIRE_WAIT_MAX, wait))
    return Signals(endpoint, status, codes, limit, text, wait, "x-flux-hold-reason" in h)

# ---------------------------------------------------------------- 4. decide: action, then reason
def terminal_text_reason(s):
    return first_text_reason(s.text, OVERRIDE_TEXT) or first_text_reason(s.text, TEXT_RULES)

def step_terminal_status(s):
    return (STOP, None) if s.status in TERMINAL_STATUS else None

def step_final_code(s):
    return (STOP, None) if any(c in FLUX_FINAL for c in s.codes) else None

def step_terminal_text(s):
    return (STOP, None) if terminal_text_reason(s) else None

def step_hold(s):
    if any(c in HOLD_CODES for c in s.codes) or any(t in s.text for t in HOLD_TEXT):
        return (RETRY_ONCE, s.wait if s.wait is not None else 2)
    return None

def step_transient(s):
    if any(c in TRANSIENT_CODES for c in s.codes) or any(t in s.text for t in RATE_TEXT):
        return (BACKOFF, s.wait if s.wait is not None else "ladder")
    return None

def step_429_known_wait(s):  # Astra P2-4: a known wait is never discarded for the ladder
    return (BACKOFF, s.wait) if s.status == 429 and s.wait is not None else None

def step_429_unknown(s):     # honest unknown: no automatic resend, no claimed cause
    return (PAUSE, None) if s.status == 429 else None

def step_5xx(s):
    return (RETRY_ONCE, s.wait if s.wait is not None else 2) if s.status >= 500 else None

# Section 2.2 precedence, explicit. First match wins. Mutants reorder or drop entries here.
ACTION_STEPS = [step_terminal_status, step_final_code, step_terminal_text, step_hold,
                step_transient, step_429_known_wait, step_429_unknown, step_5xx]


def key_budget_subtype(s):
    if s.limit in LIMIT_SUBTYPE:
        return LIMIT_SUBTYPE[s.limit]
    t = first_text_reason(s.text, TEXT_RULES)
    return t if t in SUBTYPE_TEXT else "keyBudget"


def mislabel(s):
    """Chat failure-hook rewrite: free_tier_exhausted with no hold header names no true cause."""
    return s.endpoint == "chat" and "free_tier_exhausted" in s.codes and not s.hold_header


def stop_reason(s):
    if mislabel(s):
        return "fluxStop"
    r = first_text_reason(s.text, OVERRIDE_TEXT)
    if r:
        return r
    for code, reason in FINAL_ORDER:       # transient and hold codes never reach here
        if code in s.codes:
            return key_budget_subtype(s) if code == "key_budget_reached" else reason
    r = first_text_reason(s.text, TEXT_RULES)
    if r:
        return r
    return "keyRefused" if s.status in (401, 403) else "fluxStop"


def decide(s):
    action, wait = PASS, None
    for step in ACTION_STEPS:
        got = step(s)
        if got:
            action, wait = got
            break
    if action == STOP:
        reason = stop_reason(s)
        out_wait = f"reset+{s.wait}" if reason == "hourly" and s.wait is not None else "-"
        return (reason, STOP, out_wait)
    if action == PAUSE:
        return ("unknownLimit", PAUSE, "-")
    if action == RETRY_ONCE:
        held = any(c in HOLD_CODES for c in s.codes) or any(t in s.text for t in HOLD_TEXT)
        return ("hold" if held else "busy", RETRY_ONCE, wait)
    if action == BACKOFF:
        return ("busy", BACKOFF, wait)
    return ("other", PASS, "-")


def classify(endpoint, status, headers, body, now=FROZEN_NOW):
    return decide(extract(endpoint, status, headers, body, now))


def key_rejected_mark(reason):
    """KEY_REJECTED_REASON ("change it in Settings") only for keyRevoked."""
    return reason == "keyRevoked"

# ---------------------------------------------------------------- 5. Fuigo 1.0.42 port surface
def fuigo_upstream(status, headers, body):
    """What Fuigo 1.0.42 puts in data.upstream for a refusal (A6-A8 as amended by A2.1).
    Slugs only, never free text. `limit` is new in A2.1. Integers exclude JSON booleans."""
    h = lower_headers(headers)
    e = _dict(_dict(body).get("error"))
    psf = _dict(e.get("provider_specific_fields"))
    pe = psf.get("error")
    ped = _dict(pe)
    u = {"http_status": status}
    if slug(e.get("type")): u["type"] = e["type"]
    if slug(e.get("state")): u["state"] = e["state"]
    code = None
    if slug(e.get("error")): code = e["error"]
    elif slug(pe): code = pe
    elif slug(ped.get("state")) or slug(ped.get("type")): code = slug(ped.get("state")) or ped["type"]
    elif slug(e.get("code")) and not e["code"].isdigit(): code = e["code"]
    if code: u["code"] = code
    codes = []                                  # A2.2: every slug code, in extract() order, none lost
    for v in (e.get("state"), e.get("error"),
              e.get("code") if isinstance(e.get("code"), str) and not e["code"].isdigit() else None,
              e.get("type"), pe if isinstance(pe, str) else None,
              ped.get("state"), ped.get("type"), ped.get("error")):
        if slug(v) and v not in codes:
            codes.append(v)
    if codes: u["codes"] = codes
    if slug(h.get("x-flux-hold-reason")): u["hold_reason"] = h["x-flux-hold-reason"]
    lim = slug(e.get("limit")) or slug(psf.get("limit")) or slug(ped.get("limit"))
    if lim: u["limit"] = lim
    ra = header_wait(h.get("retry-after"))
    for v in (e.get("retry_after"), psf.get("retry_after"), ped.get("retry_after")):
        if ra is None:
            ra = wire_wait(v)
    if ra is not None: u["retry_after_s"] = ra
    ra2 = e.get("resets_at") or psf.get("resets_at")
    if isinstance(ra2, str) and RFC3339Z.fullmatch(ra2): u["resets_at"] = ra2
    return u


def fuigo_display_text(status, body, cap=280):
    """data.message as Fuigo 1.0.41/1.0.42 emits it: Display form, capped at 280 characters."""
    e = _dict(_dict(body).get("error"))
    msg = e.get("message") if isinstance(e.get("message"), str) else ""
    typ = e.get("type") if isinstance(e.get("type"), str) else ""
    inner = f"{typ}: {msg}" if typ and msg else (msg or typ)
    return f"API error (status {status}): {inner}"[:cap]


def signals_from_upstream(u, text, now=FROZEN_NOW):
    """Murage's resp-path adapter: data.upstream (typed, decides) plus data.message (text)."""
    codes = []
    listed = u.get("codes") if isinstance(u.get("codes"), list) else []
    srcs = [u.get("hold_reason")] + listed + [u.get(k) for k in ("state", "code", "type")]
    for v in srcs:                              # A2.2: the full codes list decides, never one pick
        s = slug(v)
        if s and s in VOCAB and s not in codes:
            codes.append(s)
    wait = wire_wait(u.get("retry_after_s"))
    if wait is None:
        wait = text_wait(text, now)
    if wait is not None:
        wait = max(1, min(WIRE_WAIT_MAX, wait))
    return Signals("resp", u["http_status"], codes, slug(u.get("limit")), text, wait, "hold_reason" in u)


def fuigo_is_terminal(result):
    """Fuigo A9: no sampler retry, no 4d, no compact/resume resend for STOP and PAUSE."""
    return result[1] in (STOP, PAUSE)

# ---------------------------------------------------------------- 6. P1-3 prompt state machine
# Counts MODEL DISPATCHES (POSTs to the model endpoint), not (model, body hash).
DISPATCH_KINDS = {"main", "side", "sampler_retry", "refresh_resubmit", "provider_4c",
                  "transient_4d", "compact", "resume"}
MAX_REFRESHES = 1
OPEN, AUTH_REFRESH, REFRESHED, TERMINAL, DONE = "OPEN", "AUTH_REFRESH", "REFRESHED", "TERMINAL", "DONE"


def refresh_eligible(status, result, refreshable):
    """FA12, the ONE scoped exception to terminality: a bare 401 (no FLUX_FINAL code, no terminal
    text, so reason keyRefused) on a refreshable session-token config. Never 403, never 402."""
    return refreshable and status == 401 and result == ("keyRefused", STOP, "-")


class PromptSM:
    """One user prompt. Rules:
    R1 main is dispatched once; side at most once, and never after TERMINAL.
    R2 a STOP/PAUSE response to the main turn is TERMINAL, except R3.
    R3 bare 401 on a refreshable config: one token refresh, then one refresh_resubmit.
       Terminality applies to whatever answers that resubmit, STOP, PAUSE, BACKOFF, RETRY_ONCE
       or a non-refusal alike (no second refresh, no retry, no side call).
    R4 after TERMINAL: zero model dispatches of ANY kind, and no token refresh.
    R5 a side call's response never changes the prompt state (its failure is non-fatal)."""

    def __init__(self, refreshable):
        self.refreshable = refreshable
        self.state = OPEN
        self.dispatches = 0
        self.after_terminal = 0
        self.main = self.side = self.refreshes = self.resubmits = 0
        self.violations = []

    def _bad(self, why):
        self.violations.append(why)

    def dispatch(self, kind, key=None):
        """key = (model, body) label; recorded but NOT used by the invariant (Astra P1-3)."""
        assert kind in DISPATCH_KINDS, kind
        self.dispatches += 1
        if self.state == TERMINAL:
            self.after_terminal += 1
            self._bad(f"{kind} dispatched after terminal")
            return
        if kind == "main":
            self.main += 1
            if self.main > 1: self._bad("second main dispatch")
        elif kind == "side":
            self.side += 1
            if self.side > 1: self._bad("second side dispatch")
        elif kind == "refresh_resubmit":
            if self.state != REFRESHED: self._bad("resubmit without an eligible refresh")
            self.resubmits += 1
            if self.resubmits > 1: self._bad("second resubmit")
        elif self.state in (AUTH_REFRESH, REFRESHED):
            self._bad(f"{kind} during the auth refresh exception")

    def refresh_token(self):
        if self.state != AUTH_REFRESH:
            self._bad(f"token refresh in state {self.state}")
            return
        self.refreshes += 1
        self.state = REFRESHED

    def respond(self, kind, status, result):
        """result is classify(...) for a refusal, or None for a 2xx success."""
        if kind == "side":
            return
        if result is None:
            self.state = DONE
            return
        if kind == "refresh_resubmit":
            # A2.2: whatever answers the resubmit is final. BACKOFF / RETRY_ONCE / PASS included:
            # there is no retry, no side call and no second refresh after it.
            self.state = TERMINAL
            return
        if result[1] in (STOP, PAUSE):
            if self.state == OPEN and self.refreshes < MAX_REFRESHES and refresh_eligible(status, result, self.refreshable):
                self.state = AUTH_REFRESH
            else:
                self.state = TERMINAL
        # BACKOFF / RETRY_ONCE on the main turn leave the prompt OPEN for a retry

    def verdict(self):
        return ("violation" if self.violations else "ok", self.dispatches, self.state)


# Witness traces. Events: ("d", kind, key) dispatch; ("r", kind, row_id | "ok") response, where
# row_id names a busyloop_expected.tsv row whose bytes answer the request; ("t",) token refresh;
# ("new",) the user sends again (a fresh PromptSM). Expected: (verdict, model dispatches of the
# last prompt, final state).
WITNESS_TRACES = [
    ("W1 FA12 bare 401, refreshable: one refresh, one resubmit, success", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "ok")], ("ok", 2, DONE)),
    ("W2 resubmit refused again: terminal after the one refresh", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "14.resp")], ("ok", 2, TERMINAL)),
    ("W3 ...then a sampler retry is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "14.resp"), ("d", "sampler_retry", "auto/A")], ("violation", 3, TERMINAL)),
    ("W4 ...and a second refresh is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "14.resp"), ("t",)], ("violation", 2, TERMINAL)),
    ("W5 FA6 bare 401, static key: terminal, 1 POST", False,
     [("d", "main", "auto/A"), ("r", "main", "14.resp")], ("ok", 1, TERMINAL)),
    ("W6 bare 401, static key: a refresh is a violation", False,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",)], ("violation", 1, TERMINAL)),
    ("W7 401 + credit_unresolved (X2), refreshable: not bare, no refresh", True,
     [("d", "main", "auto/A"), ("r", "main", "X2"), ("t",)], ("violation", 1, TERMINAL)),
    ("W8 bare 403 (X15), refreshable: never refresh-eligible", True,
     [("d", "main", "auto/A"), ("r", "main", "X15"), ("t",)], ("violation", 1, TERMINAL)),
    ("W9 403 full path (X4): 1 POST, terminal", True,
     [("d", "main", "auto/A"), ("r", "main", "X4")], ("ok", 1, TERMINAL)),
    ("W10 403 (X4): 4d RetryTransient is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "X4"), ("d", "transient_4d", "auto/A")], ("violation", 2, TERMINAL)),
    ("W11 403 (X4): 4c provider recovery is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "X4"), ("d", "provider_4c", "fast/B")], ("violation", 2, TERMINAL)),
    ("W12 FA8 16.resp: side flux-fast + main flux-auto, each once", False,
     [("d", "side", "fast/S"), ("d", "main", "auto/A"), ("r", "side", "16.resp"), ("r", "main", "16.resp")],
     ("ok", 2, TERMINAL)),
    ("W13 side call after terminal is a violation", False,
     [("d", "main", "auto/A"), ("r", "main", "01.resp"), ("d", "side", "fast/S")], ("violation", 2, TERMINAL)),
    ("W14 compact-and-resubmit (new body) after terminal is a violation", False,
     [("d", "main", "auto/A"), ("r", "main", "01.resp"), ("d", "compact", "auto/A-compacted")],
     ("violation", 2, TERMINAL)),
    ("W15 FA14 session/load + idle after terminal: 0 dispatches", False,
     [("d", "main", "auto/A"), ("r", "main", "01.resp")], ("ok", 1, TERMINAL)),
    ("W16 session/load resume dispatch after terminal is a violation", False,
     [("d", "main", "auto/A"), ("r", "main", "01.resp"), ("d", "resume", "auto/A")], ("violation", 2, TERMINAL)),
    ("W17 PAUSE (X11): sampler retry is a violation", False,
     [("d", "main", "auto/A"), ("r", "main", "X11"), ("d", "sampler_retry", "auto/A")], ("violation", 2, TERMINAL)),
    ("W18 BACKOFF (09.resp): sampler retry allowed", False,
     [("d", "main", "auto/A"), ("r", "main", "09.resp"), ("d", "sampler_retry", "auto/A"), ("r", "sampler_retry", "ok")],
     ("ok", 2, DONE)),
    ("W19 terminal then the user sends again: a fresh prompt may dispatch", False,
     [("d", "main", "auto/A"), ("r", "main", "01.resp"), ("new",), ("d", "main", "auto/A2")], ("ok", 1, OPEN)),
    ("W20 402 (X1) with Retry-After: refreshable config gets no refresh", True,
     [("d", "main", "auto/A"), ("r", "main", "X1"), ("t",)], ("violation", 1, TERMINAL)),
    # A2.2 (Astra P1): whatever answers the resubmit is final, BACKOFF/RETRY_ONCE/PASS included.
    ("W21 resubmit answered by BACKOFF (09.resp): a later side dispatch is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "09.resp"), ("d", "side", "fast/S")], ("violation", 3, TERMINAL)),
    ("W22 resubmit answered by RETRY_ONCE (11.resp): a later side dispatch is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "11.resp"), ("d", "side", "fast/S")], ("violation", 3, TERMINAL)),
    ("W23 resubmit answered by RETRY_ONCE (X18): a sampler retry is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "X18"), ("d", "sampler_retry", "auto/A")], ("violation", 3, TERMINAL)),
    ("W24 resubmit answered by a non-refusal 4xx (X19, PASS): final, a side dispatch is a violation", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "X19"), ("d", "side", "fast/S")], ("violation", 3, TERMINAL)),
    ("W25 resubmit answered by BACKOFF: no second refresh either", True,
     [("d", "main", "auto/A"), ("r", "main", "14.resp"), ("t",), ("d", "refresh_resubmit", "auto/A"),
      ("r", "refresh_resubmit", "09.resp"), ("t",)], ("violation", 2, TERMINAL)),
]

# A2.2 (Astra P2): Fuigo-side projection facts the ports must assert beyond the classification.
# row id -> data.upstream keys that must be present with exactly this value.
PROJECTION_REQUIRED = {"12.resp": {"resets_at": "2026-12-01T00:00:00Z"}}


def run_trace(refreshable, events, resolve):
    """resolve(row_id) -> (status, classify result). Returns PromptSM.verdict() of the last prompt."""
    sm = PromptSM(refreshable)
    for ev in events:
        if ev[0] == "d":
            sm.dispatch(ev[1], ev[2])
        elif ev[0] == "t":
            sm.refresh_token()
        elif ev[0] == "new":
            sm = PromptSM(refreshable)
        else:
            if ev[2] == "ok":
                sm.respond(ev[1], 200, None)
            else:
                st, res = resolve(ev[2])
                sm.respond(ev[1], st, res)
    return sm.verdict()
