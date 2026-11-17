// @ts-nocheck (r3.2 reference copy for the r3.2 comparison)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READ-ONLY COPY of designs/exec-spec/restore/witnesses.ts (revision 3.2, sha256 f38c63d2..., 175 witnesses); only the import path differs.
/**
 * RESTORE-PARK executable spec, part 1b: WITNESSES (MurageMain rule, binding). Written 2026-11-10 (UTC), revision 3 (2026-11-10T21:16Z).
 *
 * r3.2 (2026-11-10T21:44Z, date -u): 175 witnesses. Astra final check of r3 (A6-H1, A6-M2..M5) and Fable final check (FA-M1..M3) each have a witness
 *   whose r3.1 verdict is WRONG, tagged `// r3.1-escape: <id>` (r3.1 accepts a must-reject) or `// r3.1-overstrict: <id>` (r3.1 rejects
 *   a must-accept) and carried in `r31` (see r31Comparison). Builders kept(), confirmStart, claimed, keptKey, keptRecord, keyOnlyKeep and
 *   the lease / remove starts now carry real tokens, authorities and Keep history: EVERY witness's start world passes initialStateValid.
 *   Named mutants: `keep-end-by-bot-delete-is-violation` (killed by keep-ended-by-owner-bot-delete), `closing-is-gone` (killed by
 *   keep-refused-inbox-gone-on-parked-evidence and keep-refused-inbox-gone-purge-unseen). The two keepEndsActive rejects now wait 150 s.
 *
 * r3 (MurageMain rules, binding):
 *   FAIL FIRST. Every High of Astra round 5 (A5-H1..H8) and Fable round 5 (F5-H1) has a NEW must-reject witness that the r2 predicate
 *   wrongly ACCEPTS and r3 rejects. Each is marked `// r2-escape: <finding>` and carries `r2: { kind: "escape", finding }`, so the
 *   harness runs it against both revisions and logs fail-before / pass-after. Over-strict r2 findings (r2 rejected correct behaviour)
 *   add a must-accept marked `// r2-overstrict: <finding>` (`r2.kind === "overstrict"`: r2 rejects it, r3 accepts it).
 *   ACTING ACCEPTS. Every must-accept performs the permitted action of its invariant (see `// PERMITTED ACTION` on each step
 *   invariant in invariants.ts), so an over-strict mutant that forbids that action fails at least one must-accept. The passive accepts
 *   Astra listed (A5-M12) are replaced: boot-adopts-other-target, keep-with-lease-on-other-target, boot-prep-opens-store,
 *   unknown-provisioning-op-row, owner-removed-inbox-not-orphan, tick-finishes-other-park-keep, keep-completes.
 *   Witnesses that set r3-only state fields (CarryRecord.removals / blindPending) run against r2 with transpile-only (no type check).
 *
 * Every exported invariant in invariants.ts has at least one MUST-REJECT trace (the bad case its comment names) and one MUST-ACCEPT
 * trace. Every High of Astra round 4 (A4-H1..H10) and Fable round 4 (F4-H1..H4) is tagged on the witness that now catches it; for the
 * Highs that reported an OVER-STRICT predicate (A4-H5, H6, H8, H10) the correct behaviour is a must-accept and the harm is a must-reject.
 * The checker runs `runWitnesses()` FIRST and aborts on any disagreement; `witnessCoverage()` must return [] (no invariant without both).
 *
 * Traces are hand-built data: each step is (action, mutation of a deep copy of the previous world). They are NOT reducer output: a
 * witness exercises ONE predicate, so only the fields that predicate reads are made consistent. Pure: no I/O.
 */
import type {
  Action, AttemptId, AuthorityRecord, Generation, KeepGuard, KeepRecord, Lease, Park, Principal, RemoteRequest, SurfaceRow, TokenIssue,
  TraceStep, World, CarryRecord, FluxCloseReason,
} from "../invariants.r32.ts";
import { STATE_INVARIANTS, STEP_INVARIANTS, TRACE_INVARIANTS, verdictOf, GUARD_POLL_WINDOW_MS, CHECKER } from "../invariants.r32.ts";

// ===================================================================================================================================
// Builders
// ===================================================================================================================================

const NOW = 1_000_000_000;
const DAY = 24 * 3600_000;
const OWN: Principal = "owner_desktop";
const ADDR = "bot1@mail.test";
const G1: Generation = { inboxId: "i1", opId: "op1", emailKeyRef: "k1", serial: 1 };
const G2: Generation = { inboxId: "i1", opId: "op1", emailKeyRef: "k2", serial: 2 };
const T_I1 = "inbox:i1";
const T_OP1 = "op:op1";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Mut = (w: World) => void;
type StepSpec = [Action, Mut?];

export function base(): World {
  return {
    step: 0, nowMs: NOW,
    bots: { b1: { botId: "b1", present: true } },
    local: {
      tablesPresent: true,
      bindings: { b1: { botId: "b1", state: "active", step: null, gen: clone(G1), address: ADDR } },
      intents: {}, parks: {}, leases: {}, keepOps: {}, keepGuards: {}, rotations: {}, pendingLifecycle: [], keptKeys: {}, savedKeys: { b1: "k1" },
    },
    carry: null,
    fs: { liveMarker: null, stagedMarker: null, messagesDbPresent: true },
    proc: { processId: 1, phase: "running", emailOn: true },
    flux: {
      inboxes: { i1: { inboxId: "i1", installOwned: true, createdUnderOp: "op1", forBot: "b1", address: ADDR, state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null } },
      keys: { k1: { keyId: "k1", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "live" } },
      requests: [], events: [], semantics: { restoreCredential: "owner", deleteIdempotencyKeyHonoured: true, listingShipped: false },
    },
    surface: [], archives: [], ops: [],
    ghost: { epoch: 0, tokens: [], authorities: [], keeps: [], restores: [], usedKeepOps: [], preparedEpochs: [], inventoryConfirmedEpochs: [], preparedResets: [], lastBootAtMs: 0, lastParkOrRestoreStep: {}, botDeletedAtStep: {} },
  };
}
const from = (m: Mut): World => { const w = base(); m(w); return w; };
function run(start: World, steps: StepSpec[]): TraceStep[] {
  const out: TraceStep[] = [];
  let prev = start;
  for (const [action, m] of steps) {
    const next = clone(prev);
    next.step = prev.step + 1;
    if (action.t === "clock.advance") next.nowMs += action.ms;
    if (m) m(next);
    out.push({ prev, action, next });
    prev = next;
  }
  return out;
}

const rq = (o: Partial<RemoteRequest> & Pick<RemoteRequest, "requestId" | "kind" | "target">): RemoteRequest => ({
  copyOf: null, purpose: "removal", credential: "owner", removalId: null, attemptId: null, authorityId: null, keepOp: null,
  sentAtStep: 0, sentAtMs: NOW, sentInProcess: 1, sentInEpoch: 0, flux: "held", appliedAtMs: null, answer: "pending", answerSeen: null, ...o,
});
const tk = (o: Partial<TokenIssue> = {}): TokenIssue => ({
  tokenId: "tB", kind: "b", botId: "b1", gen: clone(G1), park: null,
  shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: ["k1"] },
  issuedTo: OWN, issuedAtStep: 0, issuedAtMs: NOW, processId: 1, epoch: 0, ...o,
});
const au = (o: Partial<AuthorityRecord> = {}): AuthorityRecord => ({
  authorityId: "aR", kind: "remove_bot_section", principal: OWN, tokenId: "tB", verifiedAtStep: 1, verifiedAtMs: NOW, verifiedInProcess: 1, epoch: 0,
  botId: "b1", scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] }, genAtVerify: clone(G1), parkAtVerify: null, ...o,
});
const kr = (o: Partial<KeepRecord> = {}): KeepRecord => ({
  keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 0, succeededAtStep: null, succeededAtMs: null, confirmedBy: null, ...o,
});
const gd = (o: Partial<KeepGuard> = {}): KeepGuard => ({
  inboxId: "i1", botId: "b1", gen: clone(G1), keepOp: "kp1", keptAtMs: NOW, pollUntilMs: NOW + GUARD_POLL_WINDOW_MS, unresolved: ["at1"], lastCheckedAtMs: null, ...o,
});
const ls = (o: Partial<Lease> = {}): Lease => ({
  removalId: "L1", target: T_I1, inboxId: "i1", botId: "b1", authorityId: "aR", foreign: false, phase: "authorized", attemptId: null, attempts: [], keyTargets: [], ...o,
});
const pk = (o: Partial<Park> = {}): Park => ({
  parkId: "pk1", botId: "b1", parkRev: 0, origin: "restore", state: "parked", target: T_I1, inboxId: "i1", provisionOpId: "op1",
  gen: clone(G1), address: ADDR, keyTargets: [{ keyId: "k1", status: "pending" }], remoteDeletedAtMs: null, ...o,
});
const row = (o: Partial<SurfaceRow> = {}): SurfaceRow => ({
  section: "parked", target: T_I1, botId: "b1", inboxId: "i1", keyIds: ["k1"], provisionOpId: null, visible: true, line: "Choose Keep address or Remove.", actions: [], ...o,
});
const carry = (o: Partial<CarryRecord> = {}): CarryRecord => ({
  carryId: "c1", capturedAtStep: 0, forEpoch: 0, complete: true, keyIds: ["k1"], inboxIds: ["i1"], provisionOps: ["op1"], keepGuards: [], keptKeys: {}, outstandingDeletes: [],
  removals: [], blindPending: false, ...o,
});

const tick: Action = { t: "auto.tick" };
const clk = (ms: number): Action => ({ t: "clock.advance", ms });
const send = (r: RemoteRequest): Action => ({ t: "net.send", request: r });
const apply = (id: string): Action => ({ t: "flux.apply", requestId: id });
const okO = { ok: true } as const;
const no = (code: string) => ({ ok: false as const, code });
const removeA = (tokenId: string | null, o: Partial<Extract<Action, { t: "owner.remove" }>> = {}): Action =>
  ({ t: "owner.remove", principal: OWN, botId: "b1", target: T_I1, tokenId, section: "bot", outcome: okO, ...o });
const keepA = (o: Partial<Extract<Action, { t: "owner.keep" }>> = {}): Action =>
  ({ t: "owner.keep", principal: OWN, botId: "b1", target: T_I1, tokenId: null, mode: "live", outcome: okO, ...o });

/** Flux applies DELETE `rid` on i1 (active -> closing, one closing event). */
const closeBy = (rid: string, reason: "owner" | "bot_deleted" = "owner"): Mut => w => {
  const r = w.flux.requests.find(x => x.requestId === rid)!;
  r.flux = "applied"; r.appliedAtMs = w.nowMs;
  const i = w.flux.inboxes.i1;
  if (i.state === "active") {
    i.state = "closing"; i.closingCause = { kind: "delete", requestId: rid, reason }; i.closingSinceMs = w.nowMs; i.closingSinceStep = w.step;
    w.flux.events.push({ eventId: "e-" + rid, type: "email.inbox.closing", inboxId: "i1", atMs: w.nowMs, atStep: w.step, deliveredToHome: false, reason });
  }
};
const reopen: Mut = w => { const i = w.flux.inboxes.i1; i.state = "active"; i.closingCause = null; i.closingSinceMs = null; i.closingSinceStep = null; };
const fluxClose = (reason: FluxCloseReason): Mut => w => { const i = w.flux.inboxes.i1; i.state = "closing"; i.closingCause = { kind: "flux", reason }; i.closingSinceMs = w.nowMs; i.closingSinceStep = w.step; };
const delGuard: Mut = w => { delete w.local.keepGuards.i1; };
const d = (rid: string, at: AttemptId, o: Partial<RemoteRequest> = {}) =>
  rq({ requestId: rid, kind: "DELETE_INBOX", target: "i1", attemptId: at, removalId: "L1", authorityId: "aR", sentAtStep: -3, answer: "lost", ...o });

