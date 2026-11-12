"""BOT-CREATE-OUTSIDE-1019 r3.3.1 -- NORMATIVE settle predicate. Pure, stdlib only, no I/O.

Port target: server/turn-settle.ts (+ the one `complete` site per driver). The port must keep every
function, every guard line and its order; parity = vitest replays spec/traces.tsv through the port and
gets 0 mismatches (section 4 of r3.3). Code refs are c12aaad93.
"""

# Driver -> settle family. fuigo/fuigoAgent, hermes and every other ACP driver share drivers/acp/core.ts.
FAMILY = {"claude": "claude", "codex": "codex", "acp": "acp", "fuigo": "acp", "hermes": "acp"}

# Fable M1 per engine, on the FOLDED turn.completed.stopReason (Fable A1), never the driver argument.
ENGINE_FINAL_STOP = {
    "claude": frozenset({None, "end_turn"}),   # claude.ts:5479 passes o.stop_reason ?? o.terminal_reason ?? null
    "codex": frozenset({None}),                # codex emits stopReason ?? "" then extra.stopReason:null spreads after
    "acp": frozenset({None}),                  # settleClean core.ts:4115 settle(true, null)
}

# Step-1 evidence rows (r3.2 6.7.4). Hermes and "acp" (any other ACP driver) are absent: fail closed by name.
SETTLE_EVIDENCE_DRIVERS = frozenset({"claude", "codex", "fuigo"})

# Helper / sub-agent hold rows (Fable L1, A6). A row is honoured only if step 1 recorded its fixture;
# the world passes the recorded set as `rows`. A6: claude-bg and codex-helpers are REQUIRED attempts.
HELPER_ROW = {"claude": "claude-bg", "codex": "codex-helpers", "acp": "acp-helpers"}
# MAIN's named held site, using each driver's existing terminal spelling.
HELPER_SITE = {"claude": "result", "codex": "held_done", "acp": "settle_held"}


def complete_flag(engine, t, rows):
    """The driver-side `complete` argument. True at exactly ONE site per family (+ its recorded helper row).
    t: terminal facts as the driver holds them; rows: recorded helper rows."""
    fam = FAMILY[engine]
    if fam == "claude":
        if t["site"] != "result":                     # claude.ts:5538 only; :5531 steer timer, :5058 cap etc. never
            return False
        if t.get("subtype") != "success":             # Fable A3
            return False
        if t.get("steer_ever_waited"):                # steerFollowUp armed this turn
            return False
        if t.get("bg_ever_held") and HELPER_ROW["claude"] not in rows:   # bg.waiting entered, no row
            return False
        return True
    if fam == "codex":
        if t.get("stop_requested"):
            return False
        if t["site"] == "turn_completed":            # codex.ts:2264
            if t.get("helpers_ever_held"):            # holdForHelpers entered this turn
                return False
            return True
        if t["site"] == "held_done":                  # settleHeld woken :1994 / completed-while-held :2263
            return HELPER_ROW["codex"] in rows
        return False                                  # :1996 grace, :2011 cap, :2353 close-held, cancels
    # ACP family (core.ts)
    if t.get("cancel_requested"):
        return False
    if t.get("interj_accepted"):
        return False
    if t.get("interj_pending", 0) > 0:
        return False
    if t.get("interj_uncertain", 0) > 0:              # Astra r3.2 H1: core.ts:5029-5030 moves pending -> uncertain
        return False
    if t["site"] == "end_turn":                       # :6154 -> settleClean :4115 (no hold: :6131 is an if before it)
        return True
    if t["site"] == "settle_held":                    # :4080 -> :4115 after a helper hold
        return HELPER_ROW["acp"] in rows
    return False                                      # :4104 fallback grace, :4800 close-held, :5879 prewarm, cancels


def emit(engine, t, complete):
    """turn.completed as the stop-gate `finish` emits it (stop-gate.ts:118 spreads ...extra AFTER stopReason).
    Fable A2: readsComplete is a TOP-LEVEL Verdict field written only in the plain branch, never via extra."""
    fam = FAMILY[engine]
    extra = {"stopReason": None} if t.get("extra_stop", "absent") is None else {}
    if t.get("asked"):                                # a Stop asked after the verdict: finish's "asked" branch
        ev = {"ok": True, "stopReason": "cancelled"}
        ev.update(extra)
        return ev
    arg = t.get("stop")
    base_stop = ("" if arg is None else arg) if fam == "codex" else arg   # codex.ts:1524 stopReason ?? ""
    ev = {"ok": bool(t.get("ok")), "stopReason": base_stop}
    if complete:
        ev["readsComplete"] = True
    ev.update(extra)                                  # Fable A1: extra.stopReason wins
    return ev


