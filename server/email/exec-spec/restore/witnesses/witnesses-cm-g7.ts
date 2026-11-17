// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g7 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import type { World } from "../invariants.current.ts";
import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
import { pendingRow, confirmStart, succeed, keyOnlyKeep, claimKeepNow, keepA, removeA, okO, T_I1, T_OP1, NOW, OWN, d, tokB, remHist, keepHist, deleteB1, twoBots, parked, parkedTok } from "./spec.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, removeA, okO, T_OP1, NOW, OWN, d, tokB, remHist, keepHist, deleteB1, twoBots, parked, parkedTok];
import { CHECKER } from "../invariants.current.ts";
import type { RemoteRequest } from "../invariants.current.ts";
import { ADDR, keepThenDelete, deleteB1Work, parkTok, ticks, withToken, admitKeep, markedK9, removeK9, markedK9InUse, restoreLive, staleKeep, lookAgain, g1 } from "./spec.ts";
type StepSpec = Parameters<typeof run>[1][number];

export const WITNESSES_G7: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G7);
void rej; void acc;

// ---------- r3.4d clause mutants (CLAUSE-MUTANTS-r34d.md): one witness per SURVIVED clause, named after the clause id ----------------
// guardArmedForEveryKeep: the confirmed keep succeeds at the tick (succeed() writes a well-formed guard); each witness then breaks one guard field.
const gkStep = (m: (w: World) => void): StepSpec[] => [[tick, w => { succeed("g1", 4)(w); m(w); }]];
rej("guardArmedForEveryKeep", "cm-guardArmedForEveryKeep-5-guard-names-other-keep-op", ["r3.4d-cm"], run(confirmStart(true), gkStep(w => { w.local.keepGuards.i1.keepOp = "kpX"; })));
rej("guardArmedForEveryKeep", "cm-guardArmedForEveryKeep-7-guard-window-short", ["r3.4d-cm"], run(confirmStart(true), gkStep(w => { w.local.keepGuards.i1.pollUntilMs -= 1000; })));
rej("guardArmedForEveryKeep", "cm-guardArmedForEveryKeep-8-guard-kept-at-wrong-time", ["r3.4d-cm"], run(confirmStart(true), gkStep(w => { w.local.keepGuards.i1.keptAtMs -= 1000; w.local.keepGuards.i1.pollUntilMs -= 1000; })));
rej("guardArmedForEveryKeep", "cm-guardArmedForEveryKeep-12-restore-park-guard-not-unknown", ["r3.4d-cm"], run(from(w => { Object.assign(w, confirmStart(true)); w.local.parks.pk1 = pk(); }), gkStep(() => {})));
// #3 (stricter): a key-only Keep has no inbox, so it commits without a guard.
acc("guardArmedForEveryKeep", "cm-guardArmedForEveryKeep-3-key-only-keep-no-guard", ["r3.4d-cm"], run(keyOnlyKeep(), [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: w.step } }); w.local.keepOps = {}; }]]));
// keepOpsFreshAndCasChecked
acc("keepOpsFreshAndCasChecked", "cm-keepOpsFreshAndCasChecked-6-stale-answer-changes-nothing", ["r3.4d-cm"], run(from(w => { w.flux.requests.push(rq({ requestId: "g0", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp0" })); }),
  [[{ t: "net.answer", requestId: "g0", result: "ok", fluxStateSeen: "active" }, w => { const g = w.flux.requests[0]; g.answer = "delivered"; g.answerSeen = { atStep: w.step, result: "ok", fluxStateSeen: "active" }; }]]));
acc("keepOpsFreshAndCasChecked", "cm-keepOpsFreshAndCasChecked-5-open-keep-answer-moves-state", ["r3.4d-cm"], run(from(w => { claimKeepNow(w); w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, verifiedAtStep: 0, scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] } }));
  w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", flux: "applied" })); }),
  [[{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { const g = w.flux.requests[0]; g.answer = "delivered"; g.answerSeen = { atStep: w.step, result: "ok", fluxStateSeen: "active" }; w.local.leases.LX = ls({ removalId: "LX", phase: "keeping" }); }]]));
// markerNeverArchivedAndConsumedAtBoot
const MK = (): World => from(w => { w.fs.liveMarker = { resetId: "r1" }; w.proc.phase = "boot_prep"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; });
rej("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-2-archive-top-level-marker", ["r3.4d-cm"], run(base(), [[{ t: "owner.backup", kind: "cloud_restic" }, w => { w.archives.push({ archiveId: "s1", kind: "cloud_restic", topLevelNames: ["restore-pending.json", "home/messages.db"] }); }]]));
rej("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-6-store-open-with-marker", ["r3.4d-cm"], run(MK(), [[clk(1000), w => { w.proc.phase = "running"; }]]));
rej("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-11-unlinked-before-prep", ["r3.4d-cm"], run(MK(), [[clk(1000), w => { w.fs.liveMarker = null; }]]));
rej("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-15-boot-prep-leaves-marker", ["r3.4d-cm"], run(MK(), [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(w.ghost.epoch); }]]));
acc("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-4-marker-kept-while-booting", ["r3.4d-cm"], run(MK(), [[clk(1000)]]));
acc("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-9-marker-unlinked-no-db", ["r3.4d-cm"], run(from(w => { MK(); w.fs.liveMarker = { resetId: "r1" }; w.fs.messagesDbPresent = false; w.proc.phase = "boot_prep"; w.proc.processId = 2; }), [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.fs.liveMarker = null; }]]));
acc("markerNeverArchivedAndConsumedAtBoot", "cm-markerNeverArchivedAndConsumedAtBoot-10-marker-unlinked-after-prep", ["r3.4d-cm"], run(MK(), [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.fs.liveMarker = null; w.ghost.preparedResets.push("r1"); w.ghost.preparedEpochs.push(w.ghost.epoch); w.proc.phase = "running"; }]]));
// deletedBotAuthorityDead: twoBots() + deleteB1 (b1 deleted at step 1, b1's authority aR and lease L1 predate it; b2's aR2 / L2 are live).
const afterDel = (): World => twoBots();
const dBy = (o: Parameters<typeof d>[2]) => d("d9", "at1", { answer: "pending", sentAtStep: 2, ...o });
// #19: the request's own authority is the dead one, no lease or keep op on it.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-19-dead-authority-bare-request", ["r3.4d-cm"], run(afterDel(), [deleteB1, [send(dBy({ removalId: null, attemptId: null, authorityId: "aR" })), w => { w.flux.requests.push(dBy({ removalId: null, attemptId: null, authorityId: "aR" })); }]]));
// #24: the request is sent under a live authority but names the lease of the deleted bot (its authority is dead).
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-24-lease-of-deleted-bot", ["r3.4d-cm"], run(afterDel(), [deleteB1, [send(dBy({ removalId: "L1", authorityId: "aR2" })), w => { w.flux.requests.push(dBy({ removalId: "L1", authorityId: "aR2" })); }]]));
// #27: the request is sent under a live authority but names a Keep op whose authority is dead.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-27-keep-op-of-deleted-bot", ["r3.4d-cm"], run(from(w => { Object.assign(w, twoBots()); w.ghost.keeps.push(kr({ keepOp: "kpD", authorityId: "aR" })); }), [deleteB1, [send(rq({ requestId: "g9", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kpD", authorityId: "aR2" })), w => { w.flux.requests.push(rq({ requestId: "g9", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kpD", authorityId: "aR2" })); }]]));
// #31: after the delete, the deleted bot's lease claims a NEW send attempt (no request in this step).
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-31-lease-claims-new-send", ["r3.4d-cm"], run(afterDel(), [deleteB1, [tick, w => { Object.assign(w.local.leases.L1, { phase: "sending", attemptId: "at9", attempts: ["at1", "at9"] }); }]]));
// #4: the recorded deletion step is rewritten later.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-4-deletion-step-rewritten", ["r3.4d-cm"], run(afterDel(), [deleteB1, [tick, w => { w.ghost.botDeletedAtStep.b1 = 5; }]]));
// #5: a REFUSED owner.deleteBot still records the deletion.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-5-refused-delete-records", ["r3.4d-cm"], run(afterDel(), [[{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: { ok: false, code: "confirm_expired" } }, w => { w.ghost.botDeletedAtStep.b1 = w.step; }]]));
// #7: an ok delete naming b1 records b2 as deleted too.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-7-delete-records-unnamed-bot", ["r3.4d-cm"], run(afterDel(), [[deleteB1[0], w => { deleteB1[1]!(w); w.ghost.botDeletedAtStep.b2 = w.step; }]]));
// #8: an ok delete records a deletion step that is not its own step.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-8-delete-recorded-wrong-step", ["r3.4d-cm"], run(afterDel(), [[deleteB1[0], w => { deleteB1[1]!(w); w.ghost.botDeletedAtStep.b1 = w.step + 3; }]]));
// #14: an ok delete records nothing.
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-14-ok-delete-not-recorded", ["r3.4d-cm"], run(afterDel(), [[deleteB1[0], w => { w.bots.b1.present = false; }]]));
// #10 / #3 (callback, accept direction): a refused delete records nothing and changes nothing.
acc("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-10-refused-delete-no-record", ["r3.4d-cm"], run(from(w => { w.ghost.tokens.push(tk({ tokenId: "tD" })); }), [[{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: { ok: false, code: "confirm_expired" } }]]));
// ---- batch 2 (fresh builder): deletedBotAuthorityDead remaining ----
const nonOwnerDel = (principal: "system" | "bot_credential"): StepSpec => [{ t: "owner.deleteBot", principal, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO } as never, w => { deleteB1[1]!(w); }];
// #2: a non-owner principal's "ok" delete still records the deletion (must-reject: only an owner's ok delete may record).
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-2-non-owner-ok-delete-records", ["r3.4d-cm"], run(afterDel(), [nonOwnerDel("system")]));
// #13: a second ok delete of an already-deleted bot records nothing new (accept).
const delFull: StepSpec = [deleteB1[0], w => { deleteB1[1]!(w); delete w.local.leases.L1; w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD" }); w.surface = [pendingRow()]; }];
const del2: StepSpec = [{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD2" }, outcome: okO }, w => { w.ghost.authorities.push(au({ authorityId: "aD2", kind: "bot_delete_with_token", tokenId: "tD2", verifiedAtStep: w.step })); w.local.leases.LD.authorityId = "aD2"; }];
// #22: the lease names a LIVE bot (b2) but its authority belongs to deleted b1; the request's own authority is live (accept).
acc("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-22-lease-live-bot-dead-authority", ["r3.4d-cm"], run(from(w => { Object.assign(w, afterDel()); w.local.leases.L2.authorityId = "aR"; }), [delFull, [send(dBy({ target: "i2", removalId: "L2", attemptId: "at2", authorityId: "aR2" })), w => { w.flux.requests.push(dBy({ target: "i2", removalId: "L2", attemptId: "at2", authorityId: "aR2" })); }]]));
// #28 / #29: the deleted bot's lease is not (newly) sending; it sits with its dead authority.
// #34: an authority for deleted b1 created on a token minted AFTER the delete (accept: only older tokens are dead).
// #35: an authority of the delete's kind created with b1's token at a LATER step than the delete (reject).
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-35-delete-authority-later-step", ["r3.4d-cm"], run(afterDel(), [deleteB1, [tick, w => { w.ghost.authorities.push(au({ authorityId: "aD3", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: w.step })); }]]));
// #36: a different-kind authority created in the delete step with b1's token (reject).
rej("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-36-other-kind-at-delete-step", ["r3.4d-cm"], run(afterDel(), [[deleteB1[0], w => { deleteB1[1]!(w); w.ghost.authorities.push(au({ authorityId: "aX", kind: "remove_bot_section", tokenId: "tD", verifiedAtStep: 1 })); }]]));
// ---- batch 3 (fresh builder): quiescenceReachable ----
// q-shape: the home idles with `ticks` after one owner op; quiescentModuloWaiting (line 1018) already rejects open keep ops, non-acked leases and non-parked parks,
// so the owner-op loop (line 2409-) only ever sees a home that is otherwise quiet.
const Q = ticks(CHECKER.livenessBound);
// #1 (accept): an armed job idles bound-1 steps, a fault, one more step: the fault restarts the suffix, so the job is not yet overdue.
acc("quiescenceReachable", "cm-quiescenceReachable-1-fault-restarts-suffix", ["r3.4d-cm"], run(base(), [restoreLive, ...ticks(CHECKER.livenessBound - 1), [{ t: "fault.reorder", first: "xa", second: "xb" }], [tick]]));
// Remove shapes. rmAdmit: an admitted Remove on i1 whose authority aR is created in its own step (no lease: the work is dropped).
const rmAdmit = (m: (w: World) => void = () => {}): StepSpec => [removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: w.step })); m(w); }];
// #52: an admitted Remove that left no Remove authority at all.
rej("quiescenceReachable", "cm-quiescenceReachable-52-remove-left-no-authority", ["r3.4d-cm"], run(withToken(), [[removeA("tB")], ...Q]));
// #21: the Remove's work is dropped, i1 still active.
rej("quiescenceReachable", "cm-quiescenceReachable-21-remove-dropped-inbox-active", ["r3.4d-cm"], run(withToken(), [rmAdmit(), ...Q]));
// #18: an OLDER Keep on the same target does not end the Remove (only a LATER Keep does).
rej("quiescenceReachable", "cm-quiescenceReachable-18-older-keep-not-later", ["r3.4d-cm"], run(withToken(), [rmAdmit(w => { w.ghost.keeps.push(kr({ claimedAtStep: 0 })); }), ...Q]));
// #17: a LATER Keep on a DIFFERENT target does not end the Remove.
rej("quiescenceReachable", "cm-quiescenceReachable-17-later-keep-other-target", ["r3.4d-cm"], run(withToken(), [rmAdmit(), [tick, w => { w.ghost.keeps.push(kr({ keepOp: "kpZ", target: "inbox:i2", inboxId: "i2", claimedAtStep: 9 })); }], ...Q]));
// #50: only a Remove-KIND authority is the Remove's work (a keep-kind authority on the target is not).
rej("quiescenceReachable", "cm-quiescenceReachable-50-keep-kind-is-not-remove", ["r3.4d-cm"], run(withToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au({ authorityId: "aKx", kind: "keep", verifiedAtStep: w.step, scope: { target: T_I1, inboxId: null, keyIds: [] } })); }], ...Q]));
// #51: the Remove's authority must be on the Remove's own target.
rej("quiescenceReachable", "cm-quiescenceReachable-51-remove-authority-other-target", ["r3.4d-cm"], run(withToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: w.step, scope: { target: "inbox:i2", inboxId: null, keyIds: [] } })); }], ...Q]));
// Keep shapes (base(): live Keep, claimed in the op's own step; the op is dropped at the tick, success never written).
const kpClaim: StepSpec = [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null })); w.ghost.keeps.push(kr({ claimedAtStep: 1 })); }];
const ansReq = (id: string, keepOp: string, result: "ok" | "refused"): RemoteRequest => rq({ requestId: id, kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp, flux: "applied", appliedAtMs: NOW, answer: "delivered", answerSeen: { atStep: 2, result, fluxStateSeen: "active" } });
// #10: a refusal of ANOTHER Keep op's request is not this Keep's refusal.
rej("quiescenceReachable", "cm-quiescenceReachable-10-refusal-of-other-keep-op", ["r3.4d-cm"], run(base(), [kpClaim, [tick, w => { w.local.keepOps = {}; w.flux.requests.push(ansReq("g1", "kp1", "ok"), ansReq("g2", "kpX", "refused")); }], ...Q]));
// #11: an answer that is neither refused nor not_found is not a refusal.
rej("quiescenceReachable", "cm-quiescenceReachable-11-ok-answer-is-not-refusal", ["r3.4d-cm"], run(base(), [kpClaim, [tick, w => { w.local.keepOps = {}; w.flux.requests.push(ansReq("g1", "kp1", "ok")); }], ...Q]));
// #46: the Keep's history record must still exist at the end (a vanished record is no success): the mutant dereferences it and throws.
rej("quiescenceReachable", "cm-quiescenceReachable-46-keep-record-vanished", ["r3.4d-cm"], run(base(), [kpClaim, [tick, w => { w.local.keepOps = {}; w.ghost.keeps = []; }], ...Q]));
// #14: a bot deleted BEFORE the Keep's claim is not an owner-caused end of that Keep.
rej("quiescenceReachable", "cm-quiescenceReachable-14-bot-deleted-before-claim", ["r3.4d-cm"], run(from(w => { Object.assign(w, parkedTok()); w.ghost.botDeletedAtStep.b1 = 0; }), [admitKeep(), [tick, w => { w.local.keepOps = {}; w.local.parks.pk1.state = "parked"; }], ...Q]));
// #23: a kept-key entry naming an authority that does not exist is no Keep: the mutant dereferences it and throws.
rej("quiescenceReachable", "cm-quiescenceReachable-23-kept-entry-without-authority", ["r3.4d-cm"], run(markedK9(), [removeK9, [tick, w => { w.local.leases = {}; w.local.keptKeys.k9 = "aGone"; }], ...Q]));
// #44 / #39 / #9 / #31: the first check judges the inbox OF THE TARGET: a remove_authorized park whose lease sits on another inbox that is closing.
const mismatch = (): World => from(w => { Object.assign(w, base()); w.local.bindings.b1.state = "removal_parked";
  w.local.parks.pk1 = pk({ state: "remove_authorized", target: "inbox:i2", inboxId: "i2", keyTargets: [] });
  w.local.leases.L1 = ls({ target: "inbox:i2", inboxId: "i1", phase: "acked", keyTargets: [] }); w.flux.inboxes.i1.state = "closing"; w.flux.inboxes.i1.closingCause = { kind: "flux", reason: "billing" } as never; w.flux.inboxes.i1.closingSinceMs = NOW; w.flux.inboxes.i1.closingSinceStep = 0; });