/** r3.2 valid-world helpers: the token a pre-trace Remove names, and a Keep authority + record + used op id (initialStateValid). */
const tokB = (w: World, issuedAtStep = -5) => { if (!w.ghost.tokens.some(t => t.tokenId === "tB")) w.ghost.tokens.push(tk({ issuedAtStep })); };
const keepHist = (w: World, rec: Partial<KeepRecord> = {}, verifiedAtStep = -1) => {
  const k = kr(rec);
  w.ghost.authorities.push(au({ authorityId: k.authorityId, kind: "keep", tokenId: null, verifiedAtStep: Math.min(verifiedAtStep, k.claimedAtStep), genAtVerify: null,
    scope: { target: k.target, inboxId: k.inboxId, keyIds: ["k1"] } }));
  w.ghost.keeps.push(k); w.ghost.usedKeepOps.push(k.keepOp);
};

/** A successful Keep at step 0 on i1, with DELETE d1 (attempt at1) held at Flux from before, and its guard. */
function kept(unresolved: AttemptId[] | "unknown" = ["at1"]): World {
  return from(w => {
    tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: -3 }));
    keepHist(w, { claimedAtStep: -2, succeededAtStep: 0, succeededAtMs: NOW, confirmedBy: { requestId: "g1", atStep: -1 } });
    w.flux.requests.push(d("d1", "at1"));
    w.local.keepGuards.i1 = gd({ unresolved });
  });
}

// ===================================================================================================================================
// Witnesses
// ===================================================================================================================================

/** `r2`: escape = must-reject that the r2 predicate wrongly accepted; overstrict = must-accept that the r2 predicate wrongly rejected. */
export interface Witness {
  id: string; invariant: string; expect: "reject" | "accept"; answers: string[]; settled: boolean; trace: TraceStep[];
  r2: { kind: "escape" | "overstrict"; finding: string } | null;
  /** r3.2: escape = must-reject the r3.1 predicate wrongly ACCEPTS; overstrict = must-accept the r3.1 predicate wrongly REJECTS. */
  r31?: { kind: "escape" | "overstrict"; finding: string };
}
const W: Witness[] = [];
const rej = (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false) => W.push({ id, invariant, expect: "reject", answers, settled, trace, r2: null });
const acc = (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false) => W.push({ id, invariant, expect: "accept", answers, settled, trace, r2: null });
/** Marks the witness just pushed. */
const esc = (finding: string) => { W[W.length - 1].r2 = { kind: "escape", finding }; };
const over = (finding: string) => { W[W.length - 1].r2 = { kind: "overstrict", finding }; };
const esc31 = (finding: string) => { W[W.length - 1].r31 = { kind: "escape", finding }; };
const over31 = (finding: string) => { W[W.length - 1].r31 = { kind: "overstrict", finding }; };

// ---------- (a) keepEndsActive ------------------------------------------------------------------------------------------------------

// F4-H1: 13 steps. Remove, DELETE sent, answer lost, Keep (confirmed GET), guard, restore whose carry omits the guard, DELETE lands.
rej("keepEndsActive", "restore-drops-guard-13", ["F4-H1", "A3-H1", "A4-H7"], run(base(), [
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.ghost.tokens.push(tk({ issuedAtStep: 1 })); }],
  [removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: 2 })); w.local.leases.L1 = ls(); w.local.bindings.b1.state = "removing"; }],
  [tick, w => { Object.assign(w.local.leases.L1, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(d("d1", "at1", { sentAtStep: 4, answer: "pending" })), w => { w.flux.requests.push(d("d1", "at1", { sentAtStep: 4, answer: "pending" })); }],
  [{ t: "fault.loseAnswer", requestId: "d1" }, w => { w.flux.requests[0].answer = "lost"; w.local.leases.L1.phase = "unknown"; }],
  [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 6 };
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, verifiedAtStep: 6 })); w.ghost.keeps.push(kr({ claimedAtStep: 6 })); w.local.leases.L1.phase = "keeping"; }],
  [send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 7 })), w => { w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 7, flux: "applied" })); }],
  [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { const g = w.flux.requests[1]; g.answer = "delivered"; g.answerSeen = { atStep: 8, result: "ok", fluxStateSeen: "active" }; }],
  [tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 9, succeededAtMs: NOW, confirmedBy: { requestId: "g1", atStep: 8 } });
    w.local.keepGuards.i1 = gd({ unresolved: ["at1"] }); w.local.keepOps = {}; w.local.leases = {}; w.local.bindings.b1.state = "active"; }],
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ complete: false }); }],
  [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }, w => { w.local.keepGuards = {}; w.ghost.epoch = 1;
    w.ghost.restores.push({ atStep: 11, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1" }); w.ghost.preparedEpochs.push(1); w.ghost.lastBootAtMs = NOW; }],
  [apply("d1"), closeBy("d1")],
  [clk(150_000)],
]));
rej("keepEndsActive", "late-delete-never-restored", ["A3-H1", "A4-H6"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(150_000)]]));
acc("keepEndsActive", "flux-billing-close-ends-obligation", ["A4-H5", "F4-M1"], run(kept(), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")], [clk(3600_000)], [tick]]), true);
acc("keepEndsActive", "delete-at-31d-restored-by-event", ["A4-H6"], run(kept(), [[clk(31 * DAY)], [apply("d1"), closeBy("d1")], [clk(30_000), reopen]]), true);
acc("keepEndsActive", "blind-restore-ends-window", ["F4-H1"], run(kept(), [
  [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 1, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null }); }],
  [apply("d1"), closeBy("d1")], [clk(3600_000)],
]), true);

// ---------- (a) keepSuccessIsConfirmed ------------------------------------------------------------------------------------------------

const confirmStart = (restoreAnswered: boolean) => from(w => {
  w.step = 4;
  keepHist(w, { claimedAtStep: 0 });
  w.flux.requests.push(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 1, flux: "applied",
    answer: restoreAnswered ? "delivered" : "pending", answerSeen: restoreAnswered ? { atStep: 2, result: "ok", fluxStateSeen: "active" } : null }));
  w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 3, flux: "applied", answer: "delivered", answerSeen: { atStep: 4, result: "ok", fluxStateSeen: "active" } }));
});
const succeed = (rid: string, at: number): Mut => w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs, confirmedBy: { requestId: rid, atStep: at } }); };
rej("keepSuccessIsConfirmed", "get-before-restore-answered", ["A4-H4"], run(confirmStart(false), [[tick, succeed("g1", 4)]]));
rej("keepSuccessIsConfirmed", "confirmed-by-non-get", ["A4-H4", "F4-L1"], run(confirmStart(true), [[tick, succeed("r1", 2)]]));
acc("keepSuccessIsConfirmed", "real-get-after-restore", [], run(confirmStart(true), [[tick, succeed("g1", 4)]]));

// ---------- (a) guardArmedForEveryKeep ------------------------------------------------------------------------------------------------

const claimed = () => from(w => { keepHist(w, { claimedAtStep: 0 }); });
rej("guardArmedForEveryKeep", "keep-without-guard", ["F3-H2"], run(claimed(), [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 1, succeededAtMs: NOW }); }]]));
acc("guardArmedForEveryKeep", "keep-with-guard", [], run(claimed(), [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 1, succeededAtMs: NOW }); w.local.keepGuards.i1 = gd({ unresolved: [] }); }]]));

// ---------- (a) guardLivesUntilEveryDeleteResolved ------------------------------------------------------------------------------------

rej("guardLivesUntilEveryDeleteResolved", "guard-gone-at-30d-delete-lands-31d", ["ruling-20:36Z", "A4-H6", "F4-H4"], run(kept(), [[clk(30 * DAY), delGuard], [clk(DAY)], [apply("d1"), closeBy("d1")]]));
rej("guardLivesUntilEveryDeleteResolved", "two-deletes-one-closing-event", ["FLUX-FACT-one-closing-event", "F4-M6"], run(
  from(w => { const k = kept(["at1", "at2"]); Object.assign(w, k); w.flux.requests.push(d("d2", "at2")); }),
  [[apply("d1"), closeBy("d1")], [{ t: "auto.applyEvent", eventId: "e-d1" }, delGuard], [tick, reopen], [apply("d2"), closeBy("d2")]]));
rej("guardLivesUntilEveryDeleteResolved", "unknown-released-without-resolution", ["F4-H4"], run(kept("unknown"), [[tick, delGuard]]));
acc("guardLivesUntilEveryDeleteResolved", "released-by-delivered-answer", ["ruling-20:36Z"], run(kept(), [
  [apply("d1"), closeBy("d1")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => { const r = w.flux.requests[0]; r.answer = "delivered"; r.answerSeen = { atStep: 2, result: "accepted", fluxStateSeen: "closing" }; }],
  [tick, delGuard],
]));
acc("guardLivesUntilEveryDeleteResolved", "single-delete-resolved-by-its-closing", ["ruling-20:36Z"], run(kept(), [[apply("d1"), closeBy("d1")], [{ t: "auto.applyEvent", eventId: "e-d1" }, delGuard]]));
acc("guardLivesUntilEveryDeleteResolved", "released-by-purge", ["ruling-20:36Z"], run(
  from(w => { Object.assign(w, kept("unknown")); w.flux.events.push({ eventId: "e9", type: "email.inbox.deleted", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: false, reason: null }); }),
  [[{ t: "auto.applyEvent", eventId: "e9" }, delGuard]]));

// ---------- (a) guardDiesOnFreshRemove ------------------------------------------------------------------------------------------------

const guardedWithToken = () => from(w => { w.ghost.tokens.push(tk()); w.local.keepGuards.i1 = gd(); });
rej("guardDiesOnFreshRemove", "guard-survives-owner-remove", ["F4-H3"], run(guardedWithToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au()); }]]));
acc("guardDiesOnFreshRemove", "guard-deleted-with-remove", ["F4-H3"], run(guardedWithToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au()); delGuard(w); }]]));

// ---------- (a) guardActsOnlyOnGuardRecord ------------------------------------------------------------------------------------------