def terminal_clean(engine, ev):
    fam = FAMILY[engine]
    if ev.get("ok") is not True:
        return False
    if ev.get("readsComplete") is not True:
        return False
    if ev.get("stopReason") not in ENGINE_FINAL_STOP[fam]:
        return False
    return True


def cwd_marks(holds_entry_below, inside_entry):
    """r3.2 section 9 / P4: a cwd marks only when it IS or lies UNDER a registered entry."""
    return bool(inside_entry)


class Row:
    """Ledger row, opened at admission (r3.2 6.7.2). abnormal/marked/settled are set-to-true only."""

    def __init__(self, gen, thread, driver, origin):
        self.gen, self.thread, self.driver = gen, thread, driver
        self.origin = origin            # Fable A5/Q4: captured at admission, criterion 4 reads THIS
        self.abnormal = False
        self.marked = False
        self.mark_sources = set()      # accumulate sources; a later helper mark cannot hide another source
        self.helper_read = False       # source=helper with a read/unknown item is never provisional
        self.unclassified = 0
        self.settled = False
        self.writes = []                # bot ids staged turn-open by this generation
        self.setup = []                 # setup entries filed by this generation (D6)


class Ledger:
    def __init__(self):
        self.rows = {}
        self.by_ptid = {}               # Fable Q4: providerTurn -> generation, bound after admission
        self.live = {}                  # thread -> live turnOutsideRead source or None

    def open(self, gen, thread, driver, origin):
        self.rows[gen] = Row(gen, thread, driver, origin)

    def bind(self, gen, ptid):
        self.by_ptid[ptid] = gen

    def gen_of(self, ptid, thread):
        return self.by_ptid.get(ptid)

    def take(self, gen):
        """Settle runs ONCE per generation: a second terminal / late event for a settled row gets nothing."""
        r = self.rows.get(gen)
        if r is None:
            return None
        if r.settled:
            return None
        r.settled = True
        return r

    def mark(self, thread, src, lifecycle=False):
        """markTurnOutside sink: live state AND every open row of the thread.
        Only an identified helper lifecycle frame is provisional; never clear the live mark."""
        previous = self.live.get(thread)
        self.live[thread] = src
        for r in self.rows.values():
            if r.thread == thread and not r.settled:
                r.marked = True
                if previous is not None:
                    # Retain even a live-only source that this mark would otherwise overwrite.
                    if previous == "helper" and previous not in r.mark_sources:
                        r.helper_read = True          # no lifecycle provenance for the earlier mark
                    r.mark_sources.add(previous)
                r.mark_sources.add(src)
                if src == "helper" and not lifecycle:
                    r.helper_read = True

    def helper_mark(self, gen, src="helper"):
        """A helper read / unclassified sub-agent item folded under gen marks (Fable L4)."""
        r = self.rows.get(gen)
        if r is not None and not r.settled:
            r.marked = True
            r.mark_sources.add(src)
            r.helper_read = True
        if r is not None:
            self.live[r.thread] = src

    def abnormal(self, thread=None, gen=None):
        for r in self.rows.values():
            if not r.settled and (r.gen == gen or (gen is None and r.thread == thread)):
                r.abnormal = True


def settle_verdict(row, ev, live_read, live_origin):
    """One verdict per generation: clean | outside | content | unsettled (r3.2 6.7.3 criteria 1-5).
    `row` comes from Ledger.take (exists, not yet settled); live_origin is NOT read (Fable A5: row.origin)."""
    if row.abnormal:
        return "unsettled"
    if not terminal_clean(row.driver, ev):
        return "unsettled"
    if row.unclassified > 0:
        return "outside"
    # MAIN r3.3.1: waive lifecycle-only marks here, never in the live ledger or commit gate.
    # helperRow is the recorded step-1 terminal evidence, distinct from the parent's readsComplete.
    helper = ev.get("helperRow", {})
    fam = FAMILY[row.driver]
    helper_waived = (row.mark_sources == {"helper"} and not row.helper_read
                     and live_read in (None, "helper")
                     and helper.get("name") == HELPER_ROW[fam]
                     and helper.get("site") == HELPER_SITE[fam]
                     and helper.get("recorded") is True
                     and helper.get("readsComplete") is True
                     and helper.get("outsideRead") is False
                     and helper.get("interrupted") is False)
    if row.marked and not helper_waived:
        return "outside"
    if live_read is not None and not helper_waived:   # Fable Q4: turnOutsideRead re-verified at settle
        return "outside"
    if row.origin not in ("own", "reached"):
        return "content"
    if row.driver not in SETTLE_EVIDENCE_DRIVERS:
        return "unsettled"
    return "clean"


def write_outcome(verdict, rev_at_write, rev_now):
    """Criterion 6, per staged write of the generation."""
    if verdict != "clean":
        return verdict
    if rev_at_write != rev_now:
        return "review"
    return "active"
