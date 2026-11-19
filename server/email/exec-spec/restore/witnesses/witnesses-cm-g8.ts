// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g8 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from];

export const WITNESSES_G8: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G8);
void rej; void acc;

// ---------- r3.4d clause mutants (CLAUSE-MUTANTS-r34d.md): one witness per SURVIVED clause, named after the clause id ----------------
// restoreUsesOwnerCredentialAndKeepPurpose#6 (weaker): a RESTORE with the owner credential but a removal purpose must still be refused.
rej("restoreUsesOwnerCredentialAndKeepPurpose", "cm-restoreUsesOwnerCredentialAndKeepPurpose-6-owner-restore-purpose-removal", ["r3.4d-cm"], run(base(), [[send(rq({ requestId: "r9", kind: "RESTORE_INBOX", target: "i1", purpose: "removal", credential: "owner" }))]]));
// noDestructiveSendAfterBlindRestore#2 (stricter): the fence holds only DELETE and revoke; a GET poll after an unconfirmed blind restore leaves.
acc("noDestructiveSendAfterBlindRestore", "cm-noDestructiveSendAfterBlindRestore-2-get-poll-after-blind", ["r3.4d-cm"], run(blind(false), [[tick, w => {
  w.surface = [row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }] })]; }],
  [send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "poll" }))]]));


