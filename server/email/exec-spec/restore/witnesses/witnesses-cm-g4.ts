// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g4 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import type { World, Action } from "../invariants.current.ts";
import { RESTORE_FINISHING_LINE, LOOK_AGAIN_LINE } from "../invariants.current.ts";
import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
import { parkedTok, removeA as removeAk, delStart, delOk, deleteB1Work, pkE, leaseIn, pendingRow, T_OP1, ADDR, G1, clone } from "./spec.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from];

export const WITNESSES_G4: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G4);
void rej; void acc;


// ---------- g4 batch 1 ------------------------------------------------------------------------------------------------------------------
const NOW = 1_000_000_000;
const OWN = "owner_desktop" as const;
const T_I1 = "inbox:i1";
const no = (code: string) => ({ ok: false as const, code });
const keepA = (o: Record<string, unknown> = {}) => ({ t: "owner.keep", principal: OWN, botId: "b1", target: T_I1, tokenId: null, mode: "live", outcome: { ok: true }, ...o }) as never;
const tryA = (o: Record<string, unknown> = {}) => ({ t: "owner.tryAgainNow", principal: OWN, botId: "b1", target: T_I1, outcome: { ok: true }, ...o }) as never;
const restoreA = (o: Record<string, unknown> = {}) => ({ t: "owner.restore", source: "desktop", archiveId: "B", outcome: no("restore_finishing"), ...o }) as never;
const finLine = (o: Record<string, unknown> = {}) => row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FINISHING_LINE, actions: [], ...o });

