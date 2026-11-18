// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.4d step 2/3 (s23) witnesses: one must-reject witness per NEW page rule or reducer refusal (PAGE-MISSING-batchA-B.md, MurageMain rulings 2026-11-11).
// Each is killed-by a named mutant in spec-r3.test.ts (MUTANTS, "s23"). PIN = the number of witnesses in this file.

import { base, run, from, tick, d, clone, OWN, T_I1, removeA, withToken, leaseIn, no, keptRecord, confirmStart, succeed, pk, cmKit, au, ls, tk, keepHist, NOW, sysArm, restoreArmedA, captureK9, abortStep, unmarkedK9, closingKept, guardRestore, type Witness } from "./spec.ts";

export const WITNESSES_S23: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_S23);
void from;
const tryAgain = (target: string, outcome: object) => ({ t: "owner.tryAgainNow", principal: OWN, botId: "b1", target, outcome }) as never;

// admissionPinned: Try again now is admitted only for a bot target (restore-reducer refuses not_a_bot_target).
rej("admissionPinned", "s23-try-again-non-bot-admitted", ["r3.4d-s23"], run(leaseIn("unknown"), [[tryAgain(T_I1, { ok: true })]]));
acc("admissionPinned", "s23-try-again-non-bot-refused", ["r3.4d-s23"], run(leaseIn("unknown"), [[tryAgain(T_I1, no("not_a_bot_target"))]]));
// admissionPinned: owner.* admitted only for an owner principal (Q#34).
rej("admissionPinned", "s23-owner-ok-remove-by-bot-principal", ["r3.4d-s23"], run(withToken(), [[removeA("tB", { principal: "bot_credential" })]]));
// environmentWellFormed: a copy names an existing request; inbox and key ids are disjoint; a new restore record carries the current step.
rej("environmentWellFormed", "s23-copy-names-no-request", ["r3.4d-s23"], run(base(), [[tick, w => { w.flux.requests.push(d("d9", "at1", { copyOf: "nope" })); }]]));
rej("environmentWellFormed", "s23-inbox-key-id-overlap", ["r3.4d-s23"], run(base(), [[tick, w => { w.flux.inboxes.k1 = clone(w.flux.inboxes.i1); }]]));
rej("environmentWellFormed", "s23-restore-record-stale-step", ["r3.4d-s23"], run(base(), [[tick, w => {
  w.ghost.restores.push({ atStep: w.step + 3, atMs: w.nowMs, epochAfter: 0, source: "desktop", archiveId: "A", blind: false, carryId: null, ownerRequestStep: null, jobId: null }); }]]));
// keepSuccessIsConfirmed: Keep success resets EVERY binding on its target.
rej("keepSuccessIsConfirmed", "s23-keep-success-leaves-binding-removing", ["r3.4d-s23"], run(confirmStart(true), [[tick, w => { succeed("g1", 4)(w); w.local.bindings.b1.state = "removing"; }]]));
// keptStaysKept: an owner step other than Remove never parks a kept target (the reducer's parkBinding refuses it, park.refused_kept).
rej("keptStaysKept", "s23-owner-try-again-parks-kept-target", ["r3.4d-s23"], run(keptRecord(), [[tryAgain("bot:b1", { ok: true }), w => { w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy" }); }]]));

// ---- closers for survivors the new rules exposed (cm- names follow the clause they kill) ----
// admissionPinned#107/#110-#112: the Try again now pending rule is judged on a bot:* target only.
acc("admissionPinned", "cm-admissionPinned-107-try-again-bot-refused-nothing-pending", ["r3.4d-s23"], run(base(), [[tryAgain("bot:b1", no("unavailable"))]]));
rej("admissionPinned", "cm-admissionPinned-110-try-again-bot-ok-nothing-pending", ["r3.4d-s23"], run(base(), [[tryAgain("bot:b1", { ok: true })]]));
// admissionPinned#2: an owner view carries no decision; a view by another principal is not an admitted owner decision.
acc("admissionPinned", "cm-admissionPinned-2-view-by-bot-principal-is-no-decision", ["r3.4d-s23"], run(base(), [[{ t: "owner.viewSurface", principal: "bot_credential" } as never]]));
// keepSuccessIsConfirmed#22: a binding on ANOTHER target left removing does not fail this Keep.
acc("keepSuccessIsConfirmed", "cm-keepSuccessIsConfirmed-22-other-target-binding-removing", ["r3.4d-s23"], run(confirmStart(true), [[tick, w => { succeed("g1", 4)(w); const b = clone(w.local.bindings.b1); b.botId = "b2"; b.gen = { ...b.gen, inboxId: "i2" }; b.state = "removing"; w.local.bindings.b2 = b; }]]));
// keptStaysKept#1: an owner Remove of the target is the one owner step that may park it.
acc("keptStaysKept", "cm-keptStaysKept-1-owner-remove-parks-kept-target", ["r3.4d-s23"], run(from(w => { w.ghost.tokens.push(tk()); keepHist(w, { succeededAtStep: 0, succeededAtMs: NOW }); }), [[removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: 1 })); w.local.leases.L1 = ls(); w.local.bindings.b1.state = "removing"; w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy" }); }]]));

// r3.4d-s23 step 3 closers (SHADOW verdict corrections).
// admissionPinned#90/#92: Try again now with a lease pending on a bot:* target may SUCCEED (a must-accept: the pending rule only refuses a refusal).
acc("admissionPinned", "cm-admissionPinned-90-try-again-bot-ok-lease-pending", ["r3.4d-s23"], run(from(w => { w.local.leases.L1 = ls({ phase: "unknown", target: "bot:b1" }); }), [[tryAgain("bot:b1", { ok: true })]]));
// admissionPinned#5 (the owner-principal rule): an ok Try again now by a non-owner principal on a bot:* target with a lease pending passes every other clause, so only the principal rule rejects it (a bot-principal Remove cannot: no valid authority can be created by a bot principal).
rej("admissionPinned", "cm-admissionPinned-5-try-again-ok-by-bot-principal-lease-pending", ["r3.4d-s23"], run(from(w => { w.local.leases.L1 = ls({ phase: "unknown", target: "bot:b1" }); }), [[{ ...(tryAgain("bot:b1", { ok: true }) as object), principal: "bot_credential" } as never]]));
// restoreJobProtocol#60: a present armed job p arms again under the SAME identity (the identity guard cannot fire), so only the p operand of the carry guard rejects it.
rej("restoreJobProtocol", "cm-restoreJobProtocol-60-armed-job-rearmed-same-identity", ["r3.4d-s23"], run(base(), [sysArm(), [{ t: "auto.restoreArm", source: "desktop", archiveId: "A" }, w => { w.fs.restoreJob = { ...w.fs.restoreJob!, at: w.step }; }]]));

// environmentWellFormed#31 (a.kind === confirm_inventory): an ok Remove that creates a VALID remove_bot_section authority while an inventory confirmation is recorded is no confirm.
rej("environmentWellFormed", "cm-environmentWellFormed-31-confirm-recorded-by-remove-authority", ["r3.4d-s23"], run(withToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: 1 })); w.local.leases.L1 = ls(); w.ghost.inventoryConfirmedEpochs.push(w.ghost.epoch); }]]));