// ================= r34d step 1, group g8 (builder): witnesses named after the clause id each one closes =================================
import { removeA, keepA, no, parked, parkedTok, prep, swappedStart, sysPrep, orphanRow, withRows, remHist, leaseAuth, keepHist, parkIt, replaced, G1, T_I1, T_OP1, clone, NOW, revokeK1, claimKp1, leaseIn, d } from "./spec.ts";
// prettier-ignore
void [removeA, keepA, no, parked, parkedTok, prep, swappedStart, sysPrep, orphanRow, withRows, remHist, leaseAuth, keepHist, parkIt, replaced, G1, T_I1, T_OP1, clone, NOW, revokeK1, claimKp1, leaseIn, d];
const S = "removalSendNeedsSendingLease", N = "nothingAutomaticUnparks", R = "restorePrepParksEverything", B = "blindRestoreIsOwnerVisible";
const sendL = (id: string, o: object) => [[send(rq({ requestId: id, kind: "REVOKE_KEY", target: "k1", removalId: "L1", attemptId: "at1", authorityId: "aR", ...o } as never))]] as never;
const lsS = (o: object = {}) => ls({ phase: "sending", attemptId: "at1", attempts: ["at1"], keyTargets: [{ keyId: "k1", status: "pending" }], ...o } as never);
const fromL = (l: object, ...more: ((w: ReturnType<typeof base>) => void)[]) => from(w => { remHist(w); w.local.leases.L1 = lsS(l); more.forEach(m => m(w)); });
// ---- removalSendNeedsSendingLease
rej(S, "cm-removalSendNeedsSendingLease-3-removal-revoke-no-authority", ["r3.4d-cm"], run(base(), [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", purpose: "removal" }))]]));
rej(S, "cm-removalSendNeedsSendingLease-4-rotation-revoke-by-remove-authority", ["r3.4d-cm"], run(from(w => { remHist(w); }), [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", purpose: "rotation", authorityId: "aR" }))]]));
rej(S, "cm-removalSendNeedsSendingLease-5-no-lease-at-all", ["r3.4d-cm"], run(from(w => { remHist(w); }), [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", authorityId: "aR", attemptId: "at1" }))]]));
rej(S, "cm-removalSendNeedsSendingLease-6-lease-authorized-attempt-matches", ["r3.4d-cm"], run(fromL({ phase: "authorized" }), sendL("v1", {})));
rej(S, "cm-removalSendNeedsSendingLease-7-lease-sending-other-attempt", ["r3.4d-cm"], run(fromL({ attemptId: "at0", attempts: ["at0"] }), sendL("v1", {})));
rej(S, "cm-removalSendNeedsSendingLease-11-delete-outside-lease-inbox", ["r3.4d-cm"], run(fromL({ inboxId: "i2", target: "inbox:i2", keyTargets: [] }), [[send(d("d1", "at1", { answer: "pending" }))]]));
rej(S, "cm-removalSendNeedsSendingLease-14-revoke-no-key-targets", ["r3.4d-cm"], run(fromL({ keyTargets: [] }), sendL("v1", {})));
rej(S, "cm-removalSendNeedsSendingLease-15-revoke-other-pending-key", ["r3.4d-cm"], run(fromL({ keyTargets: [{ keyId: "k2", status: "pending" }] }), sendL("v1", {})));
rej(S, "cm-removalSendNeedsSendingLease-16-revoke-already-revoked-key", ["r3.4d-cm"], run(fromL({ keyTargets: [{ keyId: "k1", status: "revoked" }] }), sendL("v1", {})));
rej(S, "cm-removalSendNeedsSendingLease-17-second-delete-same-attempt", ["r3.4d-cm"], run(fromL({ keyTargets: [] }, w => { w.flux.requests.push(d("d0", "at1", { answer: "pending" })); }), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc(S, "cm-removalSendNeedsSendingLease-18-delete-new-attempt-after-old", ["r3.4d-cm"], run(fromL({ keyTargets: [], attemptId: "at2", attempts: ["at1", "at2"] }, w => { w.flux.requests.push(d("d0", "at1")); }), [[send(d("d1", "at2", { answer: "pending" }))]]));
acc(S, "cm-removalSendNeedsSendingLease-21-second-key-revoke-same-attempt", ["r3.4d-cm"], run(fromL({ keyTargets: [{ keyId: "k1", status: "pending" }, { keyId: "k2", status: "pending" }] }, w => { w.flux.requests.push(rq({ requestId: "v0", kind: "REVOKE_KEY", target: "k2", removalId: "L1", attemptId: "at1", authorityId: "aR" })); }), sendL("v1", {})));
// ---- nothingAutomaticUnparks
const kpStart = (claimedAtStep = 0) => from(w => { w.local.parks.pk1 = pk({ state: "keep_pending" }); w.local.bindings.b1.state = "removal_parked"; keepHist(w, { mode: "orphan", claimedAtStep }); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep } as never; });
const swapX = { t: "auto.swap", source: "desktop", archiveId: "A", blind: false } as const;
const prepX = { t: "auto.restorePrepare", outcome: "committed" } as const;
const rr = (o: object = {}) => ({ atStep: 1, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: null, ...o }) as never;
const dropKp = (o: object = {}, over: (w: ReturnType<typeof base>) => void = () => {}) => (w: ReturnType<typeof base>) => { w.ghost.epoch = 1; w.ghost.restores.push(rr(o)); delete w.local.parks.pk1; delete w.local.keepOps.kp1; w.local.bindings.b1.state = "restored_unverified"; over(w); };
rej(N, "cm-nothingAutomaticUnparks-2-prep-drops-admitted-keep", ["r3.4d-cm"], run(kpStart(), [[prepX, dropKp()]]));
rej(N, "cm-nothingAutomaticUnparks-7-drop-keep-without-claim", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk({ state: "keep_pending" }); w.local.bindings.b1.state = "removal_parked"; }), [[swapX, dropKp()]]));
rej(N, "cm-nothingAutomaticUnparks-9-drop-keep-no-restore-record", ["r3.4d-cm"], run(kpStart(), [[swapX, w => { delete w.local.parks.pk1; delete w.local.keepOps.kp1; }]]));
rej(N, "cm-nothingAutomaticUnparks-10-drop-keep-stale-restore-epoch", ["r3.4d-cm"], run(kpStart(), [[swapX, dropKp({ ownerRequestStep: 5, epochAfter: 1 }, w => { w.ghost.epoch = 2; })]]));
rej(N, "cm-nothingAutomaticUnparks-11-drop-keep-system-restore-old-claim", ["r3.4d-cm"], run(kpStart(-2), [[swapX, dropKp({ ownerRequestStep: null })]]));
rej(N, "cm-nothingAutomaticUnparks-18-owner-moves-unnamed-park", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk(); w.local.parks.pk2 = pk({ parkId: "pk2", target: T_OP1, inboxId: null, provisionOpId: "op2", keyTargets: [] }); w.local.bindings.b1.state = "removal_parked"; w.ghost.tokens.push(tk()); }), [[removeA("tB", { target: T_I1, section: "parked" }), w => { w.local.parks.pk2.state = "remove_authorized"; }]]));
rej(N, "cm-nothingAutomaticUnparks-20-failed-owner-remove-unparks", ["r3.4d-cm"], run(parked(), [[removeA(null, { section: "parked", outcome: no("x") }), w => { delete w.local.parks.pk1; }]]));
rej(N, "cm-nothingAutomaticUnparks-24-failed-owner-keep-unparks", ["r3.4d-cm"], run(parked(), [[keepA({ outcome: no("x") }), w => { delete w.local.parks.pk1; }]]));
rej(N, "cm-nothingAutomaticUnparks-26-auto-park-to-remove-authorized", ["r3.4d-cm"], run(parked(), [[tick, w => { w.local.parks.pk1.state = "remove_authorized"; }]]));
rej(N, "cm-nothingAutomaticUnparks-27-auto-park-moved-out", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk({ state: "parked_evidence" }); w.local.bindings.b1.state = "removal_parked"; }), [[tick, w => { w.local.parks.pk1.state = "remove_authorized"; }]]));
rej(N, "cm-nothingAutomaticUnparks-30-auto-drops-evidence", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk({ state: "parked_evidence" }); w.local.bindings.b1.state = "removal_parked"; }), [[tick, w => { w.local.parks.pk1.state = "parked"; }]]));
acc(N, "cm-nothingAutomaticUnparks-29-auto-keeps-evidence-park", ["r3.4d-cm"], run(withRows(from(w => { w.local.parks.pk1 = pk({ state: "parked_evidence" }); w.local.bindings.b1.state = "removal_parked"; }), orphanRow()), [[tick]]));
rej(N, "cm-nothingAutomaticUnparks-35-auto-moves-parked-binding", ["r3.4d-cm"], run(parked(), [[tick, w => { w.local.bindings.b1.state = "active"; }]]));
rej(N, "cm-nothingAutomaticUnparks-41-auto-delete-parked-inbox", ["r3.4d-cm"], run(parked(), [[send(d("d1", "at1", { answer: "pending", removalId: null }))]]));
rej(N, "cm-nothingAutomaticUnparks-42-auto-revoke-parked-key", ["r3.4d-cm"], run(parked(), [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1" }))]]));
rej(N, "cm-nothingAutomaticUnparks-43-auto-restore-parked-inbox", ["r3.4d-cm"], run(parked(), [[send(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1" }))]]));
acc(N, "cm-nothingAutomaticUnparks-40-auto-poll-parked-inbox", ["r3.4d-cm"], run(withRows(parked(), orphanRow()), [[send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "poll" }))]]));
rej(N, "cm-nothingAutomaticUnparks-47-auto-creates-authority", ["r3.4d-cm"], run(base(), [[tick, w => { w.ghost.authorities.push(au()); }]]));
// ---- restorePrepParksEverything
rej(R, "cm-restorePrepParksEverything-44-lease-survives-prep", ["r3.4d-cm"], run(base(), [[prep, w => { w.local.leases.L1 = ls({ foreign: true }); }]]));
rej(R, "cm-restorePrepParksEverything-45-keepop-survives-prep", ["r3.4d-cm"], run(base(), [[prep, w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 0 } as never; }]]));
rej(R, "cm-restorePrepParksEverything-46-lifecycle-survives-prep", ["r3.4d-cm"], run(base(), [[prep, w => { w.local.pendingLifecycle.push({ botId: "b1" } as never); }]]));
rej(R, "cm-restorePrepParksEverything-36-inbox-id-lost", ["r3.4d-cm"], run(base(), [[prep, w => { w.local.bindings.b1.gen = { ...clone(G1), inboxId: null } as never; }]]));
rej(R, "cm-restorePrepParksEverything-37-op-lost", ["r3.4d-cm"], run(base(), [[prep, w => { w.local.bindings.b1.gen = { ...clone(G1), opId: null } as never; }]]));
rej(R, "cm-restorePrepParksEverything-40-carried-kept-key-lost", ["r3.4d-cm"], run(from(w => { w.carry = carry({ jobId: "js", keptKeys: { k5: "aK" } }); swappedStart(w); }), [[prep]]));
rej(R, "cm-restorePrepParksEverything-43-outstanding-delete-unguarded", ["r3.4d-cm"], run(from(w => { w.carry = carry({ jobId: "js", outstandingDeletes: [{ inboxId: "i1", attemptId: "at1" }] }); swappedStart(w); }), [[prep]]));
rej(R, "cm-restorePrepParksEverything-9-no-tables-carry-guard-lost", ["r3.4d-cm"], run(from(w => { w.local.tablesPresent = false; w.carry = carry({ jobId: "js", keepGuards: [gd()] }); swappedStart(w); }), [[prep]]));
rej(R, "cm-restorePrepParksEverything-12-parked-though-kept", ["r3.4d-cm"], run(from(w => { w.local.bindings.b1.state = "removing"; w.carry = carry({ jobId: "js", keepGuards: [gd()] }); swappedStart(w); }), [[prep, w => { w.local.keepGuards.i1 = gd(); w.local.parks.pk1 = pk(); }]]));
rej(R, "cm-restorePrepParksEverything-16-evidence-lost", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk({ state: "parked_evidence" }); w.local.bindings.b1.state = "removal_parked"; }), [[prep, w => { w.local.parks.pk1.state = "parked"; }]]));
acc(R, "cm-restorePrepParksEverything-15-evidence-kept", ["r3.4d-cm"], run(withRows(from(w => { w.local.parks.pk1 = pk({ state: "parked_evidence" }); w.local.bindings.b1.state = "removal_parked"; }), orphanRow()), [[prep]]));
rej(R, "cm-restorePrepParksEverything-20-binding-left-active", ["r3.4d-cm"], run(parked(), [[prep, w => { w.local.bindings.b1.state = "active"; }]]));
const k9w = (a: Parameters<typeof au>[0], rvk = false) => from(w => {
  w.local.keptKeys.k9 = "aKn"; w.ghost.epoch = 1; w.ghost.restores.push(rr({ blind: true, carryId: null }));
  w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: rvk ? "revoked" : "live" };
  w.ghost.authorities.push(au({ authorityId: "aKn", kind: "keep", tokenId: null, verifiedAtStep: 2, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k9"] } }));
  w.ghost.keptHighWater.k9 = "aKn"; if (a) w.ghost.authorities.push(au({ authorityId: "aRl", tokenId: null, genAtVerify: null, ...a }));
});
const dropK9: StepSpecX = [prepX, w => { delete w.local.keptKeys.k9; }];
type StepSpecX = [typeof prepX, (w: ReturnType<typeof base>) => void];
rej(R, "cm-restorePrepParksEverything-26-keep-authority-not-a-remove", ["r3.4d-cm"], run(k9w({ kind: "keep", verifiedAtStep: 3, scope: { target: T_I1, inboxId: "i1", keyIds: ["k9"] } }), [dropK9]));
rej(R, "cm-restorePrepParksEverything-27-remove-authority-other-key", ["r3.4d-cm"], run(k9w({ kind: "remove_bot_section", verifiedAtStep: 3, scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] } }), [dropK9]));
rej(R, "cm-restorePrepParksEverything-28-remove-authority-before-high-water", ["r3.4d-cm"], run(k9w({ kind: "remove_bot_section", verifiedAtStep: 1, scope: { target: T_I1, inboxId: "i1", keyIds: ["k9"] } }), [dropK9]));
rej(R, "cm-restorePrepParksEverything-23-unkept-key-revoked-lost", ["r3.4d-cm"], run(from(w => { w.flux.keys.k1.state = "revoked"; }), [[prepX, w => { w.local.savedKeys = {}; w.local.bindings.b1.gen = { ...clone(G1), emailKeyRef: null } as never; }]]));
rej(R, "cm-restorePrepParksEverything-21-carried-key-revoked-lost", ["r3.4d-cm"], run(from(w => { w.local.keptKeys.k9 = "aKn"; w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "revoked" }; w.carry = carry({ jobId: "js", keyIds: ["k1", "k9"] }); swappedStart(w); }), [[prepX, w => { delete w.local.keptKeys.k9; }]]));
rej(R, "cm-restorePrepParksEverything-32-active-lease-inbox-lost", ["r3.4d-cm"], run(from(w => { w.local.leases.L7 = ls({ removalId: "L7", target: "inbox:i7", inboxId: "i7", botId: null, foreign: false }); }), [[prep, w => { w.local.leases = {}; w.local.parks.pk7 = pk({ parkId: "pk7", botId: null, target: "inbox:i7", inboxId: null, provisionOpId: null, keyTargets: [] }); }]]));
acc(R, "cm-restorePrepParksEverything-34-foreign-lease-inbox-dropped", ["r3.4d-cm"], run(from(w => { w.local.leases.LF = ls({ removalId: "LF", target: "inbox:i9", inboxId: "i9", botId: null, foreign: true }); w.carry = carry({ jobId: "js", inboxIds: ["i1", "i9"] }); swappedStart(w); }), [[prep, w => { sysPrep(w); w.local.leases = {}; }]]));
acc(R, "cm-restorePrepParksEverything-3-ordinary-boot-keeps-lease", ["r3.4d-cm"], run(from(w => { remHist(w); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "authorized" }); w.proc.phase = "boot_prep"; }), [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.proc.phase = "running"; }]]));
// ---- blindRestoreIsOwnerVisible
const rc = (o: object) => [[tick, (w: ReturnType<typeof base>) => { w.surface = [row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }], ...o } as never)]; }]] as never;
rej(B, "cm-blindRestoreIsOwnerVisible-4-hidden-row", ["r3.4d-cm"], run(blind(false), rc({ visible: false })));
rej(B, "cm-blindRestoreIsOwnerVisible-5-wrong-section", ["r3.4d-cm"], run(blind(false), rc({ section: "parked" })));
rej(B, "cm-blindRestoreIsOwnerVisible-6-no-actions", ["r3.4d-cm"], run(blind(false), rc({ actions: [] })));
rej(B, "cm-blindRestoreIsOwnerVisible-7-disabled-action", ["r3.4d-cm"], run(blind(false), rc({ actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: false }] })));
rej(B, "cm-blindRestoreIsOwnerVisible-8-other-action", ["r3.4d-cm"], run(blind(false), rc({ actions: [{ kind: "keep", tokenId: null, enabled: true }] })));
rej("everyReplacementPreparedBeforeStore", "cm-everyReplacementPreparedBeforeStore-1-store-open-unprepared", ["r3.4d-cm"], run(replaced(false), [[tick, w => { w.proc.phase = "store_open"; }]]));