const closingKept = (m?: Mut) => from(w => { Object.assign(w, kept()); w.step = 6; closeBy("d1")(w); if (m) m(w); });
const guardRestore = send(rq({ requestId: "r9", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", credential: "owner" }));
rej("guardActsOnlyOnGuardRecord", "guard-reverts-later-remove", ["F4-H3"], run(closingKept(w => { w.ghost.authorities.push(au({ authorityId: "aR2", verifiedAtStep: 5 })); }), [[guardRestore]]));
rej("guardActsOnlyOnGuardRecord", "guard-fights-flux-billing", ["F3-H1", "A4-H5"], run(closingKept(fluxClose("billing")), [[guardRestore]]));
acc("guardActsOnlyOnGuardRecord", "guard-restores-delete-closing", [], run(closingKept(), [[guardRestore]]));

// ---------- (a) restoreUsesOwnerCredentialAndKeepPurpose ------------------------------------------------------------------------------

rej("restoreUsesOwnerCredentialAndKeepPurpose", "restore-with-bot-key", ["A4-M11"], run(base(), [[send(rq({ requestId: "r9", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", credential: "bot_key" }))]]));
acc("restoreUsesOwnerCredentialAndKeepPurpose", "restore-with-owner-key", [], run(base(), [[guardRestore]]));

// ---------- (b) authorityCreatedByValidOwnerAction --------------------------------------------------------------------------------------

const withToken = () => from(w => { w.ghost.tokens.push(tk()); });
rej("authorityCreatedByValidOwnerAction", "token-for-rotated-generation", ["A4-H1", "A3-M9"], run(
  from(w => { w.ghost.tokens.push(tk()); w.local.bindings.b1.gen = clone(G2); w.local.savedKeys.b1 = "k2"; }),
  [[removeA("tB"), w => { w.ghost.authorities.push(au()); }]]));
rej("authorityCreatedByValidOwnerAction", "authority-from-automatic-step", ["A4-H1"], run(withToken(), [[tick, w => { w.ghost.authorities.push(au()); }]]));
rej("authorityCreatedByValidOwnerAction", "bot-credential-authority", ["A3-M11"], run(withToken(), [[removeA("tB", { principal: "bot_credential" }), w => { w.ghost.authorities.push(au({ principal: "bot_credential" })); }]]));
acc("authorityCreatedByValidOwnerAction", "valid-owner-remove", [], run(withToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au()); }]]));

// ---------- (b) ownerAuthorityForEveryDestructiveSend ---------------------------------------------------------------------------------

rej("ownerAuthorityForEveryDestructiveSend", "reconnect-deletes-inbox", ["A4-H2"], run(
  from(w => { tokB(w); w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: 0 })); }),
  [[send(d("d1", "at1", { authorityId: "aRot", answer: "pending" }))]]));
rej("ownerAuthorityForEveryDestructiveSend", "delete-after-later-keep", ["A3-H1", "Keep-always-wins"], run(
  from(w => { w.step = 2; tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 1 })); keepHist(w, { claimedAtStep: 2 }, 2); }),
  [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("ownerAuthorityForEveryDestructiveSend", "delete-under-owner-remove", [], run(from(w => { tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) removalSendNeedsSendingLease --------------------------------------------------------------------------------------------

const leaseAuth = (w: World) => { tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); };
rej("removalSendNeedsSendingLease", "delete-without-send-claim", ["F4-M4"], run(from(w => { leaseAuth(w); w.local.leases.L1 = ls(); }), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("removalSendNeedsSendingLease", "delete-under-sending-lease", [], run(from(w => { leaseAuth(w); w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) noDestructiveSendAfterBlindRestore --------------------------------------------------------------------------------------

const blind = (confirmed: boolean) => from(w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null }); if (confirmed) w.ghost.inventoryConfirmedEpochs.push(1); });
rej("noDestructiveSendAfterBlindRestore", "delete-after-blind-restore", ["Q2-ruling", "F4-M5"], run(blind(false), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("noDestructiveSendAfterBlindRestore", "delete-after-owner-confirms", ["Q2-ruling"], run(blind(true), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) keptKeysProtected -------------------------------------------------------------------------------------------------------

const keptKey = (removeAt: number) => from(w => {
  w.step = 4; w.local.keptKeys.k9 = "aK9";
  w.ghost.tokens.push(tk({ tokenId: "t9", shown: { target: "op:op9", address: null, inboxId: null, keyIds: ["k9"] } }));
  w.ghost.authorities.push(au({ authorityId: "aK9", kind: "keep", tokenId: null, verifiedAtStep: 1, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } }));
  w.ghost.authorities.push(au({ authorityId: "aRk", kind: "remove_key_only", tokenId: "t9", verifiedAtStep: removeAt, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } }));
});
const revokeK9 = send(rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aRk" }));
rej("keptKeysProtected", "kept-key-revoked-by-older-remove", ["A4-H3"], run(keptKey(0), [[revokeK9]]));
rej("keptKeysProtected", "key-marked-kept-without-keep", ["F4-L4"], run(base(), [[tick, w => { w.ghost.authorities.push(au()); w.local.keptKeys.k1 = "aR"; }]]));
acc("keptKeysProtected", "kept-key-revoked-by-later-remove", [], run(keptKey(3), [[revokeK9]]));

// ---------- (c) nothingAutomaticUnparks -------------------------------------------------------------------------------------------------

const parked = () => from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; });
rej("nothingAutomaticUnparks", "tick-resumes-parked-removal", ["standing-order"], run(parked(), [[tick, w => { w.local.leases.L1 = ls(); }]]));
// A5-M12: acting. The tick finishes the owner's Keep on ANOTHER park (keep_pending -> key_release) while pk1 stays parked.
acc("nothingAutomaticUnparks", "tick-finishes-other-park-keep", ["A5-M12"], run(
  from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; w.local.parks.pk2 = pk({ parkId: "pk2", target: "inbox:i2", inboxId: "i2", state: "keep_pending" }); }),
  [[tick, w => { w.local.parks.pk2.state = "key_release"; }]]));
acc("nothingAutomaticUnparks", "evidence-moves-pk-to-pkE", [], run(parked(), [[{ t: "auto.applyEvent", eventId: "e1" }, w => { w.local.parks.pk1.state = "parked_evidence"; }]]));

// ---------- (c) keptStaysKept ------------------------------------------------------------------------------------------------------------

const keptRecord = () => from(w => { keepHist(w, { succeededAtStep: 0, succeededAtMs: NOW }); });
rej("keptStaysKept", "boot-reparks-kept-address", ["A3-M14"], run(keptRecord(), [[{ t: "auto.boot" }, w => { w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy" }); }]]));
// A5-M12: acting. Boot adopts a legacy removal of a DIFFERENT target (inbox i2) as a park; the kept target is untouched.
acc("keptStaysKept", "boot-adopts-other-target", ["A5-M12"], run(keptRecord(), [[{ t: "auto.boot" }, w => {
  w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy", target: "inbox:i2", inboxId: "i2" }); }]]));

// ---------- (c) outgoingCapturedBeforeSwap ----------------------------------------------------------------------------------------------

const swapA: Action = { t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false };
rej("outgoingCapturedBeforeSwap", "swap-without-carry", ["A4-H7", "F4-H1"], run(base(), [[swapA]]));
rej("outgoingCapturedBeforeSwap", "carry-deleted-before-prep", ["A4-H7"], run(from(w => { w.carry = carry(); }), [[tick, w => { w.carry = null; }]]));
acc("outgoingCapturedBeforeSwap", "swap-after-complete-carry", [], run(from(w => { w.carry = carry(); }), [[swapA, w => { w.ghost.epoch = 1; }]]));

// ---------- (c) restorePrepParksEverything ----------------------------------------------------------------------------------------------

const prep: Action = { t: "auto.restorePrepare", outcome: "committed" };
const inFlight = () => from(w => { w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); });
const parkIt: Mut = w => { w.local.leases = {}; w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; };
rej("restorePrepParksEverything", "carried-guard-lost", ["A4-H7", "F4-H1"], run(from(w => { w.carry = carry({ keepGuards: [gd()] }); }), [[prep]]));
rej("restorePrepParksEverything", "restored-removal-not-parked", ["A3-H1", "standing-order"], run(inFlight(), [[prep, w => { w.local.leases = {}; }]]));
acc("restorePrepParksEverything", "restored-removal-parked", [], run(inFlight(), [[prep, parkIt]]));
acc("restorePrepParksEverything", "foreign-lease-dropped", ["F3-M2"], run(from(w => { w.local.leases.LF = ls({ removalId: "LF", target: "inbox:i9", inboxId: "i9", botId: null, foreign: true }); }), [[prep, w => { w.local.leases = {}; }]]));
acc("restorePrepParksEverything", "carried-keep-beats-archived-removal", ["R2-Q1"], run(
  from(w => { w.local.bindings.b1.state = "removing"; w.carry = carry({ keepGuards: [gd()] }); }),
  [[prep, w => { w.local.bindings.b1.state = "restored_unverified"; w.local.keepGuards.i1 = gd({ unresolved: "unknown" }); }]]));

// ---------- (c) restorePrepNeverThrows ----------------------------------------------------------------------------------------------------

rej("restorePrepNeverThrows", "prep-throws", ["F3-M2"], run(base(), [[{ t: "auto.restorePrepare", outcome: "threw" }]]));
acc("restorePrepNeverThrows", "prep-commits", [], run(base(), [[prep]]));

// ---------- (d) everyOrphanHasExecutableAction ------------------------------------------------------------------------------------------

const botGone = (m?: Mut) => from(w => { w.bots.b1.present = false; if (m) m(w); });
rej("everyOrphanHasExecutableAction", "bot-deleted-during-live-keep", ["A3-H6"], run(base(), [[tick, w => { w.bots.b1.present = false; }]]));
rej("everyOrphanHasExecutableAction", "only-try-again-nothing-pending", ["A4-H9"], run(base(), [[tick, w => {
  w.bots.b1.present = false; w.surface = [row({ actions: [{ kind: "try_again_now", tokenId: null, enabled: true }] })]; }]]));
// A5-M12: acting. The bot is gone with its create answer lost (inbox id unknown); the tick WRITES the op-backed key-only row, then
// Flux's late create lands an inbox under op1 and the same row covers it.
acc("everyOrphanHasExecutableAction", "unknown-provisioning-op-row", ["A4-H8", "D1-reversed", "A5-M12"], run(botGone(w => {
  w.local.bindings.b1 = { botId: "b1", state: "provisioning", step: "inbox", gen: { inboxId: null, opId: "op1", emailKeyRef: "k1", serial: 1 }, address: null };
  w.flux.inboxes = {};
}), [
  [tick, w => { w.surface = [row({ section: "key_only", target: T_OP1, inboxId: null, provisionOpId: "op1", actions: [{ kind: "keep", tokenId: "tp", enabled: true }, { kind: "remove", tokenId: "tp", enabled: true }] })]; }],
  [{ t: "flux.apply", requestId: "c1" }, w => { w.flux.inboxes.i1 = { inboxId: "i1", installOwned: true, createdUnderOp: "op1", forBot: "b1", address: ADDR, state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null }; }],
]));
// A5-M12: acting. The owner's Remove runs: Flux closes i1, the DELETE answer arrives, then the bot deletion completes (binding, saved
// key and lease gone, key revoked). The closing inbox is under a valid current-epoch Remove with no park: not an orphan.
acc("everyOrphanHasExecutableAction", "owner-removed-inbox-not-orphan", ["F4-M3", "A5-M12"], run(from(w => {
  w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] });
  w.ghost.authorities.push(au({ verifiedAtStep: 0 }));
  w.flux.requests.push(d("d1", "at1", { answer: "pending" }));
}), [
  [apply("d1"), closeBy("d1")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => {
    const r = w.flux.requests[0]; r.answer = "delivered"; r.answerSeen = { atStep: 2, result: "accepted", fluxStateSeen: "closing" }; w.local.leases.L1.phase = "acked"; }],
  [tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.leases = {}; w.flux.keys.k1.state = "revoked"; w.bots.b1.present = false; }],
]));

// ---------- (d) viewMintsScopedTokens ---------------------------------------------------------------------------------------------------

const view = (shownTarget: string): StepSpec => [{ t: "owner.viewSurface", principal: OWN }, w => {
  w.surface = [row({ section: "bot", actions: [{ kind: "remove", tokenId: "tB", enabled: true }] })];
  w.ghost.tokens.push(tk({ issuedAtStep: 1, shown: { target: shownTarget, address: ADDR, inboxId: "i1", keyIds: ["k1"] } }));
}];
rej("viewMintsScopedTokens", "token-shows-another-target", ["A4-H8", "A4-H9"], run(base(), [view("inbox:i2")]));
acc("viewMintsScopedTokens", "token-scoped-to-row", [], run(base(), [view(T_I1)]));

// ---------- (d) keyOnlyActionsTouchNoInbox ----------------------------------------------------------------------------------------------

const keyOnlyKeep = () => from(w => { keepHist(w, { target: T_OP1, inboxId: null, mode: "key_only" }); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_OP1, inboxId: null, mode: "key_only", authorityId: "aK", claimedAtStep: 0 }; });
rej("keyOnlyActionsTouchNoInbox", "key-only-keep-sends-get", ["F3-M3"], run(keyOnlyKeep(), [[send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1" }))]]));
acc("keyOnlyActionsTouchNoInbox", "key-only-remove-revokes", [], run(from(w => {
  w.ghost.tokens.push(tk({ tokenId: "tp", shown: { target: T_OP1, address: ADDR, inboxId: null, keyIds: ["k1"] } }));
  w.ghost.authorities.push(au({ kind: "remove_key_only", tokenId: "tp", verifiedAtStep: 0, scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } })); }),
  [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", authorityId: "aR" }))]]));

// ---------- (d) blindRestoreIsOwnerVisible ------------------------------------------------------------------------------------------

rej("blindRestoreIsOwnerVisible", "blind-restore-silent", ["F4-H1", "point-1"], run(blind(false), [[tick]]));
acc("blindRestoreIsOwnerVisible", "blind-restore-check-row", ["point-1"], run(blind(false), [[tick, w => {
  w.surface = [row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }] })]; }]]));

// ---------- (e) keepAndRemoveSerialized -------------------------------------------------------------------------------------------------

rej("keepAndRemoveSerialized", "key-only-keep-with-active-removal", ["A4-H3"], run(keyOnlyKeep(), [[tick, w => { w.local.leases.L1 = ls({ target: T_OP1, inboxId: null }); }]]));
// A5-M12: acting. With a key-only Keep open on op1, a removal lease opens on a DIFFERENT target (inbox i1).
acc("keepAndRemoveSerialized", "keep-with-lease-on-other-target", ["A5-M12"], run(keyOnlyKeep(), [[tick, w => { w.local.leases.L1 = ls(); }]]));

// ---------- (e) noRemoveDuringKeep ------------------------------------------------------------------------------------------------------

const keyOnlyRemove: StepSpec = [removeA("tp", { target: T_OP1, section: "key_only" }), w => { w.ghost.authorities.push(au({ kind: "remove_key_only", tokenId: "tp", scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } })); }];
rej("noRemoveDuringKeep", "remove-authorized-during-key-only-keep", ["A4-H3"], run(keyOnlyKeep(), [keyOnlyRemove]));
acc("noRemoveDuringKeep", "remove-with-no-keep", [], run(base(), [keyOnlyRemove]));

// ---------- (e) keepNetworkNeedsClaim ---------------------------------------------------------------------------------------------------

rej("keepNetworkNeedsClaim", "flux-closing-keep-unclaimed", ["A3-H2"], run(base(), [[send(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep" }))]]));
acc("keepNetworkNeedsClaim", "claimed-keep-restore", [], run(from(w => { keepHist(w, { mode: "flux_closing" }); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "flux_closing", authorityId: "aK", claimedAtStep: 0 }; }),
  [[send(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep", keepOp: "kp1" }))]]));

// ---------- (e) keepOpsFreshAndCasChecked -----------------------------------------------------------------------------------------------

const claimKp1: StepSpec = [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 1 }; }];
rej("keepOpsFreshAndCasChecked", "keep-op-reused", ["A3-M8"], run(from(w => { w.ghost.usedKeepOps.push("kp1"); }), [claimKp1]));
rej("keepOpsFreshAndCasChecked", "stale-answer-applies", ["A3-M8"], run(from(w => { w.flux.requests.push(rq({ requestId: "g0", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp0" })); }),
  [[{ t: "net.answer", requestId: "g0", result: "ok", fluxStateSeen: "active" }, w => { w.local.bindings.b1.state = "restored_unverified"; }]]));
acc("keepOpsFreshAndCasChecked", "fresh-keep-op", [], run(base(), [claimKp1]));

// ---------- (e) admissionPinned ---------------------------------------------------------------------------------------------------------

const leaseIn = (phase: Lease["phase"]) => from(w => { w.local.leases.L1 = ls({ phase }); });
rej("admissionPinned", "keep-refused-while-unknown", ["F4-H2", "A4-H9", "point-2"], run(leaseIn("unknown"), [[keepA({ outcome: no("removal_unknown") })]]));
rej("admissionPinned", "removal-sending-code-while-unknown", ["F4-H2", "point-2"], run(leaseIn("unknown"), [[keepA({ outcome: no("removal_sending") })]]));
rej("admissionPinned", "try-again-refused-while-pending", ["A4-H9"], run(leaseIn("unknown"), [[{ t: "owner.tryAgainNow", principal: OWN, botId: "b1", target: T_I1, outcome: no("unavailable") }]]));
acc("admissionPinned", "keep-refused-only-while-sending", ["point-2"], run(leaseIn("sending"), [[keepA({ outcome: no("removal_sending") })]]));
acc("admissionPinned", "remove-refused-while-keep-open", [], run(keyOnlyKeep(), [[removeA("tp", { target: T_OP1, section: "key_only", outcome: no("keep_pending") })]]));

// ---------- (f) keyTargetsNeverLost -----------------------------------------------------------------------------------------------------

rej("keyTargetsNeverLost", "live-key-without-record", ["A3-M7"], run(base(), [[tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; }]]));
acc("keyTargetsNeverLost", "key-held-by-park", [], run(base(), [[tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.parks.pk1 = pk(); }]]));

// ---------- (f) keyTargetEntriesNeverDropped --------------------------------------------------------------------------------------------

const parkOnlyKey = () => from(w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.parks.pk1 = pk(); });
rej("keyTargetEntriesNeverDropped", "target-dropped-while-live", ["A3-M7", "A4-H7"], run(parkOnlyKey(), [[tick, w => { w.local.parks.pk1.keyTargets = []; }]]));
acc("keyTargetEntriesNeverDropped", "target-dropped-after-revoke", [], run(parkOnlyKey(), [[tick, w => { w.local.parks.pk1.keyTargets = []; w.flux.keys.k1.state = "revoked"; }]]));

// ---------- (f) savedKeyNeverOutlivesRevokeWithoutWork ----------------------------------------------------------------------------------

rej("savedKeyNeverOutlivesRevokeWithoutWork", "revoked-key-saved-no-work", ["A3-M10", "A4-H10"], run(base(), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));
rej("savedKeyNeverOutlivesRevokeWithoutWork", "marked-revoked-before-secret-cleared", ["A3-M10"], run(base(), [[tick, w => { w.local.parks.pk1 = pk({ keyTargets: [{ keyId: "k1", status: "revoked" }] }); }]]));
acc("savedKeyNeverOutlivesRevokeWithoutWork", "async-revoke-pending", ["A4-H10"], run(from(w => { w.local.parks.pk1 = pk(); }), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));

// ---------- (g) markerNeverArchivedAndConsumedAtBoot ------------------------------------------------------------------------------------

rej("markerNeverArchivedAndConsumedAtBoot", "cloud-restic-carries-marker", ["A3-M16"], run(base(), [[{ t: "owner.backup", kind: "cloud_restic" }, w => { w.archives.push({ archiveId: "s1", kind: "cloud_restic", topLevelNames: ["home/messages.db", "home/restore-pending.json"] }); }]]));
acc("markerNeverArchivedAndConsumedAtBoot", "archive-without-marker", [], run(base(), [[{ t: "owner.backup", kind: "cloud_export" }, w => { w.archives.push({ archiveId: "s1", kind: "cloud_export", topLevelNames: ["home/messages.db"] }); }]]));

// ---------- (g) everyReplacementPreparedBeforeStore -------------------------------------------------------------------------------------

const replaced = (prepared: boolean) => from(w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "cloud_undo", archiveId: "A", blind: false, carryId: "c1" }); if (prepared) w.ghost.preparedEpochs.push(1); });
rej("everyReplacementPreparedBeforeStore", "store-open-without-prep", ["A4-M14"], run(replaced(false), [[tick]]));
// A5-M12: acting. Boot prep commits the epoch's prep, then the store opens.
acc("everyReplacementPreparedBeforeStore", "boot-prep-opens-store", ["A5-M12"], run(from(w => { Object.assign(w, replaced(false)); w.proc.phase = "boot_prep"; }),
  [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(1); w.proc.phase = "store_open"; }]]));

// ---------- (h) quiescenceReachable ------------------------------------------------------------------------------------------------------

const ticks = (n: number): StepSpec[] => Array.from({ length: n }, () => [tick] as StepSpec);
rej("quiescenceReachable", "remove-never-progresses", ["A4-H9", "A4-M13"], run(base(), [[removeA("tB"), w => { w.local.leases.L1 = ls(); }], ...ticks(CHECKER.livenessBound)]));
// A5-H6 / A5-M12: acting. The admitted Keep claims (authority, op, history), confirms with its own GET, records success, arms its guard.
const g1 = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 2, ...o });
acc("quiescenceReachable", "keep-completes", ["A5-H6", "A5-M12"], run(base(), [
  [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 1 };
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null })); w.ghost.keeps.push(kr({ claimedAtStep: 1 })); }],
  [send(g1()), w => { w.flux.requests.push(g1()); }],
  [apply("g1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 4, result: "ok", fluxStateSeen: "active" } }); }],
  [tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 5, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: 4 } }); w.local.keepOps = {}; w.local.keepGuards.i1 = gd({ unresolved: [] }); }],
  ...ticks(CHECKER.livenessBound - 3)]));
acc("quiescenceReachable", "unfair-suffix-not-judged", ["A4-M13"], run(base(), [
  [removeA("tB"), w => { w.local.leases.L1 = ls(); w.flux.requests.push(d("d1", "at1", { answer: "pending", sentAtStep: 1 })); }],
  ...Array.from({ length: CHECKER.livenessBound }, () => [clk(60_000)] as StepSpec)]));

// ---------- Check 2 opsLinesNeverNameAddress -------------------------------------------------------------------------------------------

const opsLine = (text: string, bindingId: string | null, kind: "blip" | "other" = "other"): Mut => w => {
  w.ops.push({ kind, bindingId, gen: bindingId ? clone(G1) : null, text, window: kind === "blip" ? { closingSinceMs: NOW, restoredAtMs: NOW + 30_000 } : null });
};
rej("opsLinesNeverNameAddress", "line-names-address", ["Check-2"], run(base(), [[tick, opsLine(`blip on ${ADDR}`, "b1", "blip")]]));
rej("opsLinesNeverNameAddress", "line-without-binding", ["A4-L15"], run(base(), [[tick, opsLine("guard check", null)]]));
acc("opsLinesNeverNameAddress", "line-binding-and-window", ["Check-2"], run(base(), [[tick, opsLine("blip b1 gen 1", "b1", "blip")]]));

// ---------- environmentWellFormed ----------------------------------------------------------------------------------------------------------

const heldD1 = () => from(w => { w.flux.requests.push(d("d1", "at1", { answer: "pending" })); });
rej("environmentWellFormed", "restore-erases-held-delete", ["A4-M12", "A3-H1"], run(heldD1(), [[swapA, w => { w.flux.requests = []; }]]));
rej("environmentWellFormed", "delete-on-closing-emits-second-event", ["FLUX-FACT-one-closing-event"], run(
  from(w => { w.flux.requests.push(d("d1", "at1", { flux: "applied" }), d("d2", "at2", { answer: "pending" })); Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "delete", requestId: "d1", reason: "owner" }, closingSinceMs: NOW, closingSinceStep: 0 }); }),
  [[apply("d2"), w => { w.flux.requests[1].flux = "applied"; w.flux.events.push({ eventId: "e-d2", type: "email.inbox.closing", inboxId: "i1", atMs: NOW, atStep: 1, deliveredToHome: false, reason: "owner" }); }]]));
acc("environmentWellFormed", "delete-closes-once", [], run(heldD1(), [[apply("d1"), closeBy("d1")]]));

// ===================================================================================================================================
// r3 witnesses (Astra round 5 = A5-*, Fable round 5 = F5-*)
// ===================================================================================================================================

// ---------- A5-H1: authority bound to what the owner saw and chose ------------------------------------------------------------------

// r2-escape: A5-H1. The row shows k1; the token minted for its Remove additionally shows k2 (an undisplayed key).
rej("viewMintsScopedTokens", "token-shows-undisplayed-key", ["A5-H1"], run(base(), [[{ t: "owner.viewSurface", principal: OWN }, w => {
  w.surface = [row({ section: "bot", keyIds: ["k1"], actions: [{ kind: "remove", tokenId: "tB", enabled: true }] })];
  w.ghost.tokens.push(tk({ issuedAtStep: 1, shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: ["k1", "k2"] } })); }]])); esc("A5-H1");
rej("viewMintsScopedTokens", "token-minted-outside-view", ["A5-H1"], run(base(), [[tick, w => { w.ghost.tokens.push(tk({ issuedAtStep: 1 })); }]])); esc("A5-H1");
const parkTok = (o: Partial<TokenIssue> = {}) => tk({ tokenId: "tP", kind: "p", gen: null, park: { parkId: "pk1", parkRev: 0 }, ...o });
const parkedTok = () => from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; w.ghost.tokens.push(parkTok()); });
// r2-escape: A5-H1. Reconnect presented with a PARK token: r2 validated it in the p branch and never ran the rotation checks.
rej("authorityCreatedByValidOwnerAction", "reconnect-with-park-token", ["A5-H1"], run(parkedTok(), [[
  { t: "owner.reconnect", principal: OWN, botId: "b1", tokenId: "tP", outcome: okO },
  w => { w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", tokenId: "tP", parkAtVerify: { parkId: "pk1", parkRev: 0 } })); }]])); esc("A5-H1");
// r2-escape: A5-H1. The owner pressed Remove on i2's row; the authority is scoped to i1 (the token's target), not the owner's choice.
rej("authorityCreatedByValidOwnerAction", "authority-target-differs-from-action", ["A5-H1"], run(withToken(), [[removeA("tB", { target: "inbox:i2" }), w => { w.ghost.authorities.push(au()); }]])); esc("A5-H1");
// r2-escape: F5-L5. An untokened bot-row Keep authority names key k7, which the binding does not hold.
rej("authorityCreatedByValidOwnerAction", "untokened-keep-names-foreign-key", ["F5-L5", "A5-H1"], run(base(), [[keepA(), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k7"] } })); }]])); esc("F5-L5");
acc("authorityCreatedByValidOwnerAction", "untokened-bot-keep", ["R2-Q5"], run(base(), [[keepA(), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] } })); }]]));
acc("authorityCreatedByValidOwnerAction", "park-remove-with-park-token", ["A5-H1"], run(parkedTok(), [[removeA("tP", { section: "parked" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aRp", kind: "remove_park", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } })); }]]));

// ---------- A5-H2: the carry holds queued removals and evidence; one park per target --------------------------------------------------

const carriedRemoval = () => from(w => { w.carry = carry({ removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] }); });
// r2-escape: A5-H2. The outgoing home had an authorized, unsent removal of i1; the archive has i1 active. Prep leaves it active, unparked.
rej("restorePrepParksEverything", "carried-unsent-removal-not-parked", ["A5-H2", "A4-H7"], run(carriedRemoval(), [[prep]])); esc("A5-H2");
acc("restorePrepParksEverything", "carried-unsent-removal-parked", ["A5-H2"], run(carriedRemoval(), [[prep, w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; }]]));
// r2-escape: A5-H2. Two key-only removals (op1, op2) in the archive; prep parks one and resumes the other. r2 let one park stand for both.
rej("restorePrepParksEverything", "one-park-for-two-op-removals", ["A5-H2"], run(from(w => {
  w.local.bindings = {}; w.local.savedKeys = {};
  w.local.parks.pkA = pk({ parkId: "pkA", target: T_OP1, inboxId: null, provisionOpId: "op1" });
  w.local.parks.pkB = pk({ parkId: "pkB", target: "op:op2", inboxId: null, provisionOpId: "op2", keyTargets: [{ keyId: "k2", status: "pending" }] });
}), [[prep, w => { w.local.parks.pkB.state = "remove_authorized"; }]])); esc("A5-H2");
// r2-escape: A5-H2. The outgoing home has an authorized removal lease with no attempt yet; the carry omits it and the swap proceeds.
rej("outgoingCapturedBeforeSwap", "carry-omits-queued-removal", ["A5-H2"], run(from(w => {
  w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls(); w.carry = carry();
}), [[swapA, w => { w.ghost.epoch = 1; }]])); esc("A5-H2");
acc("outgoingCapturedBeforeSwap", "carry-holds-queued-removal", ["A5-H2"], run(from(w => {
  w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls(); w.carry = carry({ removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] });
}), [[swapA, w => { w.ghost.epoch = 1; }]]));
acc("outgoingCapturedBeforeSwap", "carry-deleted-after-prep", [], run(from(w => { w.carry = carry(); w.ghost.epoch = 1; }), [[prep, w => { w.ghost.preparedEpochs.push(1); w.carry = null; }]]));

// ---------- A5-H3: protected contents cannot be edited away ---------------------------------------------------------------------------

// r2-escape: A5-H3 / F5-L1. A tick rewrites an "unknown" guard to [], the next tick releases it (no DELETE held at that moment).
rej("guardLivesUntilEveryDeleteResolved", "unknown-rewritten-then-released", ["A5-H3", "F5-L1"], run(
  from(w => { Object.assign(w, kept("unknown")); w.flux.requests[0].flux = "applied"; }),
  [[tick, w => { w.local.keepGuards.i1.unresolved = []; }], [tick, delGuard]])); esc("A5-H3");
acc("guardLivesUntilEveryDeleteResolved", "guard-drops-answered-attempt", ["A5-H3"], run(
  from(w => { Object.assign(w, kept(["at1", "at2"])); w.flux.requests.push(d("d2", "at2")); Object.assign(w.flux.requests[0], { flux: "applied", answer: "delivered", answerSeen: { atStep: 0, result: "accepted", fluxStateSeen: "closing" } }); }),
  [[tick, w => { w.local.keepGuards.i1.unresolved = ["at2"]; }]]));
// r2-overstrict: F5-L6. An archived guard for an inbox already purged is released by a GET that answers not_found.
acc("guardLivesUntilEveryDeleteResolved", "guard-released-by-get-not-found", ["F5-L6"], run(
  from(w => { Object.assign(w, kept("unknown")); w.flux.requests[0].flux = "applied"; w.flux.inboxes.i1.state = "purged";
    w.flux.requests.push(rq({ requestId: "g7", kind: "GET_INBOX", target: "i1", purpose: "guard", flux: "applied", answer: "delivered", answerSeen: { atStep: 0, result: "not_found", fluxStateSeen: null } })); }),
  [[tick, delGuard]])); over("F5-L6");
const keptK9 = (removeAt: number) => from(w => { Object.assign(w, keptKey(removeAt)); w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op9", forBot: "b1", state: "live" }; });
// r2-escape: A5-H3. A tick deletes the kept-key entry; the older Remove then revokes the key the owner kept.
rej("keptKeysProtected", "kept-key-entry-dropped-then-revoked", ["A5-H3"], run(keptK9(0), [[tick, w => { delete w.local.keptKeys.k9; }], [revokeK9]])); esc("A5-H3");
acc("keptKeysProtected", "kept-entry-cleared-after-later-remove-revoke", ["A5-H3"], run(keptK9(3), [[revokeK9],
  [{ t: "net.answer", requestId: "v9", result: "ok", fluxStateSeen: null }, w => { w.flux.keys.k9.state = "revoked"; delete w.local.keptKeys.k9; }]]));
// r2-escape: A5-H3. Prep keeps the carried guard's row but rewrites its "unknown" attempts to [] (released on the next tick).
rej("restorePrepParksEverything", "carried-guard-content-weakened", ["A5-H3"], run(from(w => { w.carry = carry({ keepGuards: [gd({ unresolved: "unknown" })] }); }),
  [[prep, w => { w.local.keepGuards.i1 = gd({ unresolved: [] }); }]])); esc("A5-H3");

// ---------- A5-H4: timing judged only where the named assumptions held; purge ends the terminal obligation ------------------------------

// r2-escape: A5-H4. One early fault excused the bound for ever in r2; r3 restarts the clock at the fault, so 10 idle minutes fail.
rej("keepEndsActive", "fault-excuses-forever", ["A5-H4"], run(kept(), [[apply("d1"), closeBy("d1")], [{ t: "fault.loseAnswer", requestId: "d1" }], [clk(600_000)]])); esc("A5-H4");
const restoreReq = (sentAtMs: number) => rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", sentAtMs });
// r2-overstrict: A5-H4. The home sends its guard RESTORE at once; Flux holds it 120 s (A-RESTORE-APPLY broken); it applies; active.
acc("keepEndsActive", "restore-held-beyond-90s-excused", ["A5-H4"], run(kept(), [
  [apply("d1"), closeBy("d1")],
  [send(restoreReq(NOW)), w => { w.flux.requests.push(restoreReq(NOW)); }],
  [clk(120_000)],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }],
]), true); over("A5-H4");
// r2-overstrict: A5-H4. Crash, the DELETE closes the inbox, 31 days offline, Flux purges it, the home boots and drops the guard.
acc("keepEndsActive", "offline-30d-purge-then-recover", ["A5-H4"], run(kept(), [
  [apply("d1"), closeBy("d1")],
  [{ t: "fault.crash", at: "W16_event_batch", when: "before" }, w => { w.proc.phase = "down"; }],
  [clk(31 * DAY)],
  [{ t: "flux.purge", inboxId: "i1" }, w => { w.flux.inboxes.i1.state = "purged"; w.flux.events.push({ eventId: "eP", type: "email.inbox.deleted", inboxId: "i1", atMs: w.nowMs, atStep: w.step, deliveredToHome: false, reason: null }); }],
  [{ t: "auto.boot" }, w => { w.proc.phase = "running"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; }],
  [{ t: "auto.applyEvent", eventId: "eP" }, delGuard],
]), true); over("A5-H4");
// r2-overstrict: A5-H4 / R2-Q3. After 24 h the bound rests on A-EVENT-5MIN; the closing event arrives 8 min late, the home restores at once.
acc("keepEndsActive", "late-event-after-24h-excused", ["A5-H4", "R2-Q3"], run(kept(), [
  [clk(2 * DAY)],
  [apply("d1"), closeBy("d1")],
  [clk(8 * 60_000)],
  [{ t: "auto.applyEvent", eventId: "e-d1" }],
  [send(restoreReq(NOW + 2 * DAY + 8 * 60_000)), w => { w.flux.requests.push(restoreReq(w.nowMs)); }],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }],
]), true); over("A5-H4");
// r2-overstrict: F5-L4. A Remove recorded before the trace (initial ghost) but after the Keep ends the Keep's window.
acc("keepEndsActive", "pre-trace-remove-ends-window", ["F5-L4"], run(from(w => { Object.assign(w, kept()); w.step = 3; w.ghost.authorities.push(au({ authorityId: "aR2", verifiedAtStep: 2 })); }),
  [[apply("d1"), closeBy("d1")], [clk(2 * 3600_000)]])); over("F5-L4");

// ---------- A5-H5, F5-M1, F5-M2: blind restore, owner confirmation, discovery ----------------------------------------------------------

const unknownEntries: Mut = w => {
  w.flux.inboxes.i5 = { inboxId: "i5", installOwned: true, createdUnderOp: "op5", forBot: "b5", address: "x5@mail.test", state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null };
  w.flux.keys.k5 = { keyId: "k5", installOwned: true, mintedUnderOp: "op5", forBot: "b5", state: "live" };
};
// r2-escape: A5-H5 / F5-M2. Blind restore (epoch 1, unconfirmed), then a NON-blind restore (epoch 2) of that incomplete DB: r2 lifted the fence.
rej("noDestructiveSendAfterBlindRestore", "fence-dropped-by-second-restore", ["A5-H5", "F5-M2"], run(from(w => {
  w.ghost.epoch = 2;
  w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null });
  w.ghost.restores.push({ atStep: 1, atMs: NOW, epochAfter: 2, source: "cloud_undo", archiveId: "B", blind: false, carryId: "c1" });
}), [[send(d("d1", "at1", { answer: "pending" }))]])); esc("A5-H5");
acc("noDestructiveSendAfterBlindRestore", "delete-after-complete-listing", ["Q2-ruling", "A5-H5"], run(from(w => {
  Object.assign(w, blind(false)); w.flux.semantics.listingShipped = true;
  w.flux.requests.push(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1, sentInEpoch: 1, flux: "applied", answer: "delivered", answerSeen: { atStep: 2, result: "ok", fluxStateSeen: null }, listingComplete: true }));
}), [[send(d("d1", "at1", { answer: "pending" }))]]));
const rcRow = () => row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }] });
const rTok = () => tk({ tokenId: "tr", kind: "r", botId: null, gen: null, shown: { target: null, address: null, inboxId: null, keyIds: [] }, epoch: 1 });
const confirmStep = (): StepSpec => [{ t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aC", kind: "confirm_inventory", tokenId: "tr", epoch: 1, botId: null, scope: { target: null, inboxId: null, keyIds: [] }, genAtVerify: null }));
  w.ghost.inventoryConfirmedEpochs.push(1); w.surface = []; }];