// restoreJobProtocol (named mutant job-arm-over-finished): an ABORTED job whose carry is still present is re-armed under the SAME identity; only the carry operand of `if (p || prev.carry)` rejects it.
rej("restoreJobProtocol", "cm-restoreJobProtocol-60-aborted-job-rearmed-same-identity-carry-present", ["r3.4d-s23"], run(unmarkedK9(), [restoreArmedA, captureK9(), abortStep(), [{ t: "auto.restoreArm", source: "desktop", archiveId: "A" }, w => { w.fs.restoreJob = { ...w.fs.restoreJob!, phase: "armed", at: w.step }; }]]));

// r3.4d-s23 S5 (page "lease and park refusals on a guard restore"): the guard-restore step itself may not open a lease or a park on its target.
// S13 nothingAutomaticUnparks: a guard restore (automatic, purpose guard) on a target that carries a park opens a lease: refused ("automatic lease on parked").
rej("nothingAutomaticUnparks", "s23-s5-guard-restore-opens-lease-on-parked-target", ["r3.4d-s23"], run(closingKept(w => { w.local.parks.pk1 = pk(); }), [[guardRestore, w => { w.local.leases.L1 = ls(); }]]));
// S26 keepAndRemoveSerialized: a guard restore runs under an open Keep op; a lease opened on that target beside it is refused ("open Keep and active removal").
rej("keepAndRemoveSerialized", "s23-s5-guard-restore-opens-lease-beside-open-keep", ["r3.4d-s23"], run(closingKept(w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 0 }; }), [[guardRestore, w => { w.local.leases.L1 = ls(); }]]));
// S13: the guard-restore step drops the park on its target: refused ("moved park out of parked").
rej("nothingAutomaticUnparks", "s23-s5-guard-restore-drops-park-on-target", ["r3.4d-s23"], run(closingKept(w => { w.local.parks.pk1 = pk(); }), [[guardRestore, w => { delete w.local.parks.pk1; }]]));
// S5 result: S13 ACCEPTS a NEW park opened by a guard-restore step (S13 judges only the parks that already exist; an automatic step may open a park elsewhere), so the refusal on a kept target is S14 keptStaysKept (+ reducer park.refused_kept, hit-id and ownerResult already in place): proven here.
rej("keptStaysKept", "s23-s5-guard-restore-opens-park-on-target", ["r3.4d-s23"], run(closingKept(), [[guardRestore, w => { w.local.parks.pk2 = pk({ parkId: "pk2" }); }]]));


// r3.4d fix-s1 (page S1, key-only Keep): the owner removed a provisioning-unknown bot (binding removing, lease on bot:b1 not sending), then a key-only Keep on bot:b1 succeeds.
// The OLD reducer deleted the lease and left the binding removing. Killed by the S1 loop now judged for key-only Keeps (MUTANT keep-success-key-only-skipped).
const keyOnlyS1 = (state: "removing" | "active") => run(from(w => {
  keepHist(w, { target: "bot:b1", inboxId: null, mode: "key_only" });
  w.local.bindings.b1.gen = { ...w.local.bindings.b1.gen, inboxId: null }; w.local.bindings.b1.state = "removing";
  w.local.leases.L1 = ls({ target: "bot:b1", inboxId: null, phase: "unknown" });
}), [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs }); delete w.local.leases.L1; w.local.bindings.b1.state = state;
  w.surface = [{ section: "bot", target: "bot:b1", botId: "b1", inboxId: null, keyIds: ["k1"], provisionOpId: "op1", visible: true, line: "Email for this bot", actions: [{ kind: "keep", tokenId: null, enabled: true }, { kind: "remove", tokenId: null, enabled: true }] } as never]; }]]);
rej("keepSuccessIsConfirmed", "s23-key-only-keep-leaves-binding-removing", ["r3.4d-s23"], keyOnlyS1("removing"));
acc("keepSuccessIsConfirmed", "s23-key-only-keep-resets-binding", ["r3.4d-s23"], keyOnlyS1("active"));

export const PIN = 24;
