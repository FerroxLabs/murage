// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g6 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from];

export const WITNESSES_G6: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G6);
void rej; void acc;

// ---------- r3.4d clause mutants (CLAUSE-MUTANTS-r34d.md), group g6: one witness per SURVIVED clause, named after the clause id ----------------
type StepSpec = [import("../invariants.current.ts").Action, ((w: import("../invariants.current.ts").World) => void)?];
import { sysJob, noLiveStart, ownerRestoreNoLive, swapNoLive, restoreLive, abortStep, clearJob, failedRow, fetchFail, swappedStart, sysPrep, sysSwap, bootPrepOk, prepMarks, nolive, phase, arm, crashAt, bootW, T_OP1, keepHist, T_I1, kept, closeBy, fluxClose, sysArm, finishing, withEvent, applyER, ticks, restoreB, captureB, swapB, blindSwapSys, withEventBase } from "./spec.ts";
import { NOW, ADDR } from "./spec.ts";
import { RESTORE_FAILED_LINE, LOOK_AGAIN_LINE } from "../invariants.current.ts";
void [T_I1, closeBy, fluxClose, kept, sysJob, noLiveStart, ownerRestoreNoLive, swapNoLive, restoreLive, abortStep, clearJob, failedRow, fetchFail, swappedStart, sysPrep, sysSwap, bootPrepOk, prepMarks, nolive, phase, arm, crashAt, bootW, T_OP1, keepHist, T_I1, kept, closeBy, fluxClose, sysArm, finishing, withEvent, applyER, ticks, restoreB, captureB, swapB, blindSwapSys, withEventBase, RESTORE_FAILED_LINE, LOOK_AGAIN_LINE];
const CM = ["r3.4d-cm"];

// keyOnlyActionsTouchNoInbox#8 (weaker): a key-only REMOVE authority (not a Keep op) may not send DELETE either.
rej("keyOnlyActionsTouchNoInbox", "cm-keyOnlyActionsTouchNoInbox-8-key-only-remove-sends-delete", CM, run(from(w => {
  w.ghost.tokens.push(tk({ tokenId: "tp", shown: { target: T_OP1, address: ADDR, inboxId: null, keyIds: ["k1"] } }));
  w.ghost.authorities.push(au({ kind: "remove_key_only", tokenId: "tp", verifiedAtStep: 0, scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } }));
  w.local.leases.L1 = ls({ target: T_OP1, inboxId: null, phase: "sending", attemptId: "at1", attempts: ["at1"], keyTargets: [{ keyId: "k1", status: "pending" }] }); }),
  [[send(rq({ requestId: "v1", kind: "DELETE_INBOX", target: "i1", authorityId: "aR", removalId: "L1", attemptId: "at1" }))]]));

// savedKeyNeverOutlivesRevokeWithoutWork: #5 a pending target for ANOTHER key does not cover; #6 a target of the key in a non-work status does not cover;
// #2 (stricter) a key being rotated out is covered by its rotation cursor; #8 (stricter) a revoked target of ANOTHER key is no breach.
rej("savedKeyNeverOutlivesRevokeWithoutWork", "cm-savedKeyNeverOutlivesRevokeWithoutWork-5-other-keys-target", CM, run(from(w => { w.local.parks.pk1 = pk({ keyTargets: [{ keyId: "k2", status: "pending" }] }); }), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));
rej("savedKeyNeverOutlivesRevokeWithoutWork", "cm-savedKeyNeverOutlivesRevokeWithoutWork-6-kept-status-no-cover", CM, run(from(w => { w.local.parks.pk1 = pk({ keyTargets: [{ keyId: "k1", status: "kept" }] }); }), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));
acc("savedKeyNeverOutlivesRevokeWithoutWork", "cm-savedKeyNeverOutlivesRevokeWithoutWork-2-rotation-old-key-revoked", CM, run(from(w => {
  w.flux.keys.k2 = { keyId: "k2", installOwned: true, mintedUnderOp: "op2", forBot: "b1", state: "live" };
  w.local.rotations.b1 = { botId: "b1", opId: "op2", oldKeyId: "k1", newKeyId: "k2", authorityId: "aR" }; }), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));