// r2-overstrict: A5-H5 / F5-M1 / R2-Q4. Owner confirms a blind restore before any listing: unknown inbox i5 and key k5 stay live, no row.
acc("everyOrphanHasExecutableAction", "unknown-inbox-after-confirm-no-listing", ["A5-H5", "F5-M1", "R2-Q4"], run(
  from(w => { Object.assign(w, blind(false)); unknownEntries(w); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), [confirmStep()])); over("A5-H5");
// r2-overstrict: A5-H5 / F5-M1. Listing shipped, owner confirmed; the discovery LIST is sent and not yet answered: k5 is not yet lost.
acc("keyTargetsNeverLost", "unknown-key-while-discovery-pending", ["A5-H5", "F5-M1", "R2-Q4"], run(
  from(w => { Object.assign(w, blind(true)); unknownEntries(w); w.flux.semantics.listingShipped = true; }),
  [[send(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1 })), w => { w.flux.requests.push(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1 })); }]])); over("A5-H5");
rej("keyTargetsNeverLost", "listed-key-no-record", ["A5-H5", "F5-M1"], run(
  from(w => { Object.assign(w, blind(true)); unknownEntries(w); w.flux.semantics.listingShipped = true; }),
  [[{ t: "net.answer", requestId: "L1", result: "ok", fluxStateSeen: null }, w => {
    w.flux.requests.push(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1, sentInEpoch: 1, flux: "applied", answer: "delivered", answerSeen: { atStep: 1, result: "ok", fluxStateSeen: null }, listingComplete: true })); }]]));