export const PIN = 67;

// ---- cm round 2 (builder 2)
import { carriedRemoval, parkedTok as pTok, admitKeepNow as admitK, captureK as capK, sysArm as sArm, pendingPrep as pPrep } from "./spec.ts";
const keepSwap = (state: "keep_pending" | "key_release", req: number | null = null) => [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }, (w: ReturnType<typeof base>) => {
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: req, jobId: w.fs.restoreJob?.id ?? null } as never);
  w.local.parks.pk1.state = state; pPrep(w, true); w.proc.phase = "boot_prep"; }] as never;
acc(N, "cm-nothingAutomaticUnparks-5-swap-keeps-keep-pending", ["r3.4d-cm"], run(pTok(), [admitK(), sArm(), capK, keepSwap("keep_pending")]));
acc(N, "cm-nothingAutomaticUnparks-4-swap-keeps-admitted-keep", ["r3.4d-cm"], run(pTok(), [admitK(), sArm(), capK, keepSwap("keep_pending")]));
acc(N, "cm-nothingAutomaticUnparks-6-swap-finishes-keep-key-release", ["r3.4d-cm"], run(pTok(), [admitK(), sArm(), capK, keepSwap("key_release")]));
rej(N, "cm-nothingAutomaticUnparks-25-auto-deletes-parked-park", ["r3.4d-cm"], run(parked(), [[tick, w => { delete w.local.parks.pk1; }]]));
acc(N, "cm-nothingAutomaticUnparks-33-auto-removes-parked-bots-binding", ["r3.4d-cm"], run(withRows(parked(), orphanRow()), [[tick, w => { delete w.local.bindings.b1; }]]));
acc(N, "cm-nothingAutomaticUnparks-37-preexisting-lease-on-parked-target", ["r3.4d-cm"], run(withRows(from(w => { remHist(w); w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; w.local.leases.L1 = ls({ phase: "authorized" } as never); }), orphanRow()), [[tick]]));
acc(N, "cm-nothingAutomaticUnparks-38-new-lease-other-target-while-parked", ["r3.4d-cm"], run(withRows(from(w => { remHist(w); w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; }), orphanRow()), [[tick, w => { w.local.leases.L2 = ls({ removalId: "L2", target: "inbox:i2", inboxId: "i2", botId: "b2", phase: "authorized" } as never); }]]));
acc(R, "cm-restorePrepParksEverything-41-outstanding-delete-guard-only", ["r3.4d-cm"], run(from(w => { w.local.bindings.b1.state = "removing"; w.carry = carry({ keepGuards: [gd()], outstandingDeletes: [{ inboxId: "i1", attemptId: "at1" }] }); swappedStart(w); }), [[prep, w => { sysPrep(w); w.local.bindings.b1.state = "restored_unverified"; w.local.keepGuards.i1 = gd(); }]]));
acc(R, "cm-restorePrepParksEverything-42-outstanding-delete-park-only", ["r3.4d-cm"], run(from(w => { Object.assign(w, carriedRemoval()); w.carry!.outstandingDeletes = [{ inboxId: "i1", attemptId: "at1" }]; swappedStart(w); }), [[prep, w => { sysPrep(w); w.surface = [orphanRow()]; w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; }]]));
