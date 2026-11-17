// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GROUP g3 witnesses (CM-GROUPS.md). Add witnesses ONLY here; each is named cm-<predicate>-<n>-<slug> after the clause it closes
// (clause id <predicate>#<n>, CLAUSE-MUTANTS-r34d.md). Helpers come from ./spec.ts (exported kit); rej/acc push into this file's own array.
// PIN = the number of witnesses in this file; update it when you add witnesses (spec-witness.test.ts checks it per file, no shared pin to edit).

import { base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from, cmKit, type Witness } from "./spec.ts";
import { d, kept, closeBy, delGuard, withRows, botKeepRow, removeA, keepA, keepHist, closingKept, guardRestore, guardLine, confirmStart, succeed, swappedStart, sysJob, sysSwap, sysPrep, parkTok, OWN, ADDR, NOW, G2, T_I1 } from "./spec.ts";
import type { World } from "../invariants.current.ts";
// prettier-ignore
void [base, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, blind, from];

export const WITNESSES_G3: Witness[] = [];
const { rej, acc } = cmKit(WITNESSES_G3);
const CM = ["r3.4d-cm"];
type Ev = World["flux"]["events"][number];
const ans = (result: "accepted" | "ok" | "not_found" | "uncertain" = "accepted") => ({ atStep: 0, result, fluxStateSeen: null });
/** kept() with DELETE d1 already applied at Flux (not held), so only the answer / closing-event rules judge a release. */
const keptA = (un: string[] | "unknown" = ["at1"], m?: (w: World) => void) => from(w => { Object.assign(w, kept(un)); w.flux.requests[0].flux = "applied"; if (m) m(w); });
const ev = (o: Partial<Ev> = {}): Ev => ({ eventId: "e-y", type: "email.inbox.closing", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: false, reason: "owner", ...o });

