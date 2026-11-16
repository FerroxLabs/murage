// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CI gates for the restore-park spec (r3 / r3.1), harness plumbing only (no predicate or witness is edited):
//  1. r2 comparison: the r2-tagged witnesses against the r2 predicates (r2 wrongly ACCEPTS every escape, wrongly REJECTS every over-strict accept)
//  2. over-strict MUTANT test: one mutant per step invariant forbidding its `// PERMITTED ACTION:`; each must fail a must-accept witness
//  3. INVERSION test: inverting each predicate must fail its must-rejects
//  4. seed generator check: no generated starting state may rely on an authority / token / keep-op that no valid action created

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as R2 from "./invariants.r2.ts";
import * as SPEC from "./invariants.current.ts";
import { STATE_INVARIANTS, STEP_INVARIANTS, TRACE_INVARIANTS, OWNER_PRINCIPALS } from "./invariants.current.ts";
import type { Verdict, World } from "./invariants.current.ts";
import { ACTIVE_PREDICATES, fromRegistries, type PredicateSet } from "./predicates.ts";
import { toWorld } from "./model.ts";
import { SEEDS } from "./seeds.ts";
import { verdictViaPredicates } from "./witnesses/specRun.ts";
import { r2Comparison, type Witness } from "./witnesses/spec.ts";
import { WITNESSES } from "./witnesses/witnesses-all.ts";

const r2Set = fromRegistries("r2", R2.STEP_INVARIANTS as never, R2.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => R2.TRACE_INVARIANTS.keepEndsActive(t as never, s), quiescenceReachable: t => R2.TRACE_INVARIANTS.quiescenceReachable(t as never, R2.CHECKER.livenessBound),
});
const has = (ps: PredicateSet, n: string): boolean => n in ps.step || n in ps.state || n in ps.trace;
const named = (v: Verdict, n: string): boolean => !v.ok && v.invariant === n;
const verdict = (ps: PredicateSet, w: Witness): Verdict => (has(ps, w.invariant) ? verdictViaPredicates(ps, w.invariant, w.trace, w.settled) : { ok: true });
const nStep = Object.keys(STEP_INVARIANTS).length, nAll = nStep + Object.keys(STATE_INVARIANTS).length + Object.keys(TRACE_INVARIANTS).length;