// keepNetworkNeedsClaim#4 (weaker): the Keep op is open but for ANOTHER inbox: the send must still be refused.
rej("keepNetworkNeedsClaim", "cm-keepNetworkNeedsClaim-4-op-names-other-inbox", ["r3.4d-cm"], run(from(w => {
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: "inbox:i2", inboxId: "i2", mode: "live", authorityId: "aK", claimedAtStep: 0 }; }),
  [[send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1" }))]]));

// keptStaysKept: Keep succeeded at step 1; a park of that target is created by an automatic step.
const keptAt1 = (restoreAt: number | null) => from(w => {
  w.ghost.keeps.push(kr({ succeededAtStep: 1, succeededAtMs: NOW }));
  if (restoreAt !== null) { w.ghost.restores.push({ atStep: restoreAt, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: null, ownerRequestStep: null, jobId: null }); w.ghost.epoch = 1; w.ghost.preparedEpochs.push(1); } });
const park = (origin: "restore" | "legacy" | "kept") => (w: World) => { w.local.parks.pk1 = pk({ origin }); w.local.bindings.b1.state = "removal_parked"; w.surface = [row({ section: "parked", actions: [{ kind: "keep", tokenId: null, enabled: true }, { kind: "remove", tokenId: null, enabled: true }] })]; };
// #2 (stricter): a restore swapped at step 0, then the Keep's in-flight confirmation landed at step 1 (swap BEFORE the success); the prep parks the target.
acc("keptStaysKept", "cm-keptStaysKept-2-prep-parks-kept-after-earlier-swap", ["r3.4d-cm"], run(keptAt1(0), [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { park("restore")(w); w.ghost.epoch = 1; w.ghost.preparedEpochs.push(1); }]]));
// #3 (stricter): the same, the park is created by the swap step itself.
// #4 (callback, stricter side): a Keep claimed but not yet succeeded is no kept target: an automatic park of it is fine.
acc("keptStaysKept", "cm-keptStaysKept-4-keep-not-succeeded-park-ok", ["r3.4d-cm"], run(from(w => { w.ghost.keeps.push(kr({ succeededAtStep: null })); }), [[tick, park("restore")]]));
// #7 (stricter): a restore happened AFTER the Keep succeeded; an automatic tick then parks the target (restore origin).
acc("keptStaysKept", "cm-keptStaysKept-7-park-after-later-restore", ["r3.4d-cm"], run(keptAt1(4), [[tick, park("restore")]]));
// #8 (stricter): an automatic step parks the kept target with origin "kept" (the comment's allowed shape).
acc("keptStaysKept", "cm-keptStaysKept-8-park-origin-kept", ["r3.4d-cm"], run(keptAt1(null), [[tick, park("kept")]]));

// admissionPinned: finished-job restore refusal (r3.4c), lines 2012-2016.
const prepared = (w: World, ph: "prepared" | "aborted" | "armed" = "prepared") => { w.fs.restoreJob = { id: "j1", archiveId: "A", source: "desktop", phase: ph, at: 0 }; };
const fin = from(w => prepared(w));
rej("admissionPinned", "cm-admissionPinned-7-finished-refusal-changes-state", ["r3.4d-cm"], run(fin, [[restoreA(), w => { w.local.savedKeys = {}; w.surface = [finLine()]; }]]));
rej("admissionPinned", "cm-admissionPinned-8-finished-refusal-no-line", ["r3.4d-cm"], run(fin, [[restoreA()]]));
rej("admissionPinned", "cm-admissionPinned-9-finished-refusal-line-invisible", ["r3.4d-cm"], run(fin, [[restoreA(), w => { w.surface = [finLine({ visible: false })]; }]]));
rej("admissionPinned", "cm-admissionPinned-10-finished-refusal-line-wrong-section", ["r3.4d-cm"], run(fin, [[restoreA(), w => { w.surface = [finLine({ section: "bot" })]; }]]));
rej("admissionPinned", "cm-admissionPinned-11-finished-refusal-wrong-line", ["r3.4d-cm"], run(fin, [[restoreA(), w => { w.surface = [finLine({ line: "Something else." })]; }]]));
// #3 (stricter): a job still ARMED (window open, not finished): the window branch accepts a restore_finishing refusal with no home line.

// #74 / #92 (stricter): a non-owner principal's refused Keep / Remove has no owner precondition to check.
acc("admissionPinned", "cm-admissionPinned-74-nonowner-keep-refused", ["r3.4d-cm"], run(base(), [[keepA({ principal: "bot_credential", outcome: no("not_owner") })]]));
acc("admissionPinned", "cm-admissionPinned-92-nonowner-remove-refused", ["r3.4d-cm"], run(base(), [[{ t: "owner.remove", principal: "bot_credential", botId: "b1", target: T_I1, tokenId: null, section: "bot", outcome: no("not_owner") } as never]]));
// #81 / #94 (weaker): a refusal code outside the legal list that happens to be an inherited object key (pre[code] is truthy).
rej("admissionPinned", "cm-admissionPinned-81-keep-refused-inherited-key-code", ["r3.4d-cm"], run(base(), [[keepA({ outcome: no("toString") })]]));
rej("admissionPinned", "cm-admissionPinned-94-remove-refused-inherited-key-code", ["r3.4d-cm"], run(base(), [[{ t: "owner.remove", principal: OWN, botId: "b1", target: T_I1, tokenId: null, section: "bot", outcome: no("toString") } as never]]));

// #100 / #104 (stricter): nothing pending, Try again now refused: legal.  #101 / #103 (stricter): work pending, Try again now ok: legal.
acc("admissionPinned", "cm-admissionPinned-100-try-again-refused-nothing-pending", ["r3.4d-cm"], run(base(), [[tryA({ outcome: no("unavailable") })]]));
// #105 (weaker): Try again now "succeeds" with nothing pending: must still be rejected.
rej("admissionPinned", "cm-admissionPinned-105-try-again-ok-nothing-pending", ["r3.4d-cm"], run(base(), [[tryA()]]));


// ---------- g4 batch 2 (fresh builder) ---------------------------------------------------------------------------------------------------
const NOWB = NOW;
const parked = () => { const w = base(); w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; return w; };
const refKeep = (o: Record<string, unknown>) => keepA({ mode: "orphan", tokenId: null, ...o });
// bot_present premise (lines 2028-2031). Each witness is a Keep refused bot_present with the premise missing one condition.
rej("admissionPinned", "cm-admissionPinned-16-bot-present-premise-not-needed", ["r3.4d-cm"], run(base(), [[keepA({ mode: "bot_section", outcome: no("bot_present") })]]));
rej("admissionPinned", "cm-admissionPinned-17-bot-present-while-park-holds-target", ["r3.4d-cm"], run(from(w => { w.local.parks.pk1 = pk(); }), [[refKeep({ outcome: no("bot_present") })]]));
rej("admissionPinned", "cm-admissionPinned-18-bot-present-binding-bot-gone", ["r3.4d-cm"], run(from(w => { w.bots.b1.present = false; }), [[refKeep({ outcome: no("bot_present") })]]));
rej("admissionPinned", "cm-admissionPinned-19-bot-present-binding-removal-parked", ["r3.4d-cm"], run(from(w => { w.local.bindings.b1.state = "removal_parked"; }), [[refKeep({ outcome: no("bot_present") })]]));

// ---- ok owner.deleteBot (lines 2046-2060)
const delAct = (o: Record<string, unknown> = {}) => ({ ...delOk, ...o }) as never;
const authD = (o: Record<string, unknown> = {}) => au({ authorityId: "aD", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: 1, ...o });
const delStep = (tweak: (w: World) => void): StepSpec => [delOk, w => { w.ghost.botDeletedAtStep.b1 = 1; w.bots.b1.present = false; tweak(w); }];
type StepSpec = [Action, ((w: World) => void)?];
acc("admissionPinned", "cm-admissionPinned-34-owner-deleteBot-refused", ["r3.4d-cm"], run(delStart(), [[delAct({ outcome: no("unavailable") })]]));
const noHold = (w: World) => { w.ghost.tokens.push(tk({ tokenId: "tD" })); };
rej("admissionPinned", "cm-admissionPinned-35-deleteBot-holds-only-by-binding", ["r3.4d-cm"], run(from(w => { noHold(w); w.local.savedKeys = {}; }), [delStep(() => {})]));
rej("admissionPinned", "cm-admissionPinned-36-deleteBot-holds-only-by-saved-key", ["r3.4d-cm"], run(from(w => { noHold(w); Object.assign(w.local.bindings.b1.gen, { inboxId: null, opId: null, emailKeyRef: null }); }), [delStep(() => {})]));
rej("admissionPinned", "cm-admissionPinned-37-deleteBot-holds-only-by-park", ["r3.4d-cm"], run(from(w => { noHold(w); w.local.savedKeys = {}; Object.assign(w.local.bindings.b1.gen, { inboxId: null, opId: null, emailKeyRef: null }); w.local.parks.pk1 = pk(); }), [delStep(() => {})]));
rej("admissionPinned", "cm-admissionPinned-39-deleteBot-other-bots-authority", ["r3.4d-cm"], run(from(w => { w.bots.b2 = { botId: "b2", present: true }; w.local.bindings.b2 = { botId: "b2", state: "active", step: null, gen: clone(G1), address: ADDR }; w.ghost.tokens.push(tk({ tokenId: "tD" }), tk({ tokenId: "tD2", botId: "b2" })); }),
  [[delAct({ botIds: ["b1", "b2"], tokens: { b1: "tD", b2: "tD2" } }), w => { w.ghost.botDeletedAtStep.b1 = 1; w.bots.b1.present = false; w.ghost.authorities.push(authD({ authorityId: "aD", botId: "b2", tokenId: "tD2" })); w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD" }); w.local.leases.LD2 = ls({ removalId: "LD2", botId: "b2", authorityId: "aD" }); }]]));
rej("admissionPinned", "cm-admissionPinned-40-deleteBot-authority-bad-stamps", ["r3.4d-cm"], run(delStart(), [delStep(w => { w.ghost.authorities.push(authD({ verifiedAtStep: 0 })); w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD" }); })]));
rej("admissionPinned", "cm-admissionPinned-42-deleteBot-authority-names-no-target", ["r3.4d-cm"], run(from(w => { w.ghost.tokens.push(tk({ tokenId: "tD", shown: { target: null as never, address: null, inboxId: null, keyIds: [] } })); }), [delStep(w => { w.ghost.authorities.push(authD({ scope: { target: null, inboxId: null, keyIds: [] } as never })); w.local.leases.LD = ls({ removalId: "LD", target: null as never, authorityId: "aD" }); })]));
rej("admissionPinned", "cm-admissionPinned-43-deleteBot-authority-no-lease", ["r3.4d-cm"], run(delStart(), [delStep(w => { w.ghost.authorities.push(authD()); })]));
rej("admissionPinned", "cm-admissionPinned-44-deleteBot-lease-already-existed", ["r3.4d-cm"], run(from(w => { noHold(w); w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD" }); }), [delStep(w => { w.ghost.authorities.push(authD()); })]));
rej("admissionPinned", "cm-admissionPinned-45-deleteBot-lease-other-target", ["r3.4d-cm"], run(delStart(), [delStep(w => { w.ghost.authorities.push(authD()); w.local.leases.LD = ls({ removalId: "LD", target: "inbox:i2", inboxId: "i2", authorityId: "aD" }); })]));
rej("admissionPinned", "cm-admissionPinned-46-deleteBot-lease-other-bot", ["r3.4d-cm"], run(delStart(), [delStep(w => { w.ghost.authorities.push(authD()); w.local.leases.LD = ls({ removalId: "LD", botId: "b2", authorityId: "aD" }); })]));
rej("admissionPinned", "cm-admissionPinned-47-deleteBot-lease-other-authority", ["r3.4d-cm"], run(delStart(), [delStep(w => { w.ghost.authorities.push(authD()); w.local.leases.LD = ls({ removalId: "LD", authorityId: "aX" }); })]));
acc("admissionPinned", "cm-admissionPinned-48-deleteBot-park-completed-away", ["r3.4d-cm"], run(from(w => { Object.assign(w, parked()); noHold(w); }),
  [[deleteB1Work[0], w => { deleteB1Work[1]!(w); delete w.local.parks.pk1; w.surface = [pendingRow()]; }]]));

// ---- ok owner.keep (lines 2063-2072): the one valid Keep step with a single deviation
const kStep = (tweak: (w: World) => void, pre?: (w: World) => void): [World, StepSpec] => [from(w => { Object.assign(w, parkedTok()); pre?.(w); }), [keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk1.state = "keep_pending"; w.surface = [pendingRow()];
  tweak(w); }]];
const kRej = (id: string, tweak: (w: World) => void, pre?: (w: World) => void) => { const [s, st] = kStep(tweak, pre); rej("admissionPinned", id, ["r3.4d-cm"], run(s, [st])); };
kRej("cm-admissionPinned-23-keep-authority-bad-stamps", w => { w.ghost.authorities.find(a => a.authorityId === "aK")!.verifiedAtStep = 0; });
kRej("cm-admissionPinned-55-keep-record-other-target", w => { w.ghost.keeps[0]!.target = "inbox:i2"; });
kRej("cm-admissionPinned-56-keep-record-other-step", w => { w.ghost.keeps[0]!.claimedAtStep = 0; });
kRej("cm-admissionPinned-57-keep-record-other-authority", w => { w.ghost.keeps[0]!.authorityId = "aZ"; w.local.keepOps.kp1!.authorityId = "aZ"; });
kRej("cm-admissionPinned-58-keep-no-record", w => { w.ghost.keeps = []; });
kRej("cm-admissionPinned-59-keep-no-op-opened", w => { delete w.local.keepOps.kp1; });
const preOp = (o: Record<string, unknown> = {}) => (w: World) => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 0, ...o } as never; };
kRej("cm-admissionPinned-60-keep-op-already-open", () => {}, preOp());
kRej("cm-admissionPinned-61-keep-op-other-target", w => { w.local.keepOps.kp1!.target = "inbox:i2"; });
kRej("cm-admissionPinned-62-keep-op-other-authority", w => { w.local.keepOps.kp1!.authorityId = "aY"; });
acc("admissionPinned", "cm-admissionPinned-64-key-only-keep-succeeds-at-once-no-op", ["r3.4d-cm"], run(from(w => { w.ghost.tokens.push(tk({ tokenId: "tp", shown: { target: T_OP1, address: ADDR, inboxId: null, keyIds: ["k1"] } })); }),
  [[keepA({ mode: "key_only", target: T_OP1, tokenId: "tp" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tp", scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } as never, verifiedAtStep: 1 }));
    w.ghost.keeps.push(kr({ target: T_OP1, inboxId: null, mode: "key_only", claimedAtStep: 1, succeededAtStep: 1, succeededAtMs: NOWB })); w.ghost.usedKeepOps.push("kp1"); }]]));
// ---- ok owner.remove (lines 2073-2078)
const rStep = (tweak: (w: World) => void, pre?: (w: World) => void) => { const s = from(w => { Object.assign(w, parkedTok()); pre?.(w); });
  return [s, [removeAk("tP", { section: "parked" }), (w: World) => { w.ghost.authorities.push(au({ authorityId: "aRp", kind: "remove_park", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } })); w.local.parks.pk1.state = "remove_authorized"; w.surface = [pendingRow()]; tweak(w); }]] as [World, StepSpec]; };
const rRej = (id: string, tweak: (w: World) => void, pre?: (w: World) => void) => { const [s, st] = rStep(tweak, pre); rej("admissionPinned", id, ["r3.4d-cm"], run(s, [st])); };
rRej("cm-admissionPinned-70-remove-no-lease", () => {});
rRej("cm-admissionPinned-71-remove-lease-already-existed", () => {}, w => { w.local.leases.L1 = ls({ authorityId: "aRp" }); });
rRej("cm-admissionPinned-72-remove-lease-other-target", w => { w.local.leases.L1 = ls({ target: "inbox:i2", inboxId: "i2", authorityId: "aRp" }); });
rRej("cm-admissionPinned-73-remove-lease-other-authority", w => { w.local.leases.L1 = ls({ authorityId: "aX" }); });

// ---- refused owner.keep / owner.remove / tryAgainNow (lines 2081-2121)
acc("admissionPinned", "cm-admissionPinned-77-key-only-keep-refused-bot-present", ["r3.4d-cm"], run(base(), [[keepA({ mode: "key_only", target: T_OP1, botId: "b2", tokenId: null, outcome: no("bot_present") })]]));
acc("admissionPinned", "cm-admissionPinned-78-orphan-keep-refused-confirm-expired-no-line", ["r3.4d-cm"], run(base(), [[keepA({ mode: "orphan", botId: "b2", tokenId: null, outcome: no("confirm_expired") })]]));
acc("admissionPinned", "cm-admissionPinned-84-stale-keep-refused-removal-sending", ["r3.4d-cm"], run(leaseIn("sending"), [[keepA({ mode: "bot_section", botId: "b2", tokenId: null, outcome: no("removal_sending") })]]));
const lookRow = (o: Record<string, unknown>) => (w: World) => { w.surface = [row({ section: "bot", line: LOOK_AGAIN_LINE, actions: [{ kind: "keep", tokenId: null, enabled: true }], ...o })]; };
const staleRef = keepA({ mode: "bot_section", target: "inbox:i2", tokenId: null, outcome: no("confirm_expired") });
rej("admissionPinned", "cm-admissionPinned-88-look-again-row-invisible", ["r3.4d-cm"], run(base(), [[staleRef, lookRow({ visible: false })]]));
rej("admissionPinned", "cm-admissionPinned-90-look-again-row-other-bot", ["r3.4d-cm"], run(base(), [[staleRef, lookRow({ botId: "b2" })]]));
rej("admissionPinned", "cm-admissionPinned-91-look-again-row-other-line", ["r3.4d-cm"], run(base(), [[staleRef, lookRow({ line: "Something else." })]]));

// ---- inbox_gone evidence (lines 2039-2040)
const purgedBase = (tweak: (w: World) => void) => from(w => { Object.assign(w, pkE()); w.flux.inboxes.i1.state = "purged"; tweak(w); });
const gone = (): Action => keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") });
const nf = (o: Record<string, unknown> = {}) => rq({ requestId: "g0", kind: "GET_INBOX", target: "i1", purpose: "poll", flux: "applied", answer: "delivered", answerSeen: { atStep: 0, result: "not_found", fluxStateSeen: null }, ...o } as never);
const ev = (o: Record<string, unknown> = {}) => ({ eventId: "eP", type: "email.inbox.deleted", inboxId: "i1", atMs: NOWB, atStep: 0, deliveredToHome: true, reason: null, ...o }) as never;
acc("admissionPinned", "cm-admissionPinned-24-inbox-gone-by-request-evidence-only", ["r3.4d-cm"], run(purgedBase(w => { w.flux.requests.push(nf()); }), [[gone()]]));
rej("admissionPinned", "cm-admissionPinned-26-inbox-gone-request-other-inbox", ["r3.4d-cm"], run(purgedBase(w => { w.flux.requests.push(nf({ target: "i2" })); }), [[gone()]]));
rej("admissionPinned", "cm-admissionPinned-27-inbox-gone-request-not-delivered", ["r3.4d-cm"], run(purgedBase(w => { w.flux.requests.push(nf({ answer: "pending" })); }), [[gone()]]));
rej("admissionPinned", "cm-admissionPinned-28-inbox-gone-request-answer-ok", ["r3.4d-cm"], run(purgedBase(w => { w.flux.requests.push(nf({ answerSeen: { atStep: 0, result: "ok", fluxStateSeen: null } })); }), [[gone()]]));
rej("admissionPinned", "cm-admissionPinned-29-inbox-gone-event-other-inbox", ["r3.4d-cm"], run(purgedBase(w => { w.flux.events.push(ev({ inboxId: "i2" })); }), [[gone()]]));
rej("admissionPinned", "cm-admissionPinned-30-inbox-gone-event-other-type", ["r3.4d-cm"], run(purgedBase(w => { w.flux.events.push(ev({ type: "email.inbox.created" })); }), [[gone()]]));


export const PIN = 59;
