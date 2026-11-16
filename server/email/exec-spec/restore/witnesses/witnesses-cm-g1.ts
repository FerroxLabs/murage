// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g1 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
import type { World, CarryRecord, RemoteRequest, Action } from "../invariants.current.ts";
import { NOW, DAY, OWN, G1, G2, T_I1, clone, no, okO, keepA, closeBy, confirmStep, rcRow, rTok } from "./spec.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, keepA, closeBy, confirmStep];

export const WITNESSES_G1: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G1);
void rej; void acc;



// ---------- restoreJobMatchesReality (state invariant, single-state witnesses; each breaks exactly the one clause it is named after) ----------
const RJ = "restoreJobMatchesReality";
type RR = World["ghost"]["restores"][number];
const rr = (o: Partial<RR> = {}): RR => ({ atStep: 0, atMs: NOW, epochAfter: 1, source: "cloud_reset", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: "j1", ...o });
const jb = (w: World, ph: "armed" | "captured" | "swapped" | "prepared" | "aborted") => { w.fs.restoreJob = { id: "j1", archiveId: "A", source: "cloud_reset", phase: ph, at: 0 }; };
const jc = (o: Partial<CarryRecord> = {}) => carry({ jobId: "j1", ...o });
const st = (m: (w: World) => void) => run(from(m), [[tick]]);
// #2: a carry with no restore job at all.
rej(RJ, "cm-restoreJobMatchesReality-2-carry-without-job", ["r3.4d-cm"], st(w => { w.carry = jc(); }));
// #3: the journal itself says "swapped" (only the database mark may), everything else a valid swapped job.
rej(RJ, "cm-restoreJobMatchesReality-3-journal-holds-swapped", ["r3.4d-cm"], st(w => { jb(w, "swapped"); w.ghost.epoch = 1; w.ghost.restores.push(rr()); w.carry = jc(); }));
// #8: journal aborted while the database says swapped (blind swap, no carry).
rej(RJ, "cm-restoreJobMatchesReality-8-journal-aborted-db-swapped", ["r3.4d-cm"], st(w => { jb(w, "aborted"); w.local.swappedJobId = "j1"; w.ghost.epoch = 1; w.ghost.restores.push(rr({ blind: true, carryId: null })); }));
// #16: a pending prep (another job's record, unprepared epoch) while job j1 is only armed and owns no record.
rej(RJ, "cm-restoreJobMatchesReality-16-prep-pending-while-armed", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.ghost.epoch = 1; w.ghost.restores.push(rr({ jobId: "jOther" })); }));
// #17: armed job whose archive was installed (prepared epoch, so no pending prep).
rej(RJ, "cm-restoreJobMatchesReality-17-armed-but-installed", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.ghost.epoch = 1; w.ghost.restores.push(rr()); w.ghost.preparedEpochs.push(1); }));
// #18: captured job whose archive was installed.
rej(RJ, "cm-restoreJobMatchesReality-18-captured-but-installed", ["r3.4d-cm"], st(w => { jb(w, "captured"); w.carry = jc(); w.ghost.epoch = 1; w.ghost.restores.push(rr()); w.ghost.preparedEpochs.push(1); }));
// #19/#21: captured with no carry at all.
rej(RJ, "cm-restoreJobMatchesReality-21-captured-without-carry", ["r3.4d-cm"], st(w => { jb(w, "captured"); }));
// #20: captured with an incomplete carry.
rej(RJ, "cm-restoreJobMatchesReality-20-captured-incomplete-carry", ["r3.4d-cm"], st(w => { jb(w, "captured"); w.carry = jc({ complete: false }); }));
// #22/#24: swapped in the database with no restore record.
rej(RJ, "cm-restoreJobMatchesReality-24-swapped-without-record", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.local.swappedJobId = "j1"; }));
// #23: swapped, but the record is for an older epoch than the installed one (prep of epoch 2 pending).
rej(RJ, "cm-restoreJobMatchesReality-23-swapped-record-wrong-epoch", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.local.swappedJobId = "j1"; w.ghost.epoch = 2; w.ghost.restores.push(rr({ blind: true, carryId: null })); }));
// #28: swapped, not blind, carry lost.
rej(RJ, "cm-restoreJobMatchesReality-28-swapped-lost-carry", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.local.swappedJobId = "j1"; w.ghost.epoch = 1; w.ghost.restores.push(rr()); }));
// #31: swapped blind but still holding a carry.
rej(RJ, "cm-restoreJobMatchesReality-31-blind-swap-holds-carry", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.local.swappedJobId = "j1"; w.ghost.epoch = 1; w.ghost.restores.push(rr({ blind: true, carryId: null })); w.carry = jc(); }));
// #32: prepared in the database with no committed prep of its epoch.
rej(RJ, "cm-restoreJobMatchesReality-32-prepared-without-prep", ["r3.4d-cm"], st(w => { jb(w, "armed"); w.local.preparedJobId = "j1"; }));