// r2-escape: A5-H5 (R2-Q4: a discovery pass is REQUIRED once the listing exists). Listing shipped, nothing ever lists: r2 called it quiet.
rej("quiescenceReachable", "discovery-never-run", ["A5-H5", "R2-Q4"], run(from(w => { Object.assign(w, blind(true)); w.flux.semantics.listingShipped = true; }), ticks(CHECKER.livenessBound))); esc("A5-H5");
const listReq = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1, sentInEpoch: 1, ...o });
acc("quiescenceReachable", "discovery-run-then-quiet", ["A5-H5", "R2-Q4"], run(from(w => { Object.assign(w, blind(true)); w.flux.semantics.listingShipped = true; }), [
  [send(listReq()), w => { w.flux.requests.push(listReq()); }],
  [apply("L1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "L1", result: "ok", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 3, result: "ok", fluxStateSeen: null }, listingComplete: true }); }],
  ...ticks(CHECKER.livenessBound - 3)]));

// ---------- A5-H6, F5-H1: an admitted owner action does its work; refusals keyed to their premise ---------------------------------------

// r2-escape: A5-H6. Keep on a visible parked row "succeeds" and creates no authority, no Keep op, no history; the park is unchanged.
rej("admissionPinned", "noop-keep-ok", ["A5-H6", "F4-H2"], run(parkedTok(), [[keepA({ mode: "orphan", tokenId: "tP" })]])); esc("A5-H6");
// r2-escape: A5-H6. The same no-op Keep, then a fair quiet suffix: r2 judged it quiescent (parked waiting) and complete.
rej("quiescenceReachable", "noop-keep-quiescent", ["A5-H6"], run(parkedTok(), [[keepA({ mode: "orphan", tokenId: "tP" })], ...ticks(CHECKER.livenessBound)])); esc("A5-H6");
acc("admissionPinned", "keep-ok-claims", ["A5-H6"], run(parkedTok(), [[keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.local.parks.pk1.state = "keep_pending"; }]]));
// r2-escape: F5-H1. Remove on a PARKED row of a present bot refused "bot_present": r2 treated every non-bot section as absent-bot.
rej("admissionPinned", "remove-refused-bot-present-on-parked", ["F5-H1"], run(parkedTok(), [[removeA("tP", { section: "parked", outcome: no("bot_present") })]])); esc("F5-H1");
// r2-escape: F5-H1. Keep on an orphan inbox held only by a carried guard refused "inbox_gone" with no gone evidence.
rej("admissionPinned", "keep-refused-inbox-gone-guard-only", ["F5-H1"], run(from(w => {
  w.bots.b1.present = false; w.local.bindings = {}; w.local.savedKeys = {}; w.local.keepGuards.i1 = gd({ unresolved: "unknown" });
  w.ghost.tokens.push(tk({ tokenId: "tF", kind: "f", botId: null, gen: null }));
}), [[keepA({ mode: "orphan", tokenId: "tF", outcome: no("inbox_gone") })]])); esc("F5-H1");
const removeParked = (): StepSpec => [removeA("tP", { section: "parked" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aRp", kind: "remove_park", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.leases.L1 = ls({ authorityId: "aRp" }); w.local.parks.pk1.state = "remove_authorized"; }];
acc("admissionPinned", "remove-on-parked-row-succeeds", ["F5-H1"], run(parkedTok(), [removeParked()]));

// ---------- A5-H7: a restored, parked removal is never hidden ---------------------------------------------------------------------------

// r2-escape: A5-H7. A pre-restore DELETE (epoch 0 authority) lands on i1 after prep parked it; r2 exempted i1 as "removed by owner".
rej("everyOrphanHasExecutableAction", "restored-parked-removal-hidden", ["A5-H7", "F4-M3"], run(from(w => {
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1" }); w.ghost.preparedEpochs.push(1);
  w.ghost.authorities.push(au({ verifiedAtStep: -5 }));
  w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked";
  w.flux.requests.push(d("d1", "at1", { flux: "applied", answer: "pending" }));
}), [[apply("d1"), closeBy("d1")]])); esc("A5-H7");

// ---------- A5-H8 (R2-Q2): both DELETE idempotency semantics encoded consistently ----------------------------------------------------

const dupAfterRestore = (honoured: boolean) => from(w => {
  w.flux.semantics.deleteIdempotencyKeyHonoured = honoured;
  w.flux.requests.push(d("d1", "at1", { flux: "applied", appliedAtMs: NOW, answer: "delivered" }), d("d1c", "at1", { copyOf: "d1", answer: "pending" }));
});
// r2-escape: A5-H8. Idempotency key honoured: the duplicate lands after the Keep restored i1 and closes it AGAIN (a second execution).
rej("environmentWellFormed", "idempotent-duplicate-executes-twice", ["A5-H8", "R2-Q2"], run(dupAfterRestore(true), [[apply("d1c"), closeBy("d1c")]])); esc("A5-H8");
// r2-overstrict: A5-H8. Idempotency key honoured: the duplicate is applied with no effect.
acc("environmentWellFormed", "idempotent-duplicate-silent", ["A5-H8", "R2-Q2"], run(dupAfterRestore(true), [[apply("d1c"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); }]])); over("A5-H8");
acc("environmentWellFormed", "non-idempotent-duplicate-executes", ["A5-H8", "R2-Q2"], run(dupAfterRestore(false), [[apply("d1c"), closeBy("d1c")]]));

// ---------- A5-M9: fairness covers work created during the suffix; livelock is caught -----------------------------------------------

// r2-overstrict: A5-M9. Recovery from an authorized lease sends its DELETE near the end; the request is legitimately still held.
acc("quiescenceReachable", "recovery-new-request-at-end", ["A5-M9"], run(from(w => { w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls(); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); }), [
  ...ticks(4), [tick, w => { Object.assign(w.local.leases.L1, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(d("d1", "at1", { answer: "pending", sentAtStep: 6 })), w => { w.flux.requests.push(d("d1", "at1", { answer: "pending", sentAtStep: 6 })); }],
  [tick]])); over("A5-M9");
const pollRound = (n: number): StepSpec[] => {
  const g = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "p" + n, kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: 3 * n + 1, ...o });
  return [[tick, w => { w.flux.requests.push(g()); }], [apply("p" + n), w => { Object.assign(w.flux.requests[n], { flux: "applied", appliedAtMs: w.nowMs }); }],
    [{ t: "net.answer", requestId: "p" + n, result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[n], { answer: "delivered", answerSeen: { atStep: 3 * n + 3, result: "ok", fluxStateSeen: "active" } }); }]];
};
const livelockRounds = Math.ceil(CHECKER.fairRecoverySteps / 3);
rej("quiescenceReachable", "recovery-livelock", ["A5-M9"], run(base(), [
  ...Array.from({ length: livelockRounds }, (_, n) => pollRound(n)).flat(),
  [tick, w => { w.flux.requests.push(rq({ requestId: "pz", kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: 3 * livelockRounds + 1 })); }]]));

// ---------- A5-M10: removal revokes need the send claim too --------------------------------------------------------------------------

const revokeK1 = send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", removalId: "L1", attemptId: "at2", authorityId: "aR", answer: "pending" }));
// r2-escape: A5-M10. A removal revoke leaves while the lease is only authorized (no send claim; Keep admission cannot see it).
rej("removalSendNeedsSendingLease", "revoke-without-send-claim", ["A5-M10", "F4-M4"], run(from(w => { w.local.leases.L1 = ls({ keyTargets: [{ keyId: "k1", status: "pending" }] }); }), [[revokeK1]])); esc("A5-M10");
acc("removalSendNeedsSendingLease", "revoke-under-sending-lease", ["A5-M10"], run(from(w => {
  w.local.leases.L1 = ls({ phase: "sending", attemptId: "at2", attempts: ["at2"], keyTargets: [{ keyId: "k1", status: "pending" }] }); }), [[revokeK1]]));

// ---------- A5-M11, F5-L2: history and recorder fields are fixed once written ----------------------------------------------------------

// r2-escape: A5-M11. A successful Keep's success time is erased (keepEndsActive would then skip it).
rej("environmentWellFormed", "keep-success-time-erased", ["A5-M11", "A4-M12"], run(keptRecord(), [[tick, w => { w.ghost.keeps[0].succeededAtMs = null; }]])); esc("A5-M11");
// r2-escape: F5-L2. A non-owner step records an inventory confirmation (would make the blind fence vacuous).
rej("environmentWellFormed", "confirm-epoch-without-owner", ["F5-L2"], run(blind(false), [[tick, w => { w.ghost.inventoryConfirmedEpochs.push(1); }]])); esc("F5-L2");
acc("environmentWellFormed", "owner-confirms-inventory", ["F5-L2"], run(from(w => { Object.assign(w, blind(false)); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), [confirmStep()]));

// ---------- F5-M3: a Flux-caused closing is offered even when a guard exists ------------------------------------------------------------

// r2-escape: F5-M3. After a Keep (guard present), Flux closes i1 for billing; no Keep is offered on the bot row.
rej("everyOrphanHasExecutableAction", "flux-close-guarded-no-keep-row", ["F5-M3", "F4-M1"], run(from(w => { w.local.keepGuards.i1 = gd(); }), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")]])); esc("F5-M3");
acc("everyOrphanHasExecutableAction", "flux-close-guarded-keep-row", ["F5-M3"], run(from(w => { w.local.keepGuards.i1 = gd(); }), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, w => {
  fluxClose("billing")(w); w.surface = [row({ section: "bot", actions: [{ kind: "keep", tokenId: null, enabled: true }] })]; }]]));

// ---------- F5-L3: only an ok Keep / Remove / bot delete moves a parked park ------------------------------------------------------------

// r2-escape: F5-L3. Reconnect names the bot and moves its parked park to remove_authorized.
rej("nothingAutomaticUnparks", "reconnect-unparks", ["F5-L3"], run(parked(), [[{ t: "owner.reconnect", principal: OWN, botId: "b1", tokenId: "tB", outcome: okO }, w => { w.local.parks.pk1.state = "remove_authorized"; }]])); esc("F5-L3");
acc("nothingAutomaticUnparks", "owner-remove-moves-park", ["F5-L3", "F5-H1"], run(parkedTok(), [removeParked()]));

// ---------- R3-Q4 (r3.1): an ok owner.deleteBot kills that bot's authorities, tokens and leases in the same step ---------------------

/** b1 holds Remove authority aR (pre-trace) with lease L1 sending attempt at1; b2 holds aR2 on i2 with lease L2 sending at2. Step 1:
 *  ok owner.deleteBot [b1] with b token tD, creating its own bot_delete_with_token authority aD and recording the deletion. */
const twoBots = () => from(w => {
  w.bots.b2 = { botId: "b2", present: true };
  const s2 = { target: "inbox:i2", inboxId: "i2", keyIds: [] as string[] };
  w.ghost.tokens.push(tk({ issuedAtStep: -4 }), tk({ tokenId: "tB2", botId: "b2", gen: null, shown: { ...s2, address: null }, issuedAtStep: -4 }), tk({ tokenId: "tD" }));
  w.ghost.authorities.push(au({ verifiedAtStep: -3 }), au({ authorityId: "aR2", botId: "b2", tokenId: "tB2", verifiedAtStep: -3, scope: s2, genAtVerify: null }));
  w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] });
  w.local.leases.L2 = ls({ removalId: "L2", target: "inbox:i2", inboxId: "i2", botId: "b2", authorityId: "aR2", phase: "sending", attemptId: "at2", attempts: ["at2"] });
});
const deleteB1: StepSpec = [{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aD", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: 1 }));
  w.ghost.botDeletedAtStep.b1 = 1; w.bots.b1.present = false; }];