rej("quiescenceReachable", "cm-quiescenceReachable-44-park-authorized-inbox-not-closing", ["r3.4d-cm"], run(mismatch(), [[{ t: "owner.tryAgainNow", principal: OWN, botId: "b1", target: "inbox:i2", outcome: okO }], ...Q]));
// #33 (accept): a REFUSED owner op is never judged.
acc("quiescenceReachable", "cm-quiescenceReachable-33-refused-keep-not-judged", ["r3.4d-cm"], run(base(), [[staleKeep, lookAgain], ...Q]));
// #26 (accept): the Remove's key stays live because another bot still uses it (skipped_in_use): done, not owed.
acc("quiescenceReachable", "cm-quiescenceReachable-26-remove-key-in-use", ["r3.4d-cm"], run(markedK9InUse(), [removeK9, [tick, w => { w.local.leases = {}; }], ...Q]));
// #48 (accept): Flux refuses the Keep's own GET (not_found: the inbox was purged), so the Keep ends without success, owner-visibly.
acc("quiescenceReachable", "cm-quiescenceReachable-48-keep-refused-by-flux", ["r3.4d-cm"], run(base(), [kpClaim,
  [send(g1()), w => { w.flux.requests.push(g1()); }],
  [apply("g1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "g1", result: "not_found", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 4, result: "not_found", fluxStateSeen: null } }); }],
  [tick, w => { w.local.keepOps = {}; }], ...Q]));
// ---- batch 4 (fresh builder): witnesses only ----
// #34 (accept): the owner deletes b1 (Keep on pk2 ended by it, pk2 re-parked); a later view mints a NEW p token tP3 on pk2 AFTER the delete, and the owner's Keep with it creates authority aK2.
// Only tokens issued at or before the delete are dead; a token minted afterwards is a fresh one.
const keepDel2 = (): StepSpec[] => [
  [keepA({ target: "inbox:i2", mode: "orphan", tokenId: "tP2" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP2", genAtVerify: null, parkAtVerify: { parkId: "pk2", parkRev: 0 }, scope: { target: "inbox:i2", inboxId: "i2", keyIds: [] } }));
    w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: "inbox:i2", inboxId: "i2", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
    w.ghost.keeps.push(kr({ target: "inbox:i2", inboxId: "i2", mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk2.state = "keep_pending"; }],
  [deleteB1Work[0], w => { deleteB1Work[1]!(w); w.local.keepOps = {}; w.local.parks.pk2.state = "parked"; w.surface = [pendingRow()]; }]];
acc("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-34-token-minted-after-delete", ["r3.4d-cm"], run(keepThenDelete(), [...keepDel2(),
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [pendingRow(), row({ section: "parked", target: "inbox:i2", inboxId: "i2", keyIds: [], actions: [{ kind: "keep", tokenId: "tP3", enabled: true }] })];
    w.ghost.tokens.push(parkTok({ tokenId: "tP3", issuedAtStep: w.step, park: { parkId: "pk2", parkRev: 0 }, shown: { target: "inbox:i2", address: "old@mail.test", inboxId: "i2", keyIds: [] } })); }],
  [keepA({ target: "inbox:i2", mode: "orphan", tokenId: "tP3" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK2", kind: "keep", tokenId: "tP3", verifiedAtStep: w.step, genAtVerify: null, parkAtVerify: { parkId: "pk2", parkRev: 0 }, scope: { target: "inbox:i2", inboxId: "i2", keyIds: [] } }));
    w.local.keepOps.kp2 = { keepOp: "kp2", botId: "b1", target: "inbox:i2", inboxId: "i2", mode: "orphan", authorityId: "aK2", claimedAtStep: w.step };
    w.ghost.keeps.push(kr({ keepOp: "kp2", authorityId: "aK2", target: "inbox:i2", inboxId: "i2", mode: "orphan", claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp2"); w.local.parks.pk2.state = "keep_pending"; }]]));
// #53 (accept): the marked key k9's Remove is admitted (work dropped, k9 still live and kept under the OLD aKo), then the owner admits a LATER key-only Keep on the same target and it succeeds:
// the Keep wins, so the Remove's work is legitimately dropped (laterKeep, line 2433).
const laterKeepK9: StepSpec[] = [removeK9, [tick, w => { w.local.leases = {}; }],
  [keepA({ target: T_I1, mode: "key_only", tokenId: "tR9" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK9n", kind: "keep", tokenId: "tR9", verifiedAtStep: w.step, verifiedAtMs: w.nowMs, scope: { target: T_I1, inboxId: null, keyIds: [] } }));
    w.local.keepOps.kp9 = { keepOp: "kp9", botId: "b1", target: T_I1, inboxId: null, mode: "key_only", authorityId: "aK9n", claimedAtStep: w.step };
    w.ghost.keeps.push(kr({ keepOp: "kp9", authorityId: "aK9n", inboxId: null, mode: "key_only", claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp9"); }],
  [tick, w => { Object.assign(w.ghost.keeps[w.ghost.keeps.length - 1]!, { succeededAtStep: w.step, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: w.step } }); w.local.keepOps = {}; }]];
acc("quiescenceReachable", "cm-quiescenceReachable-53-later-keep-ends-remove", ["r3.4d-cm"], run(markedK9(), [...laterKeepK9, ...Q]));
// #54 (accept): the same dropped Remove of marked k9, then the owner deletes the bot b1 (its delete authority owes nothing: no inbox, no keys): the delete is the owner-caused end of the Remove (deletedAfter, line 2433).
acc("quiescenceReachable", "cm-quiescenceReachable-54-bot-delete-ends-remove", ["r3.4d-cm"], run(from(w => { Object.assign(w, markedK9()); w.ghost.tokens.push(tk({ tokenId: "tD", issuedAtStep: 0, shown: { target: "bot:b1", address: null, inboxId: null, keyIds: [] } })); }), [removeK9, [tick, w => { w.local.leases = {}; }],
  [deleteB1[0], w => { w.ghost.authorities.push(au({ authorityId: "aD", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: w.step, verifiedAtMs: w.nowMs, scope: { target: "bot:b1", inboxId: null, keyIds: [] } }));
    w.ghost.botDeletedAtStep.b1 = w.step; w.bots.b1.present = false; w.local.bindings = {}; w.local.leases.LD = ls({ removalId: "LD", target: "bot:b1", inboxId: null, authorityId: "aD", phase: "authorized", keyTargets: [] });
    w.surface.push(row({ section: "parked", actions: [{ kind: "keep", tokenId: null, enabled: true }, { kind: "remove", tokenId: null, enabled: true }] })); }],
  [tick, w => { w.local.leases = {}; }], ...Q]));
// Q#27 attempt (accept): Remove of marked k9 admitted and dropped; then a NEWER key-only Keep on the op target (not the Remove's target, so laterKeep skips nothing) keeps k9 under a newer authority: keptAfter holds.
const newerKeep: StepSpec[] = [removeK9, [tick, w => { w.local.leases = {}; }],
  [keepA({ target: T_OP1, mode: "key_only", tokenId: "tK9" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aKk", kind: "keep", tokenId: "tK9", verifiedAtStep: w.step, verifiedAtMs: w.nowMs, scope: { target: T_OP1, inboxId: null, keyIds: ["k9"] } }));
    w.local.keepOps.kp9 = { keepOp: "kp9", botId: "b1", target: T_OP1, inboxId: null, mode: "key_only", authorityId: "aKk", claimedAtStep: w.step };
    w.ghost.keeps.push(kr({ keepOp: "kp9", authorityId: "aKk", target: T_OP1, inboxId: null, mode: "key_only", claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp9"); }],
  [tick, w => { Object.assign(w.ghost.keeps[w.ghost.keeps.length - 1]!, { succeededAtStep: w.step, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: w.step } }); w.local.keepOps = {}; w.local.keptKeys.k9 = "aKk"; w.ghost.keptHighWater.k9 = "aKk"; }]];
acc("quiescenceReachable", "cm-quiescenceReachable-27-newer-keep-other-target-keeps-key", ["r3.4d-cm"], run(from(w => { Object.assign(w, markedK9()); w.ghost.tokens.push(tk({ tokenId: "tK9", issuedAtStep: 0, shown: { target: T_OP1, address: ADDR, inboxId: null, keyIds: ["k9"] } }));
  w.surface.push(row({ section: "key_only", target: T_OP1, inboxId: null, keyIds: ["k9"], actions: [{ kind: "keep", tokenId: "tK9", enabled: true }, { kind: "remove", tokenId: "tK9", enabled: true }] })); }), [...newerKeep, ...Q]));
// #13 attempt (accept): a second ok delete of the already-deleted b1 with a token minted after the first delete; records nothing new, the work lease LD is re-signed by the new delete authority.
acc("deletedBotAuthorityDead", "cm-deletedBotAuthorityDead-13-second-delete-records-nothing", ["r3.4d-cm"], run(afterDel(), [delFull,
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.ghost.tokens.push(tk({ tokenId: "tD2", issuedAtStep: w.step })); w.surface = [pendingRow(), row({ section: "bot", actions: [{ kind: "remove", tokenId: "tD2", enabled: true }] })]; }],
  [del2[0], w => { del2[1]!(w); delete w.local.leases.LD; w.local.leases.LD2 = ls({ removalId: "LD2", authorityId: "aD2" }); }]]));

// quiescenceReachable#37 (`!closing(inboxOfTarget(end, t))`, the clause that stays after the SHADOW deletions): an ok owner Remove whose park is remove_authorized under an ACKED lease on a CLOSING inbox of its own target is complete (waiting): the clause must not fire.
acc("quiescenceReachable", "cm-quiescenceReachable-37-remove-authorized-park-inbox-closing", ["r3.4d-s23"], run(withToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: 1 })); w.local.leases.L1 = ls({ phase: "acked" }); w.local.bindings.b1.state = "removal_parked";
  w.local.parks.pk1 = pk({ state: "remove_authorized" }); w.surface = [pendingRow()]; w.flux.inboxes.i1.state = "closing"; w.flux.inboxes.i1.closingCause = { kind: "flux", reason: "billing" } as never; w.flux.inboxes.i1.closingSinceMs = NOW; w.flux.inboxes.i1.closingSinceStep = 0; }], ...Q]));

export const PIN = 50;