acc("savedKeyNeverOutlivesRevokeWithoutWork", "cm-savedKeyNeverOutlivesRevokeWithoutWork-8-other-key-target-revoked", CM, run(from(w => {
  w.flux.keys.k2 = { keyId: "k2", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "revoked" };
  w.local.parks.pk1 = pk({ keyTargets: [{ keyId: "k1", status: "pending" }, { keyId: "k2", status: "revoked" }] }); }), [[tick]]));

// ---------- restoreJobProtocol ----------
const noCap = from(w => { w.carry = carry(); sysJob(w, "A", "cloud_reset", "captured"); });
// #3: a second capture on an already captured job (job unchanged) is a capture with no ARMED job.
rej("restoreJobProtocol", "cm-restoreJobProtocol-3-capture-on-captured-job", CM, run(noCap, [[{ t: "auto.captureOutgoing" }]]));
// #13: an archive fetch that writes the restore job.
rej("restoreJobProtocol", "cm-restoreJobProtocol-13-fetch-writes-job", CM, run(base(), [[{ t: "auto.archiveFetch", archiveId: "A", outcome: "verified" }, w => { arm(w, "A"); }]]));
// #15 (stricter): a fetch of ANOTHER archive while a job is open is fine.
acc("restoreJobProtocol", "cm-restoreJobProtocol-15-fetch-other-archive-mid-job", CM, run(base(), [restoreLive, [{ t: "auto.archiveFetch", archiveId: "C", outcome: "verified" }, w => { w.fs.localArchives = ["A", "B", "C"]; }]]));
// #19: a verified archive that is not local.
rej("restoreJobProtocol", "cm-restoreJobProtocol-19-verified-not-local", CM, run(base(), [[{ t: "auto.archiveFetch", archiveId: "C", outcome: "verified" }]]));
// #20: a failed background download that changes state.
rej("restoreJobProtocol", "cm-restoreJobProtocol-20-failed-fetch-changes-state", CM, run(from(w => { w.fs.localArchives = []; }), [[fetchFail, w => { w.local.savedKeys.b1 = null; }]]));
// #21 #22 #23: the failed line must be a VISIBLE row of the HOME section carrying RESTORE_FAILED_LINE (owner asked, so the line is owed).
const askedA = (w: any) => { w.fs.localArchives = []; w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A" }); };
rej("restoreJobProtocol", "cm-restoreJobProtocol-21-failed-line-wrong-section", CM, run(from(askedA), [[fetchFail, w => { w.surface = [row({ section: "bot", line: RESTORE_FAILED_LINE })]; }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-22-failed-line-invisible", CM, run(from(askedA), [[fetchFail, w => { w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], visible: false, line: RESTORE_FAILED_LINE })]; }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-23-failed-line-wrong-text", CM, run(from(askedA), [[fetchFail, w => { w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: LOOK_AGAIN_LINE })]; }]]));
// #24 (job open: the failed fetch is a background one, no line owed even though a request for that archive exists).
acc("restoreJobProtocol", "cm-restoreJobProtocol-24-fetch-fails-while-job-open", CM, run(from(w => { w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "C" }); }), [restoreLive, [{ t: "auto.archiveFetch", archiveId: "C", outcome: "download_failed" }]]));
// #26 (another archive's request owes no line).
acc("restoreJobProtocol", "cm-restoreJobProtocol-26-other-archive-request-no-line", CM, run(from(w => { w.fs.localArchives = []; w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "B" }); }), [[fetchFail]]));
const rest = (archiveId: string, atStep: number) => ({ atStep, atMs: NOW, epochAfter: 1, source: "desktop" as const, archiveId, blind: false, carryId: null, ownerRequestStep: null, jobId: null });
// #27 (a request already answered by a later restore of that archive owes no line).
acc("restoreJobProtocol", "cm-restoreJobProtocol-27-answered-request-no-line", CM, run(from(w => { w.fs.localArchives = []; w.ghost.epoch = 1; w.ghost.preparedEpochs.push(1); w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A" }); w.ghost.restores.push(rest("A", 0)); }), [[fetchFail]]));
// #28 (a later restore of ANOTHER archive does not answer the request): the line is owed.
rej("restoreJobProtocol", "cm-restoreJobProtocol-28-other-archive-restore-no-answer", CM, run(from(w => { askedA(w); w.ghost.epoch = 1; w.ghost.restores.push(rest("B", 1)); }), [[fetchFail]]));
// #29 (a restore BEFORE the request does not answer it).
rej("restoreJobProtocol", "cm-restoreJobProtocol-29-earlier-restore-no-answer", CM, run(from(w => { askedA(w); w.ghost.epoch = 1; w.ghost.restores.push(rest("A", -5)); }), [[fetchFail]]));
// #40 #43: an admitted owner restore / a system arm that writes no job.
rej("restoreJobProtocol", "cm-restoreJobProtocol-40-admitted-restore-arms-nothing", CM, run(base(), [[{ t: "owner.restore", source: "desktop", archiveId: "A" }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-43-system-arm-arms-nothing", CM, run(base(), [[{ t: "auto.restoreArm", source: "desktop", archiveId: "A" }]]));
// #45: a boot prep that commits an epoch must write the job prepared.
rej("restoreJobProtocol", "cm-restoreJobProtocol-45-boot-prep-leaves-job-swapped", CM, run(from(swappedStart), [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(w.ghost.epoch); w.proc.phase = "running"; }]]));
// #48 #51: capture / swap that leaves the job behind.
rej("restoreJobProtocol", "cm-restoreJobProtocol-48-capture-leaves-armed", CM, run(base(), [restoreLive, [{ t: "auto.captureOutgoing" }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-51-swap-leaves-captured", CM, run(noCap, [[{ t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false }]]));
// #56 #57 #58: an abort / a clear with nothing to do.
rej("restoreJobProtocol", "cm-restoreJobProtocol-56-abort-with-no-job", CM, run(base(), [[{ t: "auto.restoreAbort", reason: "archive_unreadable" }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-57-clear-with-no-job", CM, run(base(), [[{ t: "auto.restoreJobClear" }]]));
// #63: the job's identity (archive) changes while its phase advances.
rej("restoreJobProtocol", "cm-restoreJobProtocol-63-capture-changes-archive", CM, run(base(), [restoreLive, [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: w.fs.restoreJob!.id }); phase(w, "captured"); w.fs.restoreJob!.archiveId = "B"; }]]));
// #67: the journal's `at` is not this step.
rej("restoreJobProtocol", "cm-restoreJobProtocol-67-journal-at-stale", CM, run(base(), [[{ t: "auto.restoreArm", source: "desktop", archiveId: "A" }, w => { arm(w, "A"); w.fs.restoreJob!.at = 99; }]]));
// #70: the job vanishes at a prepared job by a step that is not the clear.
rej("restoreJobProtocol", "cm-restoreJobProtocol-70-job-vanishes-by-tick", CM, run(from(w => { sysJob(w, "A", "cloud_reset", "prepared"); }), [[tick, w => { w.fs.restoreJob = null; }]]));
// #72 #73: a clear of a job not finished; a clear that leaves the carry.
rej("restoreJobProtocol", "cm-restoreJobProtocol-72-clear-armed-job", CM, run(base(), [restoreLive, clearJob]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-73-clear-keeps-carry", CM, run(from(w => { w.carry = carry(); sysJob(w, "A", "cloud_reset", "prepared"); }), [[{ t: "auto.restoreJobClear" }, w => { w.fs.restoreJob = null; }]]));
// #75: arming while the previous carry still exists.
rej("restoreJobProtocol", "cm-restoreJobProtocol-75-arm-over-leftover-carry", CM, run(from(w => { w.carry = carry(); }), [restoreLive]));
// #78: a non-armed phase written where no job existed.
rej("restoreJobProtocol", "cm-restoreJobProtocol-78-captured-from-nothing", CM, run(base(), [[tick, w => { arm(w, "A"); phase(w, "captured"); w.carry = carry({ jobId: w.fs.restoreJob!.id }); }]]));
// #81 #82 #83 #84 #86 #87: each later phase is written only by its own step, with its evidence.
rej("restoreJobProtocol", "cm-restoreJobProtocol-81-captured-by-tick", CM, run(base(), [restoreLive, [tick, w => { w.carry = carry({ jobId: w.fs.restoreJob!.id }); phase(w, "captured"); }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-82-captured-without-carry", CM, run(base(), [restoreLive, [{ t: "auto.captureOutgoing" }, w => { phase(w, "captured"); }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-83-swapped-by-tick", CM, run(noCap, [[tick, w => { w.ghost.epoch = 1; phase(w, "swapped"); w.ghost.restores.push({ ...rest("A", w.step), source: "cloud_reset", jobId: "js", carryId: "c1" }); }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-84-swap-names-no-job", CM, run(noCap, [[{ t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false }, w => { w.ghost.epoch = 1; phase(w, "swapped"); }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-86-prepared-by-tick", CM, run(from(swappedStart), [[tick, w => { sysPrep(w); }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-87-prepared-without-epoch", CM, run(from(swappedStart), [[{ t: "auto.bootPrep", outcome: "ok" }, w => { phase(w, "prepared"); w.proc.phase = "running"; }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-89-aborted-by-tick", CM, run(base(), [restoreLive, [tick, w => { phase(w, "aborted"); w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FAILED_LINE })]; }]]));
// #93 #94 #95: the abort's failed line must be a visible home row with that text.
const abortWith = (o: Partial<ReturnType<typeof row>>) => run(base(), [restoreLive, [{ t: "auto.restoreAbort", reason: "archive_unreadable" }, w => { phase(w, "aborted"); w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FAILED_LINE, ...o })]; }]]);
rej("restoreJobProtocol", "cm-restoreJobProtocol-93-abort-line-invisible", CM, abortWith({ visible: false }));
rej("restoreJobProtocol", "cm-restoreJobProtocol-94-abort-line-wrong-section", CM, abortWith({ section: "bot" }));
rej("restoreJobProtocol", "cm-restoreJobProtocol-95-abort-line-wrong-text", CM, abortWith({ line: LOOK_AGAIN_LINE }));

// restoreJobProtocol#85: a prep commit writes `prepared` only from `swapped` (not from a captured job); #88: an abort only from armed / captured.
rej("restoreJobProtocol", "cm-restoreJobProtocol-85-prepared-from-captured", CM, run(noCap, [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(w.ghost.epoch); phase(w, "prepared"); }]]));
rej("restoreJobProtocol", "cm-restoreJobProtocol-88-abort-after-swap-clears-mark", CM, run(from(swappedStart), [[{ t: "auto.restoreAbort", reason: "archive_unreadable" }, w => {
  delete w.local.swappedJobId; w.fs.restoreJob!.phase = "aborted"; w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FAILED_LINE })]; }]]));

// ---------- keepEndsActive: decoys that must NOT end a Keep's window (kept() = a successful Keep at step 0 with a DELETE held at Flux) ----------
const lateDelete: StepSpec[] = [[apply("d1"), closeBy("d1")], [clk(150_000)]];
const decoyScope = { target: T_I1, inboxId: "i1", keyIds: ["k1"] };
rej("keepEndsActive", "cm-keepEndsActive-4-later-keep-authority-is-no-remove", CM, run(from(w => { Object.assign(w, kept());
  w.ghost.authorities.push(au({ authorityId: "aK9", kind: "keep", tokenId: null, verifiedAtStep: 1, genAtVerify: null, scope: decoyScope })); }), lateDelete));
rej("keepEndsActive", "cm-keepEndsActive-5-remove-of-another-inbox", CM, run(from(w => { Object.assign(w, kept());
  w.ghost.authorities.push(au({ authorityId: "aD", verifiedAtStep: 1, scope: { target: "inbox:i2", inboxId: "i2", keyIds: [] } })); }), lateDelete));
rej("keepEndsActive", "cm-keepEndsActive-7-remove-authority-not-valid", CM, run(kept(), [[tick, w => { w.ghost.authorities.push(au({ authorityId: "aX", verifiedAtStep: w.step })); }], ...lateDelete]));
rej("keepEndsActive", "cm-keepEndsActive-9-non-blind-restore-ends-nothing", CM, run(from(w => { Object.assign(w, kept()); w.ghost.restores.push({ ...rest("A", 1), jobId: "x" }); }), lateDelete));
const keptAt3 = () => from(w => { Object.assign(w, kept()); w.ghost.keeps[0].succeededAtStep = 3; });
rej("keepEndsActive", "cm-keepEndsActive-10-flux-close-before-success", CM, run(keptAt3(), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")]]), true);
rej("keepEndsActive", "cm-keepEndsActive-13-purge-before-success", CM, run(keptAt3(), [[tick, w => { w.flux.inboxes.i1.state = "purged"; }]]), true);
rej("keepEndsActive", "cm-keepEndsActive-11-stale-flux-cause-on-active-inbox", CM, run(from(w => { Object.assign(w, kept()); w.flux.inboxes.i1.closingCause = { kind: "flux", reason: "billing" }; }), [[tick], ...lateDelete]));
rej("keepEndsActive", "cm-keepEndsActive-27-closed-inbox-at-quiescence", CM, run(kept(), [[apply("d1"), closeBy("d1")]]), true);
// #3 (stricter): a key-only Keep has no inbox to keep active.
acc("keepEndsActive", "cm-keepEndsActive-3-key-only-keep-no-inbox", CM, run(from(w => { keepHist(w, { target: T_OP1, inboxId: null, mode: "key_only", succeededAtStep: 0, succeededAtMs: NOW }); }), [[tick]]), true);
rej("keepEndsActive", "cm-keepEndsActive-9-blind-restore-before-success", CM, run(from(w => { Object.assign(w, keptAt3()); w.ghost.restores.push({ ...rest("A", 2), blind: true, jobId: "x" }); }), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")]]), true);
// #18 (stricter): a Keep whose inbox is gone from Flux has no closing window to bound.
acc("keepEndsActive", "cm-keepEndsActive-18-inbox-absent-at-flux", CM, run(from(w => { Object.assign(w, kept()); delete (w.flux.inboxes as Record<string, unknown>).i1; }), [[tick]]));


// ---------- keepEndsActive #15 and heldInputDrains (batch 3) ----------
import { CHECKER, type RemoteRequest, type World } from "../invariants.current.ts";
import { reopen, guardLine, rcRow } from "./spec.ts";
const BND = CHECKER.livenessBound;
// #15 (stricter): a Keep that succeeds AFTER its inbox was already closing (owner Delete, then Keep): the closing BEFORE the success is not the Keep's
// window, so a closing longer than the bound before succeededAtStep is not a breach. The Keep succeeded at step 4 once the guard RESTORE reopened it.
const grA = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", ...o });
acc("keepEndsActive", "cm-keepEndsActive-15-keep-succeeds-after-delete-closing", CM, run(from(w => { Object.assign(w, kept()); w.ghost.keeps[0].succeededAtStep = 4; w.ghost.keeps[0].succeededAtMs = NOW + 121_000; }), [[apply("d1"), closeBy("d1")],
  [clk(121_000)], [send(grA({ sentAtMs: NOW + 121_000 })), w => { w.flux.requests.push(grA({ sentAtMs: w.nowMs })); guardLine(w); }],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }]]), true);

// heldInputDrains: window = [prepRun (prepared, still open), clearJob (window ends)].
const prepRun: StepSpec = [prepMarks[0], (w: World) => { prepMarks[1]!(w); w.proc.phase = "running"; w.surface = [rcRow()]; }];
const takeAns = (id: string): StepSpec => [tick, (w: World) => { w.flux.requests.find((r: RemoteRequest) => r.requestId === id)!.answerSeen = { atStep: w.step, result: "ok", fluxStateSeen: null }; }];
const reqW = (id: string, answer: "pending" | "delivered") => rq({ requestId: id, kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: -1, flux: "applied", appliedAtMs: NOW, answer });
const heldAnsStart = (...ids: [string, "pending" | "delivered"][]) => from((w: World) => { Object.assign(w, noLiveStart()); for (const [id, a] of ids) w.flux.requests.push(reqW(id, a)); });
const deliverAns = (id: string): StepSpec => [{ t: "net.answer", requestId: id, result: "ok", fluxStateSeen: null }, (w: World) => { w.flux.requests.find((r: RemoteRequest) => r.requestId === id)!.answer = "delivered"; }];
// #1 (stricter): no window ever opened, so a never-applied event is judged by nothing here.
acc("heldInputDrains", "cm-heldInputDrains-1-no-window-no-verdict", CM, run(withEventBase(), ticks(BND + 1)));
// #2 (stricter): an open-to-open step is not a window end; the count starts at the real end (the event is applied on the bound-th automatic step after it).
acc("heldInputDrains", "cm-heldInputDrains-2-open-to-open-step-no-end", CM, nolive([prepRun, ...ticks(BND - 3), clearJob, [tick], applyER], withEvent()));
// #7 (stricter): a fault after the window ends judges nothing.
acc("heldInputDrains", "cm-heldInputDrains-7-fault-judges-nothing", CM, nolive([prepRun, clearJob, [{ t: "fault.delayEvent", eventId: "eR" }], ...ticks(BND)], withEvent()));
// #8 (stricter): a new window opening before the bound judges nothing (the next owner restore re-arms a job).
acc("heldInputDrains", "cm-heldInputDrains-8-new-window-judges-nothing", CM, nolive([prepRun, [tick], [tick], clearJob, ownerRestoreNoLive, ...ticks(BND - 3)], withEvent()));
// #9: the held event is applied in time; a DIFFERENT event emitted after the window (not held by it) is not judged.
acc("heldInputDrains", "cm-heldInputDrains-9-later-event-not-held", CM, nolive([prepRun, clearJob, applyER, [{ t: "flux.emit", event: { eventId: "eX", type: "email.inbox.restored", inboxId: "i1", atMs: NOW, atStep: 99, deliveredToHome: false, reason: null } }, w => { w.flux.events.push({ eventId: "eX", type: "email.inbox.restored", inboxId: "i1", atMs: w.nowMs, atStep: w.step, deliveredToHome: false, reason: null }); }], ...ticks(BND)], withEvent()));
// #5: a request still pending when the window ends is not held by it; its answer delivered later and not yet taken is not judged.
acc("heldInputDrains", "cm-heldInputDrains-5-pending-at-end-not-held", CM, nolive([prepRun, clearJob, deliverAns("L1"), ...ticks(BND)], heldAnsStart(["L1", "pending"])));
// #11: the held answer is taken in time; a different answer delivered after the window is not held.
acc("heldInputDrains", "cm-heldInputDrains-11-later-answer-not-held", CM, nolive([prepRun, clearJob, takeAns("L1"), deliverAns("L2"), ...ticks(BND)], heldAnsStart(["L1", "delivered"], ["L2", "pending"])));
// #13: the held answer is taken within the bound, so it is no longer held (the taken answer stays delivered).
acc("heldInputDrains", "cm-heldInputDrains-13-held-answer-taken-in-time", CM, nolive([prepRun, clearJob, takeAns("L1"), ...ticks(BND)], heldAnsStart(["L1", "delivered"])));
// #15 (weaker): an answer Flux delivered and the home never took, no event: only the answer clause catches it.
rej("heldInputDrains", "cm-heldInputDrains-15-held-answer-never-taken", CM, nolive([prepRun, clearJob, ...ticks(BND)], heldAnsStart(["L1", "delivered"])));

// restoreJobProtocol#88 (Opus check): an abort sent on an already-aborted job only re-stamps the journal `at` and shows the failed line; abort is legal only from armed / captured.
rej("restoreJobProtocol", "cm-restoreJobProtocol-88-reabort-restamps-journal", CM, run(from(w => { w.fs.restoreJob = { id: "j0", archiveId: "A", source: "desktop", phase: "aborted", at: 0 }; w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FAILED_LINE })]; }), [[{ t: "auto.restoreAbort", reason: "archive_unreadable" }, w => { w.fs.restoreJob!.at = w.step; }]]));

export const PIN = 66;