// ---------- noRemoveDuringKeep / keyTargetEntriesNeverDropped ----------
// #11 (weaker): a DELETE under a Remove authority sent while a Keep op is open on the same inbox.
rej("noRemoveDuringKeep", "cm-noRemoveDuringKeep-11-delete-while-keep-open", ["r3.4d-cm"], run(from(w => {
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 0 };
  w.ghost.authorities.push(au({ verifiedAtStep: -3 })); w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); }),
  [[send(rq({ requestId: "d1", kind: "DELETE_INBOX", target: "i1", authorityId: "aR", removalId: "L1", attemptId: "at1" }))]]));

// ---------- environmentWellFormed ----------
const EW = "environmentWellFormed";
const wr = (id: string, w0: World, action: Action, m?: (w: World) => void) => rej(EW, `cm-environmentWellFormed-${id}`, ["r3.4d-cm"], run(w0, [[action, m]]));
const wa = (id: string, w0: World, action: Action, m?: (w: World) => void) => acc(EW, `cm-environmentWellFormed-${id}`, ["r3.4d-cm"], run(w0, [[action, m]]));
const ev = (o: Partial<World["flux"]["events"][number]> = {}) => ({ eventId: "e1", type: "email.inbox.closing" as const, inboxId: "i1", atMs: NOW, atStep: 1, deliveredToHome: false, reason: null, ...o });
const rrE = (o: Partial<World["ghost"]["restores"][number]> = {}) => ({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop" as const, archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: null, ...o });
const KS = { requestId: "g1", atStep: 0 };
wr("2-3-request-rewritten", from(w => { w.flux.requests.push(rq({ requestId: "r1", kind: "GET_INBOX", target: "i1" })); }), tick, w => { w.flux.requests[0].sentAtMs += 1; });
wr("8-authority-rewritten", from(w => { w.ghost.authorities.push(au()); }), tick, w => { w.ghost.authorities[0].epoch = 9; });
wr("9-token-rewritten", from(w => { w.ghost.tokens.push(tk()); }), tick, w => { w.ghost.tokens[0].issuedAtMs += 1; });
wr("10-restore-record-rewritten", from(w => { w.ghost.epoch = 1; w.ghost.restores.push(rrE()); }), tick, w => { w.ghost.restores[0].atMs += 1; });
wr("11-keep-record-rewritten", from(w => { w.ghost.keeps.push(kr()); }), tick, w => { w.ghost.keeps[0].botId = "b2"; });
wr("7-keep-confirmation-rewritten", from(w => { w.ghost.keeps.push(kr({ succeededAtStep: 1, succeededAtMs: NOW, confirmedBy: KS })); }), tick, w => { w.ghost.keeps[0].confirmedBy = { requestId: "g2", atStep: 0 }; });
wr("13-keep-step-without-time", base(), tick, w => { w.ghost.keeps.push(kr({ succeededAtStep: 1, succeededAtMs: null })); });
wr("14-used-keep-ops-rewritten", from(w => { w.ghost.usedKeepOps.push("kp1"); }), tick, w => { w.ghost.usedKeepOps[0] = "kp9"; });
wr("15-prepared-epochs-rewritten", from(w => { w.ghost.epoch = 1; w.ghost.preparedEpochs.push(1); }), tick, w => { w.ghost.preparedEpochs[0] = 2; });
wr("16-confirmed-epochs-rewritten", from(w => { w.ghost.epoch = 1; w.ghost.inventoryConfirmedEpochs.push(1); }), tick, w => { w.ghost.inventoryConfirmedEpochs[0] = 2; });
wr("17-prepared-resets-rewritten", from(w => { w.ghost.preparedResets.push("r1"); }), tick, w => { w.ghost.preparedResets[0] = "r2"; });
wr("22-prepared-epoch-by-tick", base(), tick, w => { w.ghost.preparedEpochs.push(0); });
wr("23-prep-records-other-epoch", base(), { t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(5); });
wr("25-confirm-not-ok", from(w => { Object.assign(w, blind(false)); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), { t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: no("refused") }, w => {
  w.ghost.authorities.push(au({ authorityId: "aC", kind: "confirm_inventory", tokenId: "tr", epoch: 1, botId: null, scope: { target: null, inboxId: null, keyIds: [] }, genAtVerify: null })); w.ghost.inventoryConfirmedEpochs.push(1); });
wr("26-confirm-without-authority", from(w => { Object.assign(w, blind(false)); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), { t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: okO }, w => { w.ghost.inventoryConfirmedEpochs.push(1); });
wr("28-confirm-invalid-authority", from(w => { Object.assign(w, blind(false)); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), { t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aC", kind: "confirm_inventory", tokenId: "tr", epoch: 1, botId: null, principal: "bot_credential", scope: { target: null, inboxId: null, keyIds: [] }, genAtVerify: null })); w.ghost.inventoryConfirmedEpochs.push(1); });
wr("30-confirm-other-epoch", from(w => { Object.assign(w, blind(false)); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), { t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aC", kind: "confirm_inventory", tokenId: "tr", epoch: 1, botId: null, scope: { target: null, inboxId: null, keyIds: [] }, genAtVerify: null })); w.ghost.inventoryConfirmedEpochs.push(2); });
wr("32-park-step-went-back", from(w => { w.ghost.lastParkOrRestoreStep.b1 = 3; }), tick, w => { w.ghost.lastParkOrRestoreStep.b1 = 2; });
wr("35-deleted-event-not-purged", base(), tick, w => { w.flux.events.push(ev({ type: "email.inbox.deleted" })); });
wr("36-epoch-went-back", from(w => { w.ghost.epoch = 1; }), tick, w => { w.ghost.epoch = 0; });
wr("37-owner-requests-rewritten", from(w => { w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A" }); }), tick, w => { w.ghost.ownerRestoreRequests[0].archiveId = "B"; });
wr("40-owner-request-by-tick", base(), tick, w => { w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "A" }); });
const swapD: Action = { t: "auto.swap", source: "desktop", archiveId: "A", blind: false };
const withReq = (o: Partial<{ atStep: number; source: "desktop" | "cloud_reset" | "cloud_undo"; archiveId: string }> = {}) => from(w => { w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A", ...o }); });
wr("41-record-names-request-outside-swap", withReq(), tick, w => { w.ghost.epoch = 1; w.ghost.restores.push(rrE({ atStep: w.step, ownerRequestStep: 0 })); });
wr("43-record-names-future-request", withReq({ atStep: 1 }), swapD, w => { w.ghost.epoch = 1; w.ghost.restores.push(rrE({ atStep: w.step, ownerRequestStep: 1 })); });
wr("44-record-source-differs", withReq(), swapD, w => { w.ghost.epoch = 1; w.ghost.restores.push(rrE({ atStep: w.step, ownerRequestStep: 0, source: "cloud_reset" })); });
wr("45-record-archive-differs", withReq(), swapD, w => { w.ghost.epoch = 1; w.ghost.restores.push(rrE({ atStep: w.step, ownerRequestStep: 0, archiveId: "B" })); });
wr("46-request-used-twice", from(w => { w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A" }); w.ghost.epoch = 1; w.ghost.restores.push(rrE({ ownerRequestStep: 0 })); }), swapD, w => { w.ghost.epoch = 2; w.ghost.restores.push(rrE({ atStep: w.step, ownerRequestStep: 0, epochAfter: 2 })); });
wr("53-generation-changed-same-serial", base(), tick, w => { w.local.bindings.b1.gen = { ...G1, emailKeyRef: "k2" }; });
wr("56-swap-changed-flux", base(), swapD, w => { w.flux.inboxes.i1.address = "other@mail.test"; });
const PURGE: Action = { t: "flux.purge", inboxId: "i1" };
const closingI1 = (since: number | null) => from(w => { Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "flux", reason: "billing" }, closingSinceMs: since, closingSinceStep: 0 }); });
wr("57-purge-unknown-inbox", base(), { t: "flux.purge", inboxId: "i9" });
wr("58-purge-active-inbox", from(w => { w.flux.inboxes.i1.closingSinceMs = NOW - 31 * DAY; }), PURGE);
wr("59-purge-closing-no-time", closingI1(null), PURGE);
wr("60-purge-too-early", closingI1(NOW), PURGE);
const dd = (rid: string, o: Partial<RemoteRequest> = {}) => rq({ requestId: rid, kind: "DELETE_INBOX", target: "i1", removalId: "L1", attemptId: "a" + rid, authorityId: "aR", ...o });
const closedBy = (since = NOW) => ({ state: "closing" as const, closingCause: { kind: "delete" as const, requestId: "d1", reason: "owner" as const }, closingSinceMs: since, closingSinceStep: 0 });
const applied = (rid: string, o: Partial<RemoteRequest> = {}) => dd(rid, { flux: "applied", appliedAtMs: NOW, ...o });
const dupWorld = (honoured: boolean, copy: boolean) => from(w => { w.flux.semantics.deleteIdempotencyKeyHonoured = honoured; Object.assign(w.flux.inboxes.i1, closedBy()); w.flux.requests.push(applied("d1"), dd(copy ? "d1c" : "d2", copy ? { copyOf: "d1", attemptId: "ad1" } : {})); });
const markApplied = (rid: string): ((w: World) => void) => w => { const r = w.flux.requests.find(x => x.requestId === rid)!; r.flux = "applied"; r.appliedAtMs = w.nowMs; };
wr("71-duplicate-changed-inbox", dupWorld(true, true), apply("d1c"), w => { markApplied("d1c")(w); w.flux.inboxes.i1.address = "other@mail.test"; });
wr("72-duplicate-emitted-closing-event", dupWorld(true, true), apply("d1c"), w => { markApplied("d1c")(w); w.flux.events.push(ev()); });
wr("76-delete-on-active-did-not-close", from(w => { w.flux.requests.push(dd("d1")); }), apply("d1"), markApplied("d1"));
wa("74-delete-on-purged-inbox", from(w => { w.flux.inboxes.i1.state = "purged"; w.flux.requests.push(dd("d1")); }), apply("d1"), markApplied("d1"));
wa("52-generation-new-serial", base(), tick, w => { w.local.bindings.b1.gen = clone(G2); });
wa("49-prep-replaces-binding-generation", base(), { t: "auto.restorePrepare", outcome: "committed" }, w => { w.local.bindings.b1.gen = { ...G1, emailKeyRef: "k2" }; w.ghost.preparedEpochs.push(w.ghost.epoch); });
wr("59-purge-closing-no-time-late-clock", from(w => { w.nowMs = 40 * DAY; Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "flux", reason: "billing" }, closingSinceMs: null, closingSinceStep: 0 }); }), PURGE);
// ---------- builder 2 continuation: witnesses for the combined-gate rejects and untried clauses ----------
import { keepHist, tokB, botKeepRow, parkOnlyKey, swapA, sysSwap, sysJob } from "./spec.ts";
const dd2 = (rid: string, o: Partial<RemoteRequest> = {}) => rq({ requestId: rid, kind: "DELETE_INBOX", target: "i1", removalId: "L1", attemptId: "a" + rid, authorityId: "aR", ...o });
const ap2 = (rid: string, o: Partial<RemoteRequest> = {}) => dd2(rid, { flux: "applied", appliedAtMs: NOW, ...o });
const mk2 = (rid: string): ((w: World) => void) => w => { const r = w.flux.requests.find(x => x.requestId === rid)!; r.flux = "applied"; r.appliedAtMs = w.nowMs; };
const dupW2 = from(w => { Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "delete", requestId: "d1", reason: "owner" }, closingSinceMs: NOW, closingSinceStep: 0 }); w.flux.requests.push(ap2("d1"), dd2("d1c", { copyOf: "d1", attemptId: "ad1" })); w.surface = [botKeepRow()]; });
wr("66-reapply-applied-no-close", from(w => { w.flux.requests.push(ap2("d1")); }), apply("d1"), mk2("d1"));
wr("67-unrelated-applied-no-close", from(w => { w.flux.requests.push(ap2("d0"), dd2("d2", { attemptId: "ad2" })); }), apply("d2"), mk2("d2"));
wr("68-copy-of-unapplied-no-close", from(w => { w.flux.requests.push(dd2("d1"), dd2("d1c", { copyOf: "d1", attemptId: "ad1" })); }), apply("d1c"), mk2("d1c"));
wa("78-delete-on-flux-closing-untouched", from(w => { Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "flux", reason: "billing" }, closingSinceMs: NOW, closingSinceStep: 0 }); w.flux.requests.push(dd2("d1")); w.surface = [botKeepRow()]; }), apply("d1"), mk2("d1"));
wa("64-duplicate-restored-event", dupW2, apply("d1c"), w => { mk2("d1c")(w); w.flux.events.push(ev({ type: "email.inbox.restored", eventId: "e9" })); });
wa("65-duplicate-other-inbox-closing-event", dupW2, apply("d1c"), w => { mk2("d1c")(w); w.flux.events.push(ev({ inboxId: "i2", eventId: "e9" })); });
wa("48-swap-binding-older-generation", from(w => { w.local.bindings.b1.gen = clone(G2); w.carry = carry({ keyIds: ["k1", "k2"] }); sysJob(w, "A", "cloud_reset", "captured"); }), swapA, w => { sysSwap(w); w.local.bindings.b1.gen = clone(G1); });
acc("keyTargetEntriesNeverDropped", "cm-keyTargetEntriesNeverDropped-1-swap-drops-live-target", ["r3.4d-cm"], run((() => { const w = parkOnlyKey(); w.carry = carry({ removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] }); sysJob(w, "A", "cloud_reset", "captured"); return w; })(), [[swapA, w => { sysSwap(w); w.local.parks = {}; w.surface = []; }]]));

const NRK = "noRemoveDuringKeep";
const openKeep = (w: World) => { keepHist(w, { claimedAtStep: 0 }, 0); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 0 }; w.ghost.usedKeepOps.push("kp1"); };
acc(NRK, "cm-noRemoveDuringKeep-8-rotation-revoke-under-open-keep", ["r3.4d-cm"], run(from(w => { tokB(w); openKeep(w); w.local.bindings.b1.gen = clone(G2); w.local.savedKeys.b1 = "k2";
  w.flux.keys.k2 = { keyId: "k2", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "live" }; w.local.rotations.r1 = { botId: "b1", opId: "op1", oldKeyId: "k1", newKeyId: "k2", authorityId: "aRot" };
  w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: 0 })); }), [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", authorityId: "aRot", purpose: "rotation", answer: "pending" }))]]));
acc(NRK, "cm-noRemoveDuringKeep-6-keep-get-under-remove-authority", ["r3.4d-cm"], run(from(w => { tokB(w); openKeep(w); w.ghost.authorities.push(au({ authorityId: "aR", verifiedAtStep: -1 })); }),
  [[send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", authorityId: "aR" }))]]));
acc(NRK, "cm-noRemoveDuringKeep-1-reconnect-authority-while-keep-open", ["r3.4d-cm"], run(from(w => { w.step = 2; w.ghost.tokens.push(tk({ issuedAtStep: 1 })); openKeep(w); }), [[{ t: "owner.reconnect", principal: OWN, botId: "b1", tokenId: "tB", outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: w.step })); }]]));
// #3 (stricter): a target whose status is kept / skipped_in_use is not owed a revoke, so dropping it while the key is live at Flux is legal.
const dropTarget = (status: "kept" | "skipped_in_use") => run((() => { const w = parkOnlyKey(); w.local.parks.pk1.keyTargets = [{ keyId: "k1", status }]; return w; })(), [[tick, w => { w.local.parks.pk1.keyTargets = []; }]]);
acc("keyTargetEntriesNeverDropped", "cm-keyTargetEntriesNeverDropped-3-kept-target-dropped", ["r3.4d-cm"], dropTarget("kept"));

export const PIN = 66;
