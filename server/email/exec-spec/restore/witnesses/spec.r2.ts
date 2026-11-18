// @ts-nocheck (r2 reference copy for the r2 comparison; its known tsc defect is fixed in r3)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READ-ONLY COPY of designs/exec-spec/restore/witnesses.ts (revision 2, 96 witnesses); only the import path differs. Mismatches go back to the spec author.
/**
 * RESTORE-PARK executable spec, part 1b: WITNESSES (MurageMain rule, binding). Written 2026-11-10 (UTC), revision 2.
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
} from "../invariants.r2.ts";
import { STATE_INVARIANTS, STEP_INVARIANTS, TRACE_INVARIANTS, verdictOf, GUARD_POLL_WINDOW_MS, CHECKER } from "../invariants.r2.ts";

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
    ghost: { epoch: 0, tokens: [], authorities: [], keeps: [], restores: [], usedKeepOps: [], preparedEpochs: [], inventoryConfirmedEpochs: [], preparedResets: [], lastBootAtMs: 0, lastParkOrRestoreStep: {} },
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
  carryId: "c1", capturedAtStep: 0, forEpoch: 0, complete: true, keyIds: ["k1"], inboxIds: ["i1"], provisionOps: ["op1"], keepGuards: [], keptKeys: {}, outstandingDeletes: [], ...o,
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

/** A successful Keep at step 0 on i1, with DELETE d1 (attempt at1) held at Flux from before, and its guard. */
function kept(unresolved: AttemptId[] | "unknown" = ["at1"]): World {
  return from(w => {
    w.ghost.authorities.push(au({ verifiedAtStep: -3 }));
    w.ghost.keeps.push(kr({ claimedAtStep: -2, succeededAtStep: 0, succeededAtMs: NOW, confirmedBy: { requestId: "g1", atStep: -1 } }));
    w.flux.requests.push(d("d1", "at1"));
    w.local.keepGuards.i1 = gd({ unresolved });
  });
}

// ===================================================================================================================================
// Witnesses
// ===================================================================================================================================

export interface Witness { id: string; invariant: string; expect: "reject" | "accept"; answers: string[]; settled: boolean; trace: TraceStep[] }
const W: Witness[] = [];
const rej = (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false) => W.push({ id, invariant, expect: "reject", answers, settled, trace });
const acc = (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false) => W.push({ id, invariant, expect: "accept", answers, settled, trace });

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
  [clk(120_000)],
]));
rej("keepEndsActive", "late-delete-never-restored", ["A3-H1", "A4-H6"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(120_000)]]));
acc("keepEndsActive", "flux-billing-close-ends-obligation", ["A4-H5", "F4-M1"], run(kept(), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")], [clk(3600_000)], [tick]]), true);
acc("keepEndsActive", "delete-at-31d-restored-by-event", ["A4-H6"], run(kept(), [[clk(31 * DAY)], [apply("d1"), closeBy("d1")], [clk(30_000), reopen]]), true);
acc("keepEndsActive", "blind-restore-ends-window", ["F4-H1"], run(kept(), [
  [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 1, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null }); }],
  [apply("d1"), closeBy("d1")], [clk(3600_000)],
]), true);

// ---------- (a) keepSuccessIsConfirmed ------------------------------------------------------------------------------------------------

const confirmStart = (restoreAnswered: boolean) => from(w => {
  w.step = 4;
  w.ghost.keeps.push(kr({ claimedAtStep: 0 }));
  w.flux.requests.push(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 1, flux: "applied",
    answer: restoreAnswered ? "delivered" : "pending", answerSeen: restoreAnswered ? { atStep: 2, result: "ok", fluxStateSeen: "active" } : null }));
  w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 3, flux: "applied", answer: "delivered", answerSeen: { atStep: 4, result: "ok", fluxStateSeen: "active" } }));
});
const succeed = (rid: string, at: number): Mut => w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs, confirmedBy: { requestId: rid, atStep: at } }); };
rej("keepSuccessIsConfirmed", "get-before-restore-answered", ["A4-H4"], run(confirmStart(false), [[tick, succeed("g1", 4)]]));
rej("keepSuccessIsConfirmed", "confirmed-by-non-get", ["A4-H4", "F4-L1"], run(confirmStart(true), [[tick, succeed("r1", 2)]]));
acc("keepSuccessIsConfirmed", "real-get-after-restore", [], run(confirmStart(true), [[tick, succeed("g1", 4)]]));

// ---------- (a) guardArmedForEveryKeep ------------------------------------------------------------------------------------------------

const claimed = () => from(w => { w.ghost.keeps.push(kr({ claimedAtStep: 0 })); });
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
  from(w => { w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: 0 })); }),
  [[send(d("d1", "at1", { authorityId: "aRot", answer: "pending" }))]]));