// r3-escape: Q4. After the ok bulk delete of b1, b1's OLD Remove authority aR (and its lease L1) is used again to send a DELETE of i1.
const reusedD = d("d1", "at1", { answer: "pending", sentAtStep: 2 });
rej("deletedBotAuthorityDead", "deleteBot-authority-reused", ["R3-Q4"], run(twoBots(), [deleteB1, [send(reusedD), w => { w.flux.requests.push(clone(reusedD)); }]]));
// r3-escape: Q4. The same delete leaves b2 untouched: b2's authority aR2 and lease L2 then send i2's DELETE legitimately.
const otherD = d("d2", "at2", { target: "i2", removalId: "L2", authorityId: "aR2", answer: "pending", sentAtStep: 2 });
acc("deletedBotAuthorityDead", "deleteBot-other-bot-untouched", ["R3-Q4"], run(twoBots(), [deleteB1, [send(otherD), w => { w.flux.requests.push(clone(otherD)); }]]));

// ===================================================================================================================================
// r3.2 witnesses (Astra final check of r3 = A6-*, Fable final check = FA-*). Every start world passes initialStateValid.
// ===================================================================================================================================

// ---------- A6-H1: every admitted owner op completes; nothing automatic rolls keep_pending back to parked ------------------------------

/** Step 1: an admitted orphan Keep on parked pk1 (valid p token): authority, Keep op, history, park keep_pending. */
const admitKeep = (): StepSpec => [keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk1.state = "keep_pending"; }];
const viewS: StepSpec = [{ t: "owner.viewSurface", principal: OWN }];
// r3.1-escape: A6-H1. The admitted Keep is discarded after a later view (op dropped, keep_pending -> parked); r3.1 judged only the view.
rej("quiescenceReachable", "keep-admitted-then-view-discarded", ["A6-H1", "A5-H6"], run(parkedTok(), [admitKeep(), viewS,
  [tick, w => { w.local.keepOps = {}; w.local.parks.pk1.state = "parked"; }], ...ticks(CHECKER.livenessBound)])); esc31("A6-H1");