// ===================================== guardLivesUntilEveryDeleteResolved =========================================================
const G = "guardLivesUntilEveryDeleteResolved";
// answered(): a delivered answer of a non-DELETE, another attempt, a duplicate, or an uncertain answer resolves nothing.
rej(G, "cm-guardLivesUntilEveryDeleteResolved-1-answered-by-non-delete", CM, run(keptA(["at1"], w => { w.flux.requests.push(rq({ requestId: "g8", kind: "GET_INBOX", target: "i1", attemptId: "at1", purpose: "guard", flux: "applied", answer: "delivered", answerSeen: ans("ok") })); }), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-2-answered-other-attempt", CM, run(keptA(["at1"], w => { w.flux.requests.push(d("d2", "at2", { flux: "applied", answer: "delivered", answerSeen: ans() })); }), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-3-answered-by-copy", CM, run(keptA(["at1"], w => { w.flux.requests.push(d("d1c", "at1", { copyOf: "d1", flux: "applied", answer: "delivered", answerSeen: ans() })); }), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-5-answered-uncertain", CM, run(keptA(["at1"], w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: ans("uncertain") }); }), [[tick, delGuard]]));
// closingEventFor(): only an applied closing event of this inbox, with a DELETE-caused reason, for the very event being applied.
const closeStep = [apply("d1"), closeBy("d1")] as const;
const onlyAt1Applied = () => keptA();
rej(G, "cm-guardLivesUntilEveryDeleteResolved-6-delay-event-is-not-apply", CM, run(onlyAt1Applied(), [[...closeStep], [{ t: "fault.delayEvent", eventId: "e-d1" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-7-apply-event-no-closing-event", CM, run(onlyAt1Applied(), [[{ t: "auto.applyEvent", eventId: "e-x" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-8-apply-other-event", CM, run(onlyAt1Applied(), [[...closeStep], [{ t: "auto.applyEvent", eventId: "e-x" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-9-event-not-closing", CM, run(keptA(["at1"], w => { w.flux.events.push(ev({ type: "email.inbox.restored" })); }), [[{ t: "auto.applyEvent", eventId: "e-y" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-10-closing-event-other-inbox", CM, run(keptA(["at1"], w => { w.flux.events.push(ev({ inboxId: "i2" })); }), [[{ t: "auto.applyEvent", eventId: "e-y" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-11-closing-event-flux-reason", CM, run(keptA(["at1"], w => { w.flux.events.push(ev({ reason: "billing" })); }), [[{ t: "auto.applyEvent", eventId: "e-y" }, delGuard]]));
// goneByGet(): only a DELIVERED GET of this inbox answering not_found proves it purged.
const gone = (o: Partial<ReturnType<typeof rq>> = {}) => rq({ requestId: "g7", kind: "GET_INBOX", target: "i1", purpose: "guard", flux: "applied", answer: "delivered", answerSeen: ans("not_found"), ...o });
rej(G, "cm-guardLivesUntilEveryDeleteResolved-12-not-found-from-non-get", CM, run(keptA("unknown", w => { w.flux.requests.push(gone({ kind: "RESTORE_INBOX" })); }), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-13-not-found-other-inbox", CM, run(keptA("unknown", w => { w.flux.requests.push(gone({ target: "i2" })); }), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-14-not-found-lost-answer", CM, run(keptA("unknown", w => { w.flux.requests.push(gone({ answer: "lost" })); }), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-15-get-answered-ok", CM, run(keptA("unknown", w => { w.flux.requests.push(gone({ answerSeen: ans("ok") })); }), [[tick, delGuard]]));
// resolvable(): the single remaining attempt may leave the list when its closing event is applied (the list shrinks, the guard stays).
acc(G, "cm-guardLivesUntilEveryDeleteResolved-17-closing-event-shrinks-list", CM, run(withRows(kept(), botKeepRow()), [[...closeStep], [{ t: "auto.applyEvent", eventId: "e-d1" }, w => { w.local.keepGuards.i1.unresolved = []; }]]));
// swap / prep are governed by the carry checks: the archive's guard may differ from the live one.
const carriedGuardWorld = (m: (w: World) => void) => from(w => { Object.assign(w, kept()); w.flux.requests = []; w.carry = carry({ keepGuards: [gd()] }); m(w); });
acc(G, "cm-guardLivesUntilEveryDeleteResolved-18-swap-installs-archive-guard", CM, run(carriedGuardWorld(w => { sysJob(w, "A", "cloud_reset", "captured"); }),
  [[{ t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false }, w => { sysSwap(w); w.local.keepGuards.i1 = gd({ keepOp: "kp0" }); }]]));
acc(G, "cm-guardLivesUntilEveryDeleteResolved-19-prep-reapplies-carry-guard", CM, run(carriedGuardWorld(w => { swappedStart(w); w.local.keepGuards.i1 = gd({ keepOp: "kp0" }); }),
  [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { sysPrep(w); w.local.keepGuards.i1 = gd(); }]]));
acc(G, "cm-guardLivesUntilEveryDeleteResolved-21-guard-rewritten-after-purge", CM, run(keptA("unknown", w => { w.flux.inboxes.i1.state = "purged"; w.flux.requests.push(gone()); }), [[tick, w => { w.local.keepGuards.i1.unresolved = []; }]]));
// A guard may move to a newer Keep op exactly when that Keep succeeds in this step.
const reKeep = () => { const w0 = confirmStart(true); w0.local.keepGuards.i1 = gd({ keepOp: "kpOld", unresolved: [] }); return w0; };
acc(G, "cm-guardLivesUntilEveryDeleteResolved-23-guard-moves-with-succeeding-keep", CM, run(reKeep(), [[tick, succeed("g1", 4)]]));
acc(G, "cm-guardLivesUntilEveryDeleteResolved-27-new-keep-guard-new-content", CM, run(reKeep(), [[tick, succeed("g1", 4)]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-24-guard-moves-no-keep", CM, run(kept(), [[tick, w => { w.local.keepGuards.i1 = gd({ keepOp: "kp2" }); }]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-25-other-keep-succeeds-now", CM, run(kept(), [[tick, w => { w.local.keepGuards.i1 = gd({ keepOp: "kp2" }); w.ghost.keeps.push(kr({ keepOp: "kp3", succeededAtStep: w.step, succeededAtMs: w.nowMs })); }]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-26-keep-succeeded-earlier", CM, run(kept(), [[tick, w => { w.local.keepGuards.i1 = gd({ keepOp: "kp2" }); w.ghost.keeps.push(kr({ keepOp: "kp2", succeededAtStep: 0, succeededAtMs: NOW })); }]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-29-window-rewritten", CM, run(kept(), [[tick, w => { w.local.keepGuards.i1.pollUntilMs += 1000; }]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-33-attempt-dropped-unresolved", CM, run(keptA(), [[tick, w => { w.local.keepGuards.i1.unresolved = []; }]]));
acc(G, "cm-guardLivesUntilEveryDeleteResolved-36-swap-drops-guard-carry-holds-it", CM, run(carriedGuardWorld(w => { sysJob(w, "A", "cloud_reset", "captured"); }), [[{ t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false }, w => { sysSwap(w); delGuard(w); }]]));
// newAuthorities(): only a VALID Remove authority of THIS inbox excuses a release.
rej(G, "cm-guardLivesUntilEveryDeleteResolved-37-keep-authority-is-not-remove", CM, run(keptA(), [[keepA({ tokenId: null }), w => { w.ghost.authorities.push(au({ authorityId: "aK2", kind: "keep", tokenId: null, genAtVerify: null, verifiedAtStep: w.step })); delGuard(w); }]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-38-remove-authority-other-inbox", CM, run(keptA(["at1"], w => { w.ghost.tokens.push(tk({ tokenId: "tB2", issuedAtStep: 0, shown: { target: "inbox:i2", address: ADDR, inboxId: "i2", keyIds: ["k1"] } })); }),
  [[removeA("tB2", { target: "inbox:i2" }), w => { w.ghost.authorities.push(au({ authorityId: "aR2", tokenId: "tB2", scope: { target: "inbox:i2", inboxId: "i2", keyIds: ["k1"] }, verifiedAtStep: w.step })); delGuard(w); }]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-39-remove-authority-invalid", CM, run(keptA(), [[tick, w => { w.ghost.authorities.push(au({ authorityId: "aX", verifiedAtStep: w.step })); delGuard(w); }]]));
// purged: only the applied deleted-event of THIS inbox.
const delEv = (o: Partial<Ev> = {}) => ev({ eventId: "e9", type: "email.inbox.deleted", reason: null, ...o });
rej(G, "cm-guardLivesUntilEveryDeleteResolved-40-delay-event-is-not-apply-purge", CM, run(keptA("unknown", w => { w.flux.events.push(delEv()); }), [[{ t: "fault.delayEvent", eventId: "e9" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-42-purge-event-not-the-applied-one", CM, run(keptA("unknown", w => { w.flux.events.push(delEv()); }), [[{ t: "auto.applyEvent", eventId: "e8" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-44-purge-event-other-inbox", CM, run(keptA("unknown", w => { w.flux.events.push(delEv({ inboxId: "i2" })); }), [[{ t: "auto.applyEvent", eventId: "e9" }, delGuard]]));
// release: with two unanswered DELETEs one closing event proves at most one; with one and no closing event nothing is proven.
rej(G, "cm-guardLivesUntilEveryDeleteResolved-48-two-unanswered-one-closing", CM, run(keptA(["at1", "at2"], w => { w.flux.requests.push(d("d2", "at2", { flux: "applied" })); }), [[...closeStep], [{ t: "auto.applyEvent", eventId: "e-d1" }, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-49-single-unanswered-no-closing-event", CM, run(keptA(), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-50-single-unanswered-guard-released", CM, run(keptA(), [[tick, delGuard]]));
// held(): only a held DELETE of THIS inbox that is not a tolerated duplicate blocks a release (no DELETE listed: the list is empty).
const keptNone = (reqs: ReturnType<typeof rq>[], un: string[] = []) => from(w => { Object.assign(w, kept(un)); w.flux.requests = reqs; });
acc(G, "cm-guardLivesUntilEveryDeleteResolved-51-held-get-does-not-block", CM, run(keptNone([rq({ requestId: "g5", kind: "GET_INBOX", target: "i1", purpose: "guard", flux: "held" })]), [[tick, delGuard]]));
acc(G, "cm-guardLivesUntilEveryDeleteResolved-52-held-delete-other-inbox", CM, run(keptNone([d("d3", "at9", { target: "i2", flux: "held" })]), [[tick, delGuard]]));
acc(G, "cm-guardLivesUntilEveryDeleteResolved-54-held-copy-tolerated-when-key-honoured", CM, run(keptNone([d("d1", "at1", { flux: "applied", answer: "delivered", answerSeen: ans() }), d("d1c", "at1", { copyOf: "d1", flux: "held" })], ["at1"]), [[tick, delGuard]]));
rej(G, "cm-guardLivesUntilEveryDeleteResolved-55-unlisted-delete-still-held", CM, run(keptNone([d("d1", "at1", { flux: "applied", answer: "delivered", answerSeen: ans() }), d("d2", "at2", { flux: "held" })], ["at1"]), [[tick, delGuard]]));

// ===================================== guardActsOnlyOnGuardRecord =================================================================
const GA = "guardActsOnlyOnGuardRecord";
acc(GA, "cm-guardActsOnlyOnGuardRecord-2-guard-poll-is-not-a-restore", CM, run(kept(), [[send(rq({ requestId: "g9", kind: "GET_INBOX", target: "i1", purpose: "guard" }))]]));
rej(GA, "cm-guardActsOnlyOnGuardRecord-4-restore-without-guard", CM, run(closingKept(w => { delete w.local.keepGuards.i1; w.ghost.keeps = []; }), [[guardRestore]]));
rej(GA, "cm-guardActsOnlyOnGuardRecord-5-restore-with-lease", CM, run(closingKept(w => { w.local.leases.L1 = ls({ phase: "sending" }); }), [[guardRestore]]));
rej(GA, "cm-guardActsOnlyOnGuardRecord-6-restore-of-parked", CM, run(closingKept(w => { w.local.parks.pk1 = pk(); }), [[guardRestore]]));
rej(GA, "cm-guardActsOnlyOnGuardRecord-7-restore-of-unknown-inbox", CM, run(closingKept(w => { w.local.keepGuards.i9 = gd({ inboxId: "i9" }); }), [[send(rq({ requestId: "r8", kind: "RESTORE_INBOX", target: "i9", purpose: "guard", credential: "owner" }))]]));
rej(GA, "cm-guardActsOnlyOnGuardRecord-8-restore-of-purged", CM, run(closingKept(w => { w.flux.inboxes.i1.state = "purged"; }), [[guardRestore]]));
acc(GA, "cm-guardActsOnlyOnGuardRecord-11-guard-without-keep-record", CM, run(closingKept(w => { w.local.keepGuards.i1.keepOp = "kpZ"; w.ghost.keeps = []; }), [[guardRestore, guardLine]]));
acc(GA, "cm-guardActsOnlyOnGuardRecord-14-later-keep-authority-is-not-remove", CM, run(closingKept(w => { keepHist(w, { keepOp: "kp2", authorityId: "aK2", claimedAtStep: 5 }, 5); }), [[guardRestore, guardLine]]));
acc(GA, "cm-guardActsOnlyOnGuardRecord-15-later-remove-other-inbox", CM, run(closingKept(w => { w.ghost.authorities.push(au({ authorityId: "aR2", verifiedAtStep: 5, scope: { target: "inbox:i2", inboxId: "i2", keyIds: ["k1"] } })); }), [[guardRestore, guardLine]]));

// ===================================== restorePrepNeverThrows =====================================================================
rej("restorePrepNeverThrows", "cm-restorePrepNeverThrows-6-boot-prep-threw", CM, run(base(), [[{ t: "auto.bootPrep", outcome: "threw" }]]));

// ===================================== viewMintsScopedTokens ======================================================================
const VM = "viewMintsScopedTokens";
const vw = (rows: ReturnType<typeof row>[], toks: ReturnType<typeof tk>[] = [], w0: World = base()): ReturnType<typeof run> =>
  run(w0, [[{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = rows; w.ghost.tokens.push(...toks); }]]);
const pRow = (a: ReturnType<typeof row>["actions"], o: Partial<ReturnType<typeof row>> = {}) => row({ section: "parked", actions: a, ...o });
const keepAct = (tokenId: string | null, enabled = true) => ({ kind: "keep" as const, tokenId, enabled });
const rmAct = (tokenId: string | null, enabled = true) => ({ kind: "remove" as const, tokenId, enabled });
const fresh = (o: Parameters<typeof tk>[0] = {}) => tk({ issuedAtStep: 1, ...o });
const shown = (o: Partial<ReturnType<typeof tk>["shown"]> = {}) => ({ target: T_I1, address: ADDR, inboxId: "i1", keyIds: ["k1"], ...o });
rej(VM, "cm-viewMintsScopedTokens-3-token-shows-fewer-keys", CM, vw([pRow([rmAct("tB")], { keyIds: ["k1", "k2"], section: "bot" })], [fresh({ shown: shown({ keyIds: ["k1"] }) })]));
rej(VM, "cm-viewMintsScopedTokens-4-token-shows-other-key", CM, vw([pRow([rmAct("tB")], { keyIds: ["k9"], section: "bot" })], [fresh({ shown: shown({ keyIds: ["k1"] }) })]));
acc(VM, "cm-viewMintsScopedTokens-5-disabled-action-needs-no-token", CM, run(base(), [[{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [pRow([rmAct(null, false)])]; }]]));
rej(VM, "cm-viewMintsScopedTokens-7-bot-row-remove-needs-token", CM, vw([row({ section: "bot", actions: [rmAct(null)] })]));
rej(VM, "cm-viewMintsScopedTokens-8-parked-row-keep-needs-token", CM, vw([pRow([keepAct(null)])]));
rej(VM, "cm-viewMintsScopedTokens-10-token-never-minted", CM, vw([pRow([rmAct("tGhost")])]));
const oldTok = (o: Parameters<typeof tk>[0] = {}) => from(w => { w.ghost.tokens.push(tk({ issuedAtStep: 0, ...o })); });
rej(VM, "cm-viewMintsScopedTokens-11-token-from-earlier-step", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [], oldTok()));
rej(VM, "cm-viewMintsScopedTokens-12-token-from-other-process", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [fresh({ processId: 2 })]));
rej(VM, "cm-viewMintsScopedTokens-13-token-from-other-epoch", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [fresh({ epoch: 1 })]));
rej(VM, "cm-viewMintsScopedTokens-14-token-for-other-principal", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [fresh({ issuedTo: "bot_credential" })]));
rej(VM, "cm-viewMintsScopedTokens-17-token-shows-other-inbox", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [fresh({ shown: shown({ inboxId: "i2" }) })]));
rej(VM, "cm-viewMintsScopedTokens-20-b-token-for-no-binding", CM, vw([row({ section: "bot", botId: "b9", actions: [rmAct("tB")] })], [fresh({ botId: "b9" })]));
rej(VM, "cm-viewMintsScopedTokens-21-b-token-for-other-bot", CM, vw([row({ section: "bot", botId: "b2", actions: [rmAct("tB")] })], [fresh()]));
rej(VM, "cm-viewMintsScopedTokens-22-b-token-stale-generation", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [fresh({ gen: G2 })]));
rej(VM, "cm-viewMintsScopedTokens-24-b-token-other-address", CM, vw([row({ section: "bot", actions: [rmAct("tB")] })], [fresh({ shown: shown({ address: "other@x.test" }) })]));
const parkedW = () => from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; });
const pTok = (o: Parameters<typeof tk>[0] = {}) => parkTok({ issuedAtStep: 1, tokenId: "tP", ...o });
rej(VM, "cm-viewMintsScopedTokens-25-park-token-for-no-park", CM, vw([pRow([rmAct("tP")])], [pTok({ park: { parkId: "pk9", parkRev: 0 } })], parkedW()));
rej(VM, "cm-viewMintsScopedTokens-27-park-token-stale-revision", CM, vw([pRow([rmAct("tP")])], [pTok({ park: { parkId: "pk1", parkRev: 0 } })], from(w => { w.local.parks.pk1 = pk({ parkRev: 1 }); w.local.bindings.b1.state = "removal_parked"; })));
rej(VM, "cm-viewMintsScopedTokens-28-park-token-other-target", CM, vw([pRow([rmAct("tP")])], [pTok()], from(w => { w.local.parks.pk1 = pk({ target: "inbox:i2" }); w.local.bindings.b1.state = "removal_parked"; })));
rej(VM, "cm-viewMintsScopedTokens-30-park-token-other-address", CM, vw([pRow([rmAct("tP")])], [pTok({ shown: shown({ address: "other@x.test" }) })], parkedW()));
rej(VM, "cm-viewMintsScopedTokens-31-token-minted-for-no-action", CM, vw([], [fresh()]));

// ===================================== carryImmutable =============================================================================
const CI = "carryImmutable";
const armedJob = (w: World) => { w.fs.restoreJob = { id: "j9", archiveId: "A", source: "desktop", phase: "armed", at: 0 }; };
rej(CI, "cm-carryImmutable-6-capture-with-no-armed-job", CM, run(base(), [[{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ complete: false }); }]]));
rej(CI, "cm-carryImmutable-8-capture-stamped-for-other-job", CM, run(from(armedJob), [[{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: "other", complete: false }); }]]));
rej(CI, "cm-carryImmutable-11-armed-job-tick-rewrites-carry", CM, run(from(w => { armedJob(w); w.carry = carry({ jobId: "j9" }); }), [[tick, w => { w.carry = carry({ jobId: "j9", complete: false }); }]]));
rej(CI, "cm-carryImmutable-12-capture-after-armed-phase-rewrites-carry", CM, run(from(w => { armedJob(w); w.fs.restoreJob!.phase = "captured"; w.carry = carry({ jobId: "j9" }); }), [[{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: "j9", complete: false }); }]]));


// Independent S5 source port: every guard restore must name the DELETE covered by its guard record.
const guardPortCase = (edit: Parameters<typeof closingKept>[0]) => run(closingKept(edit), [[guardRestore]]);
rej("guardActsOnlyOnGuardRecord", "port-s5-missing-closing-request", ["S5"], guardPortCase(w => { w.flux.requests = w.flux.requests.filter(r => r.requestId !== "d1"); }));
rej("guardActsOnlyOnGuardRecord", "port-s5-closing-request-is-not-delete", ["S5"], guardPortCase(w => { w.flux.requests.find(r => r.requestId === "d1")!.kind = "GET_INBOX"; }));
rej("guardActsOnlyOnGuardRecord", "port-s5-closing-request-is-another-inbox", ["S5"], guardPortCase(w => { w.flux.requests.find(r => r.requestId === "d1")!.target = "i2"; }));
rej("guardActsOnlyOnGuardRecord", "port-s5-closing-attempt-not-covered", ["S5"], guardPortCase(w => { w.local.keepGuards.i1.unresolved = ["at-other"]; }));
rej("guardActsOnlyOnGuardRecord", "port-s5-closing-attempt-is-null", ["S5"], guardPortCase(w => { w.local.keepGuards.i1.unresolved = ["at1"]; w.flux.requests.find(r => r.requestId === "d1")!.attemptId = null; }));
rej("guardActsOnlyOnGuardRecord", "port-s5-no-closing-cause", ["S5"], guardPortCase(w => { w.flux.inboxes.i1.closingCause = null; }));

acc("guardActsOnlyOnGuardRecord", "port-s5-unknown-delete-inventory-covers-current-closing", ["S5"], run(closingKept(w => { w.local.keepGuards.i1.unresolved = "unknown"; }), [[guardRestore, guardLine]]));

export const PIN = 80;