rej("ownerAuthorityForEveryDestructiveSend", "delete-after-later-keep", ["A3-H1", "Keep-always-wins"], run(
  from(w => { w.step = 2; w.ghost.authorities.push(au({ verifiedAtStep: 1 })); w.ghost.keeps.push(kr({ claimedAtStep: 2 })); }),
  [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("ownerAuthorityForEveryDestructiveSend", "delete-under-owner-remove", [], run(from(w => { w.ghost.authorities.push(au({ verifiedAtStep: 0 })); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) removalSendNeedsSendingLease --------------------------------------------------------------------------------------------

rej("removalSendNeedsSendingLease", "delete-without-send-claim", ["F4-M4"], run(from(w => { w.local.leases.L1 = ls(); }), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("removalSendNeedsSendingLease", "delete-under-sending-lease", [], run(from(w => { w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) noDestructiveSendAfterBlindRestore --------------------------------------------------------------------------------------

const blind = (confirmed: boolean) => from(w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null }); if (confirmed) w.ghost.inventoryConfirmedEpochs.push(1); });
rej("noDestructiveSendAfterBlindRestore", "delete-after-blind-restore", ["Q2-ruling", "F4-M5"], run(blind(false), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("noDestructiveSendAfterBlindRestore", "delete-after-owner-confirms", ["Q2-ruling"], run(blind(true), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) keptKeysProtected -------------------------------------------------------------------------------------------------------

const keptKey = (removeAt: number) => from(w => {
  w.step = 4; w.local.keptKeys.k9 = "aK9";
  w.ghost.authorities.push(au({ authorityId: "aK9", kind: "keep", verifiedAtStep: 1, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } }));
  w.ghost.authorities.push(au({ authorityId: "aRk", kind: "remove_key_only", verifiedAtStep: removeAt, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } }));
});
const revokeK9 = send(rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aRk" }));
rej("keptKeysProtected", "kept-key-revoked-by-older-remove", ["A4-H3"], run(keptKey(0), [[revokeK9]]));
rej("keptKeysProtected", "key-marked-kept-without-keep", ["F4-L4"], run(base(), [[tick, w => { w.ghost.authorities.push(au()); w.local.keptKeys.k1 = "aR"; }]]));
acc("keptKeysProtected", "kept-key-revoked-by-later-remove", [], run(keptKey(3), [[revokeK9]]));

// ---------- (c) nothingAutomaticUnparks -------------------------------------------------------------------------------------------------

const parked = () => from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; });
rej("nothingAutomaticUnparks", "tick-resumes-parked-removal", ["standing-order"], run(parked(), [[tick, w => { w.local.leases.L1 = ls(); }]]));
acc("nothingAutomaticUnparks", "tick-leaves-park", [], run(parked(), [[tick]]));
acc("nothingAutomaticUnparks", "evidence-moves-pk-to-pkE", [], run(parked(), [[{ t: "auto.applyEvent", eventId: "e1" }, w => { w.local.parks.pk1.state = "parked_evidence"; }]]));

// ---------- (c) keptStaysKept ------------------------------------------------------------------------------------------------------------

const keptRecord = () => from(w => { w.ghost.keeps.push(kr({ succeededAtStep: 0, succeededAtMs: NOW })); });
rej("keptStaysKept", "boot-reparks-kept-address", ["A3-M14"], run(keptRecord(), [[{ t: "auto.boot" }, w => { w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy" }); }]]));
acc("keptStaysKept", "boot-leaves-kept-address", [], run(keptRecord(), [[{ t: "auto.boot" }]]));

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
acc("everyOrphanHasExecutableAction", "unknown-provisioning-op-row", ["A4-H8", "D1-reversed"], run(botGone(w => {
  w.local.bindings.b1 = { botId: "b1", state: "provisioning", step: "inbox", gen: { inboxId: null, opId: "op1", emailKeyRef: "k1", serial: 1 }, address: null };
  w.surface = [row({ section: "key_only", target: T_OP1, inboxId: null, provisionOpId: "op1", actions: [{ kind: "keep", tokenId: "tp", enabled: true }, { kind: "remove", tokenId: "tp", enabled: true }] })];
}), [[tick]]));
acc("everyOrphanHasExecutableAction", "owner-removed-inbox-not-orphan", ["F4-M3"], run(botGone(w => {
  w.local.bindings = {}; w.local.savedKeys = {}; w.flux.keys.k1.state = "revoked";
  w.ghost.authorities.push(au({ verifiedAtStep: 0 }));
  w.flux.requests.push(d("d1", "at1", { flux: "applied", answer: "delivered" }));
  Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "delete", requestId: "d1", reason: "owner" }, closingSinceMs: NOW, closingSinceStep: 0 });
}), [[tick]]));

// ---------- (d) viewMintsScopedTokens ---------------------------------------------------------------------------------------------------

const view = (shownTarget: string): StepSpec => [{ t: "owner.viewSurface", principal: OWN }, w => {
  w.surface = [row({ section: "bot", actions: [{ kind: "remove", tokenId: "tB", enabled: true }] })];
  w.ghost.tokens.push(tk({ issuedAtStep: 1, shown: { target: shownTarget, address: ADDR, inboxId: "i1", keyIds: ["k1"] } }));
}];
rej("viewMintsScopedTokens", "token-shows-another-target", ["A4-H8", "A4-H9"], run(base(), [view("inbox:i2")]));
acc("viewMintsScopedTokens", "token-scoped-to-row", [], run(base(), [view(T_I1)]));

// ---------- (d) keyOnlyActionsTouchNoInbox ----------------------------------------------------------------------------------------------

const keyOnlyKeep = () => from(w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_OP1, inboxId: null, mode: "key_only", authorityId: "aK", claimedAtStep: 0 }; });
rej("keyOnlyActionsTouchNoInbox", "key-only-keep-sends-get", ["F3-M3"], run(keyOnlyKeep(), [[send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1" }))]]));
acc("keyOnlyActionsTouchNoInbox", "key-only-remove-revokes", [], run(from(w => { w.ghost.authorities.push(au({ kind: "remove_key_only", scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } })); }),
  [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", authorityId: "aR" }))]]));

// ---------- (d) blindRestoreIsOwnerVisible ------------------------------------------------------------------------------------------

rej("blindRestoreIsOwnerVisible", "blind-restore-silent", ["F4-H1", "point-1"], run(blind(false), [[tick]]));
acc("blindRestoreIsOwnerVisible", "blind-restore-check-row", ["point-1"], run(blind(false), [[tick, w => {
  w.surface = [row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }] })]; }]]));

// ---------- (e) keepAndRemoveSerialized -------------------------------------------------------------------------------------------------

rej("keepAndRemoveSerialized", "key-only-keep-with-active-removal", ["A4-H3"], run(keyOnlyKeep(), [[tick, w => { w.local.leases.L1 = ls({ target: T_OP1, inboxId: null }); }]]));
acc("keepAndRemoveSerialized", "keep-alone", [], run(keyOnlyKeep(), [[tick]]));

// ---------- (e) noRemoveDuringKeep ------------------------------------------------------------------------------------------------------

const keyOnlyRemove: StepSpec = [removeA("tp", { target: T_OP1, section: "key_only" }), w => { w.ghost.authorities.push(au({ kind: "remove_key_only", tokenId: "tp", scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } })); }];
rej("noRemoveDuringKeep", "remove-authorized-during-key-only-keep", ["A4-H3"], run(keyOnlyKeep(), [keyOnlyRemove]));
acc("noRemoveDuringKeep", "remove-with-no-keep", [], run(base(), [keyOnlyRemove]));

// ---------- (e) keepNetworkNeedsClaim ---------------------------------------------------------------------------------------------------

rej("keepNetworkNeedsClaim", "flux-closing-keep-unclaimed", ["A3-H2"], run(base(), [[send(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep" }))]]));
acc("keepNetworkNeedsClaim", "claimed-keep-restore", [], run(from(w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "flux_closing", authorityId: "aK", claimedAtStep: 0 }; }),
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
acc("everyReplacementPreparedBeforeStore", "store-open-after-prep", [], run(replaced(true), [[tick]]));

// ---------- (h) quiescenceReachable ------------------------------------------------------------------------------------------------------

const ticks = (n: number): StepSpec[] => Array.from({ length: n }, () => [tick] as StepSpec);
rej("quiescenceReachable", "remove-never-progresses", ["A4-H9", "A4-M13"], run(base(), [[removeA("tB"), w => { w.local.leases.L1 = ls(); }], ...ticks(CHECKER.livenessBound)]));
acc("quiescenceReachable", "keep-completes", [], run(base(), [
  [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 1 }; }],
  [tick, w => { w.local.keepOps = {}; w.local.keepGuards.i1 = gd({ unresolved: [] }); }], ...ticks(CHECKER.livenessBound - 1)]));
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

/** Invariants lacking a must-reject or a must-accept witness, and Highs lacking a witness. Must both be empty. */
export function witnessCoverage(): { missing: string[]; highsMissing: string[] } {
  const names = [...Object.keys(STEP_INVARIANTS), ...Object.keys(STATE_INVARIANTS), ...Object.keys(TRACE_INVARIANTS)];
  const missing: string[] = [];
  for (const n of names) for (const e of ["reject", "accept"] as const) if (!W.some(w => w.invariant === n && w.expect === e)) missing.push(`${n}:${e}`);
  const highs = ["A4-H1", "A4-H2", "A4-H3", "A4-H4", "A4-H5", "A4-H6", "A4-H7", "A4-H8", "A4-H9", "A4-H10", "F4-H1", "F4-H2", "F4-H3", "F4-H4"];
  const highsMissing = highs.filter(h => !W.some(w => w.expect === "reject" && w.answers.includes(h)));
  return { missing, highsMissing };
}