// r3.1-escape: A6-H1. A tick rolls an admitted keep_pending park back to parked.
rej("nothingAutomaticUnparks", "auto-rolls-keep-pending-to-parked", ["A6-H1"], run(from(w => {
  Object.assign(w, parkedTok()); keepHist(w, { mode: "orphan", claimedAtStep: 0 }); w.local.parks.pk1.state = "keep_pending";
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 0 };
}), [[tick, w => { w.local.keepOps = {}; w.local.parks.pk1.state = "parked"; }]])); esc31("A6-H1");
// A6-H1 accept: the admitted Keep completes AFTER a later view (own GET, success, guard, park done).
const g1v = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 3, ...o });
acc("quiescenceReachable", "keep-admitted-completes-after-view", ["A6-H1"], run(parkedTok(), [admitKeep(), viewS,
  [send(g1v()), w => { w.flux.requests.push(g1v()); }],
  [apply("g1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 5, result: "ok", fluxStateSeen: "active" } }); }],
  [tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 6, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: 5 } });
    w.local.keepOps = {}; w.local.keepGuards.i1 = gd({ unresolved: "unknown" }); delete w.local.parks.pk1; w.local.bindings.b1.state = "active"; }],
  ...ticks(CHECKER.livenessBound)]));
// A6-H1 owner-caused end (MurageMain a): Keep admitted on the bot's OLD inbox i2 (park pk2), then the owner deletes the bot. The
// delete kills the Keep op (deletedBotAuthorityDead), parks i2 again (owner step) and removes i1 + k1 to completion. MUTANT
// `keep-end-by-bot-delete-is-violation` (quiescenceReachable without the deletedAfter end) must reject this accept.
// (MurageMain b: the model has NO owner action that withdraws or cancels a Keep, so there is no such end and no witness.)
const keepThenDelete = () => from(w => {
  w.local.parks.pk2 = pk({ parkId: "pk2", target: "inbox:i2", inboxId: "i2", provisionOpId: "op2", keyTargets: [], address: "old@mail.test", gen: { inboxId: "i2", opId: "op2", emailKeyRef: null, serial: 0 } });
  w.ghost.tokens.push(parkTok({ tokenId: "tP2", park: { parkId: "pk2", parkRev: 0 }, shown: { target: "inbox:i2", address: "old@mail.test", inboxId: "i2", keyIds: [] } }), tk({ tokenId: "tD" }));
});
const dD = (o: Partial<RemoteRequest> = {}) => d("d1", "at1", { removalId: "LD", authorityId: "aD", answer: "pending", sentAtStep: 4, ...o });
const vD = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", removalId: "LD", attemptId: "at1", authorityId: "aD", sentAtStep: 7, ...o });
const deleteB1Work: StepSpec = [{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aD", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: w.step }));
  w.ghost.botDeletedAtStep.b1 = w.step; w.bots.b1.present = false; w.local.bindings.b1.state = "removing";
  w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD", keyTargets: [{ keyId: "k1", status: "pending" }] }); }];
acc("quiescenceReachable", "keep-ended-by-owner-bot-delete", ["A6-H1", "MurageMain-a"], run(keepThenDelete(), [
  [keepA({ target: "inbox:i2", mode: "orphan", tokenId: "tP2" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP2", genAtVerify: null, parkAtVerify: { parkId: "pk2", parkRev: 0 }, scope: { target: "inbox:i2", inboxId: "i2", keyIds: [] } }));
    w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: "inbox:i2", inboxId: "i2", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
    w.ghost.keeps.push(kr({ target: "inbox:i2", inboxId: "i2", mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk2.state = "keep_pending"; }],
  [deleteB1Work[0], w => { deleteB1Work[1]!(w); w.local.keepOps = {}; w.local.parks.pk2.state = "parked"; }],
  [tick, w => { Object.assign(w.local.leases.LD, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(dD()), w => { w.flux.requests.push(dD()); }],
  [apply("d1"), closeBy("d1", "bot_deleted")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 6, result: "accepted", fluxStateSeen: "closing" } }); w.local.leases.LD.phase = "acked"; }],
  [send(vD()), w => { w.flux.requests.push(vD()); }],
  [apply("v1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); w.flux.keys.k1.state = "revoked"; }],
  [{ t: "net.answer", requestId: "v1", result: "ok", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[1], { answer: "delivered", answerSeen: { atStep: 9, result: "ok", fluxStateSeen: null } }); }],
  [tick, w => { w.local.leases = {}; w.local.bindings = {}; w.local.savedKeys = {}; w.flux.events[0].deliveredToHome = true; }],
  ...ticks(CHECKER.livenessBound)]));

// ---------- A6-M2: after a complete listing, discovery takes effect ------------------------------------------------------------------

const unlistedBlind = () => from(w => { Object.assign(w, blind(false)); unknownEntries(w); w.flux.semantics.listingShipped = true; w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); });
const listAnswered: Mut = w => { w.flux.requests.push(listReq({ flux: "applied", answer: "delivered", answerSeen: { atStep: w.step, result: "ok", fluxStateSeen: null }, listingComplete: true })); };
const listAns: Action = { t: "net.answer", requestId: "L1", result: "ok", fluxStateSeen: null };
// r3.1-escape: A6-M2. Unconfirmed blind restore, complete listing delivered, only the restore-check row kept: listed k5 has no record.
rej("keyTargetsNeverLost", "listing-delivered-unconfirmed-no-record", ["A6-M2", "F5-M1"], run(unlistedBlind(), [[listAns, listAnswered]])); esc31("A6-M2");
// r3.1-escape: A6-M2. The same: listed inbox i5 has no row.
rej("everyOrphanHasExecutableAction", "listing-delivered-unconfirmed-no-row", ["A6-M2", "F5-M1"], run(unlistedBlind(), [[listAns, listAnswered]])); esc31("A6-M2");
const discovered: Mut = w => {
  listAnswered(w);
  w.local.parks.pk5 = pk({ parkId: "pk5", botId: "b5", origin: "restore", target: "op:op5", inboxId: null, provisionOpId: "op5", address: null, gen: { inboxId: null, opId: "op5", emailKeyRef: "k5", serial: 0 }, keyTargets: [{ keyId: "k5", status: "pending" }] });
  w.surface = [rcRow(), row({ section: "key_only", target: "op:op5", botId: "b5", inboxId: null, keyIds: ["k5"], provisionOpId: "op5",
    actions: [{ kind: "keep", tokenId: "t5", enabled: true }, { kind: "remove", tokenId: "t5", enabled: true }] })];
};
acc("keyTargetsNeverLost", "listing-delivered-entries-recorded", ["A6-M2"], run(unlistedBlind(), [[listAns, discovered]]));
acc("everyOrphanHasExecutableAction", "listing-delivered-entries-rowed", ["A6-M2"], run(unlistedBlind(), [[listAns, discovered]]));

// ---------- A6-M3: kept-key protection judged on the carry, not at the swap ----------------------------------------------------------

const keptSwapStart = (carried: string | null) => from(w => {
  const sc = { target: "op:op9", inboxId: null, keyIds: ["k9"] };
  w.ghost.authorities.push(au({ authorityId: "aKo", kind: "keep", tokenId: null, verifiedAtStep: -5, scope: sc }), au({ authorityId: "aKn", kind: "keep", tokenId: null, verifiedAtStep: -2, scope: sc }));
  w.local.keptKeys.k9 = "aKn"; w.carry = carry({ keptKeys: carried ? { k9: carried } : {} });
});
const swapOld: StepSpec = [swapA, w => { w.local.keptKeys = { k9: "aKo" }; w.ghost.epoch = 1;
  w.ghost.restores.push({ atStep: w.step, atMs: NOW, epochAfter: 1, source: "cloud_reset", archiveId: "A", blind: false, carryId: "c1" }); }];
// r3.1-overstrict: A6-M3. Outgoing k9 kept under NEWER aKn, archive under OLDER aKo; the carry holds aKn and the prep restores it.
acc("keptKeysProtected", "swap-archive-older-keep-carry-newer", ["A6-M3", "A5-H3"], run(keptSwapStart("aKn"), [swapOld,
  [prep, w => { w.local.keptKeys.k9 = "aKn"; w.ghost.preparedEpochs.push(1); w.carry = null; }]])); over31("A6-M3");
// r3.1-escape: A6-M3. Post-swap, the prep keeps the archive's OLDER Keep although the carry holds the newer one.
rej("keptKeysProtected", "prep-keeps-archive-older-keep", ["A6-M3"], run(from(w => { Object.assign(w, keptSwapStart("aKn")); swapOld[1]!(w); }),
  [[prep, w => { w.ghost.preparedEpochs.push(1); w.carry = null; }]])); esc31("A6-M3");
rej("keptKeysProtected", "swap-carry-drops-kept-key", ["A6-M3"], run(keptSwapStart(null), [swapOld]));

// ---------- A6-M4: livelock judged after the last drained step ------------------------------------------------------------------------

// r3.1-escape: A6-M4. One drained tick, then the endless polling loop of recovery-livelock.
rej("quiescenceReachable", "drained-tick-then-livelock", ["A6-M4", "A5-M9"], run(base(), [[tick],
  ...Array.from({ length: livelockRounds }, (_, n) => pollRound(n)).flat(),
  [tick, w => { w.flux.requests.push(rq({ requestId: "pz", kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: 3 * livelockRounds + 2 })); }]])); esc31("A6-M4");

// ---------- A6-M5 (R3-Q4): an ok bot delete creates its work and completes ---------------------------------------------------------

const delStart = () => from(w => { w.ghost.tokens.push(tk({ tokenId: "tD" })); });
const delOk: Action = { t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO };
// r3.1-escape: A6-M5. The ok delete records the deletion and creates no authority and no removal work.
rej("admissionPinned", "deleteBot-ok-creates-nothing", ["A6-M5", "R3-Q4"], run(delStart(), [[delOk, w => { w.ghost.botDeletedAtStep.b1 = 1; w.bots.b1.present = false; }]])); esc31("A6-M5");
// r3.1-escape: A6-M5. Authority and lease, but the delete's own parked target stays parked (waits for ever).
rej("admissionPinned", "deleteBot-leaves-park-waiting", ["A6-M5"], run(from(w => { Object.assign(w, parked()); w.ghost.tokens.push(tk({ tokenId: "tD" })); }), [deleteB1Work])); esc31("A6-M5");
acc("admissionPinned", "deleteBot-ok-authorizes-and-leases", ["A6-M5"], run(from(w => { Object.assign(w, parked()); w.ghost.tokens.push(tk({ tokenId: "tD" })); }),
  [[deleteB1Work[0], w => { deleteB1Work[1]!(w); w.local.parks.pk1.state = "remove_authorized"; }]]));
// r3.1-escape: A6-M5. The delete's lease is dropped by a tick and nothing is sent; i1 stays active.
rej("quiescenceReachable", "deleteBot-work-dropped", ["A6-M5"], run(delStart(), [deleteB1Work, [tick, w => { w.local.leases = {}; w.local.bindings = {}; }], ...ticks(CHECKER.livenessBound)])); esc31("A6-M5");

// ---------- FA-M1: the blip bound is derived from the named assumptions (120 s) ------------------------------------------------------

const guardRestoreAt = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", ...o });
// r3.1-overstrict: FA-M1. Still closing EXACTLY at the derived worst case (poll 60 + answer 30 + apply 30 = 120 s), then restored.
acc("keepEndsActive", "blip-at-derived-worst-case-120s", ["FA-M1", "A5-H4"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(120_000)],
  [apply("r1"), w => { w.flux.requests.push(guardRestoreAt({ flux: "applied", appliedAtMs: w.nowMs, sentAtMs: w.nowMs })); reopen(w); }]]), true); over31("FA-M1");
// r3.1-overstrict: FA-M1. The same at ~115 s.
acc("keepEndsActive", "blip-at-115s", ["FA-M1"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(115_000)],
  [apply("r1"), w => { w.flux.requests.push(guardRestoreAt({ flux: "applied", appliedAtMs: w.nowMs, sentAtMs: w.nowMs })); reopen(w); }]]), true); over31("FA-M1");
