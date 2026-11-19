// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g5 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from];

import { OWN, T_I1, okO, d, tokB, keepHist, swapA, blind as blindFence, phase, arm, clearJob } from "./spec.ts";
export const WITNESSES_G5: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G5);
void rej; void acc;
void [phase, arm, clearJob];
const CM_OA = "ownerAuthorityForEveryDestructiveSend", CM_OC = "outgoingCapturedBeforeSwap", CM_GD = "guardDiesOnFreshRemove", TAG = ["r3.4d-cm"];

// ---------- guardDiesOnFreshRemove ----------
// #1 (stricter): a valid owner Keep (untokened, live) creates a keep authority on i1; a Keep is no Remove, so the live guard stays.
acc(CM_GD, "cm-guardDiesOnFreshRemove-1-valid-keep-keeps-guard", TAG, run(from(w => { w.local.keepGuards.i1 = gd(); }),
  [[{ t: "owner.keep", principal: OWN, botId: "b1", target: T_I1, tokenId: null, mode: "live", outcome: okO }, w => { w.ghost.authorities.push(au({ authorityId: "aKn", kind: "keep", tokenId: null, genAtVerify: null })); w.ghost.keeps.push(kr({ authorityId: "aKn", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aKn", claimedAtStep: 1 }; }]]));

// ---------- ownerAuthorityForEveryDestructiveSend ----------
const auth = (o: Parameters<typeof au>[0] = {}) => from(w => { tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0, ...o })); });
const rev = (o: Parameters<typeof rq>[0] extends infer P ? Partial<P> : never = {}) => send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", authorityId: "aR", purpose: "rotation", ...o } as never));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-1-apply-unsent", TAG, run(base(), [[apply("nobody-sent-this")]])); // also closes #2
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-4-revoke-no-authority", TAG, run(base(), [[rev({ authorityId: "zz" })]]));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-5-delete-no-authority", TAG, run(base(), [[send(d("d1", "at1", { authorityId: "zz", answer: "pending" }))]]));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-7-earlier-epoch", TAG, run(from(w => { tokB(w); w.ghost.epoch = 1; w.ghost.authorities.push(au({ verifiedAtStep: 0, epoch: 0 })); }), [[send(d("d1", "at1", { answer: "pending" }))]]));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-10-delete-outside-scope", TAG, run(auth({ scope: { target: "t2", inboxId: "i2", keyIds: ["k1"] } }), [[send(d("d1", "at1", { answer: "pending" }))]]));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-11-revoke-outside-scope", TAG, run(auth({ kind: "remove_key_only" }), [[rev({ target: "k2" })]]));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-12-revoke-key-in-use", TAG, run(auth({ kind: "remove_orphan", botId: null }), [[rev()]]));
rej(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-16-rotation-revokes-saved-key", TAG, run(from(w => { tokB(w); w.local.savedKeys.b1 = "k1"; w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: 0 })); }), [[rev({ authorityId: "aRot" })]]));
const rot = (m?: (w: ReturnType<typeof base>) => void) => from(w => { tokB(w); w.local.savedKeys.b1 = "k1"; w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: -1, scope: { target: T_I1, inboxId: "i1", keyIds: ["k2"] } })); m?.(w); });
acc(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-15-rotation-revokes-other-key", TAG, run(rot(), [[rev({ authorityId: "aRot", target: "k2" })]]));
acc(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-17-keep-after-nonremove-authority", TAG, run(rot(w => keepHist(w, { claimedAtStep: 0 }, -1)), [[rev({ authorityId: "aRot", target: "k2" })]]));
const delLease = (m?: (w: ReturnType<typeof base>) => void) => from(w => { tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: -1 })); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); m?.(w); });
acc(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-19-keep-on-other-target", TAG, run(delLease(w => keepHist(w, { claimedAtStep: 0, target: "t2", inboxId: "i2" }, -1)), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc(CM_OA, "cm-ownerAuthorityForEveryDestructiveSend-20-keep-older-than-remove", TAG, run(delLease(w => { w.ghost.authorities[w.ghost.authorities.length - 1]!.verifiedAtStep = 0; keepHist(w, { claimedAtStep: -1 }, -2); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- outgoingCapturedBeforeSwap ----------
const swapBlind = { t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: true } as never;
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-3-live-db-declared-blind", TAG, run(from(w => { w.carry = carry(); }), [[swapBlind]]));
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-5-carry-captured-at-swap-step", TAG, run(from(w => { w.carry = carry({ capturedAtStep: 1 }); }), [[swapA]]));
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-6-carry-for-other-epoch", TAG, run(from(w => { w.carry = carry({ forEpoch: 1 }); }), [[swapA]]));
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-11-carry-drops-blind-fence", TAG, run(from(w => { Object.assign(w, blindFence(false)); w.carry = carry({ forEpoch: 1 }); }), [[swapA]]));
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-12-no-db-swap-not-blind", TAG, run(from(w => { w.local.tablesPresent = false; }), [[swapA]]));
acc(CM_OC, "cm-outgoingCapturedBeforeSwap-2-tables-absent-blind-swap", TAG, run(from(w => { w.local.tablesPresent = false; arm(w, "A", "cloud_reset"); }), [[swapBlind, w => { w.ghost.epoch = 1; phase(w, "swapped"); w.proc.phase = "boot_prep"; w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "cloud_reset", archiveId: "A", blind: true, carryId: null, ownerRequestStep: null, jobId: "j0" }); }]]));
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-14-carry-deleted-by-tick-in-aborted-job", TAG, run(from(w => { w.carry = carry(); arm(w, "A"); phase(w, "aborted"); }), [[tick, w => { w.carry = null; }]]));
rej(CM_OC, "cm-outgoingCapturedBeforeSwap-15-carry-deleted-by-clear-of-armed-job", TAG, run(from(w => { w.carry = carry(); arm(w, "A"); }), [[{ t: "auto.restoreJobClear" }, w => { w.carry = null; w.fs.restoreJob = null; }]]));


