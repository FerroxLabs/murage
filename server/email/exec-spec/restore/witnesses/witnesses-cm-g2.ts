// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g2 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, keepHist, succeed, closingKept, guardRestore, orphanRow, pendingRow, rcRow, rTok, tokB, d, closeBy, fluxClose, apply as apply_, T_I1, T_OP1, clone, G1, NOW, type Witness } from "./spec.ts";
import type { RemoteRequest } from "../invariants.current.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from];
type Mut = Parameters<typeof from>[0];

export const WITNESSES_G2: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G2);
void rej; void acc;

// ---------- keepSuccessIsConfirmed (clauses 3..19) ----------------------------------------------------------------------------------
type RqO = Partial<RemoteRequest>;
type KrO = NonNullable<Parameters<typeof kr>[0]>;
/** A Keep on i1 claimed at `claim` with an optional answered restore and a GET; every field of the GET overridable. */
const csv = (o: { restore?: boolean; claim?: number; get?: RqO; ans?: Record<string, unknown> } = {}) => from(w => {
  w.step = 4; keepHist(w, { claimedAtStep: o.claim ?? 0 });
  if (o.restore !== false) w.flux.requests.push(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 1, flux: "applied", answer: "delivered", answerSeen: { atStep: 2, result: "ok", fluxStateSeen: "active" } }));
  w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 3, flux: "applied", answer: "delivered",
    answerSeen: { atStep: 4, result: "ok", fluxStateSeen: "active", ...(o.ans ?? {}) } as never, ...(o.get ?? {}) }));
});
const S = (rid = "g1", at = 4): Parameters<typeof run>[1][number] => [tick, succeed(rid, at)];
void ({} as KrO);
acc("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-3-key-only-keep-no-confirmation", ["r3.4d-cm"], run(from(w => { keepHist(w, { target: "op:op1", inboxId: null, mode: "key_only" }); }),
  [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs }); }]]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-5-confirming-request-missing", ["r3.4d-cm"], run(csv(), [[tick, succeed("gX", 4)]]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-6-no-confirmation-recorded", ["r3.4d-cm"], run(csv(), [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs }); }]]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-7-confirmed-by-list-request", ["r3.4d-cm"], run(csv({ get: { kind: "LIST_ACCOUNT" } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-8-get-of-another-inbox", ["r3.4d-cm"], run(csv({ get: { target: "i2" } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-9-get-under-another-keep-op", ["r3.4d-cm"], run(csv({ get: { keepOp: "kp2" } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-10-get-sent-before-claim", ["r3.4d-cm"], run(csv({ restore: false, claim: 3 }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-12-get-answer-lost", ["r3.4d-cm"], run(csv({ get: { answer: "lost" } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-13-get-answer-not-seen", ["r3.4d-cm"], run(csv({ get: { answerSeen: null } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-14-get-result-not-ok", ["r3.4d-cm"], run(csv({ ans: { result: "refused" } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-15-get-reports-closing", ["r3.4d-cm"], run(csv({ ans: { fluxStateSeen: "closing" } }), [S()]));
rej("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-16-answer-step-differs", ["r3.4d-cm"], run(csv(), [S("g1", 5)]));
acc("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-19-other-keep-op-restore-unanswered", ["r3.4d-cm"], run(from(w => { Object.assign(w, csv()); w.flux.requests.push(rq({ requestId: "r2", kind: "RESTORE_INBOX", target: "i2", purpose: "keep", keepOp: "kp2", sentAtStep: 3, flux: "applied", answer: "pending", answerSeen: null })); }), [S()]));

// ---------- opsLinesNeverNameAddress ------------------------------------------------------------------------------------------------
const ol = (kind: "blip" | "other" | "guard_restore", bindingId: string | null, gen: boolean, window: boolean): Mut => w => {
  w.ops.push({ kind: kind as never, bindingId, gen: gen ? clone(G1) : null, text: "check", window: window ? { closingSinceMs: NOW, restoredAtMs: NOW + 30_000 } : null });
};
acc("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-1-inbox-with-empty-address", ["r3.4d-cm"], run(base(), [[tick, w => { w.flux.inboxes.i2 = { ...clone(w.flux.inboxes.i1), inboxId: "i2", address: "", createdUnderOp: null, forBot: null, installOwned: false }; ol("other", "b1", true, false)(w); }]]));
rej("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-4-line-without-binding-with-gen", ["r3.4d-cm"], run(base(), [[tick, ol("other", null, true, false)]]));
rej("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-5-line-without-generation", ["r3.4d-cm"], run(base(), [[tick, ol("other", "b1", false, false)]]));
acc("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-7-plain-line-has-no-window", ["r3.4d-cm"], run(base(), [[tick, ol("other", "b1", true, false)]]));
rej("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-9-blip-line-without-window", ["r3.4d-cm"], run(base(), [[tick, ol("blip", "b1", true, false)]]));
acc("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-11-guard-poll-needs-no-alert", ["r3.4d-cm"], run(base(), [[send(rq({ requestId: "p1", kind: "GET_INBOX", target: "i1", purpose: "guard" }))]]));
rej("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-14-guard-restore-without-alert", ["r3.4d-cm"], run(base(), [[send(rq({ requestId: "p1", kind: "RESTORE_INBOX", target: "i1", purpose: "guard" }))]]));
acc("opsLinesNeverNameAddress", "cm-opsLinesNeverNameAddress-16-guard-restore-with-blip-alert", ["r3.4d-cm"], run(closingKept(), [[guardRestore, ol("blip", "b1", true, true)]]));

// ---------- keepAndRemoveSerialized -------------------------------------------------------------------------------------------------
const kop = (id: string, target = "inbox:i1") => ({ keepOp: id, botId: "b1", target, inboxId: "i1", mode: "orphan" as const, authorityId: "aK", claimedAtStep: 0 });
rej("keepAndRemoveSerialized", "cm-keepAndRemoveSerialized-1-two-open-keeps", ["r3.4d-cm"], run(base(), [[tick, w => { w.local.keepOps.kp1 = kop("kp1"); w.local.keepOps.kp2 = kop("kp2"); }]]));
acc("keepAndRemoveSerialized", "cm-keepAndRemoveSerialized-3-keep-with-keeping-lease", ["r3.4d-cm"], run(from(w => { keepHist(w, {}); w.local.keepOps.kp1 = kop("kp1"); w.local.leases.L1 = ls({ phase: "keeping" as never }); }), [[tick]]));
acc("keepAndRemoveSerialized", "cm-keepAndRemoveSerialized-4-keep-with-gone-lease", ["r3.4d-cm"], run(from(w => { keepHist(w, {}); w.local.keepOps.kp1 = kop("kp1"); w.local.leases.L1 = ls({ phase: "gone" as never }); }), [[tick]]));
rej("keepAndRemoveSerialized", "cm-keepAndRemoveSerialized-5-two-leases-on-one-inbox", ["r3.4d-cm"], run(base(), [[tick, w => { w.local.leases.L1 = ls({ target: "inbox:i1" }); w.local.leases.L2 = ls({ target: "inbox:i1x", inboxId: "i1" }); }]]));

// ---------- keyTargetsNeverLost -----------------------------------------------------------------------------------------------------
acc("keyTargetsNeverLost", "cm-keyTargetsNeverLost-1-process-down-records-unloaded", ["r3.4d-cm"], run(base(), [[tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.proc.phase = "down"; }]]));
acc("keyTargetsNeverLost", "cm-keyTargetsNeverLost-2-boot-prep-records-unloaded", ["r3.4d-cm"], run(base(), [[tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.proc.phase = "boot_prep"; }]]));
acc("keyTargetsNeverLost", "cm-keyTargetsNeverLost-3-foreign-live-key", ["r3.4d-cm"], run(base(), [[tick, w => { w.flux.keys.kX = { ...clone(w.flux.keys.k1), keyId: "kX", installOwned: false, mintedUnderOp: null }; }]]));

// ---------- everyOrphanHasExecutableAction ------------------------------------------------------------------------------------------
type RowO = NonNullable<Parameters<typeof row>[0]>;
const A = (kind: string, enabled = true) => ({ kind: kind as never, tokenId: null, enabled });
const KR = [A("keep"), A("remove")];
/** b1 is gone, so i1 and k1 are orphans; `rows` (default: one orphan row naming both) is the surface. */
const og = (m?: Mut, rows?: ReturnType<typeof row>[]) => from(w => { w.bots.b1.present = false; w.surface = rows ?? [orphanRow()]; if (m) m(w); });
const T1 = [[tick]] as Parameters<typeof run>[1];
const EO = "everyOrphanHasExecutableAction";
rej(EO, "cm-everyOrphanHasExecutableAction-1-orphan-row-invisible", ["r3.4d-cm"], run(og(undefined, [orphanRow({ visible: false })]), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-2-orphan-row-blank-line", ["r3.4d-cm"], run(og(undefined, [orphanRow({ line: "" })]), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-3-orphan-row-actions-disabled", ["r3.4d-cm"], run(og(undefined, [orphanRow({ actions: [A("keep", false), A("remove", false)] })]), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-4-orphan-row-offers-other-action", ["r3.4d-cm"], run(og(undefined, [orphanRow({ actions: [A("confirm_inventory")] })]), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-5-try-again-with-only-an-open-keep", ["r3.4d-cm"], run(from(w => { keepHist(w, {}); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 0 }; w.surface = [pendingRow()]; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-7-try-again-with-a-retrying-park", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk({ state: "keep_pending" }); w.surface = [pendingRow()]; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-9-disabled-try-again-nothing-pending", ["r3.4d-cm"], run(from(w => { w.surface = [pendingRow({ actions: [A("try_again_now", false)] })]; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-11-enabled-try-again-nothing-pending", ["r3.4d-cm"], run(from(w => { w.surface = [pendingRow()]; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-14-known-inbox-excused-by-discovery", ["r3.4d-cm"], run(from(w => { Object.assign(w, blind(false)); w.bots.b1.present = false; w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), T1));
// -- removedByOwner (clauses 16..24): an inbox closed by a DELETE under an owner Remove is no orphan unless one of these facts breaks it --
const ownerDel = (m?: Mut, authKind = "remove_bot_section", authOver: Partial<ReturnType<typeof au>> = {}) => from(w => {
  w.bots.b1.present = false; w.surface = [orphanRow({ inboxId: "iX", target: "inbox:iX" })]; // covers key k1 only
  tokB(w); w.ghost.authorities.push(au({ kind: authKind as never, verifiedAtStep: 0, ...authOver }));
  w.flux.requests.push(d("d1", "at1", { flux: "applied", answer: "delivered", appliedAtMs: NOW }));
  const i = w.flux.inboxes.i1; i.state = "closing"; i.closingCause = { kind: "delete", requestId: "d1", reason: "owner" } as never; i.closingSinceMs = NOW; i.closingSinceStep = 0;
  if (m) m(w);
});
rej(EO, "cm-everyOrphanHasExecutableAction-16-reopened-inbox-keeps-old-cause", ["r3.4d-cm"], run(ownerDel(w => { w.flux.inboxes.i1.state = "active"; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-19-closed-under-a-keep-authority", ["r3.4d-cm"], run(ownerDel(undefined, "keep"), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-20-remove-from-an-older-epoch", ["r3.4d-cm"], run(ownerDel(w => { w.ghost.epoch = 1; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-21-removed-inbox-is-parked", ["r3.4d-cm"], run(ownerDel(w => { w.local.parks.pk1 = pk(); }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-22-keep-claimed-after-the-remove", ["r3.4d-cm"], run(ownerDel(w => { keepHist(w, { claimedAtStep: 5 }); }), T1));
// stricter side: a Keep that does not follow THIS inbox's Remove must not stop the exemption
const ownerRemovedAcc = (m?: Mut) => run(from(w => {
  w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] });
  tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); w.flux.requests.push(d("d1", "at1", { answer: "pending" })); if (m) m(w);
}), [
  [apply_("d1"), closeBy("d1")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => {
    const r = w.flux.requests.find(x => x.requestId === "d1")!; r.answer = "delivered"; r.answerSeen = { atStep: 2, result: "accepted", fluxStateSeen: "closing" }; w.local.leases.L1.phase = "acked"; }],
  [tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.leases = {}; w.flux.keys.k1.state = "revoked"; w.bots.b1.present = false; }],
]);
acc(EO, "cm-everyOrphanHasExecutableAction-23-keep-on-another-inbox-after-remove", ["r3.4d-cm"], ownerRemovedAcc(w => { keepHist(w, { inboxId: "i2", target: "inbox:i2", claimedAtStep: 5 }); }));
acc(EO, "cm-everyOrphanHasExecutableAction-24-earlier-keep-before-the-remove", ["r3.4d-cm"], ownerRemovedAcc(w => { keepHist(w, { claimedAtStep: -4, succeededAtStep: -3, succeededAtMs: NOW, confirmedBy: { requestId: "g0", atStep: -3 } }, -5); }));

// -- owner binding (28, 29) and key owner (46, 47, 48) --
rej(EO, "cm-everyOrphanHasExecutableAction-28-orphan-inbox-while-another-bot-present", ["r3.4d-cm"], run(from(w => { w.flux.inboxes.i2 = { ...clone(w.flux.inboxes.i1), inboxId: "i2", address: "o@mail.test", createdUnderOp: null, forBot: null }; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-29-inbox-of-a-gone-bot", ["r3.4d-cm"], run(og(undefined, [orphanRow({ inboxId: "iX", target: "inbox:iX" })]), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-46-orphan-key-while-another-key-bound", ["r3.4d-cm"], run(from(w => { w.flux.keys.kZ = { ...clone(w.flux.keys.k1), keyId: "kZ", mintedUnderOp: null }; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-47-key-of-a-gone-bot", ["r3.4d-cm"], run(og(undefined, [orphanRow({ keyIds: [] })]), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-48-key-of-a-parked-binding", ["r3.4d-cm"], run(from(w => { w.local.bindings.b1.state = "removal_parked"; w.local.savedKeys = {}; w.surface = [orphanRow({ keyIds: [] })]; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-50-key-row-found-by-provisioning-op", ["r3.4d-cm"], run(from(w => {
  w.flux.keys.kP = { ...clone(w.flux.keys.k1), keyId: "kP", mintedUnderOp: "op1" };
  w.surface = [row({ section: "key_only", target: T_OP1, inboxId: null, keyIds: [], provisionOpId: "op1", actions: [A("keep"), A("remove")] })]; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-31-guarded-delete-closing-needs-no-keep-row", ["r3.4d-cm"], run(closingKept(), T1));

// -- closing inbox of a present bot (34, 36..40) --
const fcRun = (rows: ReturnType<typeof row>[], m?: Mut) => run(from(w => { if (m) m(w); }), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, w => { fluxClose("billing")(w); w.surface = rows; }]]);
acc(EO, "cm-everyOrphanHasExecutableAction-34-flux-close-during-owner-remove", ["r3.4d-cm"], fcRun([], w => {
  w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); w.flux.requests.push(d("d1", "at1", { answer: "pending" })); }));
rej(EO, "cm-everyOrphanHasExecutableAction-36-keep-offered-on-a-parked-section-row", ["r3.4d-cm"], fcRun([row({ section: "parked", botId: "b1", actions: [A("keep")] })]));
rej(EO, "cm-everyOrphanHasExecutableAction-37-keep-offered-on-another-bots-row", ["r3.4d-cm"], fcRun([row({ section: "bot", botId: "b2", actions: [A("keep")] })]));
rej(EO, "cm-everyOrphanHasExecutableAction-38-bot-row-offers-only-remove", ["r3.4d-cm"], fcRun([row({ section: "bot", botId: "b1", actions: [A("remove")] })]));
rej(EO, "cm-everyOrphanHasExecutableAction-39-bot-row-keep-disabled", ["r3.4d-cm"], fcRun([row({ section: "bot", botId: "b1", actions: [A("keep", false), A("remove")] })]));

// -- key-only parks (52..63) and key-only provisioning bindings (64..68) --
const kpark = (rows: ReturnType<typeof row>[], state: "parked" | "keep_pending" = "parked", bot = false) => run(from(w => {
  w.bots.b1.present = bot; w.local.parks.pk1 = pk({ inboxId: null, target: T_OP1, state }); w.surface = [orphanRow({ inboxId: null, target: T_OP1, provisionOpId: "op1" }), ...rows]; }), T1);
const KO = (o: RowO = {}) => row({ section: "key_only", target: T_OP1, inboxId: null, provisionOpId: "op1", actions: KR, ...o });
acc(EO, "cm-everyOrphanHasExecutableAction-52-key-only-park-of-a-present-bot", ["r3.4d-cm"], kpark([], "parked", true));
acc(EO, "cm-everyOrphanHasExecutableAction-53-key-only-park-not-yet-parked", ["r3.4d-cm"], kpark([], "keep_pending"));
rej(EO, "cm-everyOrphanHasExecutableAction-54-key-only-park-row-in-other-section", ["r3.4d-cm"], kpark([KO({ section: "parked" })]));
rej(EO, "cm-everyOrphanHasExecutableAction-55-key-only-park-row-other-target", ["r3.4d-cm"], kpark([KO({ target: "op:op9", provisionOpId: "op9" })]));
rej(EO, "cm-everyOrphanHasExecutableAction-56-key-only-park-without-row", ["r3.4d-cm"], kpark([]));
rej(EO, "cm-everyOrphanHasExecutableAction-57-key-only-park-row-remove-only", ["r3.4d-cm"], kpark([KO({ actions: [A("remove")] })]));
rej(EO, "cm-everyOrphanHasExecutableAction-58-key-only-park-row-keep-only", ["r3.4d-cm"], kpark([KO({ actions: [A("keep")] })]));
rej(EO, "cm-everyOrphanHasExecutableAction-60-key-only-park-keep-disabled", ["r3.4d-cm"], kpark([KO({ actions: [A("keep", false), A("remove")] })]));
rej(EO, "cm-everyOrphanHasExecutableAction-62-key-only-park-remove-disabled", ["r3.4d-cm"], kpark([KO({ actions: [A("keep"), A("remove", false)] })]));
const prov = (m: Mut, rows: ReturnType<typeof row>[]) => run(from(w => { w.local.bindings.b1 = { botId: "b1", state: "provisioning", step: "inbox", gen: { inboxId: null, opId: "op1", emailKeyRef: "k1", serial: 1 }, address: null }; w.flux.inboxes = {}; m(w); w.surface = rows; }), T1);
const KROW = (o: RowO = {}) => row({ section: "key_only", target: T_OP1, inboxId: null, provisionOpId: "op1", keyIds: ["k1"], actions: KR, ...o });
rej(EO, "cm-everyOrphanHasExecutableAction-67-key-only-orphan-row-in-other-section", ["r3.4d-cm"], prov(w => { w.bots.b1.present = false; }, [KROW({ section: "parked" })]));
rej(EO, "cm-everyOrphanHasExecutableAction-68-key-only-orphan-row-of-another-bot", ["r3.4d-cm"], prov(w => { w.bots.b1.present = false; }, [KROW({ botId: "b2" })]));
acc(EO, "cm-everyOrphanHasExecutableAction-64-parked-binding-without-inbox", ["r3.4d-cm"], run(from(w => { w.bots.b1.present = false; w.local.bindings.b1.state = "removal_parked"; w.local.bindings.b1.gen.inboxId = null; w.flux.inboxes = {}; w.surface = [orphanRow({ inboxId: null, target: T_OP1, provisionOpId: "op1" })]; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-65-provisioning-binding-with-inbox", ["r3.4d-cm"], run(from(w => { w.bots.b1.present = false; w.local.bindings.b1.state = "provisioning"; w.surface = [orphanRow()]; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-66-provisioning-key-only-of-present-bot", ["r3.4d-cm"], prov(() => undefined, []));
// -- foreign inbox / key (25, 43) --
acc(EO, "cm-everyOrphanHasExecutableAction-25-foreign-inbox-needs-no-row", ["r3.4d-cm"], run(from(w => { w.flux.inboxes.i9 = { ...clone(w.flux.inboxes.i1), inboxId: "i9", installOwned: false, address: "f@mail.test", createdUnderOp: null, forBot: null }; }), T1));
acc(EO, "cm-everyOrphanHasExecutableAction-43-foreign-key-needs-no-row", ["r3.4d-cm"], run(from(w => { w.flux.keys.k9 = { ...clone(w.flux.keys.k1), keyId: "k9", installOwned: false, mintedUnderOp: null }; }), T1));
rej(EO, "cm-everyOrphanHasExecutableAction-31-delete-closing-without-guard", ["r3.4d-cm"], run(from(w => { w.flux.requests.push(d("d1", "at1", { flux: "applied", answer: "delivered", appliedAtMs: NOW })); }), [[tick, w => {
  const i = w.flux.inboxes.i1; i.state = "closing"; i.closingCause = { kind: "delete", requestId: "d1", reason: "owner" } as never; i.closingSinceMs = w.nowMs; i.closingSinceStep = w.step; }]]));


export const PIN = 73;