describe("spec vs r2: fail-before / pass-after", () => {
  const cmp = r2Comparison();
  it("r2 wrongly ACCEPTS every r2-escape and wrongly REJECTS every over-strict accept; the spec is right on all", () => {
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const c of cmp) {
      const w = WITNESSES.find(x => x.id === c.id)!;
      const r2rej = named(verdict(r2Set, w), w.invariant), r3rej = named(verdict(ACTIVE_PREDICATES, w), w.invariant);
      if (c.kind === "escape" ? r2rej : !r2rej) wrongBefore.push(c.id + " (" + c.kind + ") r2 behaved correctly: not a fail-before");
      if (c.kind === "escape" ? !r3rej : r3rej) wrongAfter.push(c.id + " (" + c.kind + ") spec wrong");
    }
    console.log("r2 comparison: escapes " + cmp.filter(c => c.kind === "escape").length + ", overstrict " + cmp.filter(c => c.kind === "overstrict").length + "; fail-before " + (cmp.length - wrongBefore.length) + "/" + cmp.length + ", pass-after " + (cmp.length - wrongAfter.length) + "/" + cmp.length + (wrongBefore.length ? "; not failing on r2: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

/** What each step invariant's PERMITTED ACTION looks like as a step shape (action-type granularity; see the comment above each predicate in the spec). */
const OWNER_ACTS = ["owner.keep", "owner.remove", "owner.deleteBot", "owner.tryAgainNow", "owner.reconnect", "owner.confirmInventory"];
type Det = (p: World, a: { t: string }, n: World) => boolean;
const PERMITTED: Record<string, Det> = {
  keepSuccessIsConfirmed: (_p, a) => ["net.answer", "auto.tick"].includes(a.t),
  guardArmedForEveryKeep: (_p, a) => ["net.answer", "auto.tick"].includes(a.t),
  guardLivesUntilEveryDeleteResolved: (_p, a) => ["net.answer", "auto.applyEvent", "owner.remove", "flux.purge"].includes(a.t),
  guardDiesOnFreshRemove: (_p, a) => a.t === "owner.remove",
  guardActsOnlyOnGuardRecord: (_p, a) => a.t === "net.send",
  restoreUsesOwnerCredentialAndKeepPurpose: (_p, a) => a.t === "net.send",
  authorityCreatedByValidOwnerAction: (_p, a) => OWNER_ACTS.includes(a.t),
  ownerAuthorityForEveryDestructiveSend: (_p, a) => a.t === "net.send",
  removalSendNeedsSendingLease: (_p, a) => a.t === "net.send",
  noDestructiveSendAfterBlindRestore: (_p, a) => a.t === "net.send",
  keptKeysProtected: (_p, a) => ["owner.remove", "net.send", "net.answer"].includes(a.t),
  nothingAutomaticUnparks: (_p, a) => ["auto.tick", "auto.applyEvent", "net.answer"].includes(a.t),
  keptStaysKept: (_p, a) => ["auto.boot", "auto.restorePrepare", "auto.bootPrep", "auto.tick"].includes(a.t),
  outgoingCapturedBeforeSwap: (_p, a) => ["auto.swap", "auto.captureOutgoing"].includes(a.t),
  restorePrepParksEverything: (_p, a) => ["auto.restorePrepare", "auto.bootPrep"].includes(a.t),
  restorePrepNeverThrows: (_p, a) => ["auto.restorePrepare", "auto.bootPrep"].includes(a.t),
  viewMintsScopedTokens: (_p, a) => a.t === "owner.viewSurface",
  keyOnlyActionsTouchNoInbox: (_p, a) => a.t === "net.send",
  noRemoveDuringKeep: (_p, a) => a.t === "owner.remove",
  keepNetworkNeedsClaim: (_p, a) => a.t === "net.send",
  keepOpsFreshAndCasChecked: (_p, a) => a.t === "owner.keep" || a.t === "net.send",
  admissionPinned: (_p, a) => a.t.startsWith("owner."),
  keyTargetEntriesNeverDropped: (_p, a) => ["net.answer", "auto.tick", "auto.applyEvent"].includes(a.t),
  savedKeyNeverOutlivesRevokeWithoutWork: (_p, a) => ["flux.apply", "auto.tick"].includes(a.t),
  markerNeverArchivedAndConsumedAtBoot: (_p, a) => ["owner.backup", "auto.boot", "auto.bootPrep"].includes(a.t),
  restoreJobProtocol: (_p, a) => ["owner.restore", "auto.restoreArm", "auto.captureOutgoing", "auto.swap", "auto.restoreAbort", "auto.restoreJobClear"].includes(a.t),
  carryImmutable: (_p, a) => a.t === "auto.captureOutgoing",
  opsLinesNeverNameAddress: (p, _a, n) => n.ops.length > p.ops.length,
  environmentWellFormed: (_p, a) => a.t.startsWith("flux."),
  deletedBotAuthorityDead: (_p, a) => a.t === "net.send" || a.t === "owner.deleteBot",
};

describe("spec: over-strict mutants (one per step invariant, forbidding its PERMITTED ACTION)", () => {
  const acceptsOf = (n: string): Witness[] => WITNESSES.filter(w => w.invariant === n && w.expect === "accept");
  it("every step invariant has a mutant definition", () => {
    expect(Object.keys(STEP_INVARIANTS).filter(k => !(k in PERMITTED))).toEqual([]);
  });
  it("each mutant fails at least one must-accept witness; survivors are listed", () => {
    const survivors: string[] = [];
    for (const n of Object.keys(STEP_INVARIANTS)) {
      const orig = STEP_INVARIANTS[n], det = PERMITTED[n];
      const mutant = (p: World, a: never, nx: World): Verdict => (det(p, a, nx) ? { ok: false, invariant: n, why: "MUTANT forbids permitted action", step: nx.step } : orig(p, a, nx));
      const ps: PredicateSet = { ...ACTIVE_PREDICATES, step: { ...ACTIVE_PREDICATES.step, [n]: mutant as never } };
      if (!acceptsOf(n).some(w => !verdictViaPredicates(ps, n, w.trace, w.settled).ok)) survivors.push(n);
    }
    console.log("mutants: " + (nStep - survivors.length) + "/" + nStep + " killed; survivors: " + (survivors.join(", ") || "none"));
    expect(survivors).toEqual([]);
  });
});

describe("spec: predicate inversion", () => {
  it("inverting each predicate fails (is not rejected on) at least one of its must-rejects", () => {
    const flip = (v: Verdict, n: string, step: number): Verdict => (v.ok ? { ok: false, invariant: n, why: "INVERTED", step } : { ok: true });
    const none: string[] = [];
    const check = (n: string, ps: PredicateSet): void => {
      const rej = WITNESSES.filter(w => w.invariant === n && w.expect === "reject");
      if (!rej.some(w => !named(verdictViaPredicates(ps, n, w.trace, w.settled), n))) none.push(n);
    };
    for (const n of [...Object.keys(STEP_INVARIANTS), ...Object.keys(STATE_INVARIANTS), ...Object.keys(TRACE_INVARIANTS)]) {
      // the inverted predicate: ok where the original fails, failing where the original is ok (judged over the whole trace)
      const inv: PredicateSet = { name: "inverted", step: {}, state: {}, trace: { [n]: (t, s) => flip(verdictViaPredicates(ACTIVE_PREDICATES, n, t, s), n, 0) } };
      check(n, inv);
    }
    console.log("inversion: " + (nAll - none.length) + "/" + nAll + " predicates fail a must-reject when inverted; not: " + (none.join(", ") || "none"));
    expect(none).toEqual([]);
  });
});

describe("spec: generated starting states", () => {
  const sp = SPEC as unknown as { initialStateValid?: (w: World) => unknown };
  // Hand-built WITNESS worlds are never checked (58 fail initialStateValid by design); only the checker's generated seeds are.
  const authProblems = (w: World): string[] => {
    const out: string[] = [], auth = new Map(w.ghost.authorities.map(a => [a.authorityId, a])), tok = new Set(w.ghost.tokens.map(t => t.tokenId));
    const need = (id: string | null | undefined, what: string): void => {
      if (!id) return;
      const a = auth.get(id);
      if (!a) { out.push(what + " references authority " + id + " that no valid action created"); return; }
      if (!Array.from(OWNER_PRINCIPALS as Iterable<string>).includes(a.principal)) out.push(what + ": authority " + id + " not created by an owner principal");
      if (!a.tokenId || !tok.has(a.tokenId)) out.push(what + ": authority " + id + " has no issued token");
    };
    for (const r of w.flux.requests) need(r.authorityId, "request " + r.requestId);
    for (const l of Object.values(w.local.leases)) need(l.authorityId, "lease " + l.removalId);
    for (const k of Object.values(w.local.keepOps)) { need(k.authorityId, "keepOp " + k.keepOp); if (!w.ghost.usedKeepOps.includes(k.keepOp)) out.push("keepOp " + k.keepOp + " not in ghost.usedKeepOps"); }
    for (const g of Object.values(w.local.keepGuards)) if (g.keepOp && !w.ghost.usedKeepOps.includes(g.keepOp)) out.push("guard " + g.inboxId + " keepOp " + g.keepOp + " never claimed");
    return out;
  };
  it("every seed passes initialStateValid (when the spec exports it) and references only authorities real actions created", () => {
    const bad: string[] = [];
    for (const n of Object.keys(SEEDS)) {
      const w = toWorld(SEEDS[n]());
      const iv = sp.initialStateValid ? sp.initialStateValid(w) : null;
      if (iv !== null && iv !== undefined) bad.push(n + ": initialStateValid -> " + JSON.stringify(iv).slice(0, 200));
      for (const p of authProblems(w)) bad.push(n + ": " + p);
    }
    console.log("seed check: " + Object.keys(SEEDS).length + " seeds, initialStateValid " + (sp.initialStateValid ? "called" : "NOT EXPORTED (structural check only)") + "; problems: " + (bad.length ? bad.slice(0, 6).join(" | ") : "none"));
    expect(bad).toEqual([]);
  });
});

describe("spec: every step invariant has a reject and an accept witness that starts from a VALID world", () => {
  const sp = SPEC as unknown as { initialStateValid?: (w: World) => unknown };
  it("lists every step invariant lacking a valid-world reject or accept (goes back to the spec author)", () => {
    if (!sp.initialStateValid) { console.log("valid-world witnesses: initialStateValid not exported by this spec revision; skipped"); return; }
    const valid = (w: Witness): boolean => { const v = sp.initialStateValid!(w.trace[0].prev); return v === null || v === undefined; };
    const lacking: string[] = [];
    for (const n of Object.keys(STEP_INVARIANTS)) for (const e of ["reject", "accept"] as const) if (!WITNESSES.some(w => w.invariant === n && w.expect === e && w.trace.length > 0 && valid(w))) lacking.push(n + ":" + e);
    console.log("valid-world witness gaps (" + lacking.length + "): " + (lacking.join(", ") || "none"));
    expect(lacking).toEqual([]);
  });
});

import * as R3 from "./invariants.r3.ts";
describe("spec r3.1: r3-escape check (Q4, deleteBot authorities die)", () => {
  it("r3 wrongly ACCEPTS deleteBot-authority-reused (no r3 step predicate rejects it; r3 state predicates reject BOTH witnesses equally on their hand-built world, so they say nothing about the escape); r3.1 rejects it and accepts deleteBot-other-bot-untouched", () => {
    const r3Rejects = (w: Witness): string[] => {
      const out: string[] = [];
      for (const s of w.trace) {
        for (const [k, f] of Object.entries(R3.STEP_INVARIANTS)) { const v = (f as never as (p: World, a: unknown, n: World) => Verdict)(s.prev, s.action, s.next); if (!v.ok) out.push(k); }
      }
      return out;
    };
    const esc = WITNESSES.find(w => w.id === "deleteBot-authority-reused")!, ok = WITNESSES.find(w => w.id === "deleteBot-other-bot-untouched")!;
    const before = r3Rejects(esc), okBefore = r3Rejects(ok);
    const afterEsc = named(verdictViaPredicates(ACTIVE_PREDICATES, esc.invariant, esc.trace, esc.settled), esc.invariant);
    const afterOk = verdictViaPredicates(ACTIVE_PREDICATES, ok.invariant, ok.trace, ok.settled).ok;
    console.log("r3-escape: r3 STEP predicates rejecting deleteBot-authority-reused: [" + before.join(",") + "] (empty = wrongly accepted); r3 on other-bot-untouched: [" + okBefore.join(",") + "]; r3.1 rejects reused=" + afterEsc + ", accepts other-bot=" + afterOk);
    expect(before).toEqual([]);
    expect(afterEsc).toBe(true);
    expect(afterOk).toBe(true);
  });
});

import * as R31 from "./invariants.r31.ts";
import { r31Comparison, r32Comparison } from "./witnesses/spec.ts";
const r31Set = fromRegistries("r31", R31.STEP_INVARIANTS as never, R31.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R31.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R31.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R31 as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.1: fail-before / pass-after", () => {
  const cmp = r31Comparison();
  it("r3.1 gives the WRONG verdict on every r3.1-escape and r3.1-overstrict witness; the spec is right on all", () => {
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const c of cmp) {
      const w = WITNESSES.find(x => x.id === c.id)!;
      const rej31 = named(verdict(r31Set, w), w.invariant), rej32 = named(verdict(ACTIVE_PREDICATES, w), w.invariant);
      if (c.kind === "escape" ? rej31 : !rej31) wrongBefore.push(c.id + " (" + c.kind + ") r3.1 behaved correctly: not a fail-before");
      if (c.kind === "escape" ? !rej32 : rej32) wrongAfter.push(c.id + " (" + c.kind + ") spec wrong");
    }
    console.log("r3.1 comparison: escapes " + cmp.filter(c => c.kind === "escape").length + ", overstrict " + cmp.filter(c => c.kind === "overstrict").length + "; r3.1 wrong verdict " + (cmp.length - wrongBefore.length) + "/" + cmp.length + ", spec right " + (cmp.length - wrongAfter.length) + "/" + cmp.length + (wrongBefore.length ? "; r3.1 correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

describe("spec: named mutants (source-level, applied to a temp copy of the spec)", () => {
  const SRC = path.join(__dirname, "invariants.current.ts");
  const MUTANTS: { name: string; from: string; to: string; invariant: string; killers: string[] }[] = [
    { name: "keep-end-by-bot-delete-is-violation", from: "|| deletedAfter(rec.botId, at)) continue; // owner-caused end", to: ") continue; // owner-caused end", invariant: "quiescenceReachable", killers: ["keep-ended-by-owner-bot-delete"] },
    { name: "closing-is-gone", from: "    if (ib === null) return false;\n    return prev.flux.requests.some(r => r.target === ib && r.answer === \"delivered\"", to: "    if (ib === null) return false;\n    if (prev.flux.inboxes[ib]?.state === \"closing\" || Object.values(prev.local.parks).some(p => p.inboxId === ib && p.state === \"parked_evidence\")) return true;\n    return prev.flux.requests.some(r => r.target === ib && r.answer === \"delivered\"", invariant: "admissionPinned", killers: ["keep-refused-inbox-gone-on-parked-evidence", "keep-refused-inbox-gone-purge-unseen"] },
    { name: "any-restore-ends-keep", from: "const restoredAfter = (step: number) => ownerRestoredAfter(end, step);", to: "const restoredAfter = (step: number) => end.ghost.restores.some(r => r.atStep > step);", invariant: "quiescenceReachable", killers: ["auto-restore-drops-admitted-keep"] },
    { name: "owner-restore-unordered", from: "r.ownerRequestStep !== null && r.ownerRequestStep > step);", to: "r.ownerRequestStep !== null);", invariant: "quiescenceReachable", killers: ["stale-owner-restore-drops-keep"] },
    { name: "swap-prep-exempt-from-keep-ban", from: "    const r = next.ghost.restores[next.ghost.restores.length - 1];\n    for (const p of values(prev.local.parks)) {\n      if (p.state !== \"keep_pending\"", to: "    return OK;\n    const r = next.ghost.restores[next.ghost.restores.length - 1];\n    for (const p of values(prev.local.parks)) {\n      if (p.state !== \"keep_pending\"", invariant: "nothingAutomaticUnparks", killers: ["auto-swap-drops-admitted-keep"] },
    { name: "unparks-unordered", from: "r.ownerRequestStep === null || r.ownerRequestStep <= claim)", to: "r.ownerRequestStep === null)", invariant: "nothingAutomaticUnparks", killers: ["stale-owner-restore-swap-drops-keep"] },
    { name: "restore-skips-older-keep-check", from: "if (action.t === \"auto.swap\" && prev.carry && k in prev.carry.keptKeys) continue;", to: "if (action.t === \"auto.swap\") continue;", invariant: "keptKeysProtected", killers: ["blind-prep-downgrades-kept-key", "nolive-swap-older-keep-store-open"] }, // r3.3f: the prep clamp also catches the first killer
    { name: "whole-tail-promptness", from: "const win = tail.slice(late.length ? late[late.length - 1] + 1 : 0);", to: "const win = late.length ? [] : tail;", invariant: "quiescenceReachable", killers: ["recovered-delay-then-livelock"] },
    { name: "livelock-window-inclusive", from: "win[0].prev.nowMs > LIVELOCK_WINDOW_MS)", to: "win[0].prev.nowMs >= LIVELOCK_WINDOW_MS)", invariant: "quiescenceReachable", killers: ["livelock-window-edge-allowed"] },
    { name: "no-time-window", from: " || win[win.length - 1].next.nowMs - win[0].prev.nowMs > LIVELOCK_WINDOW_MS))", to: "))", invariant: "quiescenceReachable", killers: ["livelock-window-one-past"] },
    { name: "queued-skips-botless-lease", from: "for (const l of values(db.leases)) if (!l.foreign) add(", to: "for (const l of values(db.leases)) if (!l.foreign && l.botId !== null) add(", invariant: "restorePrepParksEverything", killers: ["restored-other-setup-removal-unparked", "restored-other-setup-removal-parked"] },
    { name: "bot-keep-token-ignored", from: "if (a.kind === \"keep\" && r.section === \"bot\" && a.tokenId === null) continue;", to: "if (a.kind === \"keep\" && r.section === \"bot\") { if (a.tokenId !== null) carriedBy.add(a.tokenId); continue; }", invariant: "viewMintsScopedTokens", killers: ["bot-keep-token-shows-another-target"] },
    { name: "prep-delete-exempt-uncarried", from: "if (k in next.local.keptKeys || (restoreStep && prev.carry && k in prev.carry.keptKeys)) continue;", to: "if (k in next.local.keptKeys || restoreStep || windowEnds) continue;", invariant: "keptKeysProtected", killers: ["blind-prep-drops-uncarried-kept-key"] },
    { name: "reinsert-skips-high-water", from: "const was = keptHighWater(prev, k); // r3.3a", to: "const was = authorityById(prev, prev.local.keptKeys[k] ?? null); // r3.3a", invariant: "keptKeysProtected", killers: ["reinsert-older-after-legit-absence"] },
    { name: "untokened-stale-not-refusable", from: "confirm_expired: staleUntokened || tokenProblem(prev, action.tokenId, t, needsToken),", to: "confirm_expired: tokenProblem(prev, action.tokenId, t, needsToken),", invariant: "admissionPinned", killers: ["keep-stale-binding-refused-confirm-expired"] },
    { name: "ghost-high-water-unguarded", from: "if (!n || (p && n.verifiedAtStep < p.verifiedAtStep)) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["ghost-high-water-lowered-while-live-holds", "ghost-high-water-deleted-while-live-holds"] },
    { name: "token-ignores-bot-delete", from: "if (tb !== null && t.issuedAtStep <= (prev.ghost.botDeletedAtStep[tb] ?? -1)) return true; // r3.3d (R3-Q4)", to: "if (false) return true; // r3.3d (R3-Q4)", invariant: "admissionPinned", killers: ["remove-with-delete-killed-token-refused-confirm-expired", "keep-with-delete-killed-token-refused-confirm-expired"] },
    { name: "token-bot-ignores-park", from: "const tb = tokenBot(prev, t); // r3.3e", to: "const tb = t.botId; // r3.3e", invariant: "admissionPinned", killers: ["park-remove-with-delete-killed-ptoken-refused-confirm-expired"] },
    { name: "prep-skips-high-water-clamp", from: "if (hw && (!now || now.verifiedAtStep < hw.verifiedAtStep) && !(k in uNext)) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-prep-leaves-older-keep"] },
    { name: "swap-window-ignores-phase", from: "if (action.t === \"auto.swap\" && SWAP_WINDOW_PHASES.has(next.proc.phase)) continue;", to: "if (action.t === \"auto.swap\") continue;", invariant: "keptKeysProtected", killers: ["nolive-swap-older-keep-store-open"] },
    { name: "window-allows-second-restore", from: "if (prepPending(prev) && (action.t === \"auto.captureOutgoing\" || action.t === \"auto.swap\")) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-window-capture-after-refused-restore"] }, // r3.3h: re-aimed (the admitted restore now fails first)
    { name: "window-allows-send", from: "if (action.t === \"net.send\") return fail(I, `${action.request.kind} sent while", to: "if (false) return fail(I, `${action.request.kind} sent while", invariant: "keptKeysProtected", killers: ["nolive-window-poll-send"] },
    { name: "window-admits-owner", from: "if (o.ok) return fail(I, action.t === ", to: "if (false) return fail(I, action.t === ", invariant: "keptKeysProtected", killers: ["nolive-window-owner-keep-admitted"] },
    { name: "window-refusal-not-legal", from: "    return OK;\n  }\n  // r3.2 (Fable M2, L1)", to: "    return fail(I, \"MUTANT\", next.step);\n  }\n  // r3.2 (Fable M2, L1)", invariant: "admissionPinned", killers: ["armed-keep-refused-restore-finishing", "nolive-window-try-again-refused"] }, // r3.4: re-aimed
    { name: "boot-clamp-unconditional", from: "const windowEnds = prepPending(prev) && (", to: "const windowEnds = (", invariant: "keptKeysProtected", killers: ["carried-prep-then-crash-boot-prep-ok"] },
    { name: "unconfirmed-mark-unguarded", from: "if (!(k in uNext) && k in next.local.keptKeys && !freshKeep) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-unconfirmed-mark-cleared-by-tick"] },
    { name: "unconfirmed-revoke-on-old-remove", from: "if (!a || !REMOVE_KINDS.has(a.kind) || a.verifiedAtStep <= uPrev[action.request.target]) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-unconfirmed-revoked-under-pre-restore-remove"] },
    { name: "unconfirmed-look-again-skipped", from: "if (!next.surface.some(r => r.visible && r.section === \"bot\" && r.line === RECONFIRM_KEPT_LINE", to: "if (false && !next.surface.some(r => r.visible && r.section === \"bot\" && r.line === RECONFIRM_KEPT_LINE", invariant: "keptKeysProtected", killers: ["nolive-unconfirmed-view-without-look-again"] },
    { name: "clamp-checks-departed-keys", from: "if (windowEnds) for (const k of Object.keys(next.local.keptKeys)) { // r3.3g window-ending prep", to: "if (windowEnds) for (const k of Object.keys(prev.local.keptKeys)) { // r3.3g window-ending prep", invariant: "keptKeysProtected", killers: ["nolive-revoked-key-leaves-before-clamp", "nolive-later-remove-leaves-before-clamp"] },
    { name: "carried-checks-restore-prep-only", from: "carryOfJob(prev) && windowEnds; // MUTANT carried", to: "carryOfJob(prev) && windowEnds && action.t === \"auto.restorePrepare\"; // MUTANT carried", invariant: "keptKeysProtected", killers: ["carried-mark-lost-across-boot-prep"] },
    { name: "unconfirmed-mark-value-mutable", from: "if (k in uNext && uNext[k] !== s) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-unconfirmed-mark-rewritten-by-tick"] },
    { name: "unconfirmed-mark-stamp-unchecked", from: "if (!born) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-unconfirmed-mark-born-on-tick"] }, // r3.3i: re-aimed (the prep is judged by the re-stamp rule)
    { name: "removal-done-counts-older-keep", from: "&& !keptAfter) return `key", to: "&& !(k in end.local.keptKeys)) return `key", invariant: "quiescenceReachable", killers: ["fresh-remove-of-marked-key-not-revoked"] },
    { name: "window-admits-restore", from: "if (o.ok) return fail(I, action.t === ", to: "if (false) return fail(I, action.t === ", invariant: "keptKeysProtected", killers: ["nolive-window-restore-admitted"] },
    { name: "window-refusal-by-phase", from: "if (windowOpen(prev) && WINDOW_DECISIONS.has(action.t)) {", to: "if ((windowOpen(prev) || SWAP_WINDOW_PHASES.has(prev.proc.phase)) && WINDOW_DECISIONS.has(action.t)) {", invariant: "admissionPinned", killers: ["ordinary-boot-refusal-not-window"] },
    { name: "window-purity-omits-savedkeys", from: "const windowDurable = (w: World) => JSON.stringify([w.local, ", to: "const windowDurable = (w: World) => JSON.stringify([w.local.keptKeys, w.local.unconfirmedKept ?? {}, w.local.leases, w.local.keepOps, w.local.parks, w.local.bindings, ", invariant: "keptKeysProtected", killers: ["nolive-window-keep-refused-clears-savedkeys"] },
    { name: "window-refusal-no-line", from: "if (!windowLineShown(next, actionBot(action))) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-window-refusal-without-line"] },
    { name: "window-view-skips-line", from: "if (action.t === \"owner.viewSurface\" && windowOpen(next) && !windowLineShown(next, null)) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-window-refusal-crash-view-without-line"] },
    { name: "look-again-any-section", from: "r.visible && r.section === \"bot\" && r.botId === action.botId && r.line === LOOK_AGAIN_LINE", to: "r.visible && r.botId === action.botId && r.line === LOOK_AGAIN_LINE", invariant: "admissionPinned", killers: ["keep-stale-look-again-not-bot-row"] },
    // r3.3i (independent Opus design check of r3.3h, A-F; Sol copy check G)
    { name: "prep-keeps-swap-mark", from: "if (uNext[k] !== want) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["nolive-stale-swap-mark-cleared-by-tick", "nolive-unconfirmed-mark-future-dated"] },
    { name: "window-end-mark-immutable", from: "if (windowEnds) continue; // MUTANT window-end-mark-immutable", to: "// MUTANT window-end-mark-immutable", invariant: "keptKeysProtected", killers: ["carried-mark-differs-from-archive-mark-prep-commits-carried", "nolive-swap-mark-restamped-by-prep"] },
    { name: "remove-clears-mark-kept-key", from: "&& !freshKeep) return fail(I, `unconfirmed mark on kept key", to: "&& !freshKeep && !freshRemove && !revoked) return fail(I, `unconfirmed mark on kept key", invariant: "keptKeysProtected", killers: ["marked-key-remove-owed-mark-cleared-by-tick"] },
    { name: "capture-drops-owed-remove-mark", from: "if (k in prev.local.keptKeys && next.carry?.unconfirmedKept?.[k] !== uPrev[k]) return fail(", to: "if (false) return fail(", invariant: "keptKeysProtected", killers: ["owed-remove-mark-dropped-at-capture"] },
    { name: "window-purity-omits-ops-archives-highwater", from: ", w.archives, w.ops, w.ghost.keptHighWater, ", to: ", ", invariant: "keptKeysProtected", killers: ["nolive-window-refusal-writes-ops-line", "nolive-window-refusal-writes-archive", "nolive-window-refusal-moves-high-water"] },
    { name: "reconfirm-line-uses-look-again", from: "r.line === RECONFIRM_KEPT_LINE && (b !== null", to: "r.line === LOOK_AGAIN_LINE && (b !== null", invariant: "keptKeysProtected", killers: ["nolive-unconfirmed-view-look-again-wording", "nolive-prep-marks-unconfirmed-then-owner-decides"] },
    { name: "window-line-accepts-look-again", from: "r.botId === b && r.line === RESTORE_FINISHING_LINE)));", to: "r.botId === b && (r.line === RESTORE_FINISHING_LINE || r.line === LOOK_AGAIN_LINE))));", invariant: "keptKeysProtected", killers: ["nolive-window-refusal-look-again-only"] },
    // r3.4 (redesign: durable restore job, one window, sealed carry)
    { name: "job-reality-unchecked", from: "if (prepPending(w)) return fail(I, `prep of epoch", to: "if (false) return fail(I, `prep of epoch", invariant: "restoreJobMatchesReality", killers: ["nolive-restore-pending-missing-in-window", "nolive-restore-pending-lost-across-crash"] },
    { name: "job-phase-any-step", from: "if (!ok) return fail(I, `restore job", to: "if (false) return fail(I, `restore job", invariant: "restoreJobProtocol", killers: ["job-armed-lost-across-boot"] },
    // r3.4d: quiescence-ignores-job RETIRED: the L2 job bound (until cleared, automatic steps) now rejects every uncleared job first, so the quiescentModuloWaiting job clause is subsumed (no witness can separate them).
    { name: "job-swap-any-archive", from: "p.archiveId !== action.archiveId || ", to: "", invariant: "restoreJobProtocol", killers: ["job-swap-foreign-archive"] },
    { name: "job-arm-over-open", from: "if (p || prev.carry) return false;", to: "", invariant: "restoreJobProtocol", killers: ["cm-restoreJobProtocol-60-armed-job-rearmed-same-identity"] },
    { name: "prep-skips-job-phase", from: "if (commitsPrep && p?.phase === \"swapped\" && n?.phase !== \"prepared\") return fail(", to: "if (false) return fail(", invariant: "restoreJobProtocol", killers: ["job-prepared-left-swapped"] },
    { name: "abort-not-pure", from: "if (rest(prev) !== rest(next)) return fail(", to: "if (false) return fail(", invariant: "restoreJobProtocol", killers: ["abort-not-pure"] },
    { name: "abort-no-line", from: "if (!next.surface.some(r => r.visible && r.section === \"home\" && r.line === RESTORE_FAILED_LINE)) return fail(", to: "if (false) return fail(", invariant: "restoreJobProtocol", killers: ["abort-without-failed-line"] },
    { name: "window-accepts-confirm-expired", from: "export const WINDOW_REFUSAL_CODES = [\"restore_finishing\"] as const;", to: "export const WINDOW_REFUSAL_CODES = [\"restore_finishing\", \"confirm_expired\"] as const;", invariant: "admissionPinned", killers: ["armed-keep-refused-confirm-expired-impure", "nolive-window-keep-refused-confirm-expired"] },
    { name: "window-purity-omits-bots", from: ", w.bots, w.flux]);", to: "]);", invariant: "keptKeysProtected", killers: ["window-refusal-deletes-bot"] },
    { name: "carry-mutable", from: "if (!same(prev.carry, next.carry)) return fail(\"carryImmutable\"", to: "if (false) return fail(\"carryImmutable\"", invariant: "carryImmutable", killers: ["carry-mark-rewritten-after-swap"] },
    { name: "bootprep-carry-not-authority", from: "const restoreStep = action.t === \"auto.swap\" || consumesCarry;", to: "const restoreStep = action.t === \"auto.swap\" || action.t === \"auto.restorePrepare\";", invariant: "keptKeysProtected", killers: ["carried-key-missing-from-archive-rebuilt-at-boot-prep"] },
    { name: "prep-departed-key-must-stay", from: "if (!keys.has(k) && !departed(k)) return fail(", to: "if (!keys.has(k)) return fail(", invariant: "restorePrepParksEverything", killers: ["prep-departed-revoked-key-not-lost", "prep-departed-removed-key-not-lost"] },
    // r3.4b (Opus design check of r3.4, N1-N5)
    { name: "carry-created-by-any-step", from: "if (!prev.carry) return fail(\"carryImmutable\", `carry ${next.carry.carryId} created by", to: "if (false) return fail(\"carryImmutable\", `carry ${next.carry.carryId} created by", invariant: "carryImmutable", killers: ["tick-creates-carry"] },
    { name: "job-arm-over-finished", from: "if (p || prev.carry) return false;", to: "if (p && OPEN_PHASES.has(p.phase)) return false;", invariant: "restoreJobProtocol", killers: ["cm-restoreJobProtocol-60-aborted-job-rearmed-same-identity-carry-present"] },
    { name: "blind-swap-with-carry", from: "else if (prev.carry) return fail(I, `blind swap with carry", to: "else if (false) return fail(I, `blind swap with carry", invariant: "outgoingCapturedBeforeSwap", killers: ["stale-aborted-carry-blind-swap"] },
    { name: "carry-job-unchecked", from: "if (w.carry && w.carry.jobId !== j.id) return fail(", to: "if (false) return fail(", invariant: "restoreJobMatchesReality", killers: ["stale-carry-under-new-job"] },
    { name: "prep-consumes-foreign-carry", from: "return !!w.carry && !!j && w.carry.jobId === j.id; };", to: "return !!w.carry; };", invariant: "keptKeysProtected", killers: ["stale-aborted-carry-launders-at-prep"] },
    { name: "stray-prep-consumes-carry", from: "const consumesCarry = carryOfJob(prev) && windowEnds;", to: "const consumesCarry = carryOfJob(prev) && (action.t === \"auto.restorePrepare\" && action.outcome === \"committed\") || windowEnds && (action.t === \"auto.restorePrepare\" || action.t === \"auto.bootPrep\");", invariant: "keptKeysProtected", killers: ["stray-prep-after-remove-restores-key"] },
    { name: "rekeep-under-removed-keep", from: "if (!(k in prev.local.keptKeys) && (action.t === \"auto.restorePrepare\" || action.t === \"auto.bootPrep\") && next.ghost.authorities.some(", to: "if (false && next.ghost.authorities.some(", invariant: "keptKeysProtected", killers: ["stray-prep-after-remove-restores-key"] },
    { name: "journal-holds-db-phase", from: "if (jr.phase === \"swapped\" || jr.phase === \"prepared\") return fail(", to: "if (false) return fail(", invariant: "restoreJobMatchesReality", killers: ["journal-written-prepared-outside-w4"] },
    { name: "window-takes-input", from: "if (action.t === \"auto.applyEvent\" || action.t === \"net.answer\") return fail(I,", to: "if (false) return fail(I,", invariant: "keptKeysProtected", killers: ["window-event-applied-mid-job"] },
    { name: "window-admits-backup", from: "\"owner.restore\", \"owner.backup\"]);", to: "\"owner.restore\"]);", invariant: "admissionPinned", killers: ["window-backup-admitted"] },
    // r3.4c (Opus design check of r3.4b, M1-M3, L3)
    { name: "stray-prep-owes-carry", from: "c = carryDuty ? prev.carry : null; // MUTANT stray-prep-owes-carry", to: "c = prev.carry; // MUTANT stray-prep-owes-carry", invariant: "restorePrepParksEverything", killers: ["stray-prep-after-remove-leaves-key-out"] },
    { name: "held-counts-late", from: "const held = windowOpen(w); // MUTANT held-counts-late", to: "const held = false; // MUTANT held-counts-late", invariant: "quiescenceReachable", killers: ["sys-armed-held-event-livelock"] },
    { name: "keep-success-leaves-binding-removing", from: 'if ((b.gen.inboxId ? inboxTarget(b.gen.inboxId) : botTarget(b.botId)) === k.target &&', to: 'if (false && (b.gen.inboxId ? inboxTarget(b.gen.inboxId) : botTarget(b.botId)) === k.target &&', invariant: "keepSuccessIsConfirmed", killers: ["s23-keep-success-leaves-binding-removing"] },
    { name: "keep-success-key-only-skipped", from: '=== k.target && (b.state === "removing"', to: '=== k.target && k.inboxId !== null && (b.state === "removing"', invariant: "keepSuccessIsConfirmed", killers: ["s23-key-only-keep-leaves-binding-removing"] },
    { name: "owner-principal-unchecked", from: 'if ("principal" in action && action.t !== "owner.viewSurface" && !OWNER_PRINCIPALS.has(action.principal)', to: 'if (false && "principal" in action && action.t !== "owner.viewSurface" && !OWNER_PRINCIPALS.has(action.principal)', invariant: "admissionPinned", killers: ["cm-admissionPinned-5-try-again-ok-by-bot-principal-lease-pending"] },
    { name: "try-again-non-bot-admitted", from: 'if (!t.startsWith("bot:")) return action.outcome.ok', to: 'if (false) return action.outcome.ok', invariant: "admissionPinned", killers: ["s23-try-again-non-bot-admitted", "s23-try-again-non-bot-refused"] },
    { name: "copy-names-no-request", from: 'if (next.flux.requests.some(r => r.copyOf !== null && !next.flux.requests.some(x => x.requestId === r.copyOf)))', to: 'if (false)', invariant: "environmentWellFormed", killers: ["s23-copy-names-no-request"] },
    { name: "inbox-key-ids-overlap", from: 'if (Object.keys(next.flux.inboxes).some(i => i in next.flux.keys))', to: 'if (false)', invariant: "environmentWellFormed", killers: ["s23-inbox-key-id-overlap"] },
    { name: "restore-record-stale-step", from: 'if (r.atStep !== next.step) return fail(I, "a new restore record', to: 'if (false) return fail(I, "a new restore record', invariant: "environmentWellFormed", killers: ["s23-restore-record-stale-step"] },
    { name: "owner-step-parks-kept-exempt", from: 'if (action.t === "owner.remove" || action.t === "auto.restorePrepare"', to: 'if (originOf(action) === "owner" || action.t === "auto.restorePrepare"', invariant: "keptStaysKept", killers: ["s23-owner-try-again-parks-kept-target"] },
    { name: "job-progress-unchecked", from: "    if (n >= bound) return fail(I, `restore job", to: "    if (false) return fail(I, `restore job", invariant: "quiescenceReachable", killers: ["job-armed-forever-flux-held-request"] },
    { name: "download-inside-window", from: "if (!(prev.fs.localArchives ?? []).includes(n.archiveId)) return false;", to: "", invariant: "restoreJobProtocol", killers: ["arm-before-archive-local"] },
    { name: "finished-job-restore-any-code", from: "if (oc !== \"restore_finishing\") return fail(I, `owner.restore", to: "if (o.ok) return fail(I, `owner.restore", invariant: "admissionPinned", killers: ["try-again-before-clear-other-code"] },
    // r3.4d (Opus design check of r3.4c, N-M1..N-M4, N-L2, N-L4)
    { name: "job-progress-counts-all-steps", from: "    if (originOf(s.action) === \"automatic\") n++;", to: "    n++;", invariant: "quiescenceReachable", killers: ["owner-restore-many-env-steps-accepted", "system-restore-many-env-steps-accepted"] },
    { name: "job-bound-stops-at-finished", from: "const j = jobOf(s.next); if (!j) { n = 0; continue; }", to: "const j = jobOf(s.next); if (!j || !OPEN_PHASES.has(j.phase)) { n = 0; continue; }", invariant: "quiescenceReachable", killers: ["job-prepared-or-aborted-never-cleared-event-pending"] },
    { name: "archive-not-frozen", from: "if (jb && (action.archiveId === jb.archiveId", to: "if (false && (action.archiveId === jb.archiveId", invariant: "restoreJobProtocol", killers: ["fetch-replaces-job-archive-mid-job"] },
    { name: "swap-no-archive-recheck", from: "if (action.t === \"auto.swap\" && !(prev.fs.localArchives ?? []).includes(action.archiveId))", to: "if (false)", invariant: "restoreJobProtocol", killers: ["swap-archive-missing"] },
    { name: "boot-prep-exempt", from: "(action as { outcome?: unknown }).outcome === \"ok\" && prepPending(prev); // M-4", to: "(action as { outcome?: unknown }).outcome === \"ok\" && false; // M-4", invariant: "restorePrepParksEverything", killers: ["boot-prep-leaves-carried-removal-unparked", "boot-prep-drops-carried-guard"] },
    { name: "held-input-never-checked", from: "if (ev || an) return fail(I", to: "if (false) return fail(I", invariant: "heldInputDrains", killers: ["held-event-dropped-after-window"] },
    { name: "fetch-line-always", from: "if (!ownerAsked && shown)", to: "if (!ownerAsked && !shown)", invariant: "restoreJobProtocol", killers: ["background-prefetch-fails-no-line"] },
    // r3.4e S5/S6 (page lines edited by MurageMain)
    { name: "s5-drop-later-remove", from: "&& later(a))) // MUTANT s5-later-remove", to: "&& false)) // MUTANT s5-later-remove", invariant: "guardActsOnlyOnGuardRecord", killers: ["guard-reverts-later-remove"] },
    { name: "s6-drop-or-guard", from: "[\"keep\", \"guard\"]; // MUTANT s6-or-guard", to: "[\"keep\"]; // MUTANT s6-or-guard", invariant: "restoreUsesOwnerCredentialAndKeepPurpose", killers: ["restore-with-owner-key"] },
  ];
  for (const m of MUTANTS) {
    it("mutant " + m.name + " is killed", async () => {
      const text = fs.readFileSync(SRC, "utf8");
      expect(text.split(m.from).length - 1).toBe(1);
      const file = path.join(__dirname, "invariants.mutant-" + m.name + ".ts");
      fs.writeFileSync(file, "// @ts-nocheck\n" + text.replace(m.from, m.to));
      try {
        const M = (await import(/* @vite-ignore */ file)) as typeof SPEC & { CHECKER: { livenessBound: never } };
        const ps = fromRegistries("mutant", M.STEP_INVARIANTS as never, M.STATE_INVARIANTS as never, {
          keepEndsActive: (t, s) => M.TRACE_INVARIANTS.keepEndsActive(t as never, s), quiescenceReachable: t => M.TRACE_INVARIANTS.quiescenceReachable(t as never, M.CHECKER.livenessBound),
          heldInputDrains: t => (M.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).heldInputDrains(t, M.CHECKER.livenessBound),
        });
        const wrong = m.killers.filter(id => { const w = WITNESSES.find(x => x.id === id)!; const rej = named(verdict(ps, w), w.invariant); return w.expect === "accept" ? rej : !rej; });
        console.log("named mutant " + m.name + ": wrong verdict on " + wrong.length + "/" + m.killers.length + " killers (" + wrong.join(",") + "); " + (wrong.length ? "KILLED" : "SURVIVED"));
        expect(wrong.length).toBeGreaterThan(0);
        // the unmutated spec is right on every killer
        for (const id of m.killers) { const w = WITNESSES.find(x => x.id === id)!; expect(named(verdict(ACTIVE_PREDICATES, w), w.invariant)).toBe(w.expect === "reject"); }
      } finally { fs.rmSync(file, { force: true }); }
    });
  }
});

import * as R32 from "./invariants.r32.ts";
const r32Set = fromRegistries("r32", R32.STEP_INVARIANTS as never, R32.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R32.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R32.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R32 as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.2: fail-before / pass-after", () => {
  const cmp = r32Comparison();
  it("r3.2 gives the WRONG verdict on every r3.2-escape and r3.2-overstrict witness; the spec is right on all", () => {
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const c of cmp) {
      const w = WITNESSES.find(x => x.id === c.id)!;
      const rej32 = named(verdict(r32Set, w), w.invariant), rej33 = named(verdict(ACTIVE_PREDICATES, w), w.invariant);
      if (c.kind === "escape" ? rej32 : !rej32) wrongBefore.push(c.id + " (" + c.kind + ") r3.2 behaved correctly: not a fail-before");
      if (c.kind === "escape" ? !rej33 : rej33) wrongAfter.push(c.id + " (" + c.kind + ") spec wrong");
    }
    console.log("r3.2 comparison: escapes " + cmp.filter(c => c.kind === "escape").length + ", overstrict " + cmp.filter(c => c.kind === "overstrict").length + "; r3.2 wrong verdict " + (cmp.length - wrongBefore.length) + "/" + cmp.length + ", spec right " + (cmp.length - wrongAfter.length) + "/" + cmp.length + (wrongBefore.length ? "; r3.2 correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33 from "./invariants.r33.ts";
const r33Set = fromRegistries("r33", R33.STEP_INVARIANTS as never, R33.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33 as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3: fail-before / pass-after (A8-M1 escapes)", () => {
  it("r3.3 wrongly ACCEPTS every r3.3-escape witness (they have no comparison field; ids tagged `// r3.3-escape` in witnesses); the spec rejects all", () => {
    const ids = ["blind-prep-deletes-then-older-reinsert", "blind-prep-drops-uncarried-kept-key", "reinsert-older-after-legit-absence"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      if (named(verdict(r33Set, w), w.invariant)) wrongBefore.push(id + " r3.3 behaved correctly");
      if (!named(verdict(ACTIVE_PREDICATES, w), w.invariant)) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3 comparison: escapes " + ids.length + "; r3.3 wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3 correct on: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33A from "./invariants.r33a.ts";
const r33aSet = fromRegistries("r33a", R33A.STEP_INVARIANTS as never, R33A.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33A.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33A.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33A as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3a: fail-before / pass-after (r3.3b clause)", () => {
  it("r3.3a gives the WRONG verdict on every r3.3a-escape / r3.3a-overstrict witness (ids tagged in witnesses); the spec is right on all", () => {
    const ids = ["keep-stale-binding-refused-confirm-expired", "keep-retry-on-current-binding-admitted", "ghost-high-water-lowered-while-live-holds", "ghost-high-water-deleted-while-live-holds"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33aSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3a behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3a comparison: tagged " + ids.length + "; r3.3a wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3a correct on: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33B from "./invariants.r33b.ts";
const r33bSet = fromRegistries("r33b", R33B.STEP_INVARIANTS as never, R33B.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33B.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33B.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33B as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3b: fail-before / pass-after (r3.3c clause)", () => {
  it("r3.3b gives the WRONG verdict on every r3.3b-escape witness (ids tagged in witnesses); the spec is right on all", () => {
    const ids = ["keep-stale-look-again-not-bot-row"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33bSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3b behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3b comparison: tagged " + ids.length + "; r3.3b wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3b correct on: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33C from "./invariants.r33c.ts";
const r33cSet = fromRegistries("r33c", R33C.STEP_INVARIANTS as never, R33C.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33C.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33C.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33C as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3c: fail-before / pass-after (r3.3d clause)", () => {
  it("r3.3c gives the WRONG verdict on every r3.3c-overstrict witness (ids tagged in witnesses); the spec is right on all", () => {
    const ids = ["remove-with-delete-killed-token-refused-confirm-expired", "keep-with-delete-killed-token-refused-confirm-expired"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33cSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3c behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3c comparison: tagged " + ids.length + "; r3.3c wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3c correct on: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33D from "./invariants.r33d.ts";
const r33dSet = fromRegistries("r33d", R33D.STEP_INVARIANTS as never, R33D.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33D.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33D.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33D as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3d: fail-before / pass-after (r3.3e clause)", () => {
  it("r3.3d gives the WRONG verdict on every r3.3d-overstrict witness; the spec is right on all", () => {
    const ids = ["park-remove-with-delete-killed-ptoken-refused-confirm-expired"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33dSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3d behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3d comparison: tagged " + ids.length + "; r3.3d wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3d correct on: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33E from "./invariants.r33e.ts";
const r33eSet = fromRegistries("r33e", R33E.STEP_INVARIANTS as never, R33E.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33E.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33E.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33E as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3e: fail-before / pass-after (r3.3f clause)", () => {
  it("r3.3e gives the WRONG verdict on every r3.3e-overstrict witness; the spec is right on all", () => {
    const ids = ["nolive-swap-window-crash-boot-prep-clamps"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33eSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3e behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3e comparison: tagged " + ids.length + "; r3.3e wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3e correct on: " + wrongBefore.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33F from "./invariants.r33f.ts";
const r33fSet = fromRegistries("r33f", R33F.STEP_INVARIANTS as never, R33F.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33F.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33F.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33F as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3f: fail-before / pass-after (r3.3g clause)", () => {
  it("r3.3f gives the WRONG verdict on every tagged r3.3f escape / overstrict witness; the spec is right on all", () => {
    const ids = ["nolive-second-restore-inside-window", "nolive-window-poll-send", "nolive-window-owner-keep-admitted", "carried-prep-then-crash-boot-prep-ok",
      "nolive-prep-marks-unconfirmed-then-owner-decides"]; // r3.4: nolive-window-keep-refused-confirm-expired left this set (verdict changed to reject; r3.3f now agrees)
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33fSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3f behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3f comparison: tagged " + ids.length + "; r3.3f wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3f correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});

import * as R33G from "./invariants.r33g.ts";
const r33gSet = fromRegistries("r33g", R33G.STEP_INVARIANTS as never, R33G.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33G.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33G.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33G as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3g: fail-before / pass-after (r3.3h clause)", () => {
  it("r3.3g gives the WRONG verdict on every tagged r3.3g escape / overstrict witness; the spec is right on all", () => {
    const ids = ["carried-mark-lost-across-boot-prep", "nolive-unconfirmed-mark-rewritten-by-tick", "nolive-unconfirmed-mark-future-dated",
      "fresh-remove-of-marked-key-not-revoked", "nolive-window-restore-admitted", "nolive-window-try-again-refused",
      "nolive-window-keep-refused-clears-savedkeys", "nolive-window-refusal-without-line", "nolive-window-refusal-crash-view-without-line"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33gSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3g behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3g comparison: tagged " + ids.length + "; r3.3g wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3g correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});
describe("r3.3h window refusals: the combined predicates accept every refused kind (Astra r3.3g #5)", () => {
  it("keptKeysProtected, admissionPinned and environmentWellFormed all accept each window-refusal witness", () => {
    const ids = ["armed-keep-refused-restore-finishing", "nolive-window-remove-refused", "nolive-window-try-again-refused",
      "nolive-window-restore-refused", "nolive-window-restore-refused-then-served", "nolive-window-refusal-crash-view-shows-line"];
    const bad: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      for (const n of ["keptKeysProtected", "admissionPinned", "environmentWellFormed"]) {
        const v = verdictViaPredicates(ACTIVE_PREDICATES, n, w.trace, w.settled);
        if (!v.ok) bad.push(id + " " + n + ": " + v.why);
      }
    }
    console.log("r3.3h combined window refusals: " + ids.length + " witnesses x 3 predicates, failures " + bad.length + (bad.length ? ": " + bad.join(" | ") : ""));
    expect(bad).toEqual([]);
  });
});

import * as R33H from "./invariants.r33h.ts";
const r33hSet = fromRegistries("r33h", R33H.STEP_INVARIANTS as never, R33H.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33H.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33H.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33H as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3h: fail-before / pass-after (r3.3i clause)", () => {
  it("r3.3h gives the WRONG verdict on every tagged r3.3h escape / overstrict witness; the spec is right on all", () => {
    const ids = ["nolive-stale-swap-mark-cleared-by-tick", "nolive-swap-mark-restamped-by-prep", "carried-mark-differs-from-archive-mark-prep-commits-carried",
      "marked-key-remove-owed-mark-cleared-by-tick", "owed-remove-mark-dropped-at-capture", "nolive-restore-pending-missing-in-window",
      "restore-pending-left-after-prep", "nolive-restore-pending-lost-across-crash", "nolive-window-refusal-writes-ops-line",
      "nolive-window-refusal-writes-archive", "nolive-window-refusal-moves-high-water", "nolive-unconfirmed-view-look-again-wording",
      "nolive-window-refusal-look-again-only"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33hSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3h behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3h comparison: tagged " + ids.length + "; r3.3h wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3h correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});
import * as R33I from "./invariants.r33i.ts";
const r33iSet = fromRegistries("r33i", R33I.STEP_INVARIANTS as never, R33I.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R33I.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R33I.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R33I as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.3i: fail-before / pass-after (r3.4 redesign)", () => {
  it("r3.3i gives the WRONG verdict on every tagged r3.3i escape / overstrict witness; the spec is right on all", () => {
    const ids = ["carry-mark-rewritten-after-swap", "carried-key-missing-from-archive-rebuilt-at-boot-prep", "job-stuck-armed-never-finishes",
      "armed-keep-refused-confirm-expired-impure", "armed-view-without-line", "window-refusal-deletes-bot", "abort-after-capture-clears"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r33iSet, w), w.invariant) === want) wrongBefore.push(id + " r3.3i behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.3i comparison: tagged " + ids.length + "; r3.3i wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.3i correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});
import * as R34 from "./invariants.r34.ts";
const r34Set = fromRegistries("r34", R34.STEP_INVARIANTS as never, R34.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R34.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R34.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R34 as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
/** r3.4b: r3.4 kept the job in LocalDb.restoreJob; each world is projected to that layout (the effective job, SPEC.jobOf) so r3.4 judges the same history. */
const toR34 = (x: World): World => { const y = JSON.parse(JSON.stringify(x)) as World; const lj = y.local as unknown as Record<string, unknown>;
  lj.restoreJob = SPEC.jobOf(x); delete lj.swappedJobId; delete lj.preparedJobId; delete (y.fs as unknown as Record<string, unknown>).restoreJob;
  if (y.carry) delete (y.carry as unknown as Record<string, unknown>).jobId; return y; };
const asR34 = (w: Witness): Witness => ({ ...w, trace: w.trace.map(st => ({ prev: toR34(st.prev), action: st.action, next: toR34(st.next) })) });
describe("spec vs r3.4: fail-before / pass-after (r3.4b, Opus design check N1-N5)", () => {
  it("r3.4 gives the WRONG verdict on every tagged r3.4 escape witness; the spec is right on all", () => {
    const ids = ["tick-creates-carry", "stale-aborted-carry-armed-over", "stale-carry-under-new-job", "stale-aborted-carry-blind-swap", "stale-aborted-carry-launders-at-prep",
      "stray-prep-after-remove-restores-key", "window-event-applied-mid-job", "window-backup-admitted"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      if (named(verdict(r34Set, asR34(w)), w.invariant) === want) wrongBefore.push(id + " r3.4 behaved correctly");
      if (named(verdict(ACTIVE_PREDICATES, w), w.invariant) !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.4 comparison: tagged " + ids.length + "; r3.4 wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.4 correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});
import * as R34B from "./invariants.r34b.ts";
const r34bSet = fromRegistries("r34b", R34B.STEP_INVARIANTS as never, R34B.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R34B.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R34B.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R34B as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.4b: fail-before / pass-after (r3.4c, Opus design check M1-M3, L3)", () => {
  it("r3.4b gives the WRONG verdict on every tagged r3.4b witness; the spec is right on all (M2 RED included)", () => {
    const ids = ["stray-prep-after-remove-leaves-key-out", "job-armed-forever-held-event", "sys-armed-held-event-livelock", "job-armed-forever-flux-held-request",
      "arm-before-archive-local", "abort-download-failed-in-window"];
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      const before = named(verdict(r34bSet, w), w.invariant), after = named(verdict(ACTIVE_PREDICATES, w), w.invariant);
      console.log("r3.4b comparison " + id + " (" + w.expect + "): r3.4b " + (before ? "REJECTS" : "ACCEPTS") + ", r3.4c " + (after ? "REJECTS" : "ACCEPTS"));
      if (before === want) wrongBefore.push(id + " r3.4b behaved correctly");
      if (after !== want) wrongAfter.push(id + " spec wrong");
    }
    console.log("r3.4b comparison: tagged " + ids.length + "; r3.4b wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.4b correct on: " + wrongBefore.join(" | ") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(" | ") : ""));
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});
import * as R34C from "./invariants.r34c.ts";
const r34cSet = fromRegistries("r34c", R34C.STEP_INVARIANTS as never, R34C.STATE_INVARIANTS as never, {
  keepEndsActive: (t, s) => (R34C.TRACE_INVARIANTS as never as Record<string, (t: unknown, s: boolean) => Verdict>).keepEndsActive(t, s),
  quiescenceReachable: t => (R34C.TRACE_INVARIANTS as never as Record<string, (t: unknown, b: unknown) => Verdict>).quiescenceReachable(t, (R34C as never as { CHECKER: { livenessBound: unknown } }).CHECKER.livenessBound),
});
describe("spec vs r3.4c: fail-before / pass-after (r3.4d, Opus design check N-M1..N-M4, N-L2, N-L4)", () => {
  it("r3.4c gives the WRONG verdict on every tagged r3.4c witness; the spec is right on all", () => {
    const ids = fs.readFileSync(path.join(__dirname, "witnesses", "spec.ts"), "utf8").split("\n").filter(l => l.includes("// r3.4c-wrong")).map(l => /^(?:acc|rej)\("\w+", "([\w-]+)"/.exec(l)?.[1]).filter((x): x is string => !!x);
    const wrongBefore: string[] = [], wrongAfter: string[] = [];
    for (const id of ids) {
      const w = WITNESSES.find(x => x.id === id)!;
      const want = w.expect === "reject";
      const before = named(verdict(r34cSet, w), w.invariant), after = named(verdict(ACTIVE_PREDICATES, w), w.invariant);
      console.log("r3.4c comparison " + id + " (" + w.expect + "): r3.4c " + (before ? "REJECTS" : "ACCEPTS") + ", r3.4d " + (after ? "REJECTS" : "ACCEPTS"));
      if (before === want) wrongBefore.push(id); if (after !== want) wrongAfter.push(id);
    }
    // M-4 confirmation: does ANY r3.4c predicate reject the boot-prep witnesses?
    for (const id of ["boot-prep-leaves-carried-removal-unparked", "boot-prep-drops-carried-guard"]) {
      const w = WITNESSES.find(x => x.id === id)!;
      const any = [...Object.keys(r34cSet.step), ...Object.keys(r34cSet.state), ...Object.keys(r34cSet.trace)].filter(n => !verdictViaPredicates(r34cSet, n, w.trace, w.settled).ok);
      console.log("r3.4c M-4 check " + id + ": r3.4c predicates rejecting: " + (any.join(",") || "none"));
    }
    console.log("r3.4c comparison: tagged " + ids.length + "; r3.4c wrong verdict " + (ids.length - wrongBefore.length) + "/" + ids.length + ", spec right " + (ids.length - wrongAfter.length) + "/" + ids.length + (wrongBefore.length ? "; r3.4c correct on: " + wrongBefore.join(",") : "") + (wrongAfter.length ? "; spec wrong on: " + wrongAfter.join(",") : ""));
    expect(ids.length).toBeGreaterThan(9);
    expect(wrongAfter).toEqual([]);
    expect(wrongBefore).toEqual([]);
  });
});
describe("r3.4d page: every predicate has one page line, a witness each way and a killing page mutant", () => {
  const names = [...Object.keys(ACTIVE_PREDICATES.step), ...Object.keys(ACTIVE_PREDICATES.state), ...Object.keys(ACTIVE_PREDICATES.trace)];
  it("PAGE_MAP and the registered predicates are the same set (no predicate without a page line)", () => {
    expect([...names].sort()).toEqual(Object.keys(SPEC.PAGE_MAP).sort());
    expect(new Set(Object.values(SPEC.PAGE_MAP)).size).toBe(names.length);
  });
  it("each predicate disabled (page-off mutant) wrongly accepts at least one of its must-reject witnesses", () => {
    const survivors: string[] = [];
    for (const n of names) {
      const off = { ok: true } as Verdict;
      const ps: PredicateSet = { ...ACTIVE_PREDICATES, step: { ...ACTIVE_PREDICATES.step }, state: { ...ACTIVE_PREDICATES.state }, trace: { ...ACTIVE_PREDICATES.trace } };
      if (n in ps.step) ps.step[n] = (() => off) as never; else if (n in ps.state) ps.state[n] = (() => off) as never; else ps.trace[n] = () => off;
      const rejs = WITNESSES.filter(w => w.invariant === n && w.expect === "reject"), accs = WITNESSES.filter(w => w.invariant === n && w.expect === "accept");
      if (!rejs.length || !accs.length || !rejs.some(w => !named(verdict(ps, w), n))) survivors.push(n);
    }
    console.log("r3.4d page mutants: " + (names.length - survivors.length) + "/" + names.length + " killed; survivors: " + (survivors.join(",") || "none"));
    expect(survivors).toEqual([]);
  });
});
describe("r3.3i combined-predicate gate (design check F): EVERY predicate accepts EVERY must-accept witness", () => {
  it("runs all registered step, state and trace predicates over every must-accept witness; 0 failures", () => {
    const names = [...Object.keys(ACTIVE_PREDICATES.step), ...Object.keys(ACTIVE_PREDICATES.state), ...Object.keys(ACTIVE_PREDICATES.trace)];
    const accepts = WITNESSES.filter(w => w.expect === "accept");
    const bad: string[] = [];
    for (const w of accepts) for (const n of names) {
      let v: Verdict;
      try { v = verdictViaPredicates(ACTIVE_PREDICATES, n, w.trace, w.settled); } catch (e) { v = { ok: false, invariant: n, why: "threw " + (e as Error).message, step: -1 }; }
      if (!v.ok) bad.push(w.id + " " + n + ": " + v.why);
    }
    console.log("r3.4d combined-predicate gate: " + accepts.length + " must-accept witnesses x " + names.length + " predicates = " + accepts.length * names.length + " checks, failures " + bad.length + (bad.length ? ": " + bad.join(" | ") : ""));
    expect(bad).toEqual([]);
  });
});