export const PIN = 56;

// ---------- keptKeysProtected ----------
import { noLiveStart, ownerRestoreNoLive, k9Start, k9Sc } from "./spec.ts";
const CM_KK = "keptKeysProtected";
const kk = (m?: (w: ReturnType<typeof base>) => void) => from(w => { Object.assign(w, noLiveStart()); m?.(w); });
const k9B = (m?: (w: ReturnType<typeof base>) => void) => from(w => {
  w.ghost.authorities.push(au({ authorityId: "aKo", kind: "keep", tokenId: null, verifiedAtStep: -4, genAtVerify: null, scope: k9Sc }), au({ authorityId: "aKn", kind: "keep", tokenId: null, verifiedAtStep: -2, genAtVerify: null, scope: k9Sc }));
  w.local.keptKeys.k9 = "aKn"; m?.(w); });
const keepK9 = (id: string, at: number) => au({ authorityId: id, kind: "keep", tokenId: null, verifiedAtStep: at, genAtVerify: null, scope: k9Sc });
const remK9 = (id: string, at: number, kind: "remove_key_only" | "remove_bot_section" = "remove_key_only") => au({ authorityId: id, kind, tokenId: null, verifiedAtStep: at, genAtVerify: null, scope: k9Sc });
const revK9 = (authorityId: string) => send(rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId }));
const swapNB: StepSpecLike = [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }];
type StepSpecLike = Parameters<typeof run>[1][number];
// #6 (weaker): a net.answer taken while the restore window is open (job armed).
rej(CM_KK, "cm-keptKeysProtected-6-window-answer-taken", TAG, run(kk(), [ownerRestoreNoLive, [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }]]));
// #27 (weaker): a key marked kept under an authority id nobody recorded.
rej(CM_KK, "cm-keptKeysProtected-27-kept-under-unknown-authority", TAG, run(base(), [[tick, w => { w.local.keptKeys.k1 = "zz"; }]]));
// #29 (weaker): a key marked kept under a Keep whose scope names another key.
rej(CM_KK, "cm-keptKeysProtected-29-kept-under-keep-of-other-key", TAG, run(from(w => { w.ghost.authorities.push(au({ authorityId: "aW", kind: "keep", tokenId: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k2"] } })); }), [[tick, w => { w.local.keptKeys.k1 = "aW"; }]]));
// #33 (weaker): a blind swap, a carry that does NOT hold k9, the store left open: the archive's older Keep for k9 is judged against the high-water.
rej(CM_KK, "cm-keptKeysProtected-33-swap-older-keep-key-not-carried", TAG, run(kk(w => { w.local.keptKeys.k9 = "aKn"; w.carry = carry({ keptKeys: {} }); }), [[{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => { w.local.keptKeys.k9 = "aKo"; }]]));
// #36 (weaker): a consuming prep sets carried k9 to a Keep that is neither the carried one nor at the high-water (newer than the carry, older than the live entry).
rej(CM_KK, "cm-keptKeysProtected-36-prep-sets-other-than-carried", TAG, run(from(w => { Object.assign(w, k9Start(true)); w.ghost.authorities.push(keepK9("aKm", -3)); }),
  [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null; w.local.keptKeys.k9 = "aKm"; }]]));
// #44 (weaker): a non-swap step while the process is in the swap-window phase gets no exemption from the high-water rule.
rej(CM_KK, "cm-keptKeysProtected-44-tick-older-keep-in-boot-prep-phase", TAG, run(kk(w => { w.local.keptKeys.k9 = "aKn"; w.proc.phase = "boot_prep"; }), [[tick, w => { w.local.keptKeys.k9 = "aKo"; }]]));
// #60 (weaker): an unconfirmed kept key dropped under a Remove older than its mark (the drop is licensed by line 1556 only), no revoke.
rej(CM_KK, "cm-keptKeysProtected-60-unconfirmed-dropped-old-remove", TAG, run(k9B(w => { w.ghost.authorities.push(remK9("aRm", 1)); w.local.unconfirmedKept = { k9: 3 }; w.ghost.keptHighWater.k9 = "aKn"; w.ghost.authorities.push(keepK9("aKy", 6), au({ authorityId: "aR3", kind: "remove_key_only", tokenId: null, verifiedAtStep: 6, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k2"] } })); }), [[tick, w => { delete w.local.keptKeys.k9; }]]));
// #64 (weaker): an unconfirmed kept key re-attributed to a Keep that is not newer than its mark (but is at the high-water).
rej(CM_KK, "cm-keptKeysProtected-64-unconfirmed-reattributed-stale-keep", TAG, run(k9B(w => { w.ghost.authorities.push(keepK9("aKm", -1)); w.local.unconfirmedKept = { k9: 3 }; }), [[tick, w => { w.local.keptKeys.k9 = "aKm"; }]]));
// #84 (weaker): a REVOKE_KEY for an unconfirmed (not kept) key under an authority nobody recorded.
rej(CM_KK, "cm-keptKeysProtected-84-unconfirmed-revoke-unknown-authority", TAG, run(from(w => { w.local.unconfirmedKept = { k9: 3 }; }), [[revK9("nope")]]));
// #85 (weaker): the same revoke under a Keep authority verified after the mark: a Keep is no Remove.
rej(CM_KK, "cm-keptKeysProtected-85-unconfirmed-revoke-under-keep", TAG, run(from(w => { w.local.unconfirmedKept = { k9: 3 }; w.ghost.authorities.push(keepK9("aKx", 5)); }), [[revK9("aKx")]]));
// #90 (weaker): a non-blind swap whose carry holds k9 but not its unconfirmed mark.
rej(CM_KK, "cm-keptKeysProtected-90-swap-carry-lacks-mark", TAG, run(k9B(w => { w.local.unconfirmedKept = { k9: 3 }; w.carry = carry({ keptKeys: { k9: "aKn" } }); }), [swapNB]));
// #107 (weaker): a kept key (no ghost high-water) dropped under a later Remove: the entry vanishes and its high-water is lost.
rej(CM_KK, "cm-keptKeysProtected-107-highwater-lost-on-drop", TAG, run(k9B(w => { w.ghost.authorities.push(remK9("aRm", 1)); }), [[tick, w => { delete w.local.keptKeys.k9; }]]));
// #113 (weaker): a non-blind swap with a kept key and no carry at all.
rej(CM_KK, "cm-keptKeysProtected-113-swap-no-carry", TAG, run(k9B(), [swapNB]));
// #122 (weaker): the window-ending prep leaves an UNCARRIED kept key below its high-water, the job's carry holding other keys only.
rej(CM_KK, "cm-keptKeysProtected-122-prep-uncarried-below-highwater", TAG, run(from(w => { Object.assign(w, k9Start(true)); w.local.keptKeys.k9 = "aKo"; w.ghost.keptHighWater.k9 = "aKn"; w.carry!.keptKeys = {}; }),
  [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null; }]]));
// #138 (weaker): a REVOKE_KEY of a kept key under an authority nobody recorded.
rej(CM_KK, "cm-keptKeysProtected-138-kept-revoke-unknown-authority", TAG, run(k9B(), [[revK9("nope")]]));
// #139 (weaker): the same revoke under a non-Remove authority verified after the Keep.
rej(CM_KK, "cm-keptKeysProtected-139-kept-revoke-under-nonremove", TAG, run(k9B(w => { w.ghost.authorities.push(au({ authorityId: "aX", kind: "rotate_reconnect", tokenId: null, verifiedAtStep: 5, genAtVerify: null, scope: k9Sc })); }), [[revK9("aX")]]));
// #140 (weaker): a kept key whose entry names no recorded Keep (no high-water to judge by), revoked under a valid Remove.
rej(CM_KK, "cm-keptKeysProtected-140-kept-revoke-no-keep-record", TAG, run(from(w => { w.local.keptKeys.k9 = "ghostKeep"; w.ghost.authorities.push(remK9("aRm", 5)); }), [[revK9("aRm")]]));

// #129 #130 #131 (?): a kept key dropped with no revoke, beside three look-alike removals (a Keep naming k9 verified later; a Remove naming k2 verified later; a Remove naming k9 verified BEFORE the Keep). None licenses the drop.
rej(CM_KK, "cm-keptKeysProtected-129-drop-lookalike-removals", TAG, run(k9B(w => { w.ghost.keptHighWater.k9 = "aKn";
  w.ghost.authorities.push(keepK9("aKz", 6), au({ authorityId: "aR2", kind: "remove_key_only", tokenId: null, verifiedAtStep: 6, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k2"] } }), remK9("aRold", -3)); }), [[tick, w => { delete w.local.keptKeys.k9; }]]));

// ---------- batch 2 (continuation builder) ----------
const swapNL = (keys: Record<string, string>): StepSpecLike => [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => {
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null, ownerRequestStep: w.step - 1, jobId: w.fs.restoreJob?.id ?? null });
  w.local.keptKeys = { ...keys }; w.fs.messagesDbPresent = true; phase(w, "swapped"); w.proc.phase = "boot_prep"; }];
const crashBoot: StepSpecLike[] = [
  [{ t: "fault.crash", at: "W3_swap_record", when: "after" }, w => { w.proc.phase = "down"; }],
  [{ t: "auto.boot" }, w => { w.proc.phase = "boot_prep"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; }]];
const bootPrepSet = (set: Record<string, string>, m?: (w: ReturnType<typeof base>) => void): StepSpecLike => [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); Object.assign(w.local.keptKeys, set); w.proc.phase = "store_open"; m?.(w); }];
const mkAuth = (authorityId: string, kind: "keep" | "remove_key_only", at: number, keyIds: string[]) => au({ authorityId, kind, tokenId: null, verifiedAtStep: at, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds } });
// #22 (?): a FOREIGN carry (not the job's own) must not make the prep a carry-consumer; the entry is set to the carried older Keep with the key marked unconfirmed (so the clamp passes), and no ghost high-water is recorded that would hide it.
rej(CM_KK, "cm-keptKeysProtected-22-foreign-carry-prep-older-keep", TAG, run(from(w => { Object.assign(w, k9Start(true)); w.carry!.jobId = "zz"; }),
  [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null; w.local.keptKeys.k9 = "aKo"; w.ghost.keptHighWater.k9 = "aKn"; w.local.unconfirmedKept = { k9: w.step }; }]]));
// #37 (stricter): the boot prep clamps k9 (already kept, under the archive's older Keep) to the high-water Keep while an owner Remove naming k9, verified later, is on record: k9 was already kept, so nothing is re-kept.
acc(CM_KK, "cm-keptKeysProtected-37-boot-clamp-with-later-remove-on-record", TAG, run(from(w => { Object.assign(w, noLiveStart()); w.ghost.authorities.push(remK9("aRl", -1, "remove_bot_section")); }),
  [ownerRestoreNoLive, swapNL({ k9: "aKo" }), ...crashBoot, bootPrepSet({ k9: "aKn" })]));
// #39 #41 #42 #43 (stricter, ?): a boot prep newly creates k9 under the Keep at the high-water; three look-alikes are on record (a Keep naming k9 verified later, a Remove naming k2 verified later, a Remove naming k9 verified BEFORE the Keep); none is a later Remove naming k9.
acc(CM_KK, "cm-keptKeysProtected-39-boot-prep-recreates-k9-lookalike-removals", TAG, run(from(w => { Object.assign(w, noLiveStart());
    w.ghost.authorities.push(mkAuth("aKz", "keep", 6, ["k9"]), mkAuth("aR2", "remove_key_only", 6, ["k2"]), mkAuth("aRold", "remove_key_only", -3, ["k9"])); }),
  [ownerRestoreNoLive, swapNL({}), ...crashBoot, bootPrepSet({ k9: "aKn" })]));
const fluxRev = (w: ReturnType<typeof base>) => { w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "revoked" }; };
// #59 (stricter): an unconfirmed kept key (mark step 3) dropped with a Remove naming it verified after the mark (6) and no revoke: the drop is licensed by the Remove.
acc(CM_KK, "cm-keptKeysProtected-59-unconfirmed-dropped-fresh-remove-no-revoke", TAG, run(k9B(w => { w.local.unconfirmedKept = { k9: 3 }; w.ghost.keptHighWater.k9 = "aKn"; w.ghost.authorities.push(remK9("aRf", 6)); }), [[tick, w => { delete w.local.keptKeys.k9; delete w.local.unconfirmedKept; }]]));
// #58 (stricter): the same entry dropped because its key is revoked at Flux, with no Remove after the mark on record.
acc(CM_KK, "cm-keptKeysProtected-58-unconfirmed-dropped-revoked-no-remove", TAG, run(k9B(w => { w.local.unconfirmedKept = { k9: 3 }; w.ghost.keptHighWater.k9 = "aKn"; }), [[tick, w => { delete w.local.keptKeys.k9; delete w.local.unconfirmedKept; fluxRev(w); }]]));
// #56 probe (stricter): a mark on a key with no kept entry at all (dangling mark), key neither revoked nor removed.
acc(CM_KK, "cm-keptKeysProtected-56-dangling-mark-no-entry", TAG, run(from(w => { w.local.unconfirmedKept = { k9: 3 }; }), [[tick]]));
// #82 #136 (?, stricter): a request that is not a REVOKE_KEY (an inbox look-up) whose target field names the kept (and unconfirmed) key is no revoke and needs no Remove. Reachability note for the step 4 reviewer: the target of a look-up is an inbox id; this history assumes an inbox id equal to a key id.
acc(CM_KK, "cm-keptKeysProtected-82-nonrevoke-send-targets-kept-key", TAG, run(k9B(w => { w.local.unconfirmedKept = { k9: 3 }; w.ghost.keptHighWater.k9 = "aKn"; }), [[send(rq({ requestId: "s9", kind: "GET_INBOX", target: "k9", purpose: "removal" }))]]));
// #78 (stricter): the capture of an outgoing database whose unconfirmed mark sits on a key with no kept entry (a mark left behind by a departed entry): there is no kept key whose mark must be carried.
acc(CM_KK, "cm-keptKeysProtected-78-capture-mark-without-entry", TAG, run(from(w => { w.local.unconfirmedKept = { k9: 3 }; arm(w, "A"); }), [[{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ capturedAtStep: w.step - 1, jobId: w.fs.restoreJob!.id }); phase(w, "captured"); }]]));
// #96 (stricter): the window-ending prep consumes a carry whose mark sits on a key the carry does not hold (no kept entry to restore): the key stays out of keptKeys and its mark is not re-created.
acc(CM_KK, "cm-keptKeysProtected-96-prep-carried-mark-without-entry", TAG, run(from(w => { Object.assign(w, k9Start(true)); w.local.keptKeys = {}; w.carry!.keptKeys = {}; w.carry!.unconfirmedKept = { k9: 3 }; }),
  [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null; }]]));
// #98 (stricter): the consuming prep keeps carried k9 (mark 3) under a Keep the owner gave after the mark (step 6): that fresh Keep ends the mark, so the prep need not restore it.
acc(CM_KK, "cm-keptKeysProtected-98-prep-fresh-keep-ends-carried-mark", TAG, run(from(w => { Object.assign(w, k9Start(true)); w.carry!.unconfirmedKept = { k9: 3 }; w.carry!.keptKeys = { k9: "aKz" }; w.ghost.authorities.push(keepK9("aKz", 6)); w.ghost.keptHighWater.k9 = "aKn"; }),
  [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null; w.local.keptKeys.k9 = "aKz"; w.ghost.keptHighWater.k9 = "aKz"; }]]));
// #74 (weaker): a tick that creates an unconfirmed mark dated in the past (a mark is born only by a swap or a window-ending prep).
rej(CM_KK, "cm-keptKeysProtected-74-tick-creates-past-mark", TAG, run(k9B(), [[tick, w => { w.local.unconfirmedKept = { k9: 0 }; }]]));
// #75 (weaker): a swap that creates a mark stamped at its own step (not an earlier mark brought by the archive).
rej(CM_KK, "cm-keptKeysProtected-75-swap-creates-mark-at-own-step", TAG, run(from(w => { w.carry = carry(); arm(w, "A"); }), [[swapA, w => { w.local.unconfirmedKept = { k9: w.step }; }]]));
// #89 #112 (?, stricter): a BLIND swap (no live outgoing database) beside a kept, unconfirmed k9 with no carry: a blind swap owes no carry (the archive brings the same Keep).
acc(CM_KK, "cm-keptKeysProtected-89-blind-swap-kept-key-no-carry", TAG, run(kk(w => { w.local.keptKeys.k9 = "aKn"; w.local.unconfirmedKept = { k9: 3 }; }), [ownerRestoreNoLive, swapNL({ k9: "aKn" })]));
// #123 (stricter): a boot prep ends the window leaving k9 under a recorded Keep whose high-water the ghost never recorded: there is no high-water to clamp to.
acc(CM_KK, "cm-keptKeysProtected-123-boot-prep-no-highwater-recorded", TAG, run(from(w => { Object.assign(w, noLiveStart()); delete w.ghost.keptHighWater.k9; }),
  [ownerRestoreNoLive, swapNL({}), ...crashBoot, bootPrepSet({ k9: "aKn" })]));
// reconfirm row (view of an unconfirmed kept key): only a visible "bot"-section row carrying the line for the key's bot counts.
import { RECONFIRM_KEPT_LINE } from "../invariants.current.ts";
const rcView = (r: Parameters<typeof row>[0]): StepSpecLike => [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [row({ section: "bot", botId: "b1", line: RECONFIRM_KEPT_LINE, ...r })]; }];
const rcStart = () => k9B(w => { w.local.unconfirmedKept = { k9: 3 }; w.local.savedKeys.b1 = "k9"; w.ghost.keptHighWater.k9 = "aKn"; });
// #101 (weaker): the only reconfirm row is not visible.
rej(CM_KK, "cm-keptKeysProtected-101-reconfirm-row-invisible", TAG, run(rcStart(), [rcView({ visible: false })]));
// #102 (weaker): the only reconfirm row sits in another section.
rej(CM_KK, "cm-keptKeysProtected-102-reconfirm-row-wrong-section", TAG, run(rcStart(), [rcView({ section: "key_only" })]));
// #104 (weaker): the only reconfirm row is for another bot.
rej(CM_KK, "cm-keptKeysProtected-104-reconfirm-row-other-bot", TAG, run(rcStart(), [rcView({ botId: "b2" })]));