rej("keepEndsActive", "blip-1ms-past-worst-case", ["FA-M1"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(120_001)]]));

// ---------- FA-M2: bot_present keys on the TARGET row's bot, not the action's ---------------------------------------------------------

/** b1 present, live on i2 (gen 2); i1 at Flux is an orphan of ABSENT b2 (no park); f token on i1's row. */
const orphanOfOther = (i1Owner: "b1" | "none") => from(w => {
  w.bots.b2 = { botId: "b2", present: false };
  w.local.bindings.b1.gen = { inboxId: i1Owner === "b1" ? "i1" : "i2", opId: "op2", emailKeyRef: "k1", serial: 2 };
  w.flux.inboxes.i1.forBot = "b2";
  w.ghost.tokens.push(tk({ tokenId: "tF", kind: "f", botId: null, gen: null, shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: [] } }));
});
// r3.1-escape: FA-M2. The action's bot b1 is present, the row's premise (no present live binding names i1) holds: refusal illegal.
rej("admissionPinned", "keep-refused-bot-present-on-orphan-of-present-bot", ["FA-M2", "F5-H1"], run(orphanOfOther("none"), [[keepA({ mode: "orphan", tokenId: "tF", outcome: no("bot_present") })]])); esc31("FA-M2");
// r3.1-overstrict: FA-M2 / FA-L1. The action names ABSENT b2, but present b1's live binding now names i1: bot_present is legal.
acc("admissionPinned", "keep-refused-bot-present-row-bot-differs", ["FA-M2", "FA-L1"], run(orphanOfOther("b1"), [[keepA({ botId: "b2", mode: "orphan", tokenId: "tF", outcome: no("bot_present") })]])); over31("FA-M2");

// ---------- FA-M3 (High-class): inbox_gone only on purge / deleted evidence -----------------------------------------------------------

const pkE = () => from(w => { Object.assign(w, parkedTok()); w.local.parks.pk1.state = "parked_evidence"; w.local.parks.pk1.remoteDeletedAtMs = NOW;
  Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "delete", requestId: "d0", reason: "owner" }, closingSinceMs: NOW, closingSinceStep: 0 }); });
// r3.1-escape: FA-M3. Keep on the standing order's main row (parked_evidence, inbox CLOSING, restorable) refused "inbox_gone".
// MUTANT `closing-is-gone` (inboxGone true on a parked_evidence park or a closing inbox) must accept it, so this witness kills it.
rej("admissionPinned", "keep-refused-inbox-gone-on-parked-evidence", ["FA-M3", "standing-order"], run(pkE(), [[keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") })]])); esc31("FA-M3");
acc("admissionPinned", "keep-admitted-on-parked-evidence", ["FA-M3", "standing-order"], run(pkE(), [[keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk1.state = "keep_pending"; }]]));
const purgedSeen = (delivered: boolean) => from(w => { Object.assign(w, pkE()); w.flux.inboxes.i1.state = "purged";
  w.flux.events.push({ eventId: "eP", type: "email.inbox.deleted", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: delivered, reason: null }); });
acc("admissionPinned", "keep-refused-inbox-gone-after-delivered-purge", ["FA-M3"], run(purgedSeen(true), [[keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") })]]));
// r3.1-escape: FA-M3. After the purge but BEFORE the home has seen any purge / deleted evidence: inbox_gone is still illegal.
rej("admissionPinned", "keep-refused-inbox-gone-purge-unseen", ["FA-M3"], run(purgedSeen(false), [[keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") })]])); esc31("FA-M3");

export const WITNESSES: readonly Witness[] = W;

// ===================================================================================================================================
// Runner (the checker calls this FIRST)
// ===================================================================================================================================

export function runWitnesses(ws: readonly Witness[] = WITNESSES): { id: string; invariant: string; ok: boolean; why: string }[] {
  return ws.map(w => {
    const v = verdictOf(w.invariant, w.trace, w.settled);
    const rejected = !v.ok && v.invariant === w.invariant;
    const ok = w.expect === "reject" ? rejected : v.ok;
    return { id: w.id, invariant: w.invariant, ok, why: v.ok ? "accepted" : v.why };
  });
}

/** Invariants lacking a must-reject or a must-accept witness, Highs lacking a must-reject, and r3 Highs lacking an r2-escape. All empty. */
export function witnessCoverage(): { missing: string[]; highsMissing: string[]; r2EscapesMissing: string[] } {
  const names = [...Object.keys(STEP_INVARIANTS), ...Object.keys(STATE_INVARIANTS), ...Object.keys(TRACE_INVARIANTS)];
  const missing: string[] = [];
  for (const n of names) for (const e of ["reject", "accept"] as const) if (!W.some(w => w.invariant === n && w.expect === e)) missing.push(`${n}:${e}`);
  const r3Highs = ["A5-H1", "A5-H2", "A5-H3", "A5-H4", "A5-H5", "A5-H6", "A5-H7", "A5-H8", "F5-H1"];
  const highs = ["A4-H1", "A4-H2", "A4-H3", "A4-H4", "A4-H5", "A4-H6", "A4-H7", "A4-H8", "A4-H9", "A4-H10", "F4-H1", "F4-H2", "F4-H3", "F4-H4", ...r3Highs];
  const highsMissing = highs.filter(h => !W.some(w => w.expect === "reject" && w.answers.includes(h)));
  const r2EscapesMissing = r3Highs.filter(h => !W.some(w => w.expect === "reject" && w.r2?.kind === "escape" && w.r2.finding === h));
  return { missing, highsMissing, r2EscapesMissing };
}

/** r3.2 fail-first set: escapes (r3.1 must ACCEPT them) and over-strict accepts (r3.1 must REJECT them). */
export function r31Comparison(ws: readonly Witness[] = WITNESSES): { id: string; kind: "escape" | "overstrict"; finding: string; r31ShouldAccept: boolean }[] {
  return ws.filter(w => w.r31 !== undefined).map(w => ({ id: w.id, kind: w.r31!.kind, finding: w.r31!.finding, r31ShouldAccept: w.r31!.kind === "escape" }));
}

/** The fail-first set: escapes (r2 must ACCEPT them, r3 must reject) and over-strict accepts (r2 must REJECT them, r3 must accept). */
export function r2Comparison(ws: readonly Witness[] = WITNESSES): { id: string; kind: "escape" | "overstrict"; finding: string; r2ShouldAccept: boolean }[] {
  return ws.filter(w => w.r2 !== null).map(w => ({ id: w.id, kind: w.r2!.kind, finding: w.r2!.finding, r2ShouldAccept: w.r2!.kind === "escape" }));
}
