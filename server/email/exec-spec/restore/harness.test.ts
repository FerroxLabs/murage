// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests of the HARNESS itself (not of the reducer): FakeFlux facts, crash injection, late DELETE reach, hashing, fairness, witnesses.

import { describe, expect, it } from "vitest";
import { restoreReducer } from "./restore-reducer.ts";
import { DAY_MS, DOMAIN_ONE, DOMAIN_TWO } from "./domain.ts";
import { explore, makeRuntime, randomWalks, replay, stateKey, DEFAULT_CHECK } from "./checker.ts";
import * as FF from "./fakeflux.ts";
import { FLUX_PURGE_MS } from "./invariants.current.ts";
import type { HomeEvent, Reducer } from "./model.ts";
import { toWorld } from "./model.ts";
import { apply, enabled } from "./moves.ts";
import { DUMMY, PASS_ALL } from "./predicates.ts";
import { BRANCH_IDS, placeholderReducer, reduce } from "./reducer.ts";
import { formatCoverage, newCoverage, printTrace } from "./report.ts";
import { runAll } from "./run.ts";
import { SEEDS } from "./seeds.ts";
import { runWitness, runWitnessesOrThrow } from "./witness.ts";
import { DUMMY_WITNESSES } from "./witnesses/dummy.ts";

const rt0 = (d = DOMAIN_ONE, r: Reducer = placeholderReducer) => makeRuntime(d, r, newCoverage());
const ctx = (now: number, deleteReason: "owner" | "bot_deleted" = "owner"): FF.FluxCtx => { let n = 1; return { nowMs: now, step: 0, cfg: { listing: "off" }, newEventId: () => "e" + n++, botHint: "b1", deleteReason, accountEmailDisabled: false }; };
const req = (kind: "DELETE_INBOX" | "RESTORE_INBOX" | "GET_INBOX", cred: "owner" | "bot_key" = "owner") => ({ ...SEEDS.midFlightRemoval().env.flux.requests[0], kind, credential: cred, target: "i1" });

describe("FakeFlux provider contract", () => {
  it("DELETE soft-deletes with no freshness check; repeat is idempotent; closing emits one event with reason owner", () => {
    const f = SEEDS.fresh().env.flux;
    expect(FF.applyRequest(f, req("DELETE_INBOX"), ctx(10)).answer).toBe("ok");
    expect(f.inboxes.i1.state).toBe("closing");
    const again = FF.applyRequest(f, req("DELETE_INBOX"), ctx(99));
    expect(again.code).toBe("already_closing");
    expect(f.inboxes.i1.closingSinceMs).toBe(10);
    expect(f.events.filter(e => e.type === "email.inbox.closing")).toHaveLength(1);
    expect(f.events[0].reason as string).toBe("owner");
  });
  it("restore: owner key only, 409 / 410 / 403 refusals, revoked bot key does not block", () => {
    const f = SEEDS.fresh().env.flux;
    // MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md: these are distinct operations, not retries of one id.
    const restore = (id: string, cred: "owner" | "bot_key" = "owner") => ({ ...req("RESTORE_INBOX", cred), requestId: id });
    expect(FF.applyRequest(f, restore("active"), ctx(5)).code).toBe("409_not_closing");
    FF.applyRequest(f, req("DELETE_INBOX"), ctx(10));
    f.keys.k1.state = "revoked";
    expect(FF.applyRequest(f, restore("bot-key", "bot_key"), ctx(11)).answer).toBe("refused");
    expect(FF.applyRequest(f, restore("late"), ctx(10 + FLUX_PURGE_MS + 1)).code).toBe("410_restore_window_passed");
    expect(FF.applyRequest(f, restore("valid"), ctx(12)).answer).toBe("ok");
    expect(f.inboxes.i1.state).toBe("active");
    const g = SEEDS.fresh().env.flux; FF.applyRequest(g, req("DELETE_INBOX"), ctx(10));
    const c = ctx(11); c.accountEmailDisabled = true;
    expect(FF.applyRequest(g, req("RESTORE_INBOX"), c).code).toBe("403_account_email_disabled");
  });
  it("closing drops mail at intake; Flux-initiated closings are a separate reason; purge needs the 30 d horizon", () => {
    const f = SEEDS.fresh().env.flux;
    expect(FF.intake(f.inboxes.i1)).toBe("accepted");
    expect(FF.fluxClose(f, "i1", "billing", ctx(7))).toBe(true);
    expect(FF.intake(f.inboxes.i1)).toBe("dropped");
    expect(f.inboxes.i1.closingCause).toEqual({ kind: "flux", reason: "billing" });
    expect(FF.purge(f, "i1", ctx(8))).toBe(false);
    expect(FF.purge(f, "i1", ctx(7 + FLUX_PURGE_MS))).toBe(true);
    expect(f.events.map(e => e.type)).toEqual(["email.inbox.closing", "email.inbox.deleted"]);
  });
  it("listing is a switch: off by default; per_account includes foreign entries", () => {
    expect(enabled(SEEDS.twoAddressForeign({ listing: "off" }), rt0(DOMAIN_TWO)).some(m => m.t === "net.listing")).toBe(false);
    const m = SEEDS.twoAddressForeign();
    expect(enabled(m, rt0(DOMAIN_TWO)).some(x => x.t === "net.listing")).toBe(true);
    const l = FF.listing(m.env.flux);
    expect(l.inboxes.map(i => i.inboxId)).toContain("x1"); expect(l.keys.map(k => k.keyId)).toContain("kx");
  });
});

describe("domain reach", () => {
  it("a held DELETE can land at Keep+31d and later, after restore", () => {
    const seed = SEEDS.keptWithLateDelete(), rt = rt0();
    let m = seed;
    for (const ms of [FLUX_PURGE_MS + 1, DAY_MS]) m = apply(m, { t: "clock.advance", ms }, rt).model;
    expect(m.env.nowMs - seed.env.nowMs).toBeGreaterThan(31 * DAY_MS - 1);
    expect(enabled(m, rt).some(x => x.t === "flux.apply" && x.requestId === "r0")).toBe(true);
    m = apply(m, { t: "flux.apply", requestId: "r0" }, rt).model;
    expect(m.env.flux.inboxes.i1.state).toBe("closing");
    expect(m.env.flux.inboxes.i1.closingSinceMs).toBeGreaterThan(seed.env.nowMs + 30 * DAY_MS);
  });
  it("clock never exceeds maxNowMs", () => {
    let m = SEEDS.fresh(); const rt = rt0();
    for (let i = 0; i < 6; i++) { const adv = enabled(m, rt).filter(x => x.t === "clock.advance"); if (!adv.length) break; m = apply(m, adv[adv.length - 1], rt).model; }
    expect(m.env.nowMs - 1_000_000).toBeLessThanOrEqual(DOMAIN_ONE.maxNowMs);
  });
});

describe("fault injection", () => {
  it("armed crash before a durable write drops it and takes the home down; after applies it", () => {
    const rt = rt0(DOMAIN_ONE, restoreReducer); // r3.4d J1: the owner restore is the reducer's ARM step (W25), so the crash cuts the journal write
    for (const when of ["before", "after"] as const) {
      let m = SEEDS.downAfterCrash(); m.home.proc.phase = "running"; // running, then crash-arm, then boot is not enabled: use restore path
      m = apply(m, { t: "owner.backup", kind: "desktop_backup" }, rt).model;
      m = apply(m, { t: "fault.crash", at: "W25_job_armed", when }, rt).model;
      const marker = { ...m.home.local, bindings: {} };
      void marker;
      const r = apply(m, { t: "owner.restore", source: "desktop", archiveId: "a1" }, rt);
      expect(r.model.home.proc.phase).toBe("down");
      expect(r.model.env.ext.armed).toBeNull();
      expect(!!r.model.home.fs.restoreJob).toBe(when === "after"); // before: the journal write is dropped; after: it landed, then the home went down
      expect(rt.ctx).toBeDefined();
    }
  });
  it("crash points: every W1..W30 x before/after is offered", () => {
    expect(enabled(SEEDS.fresh(), rt0()).filter(m => m.t === "fault.crash")).toHaveLength(60);
  });
  it("duplicate answers and lost answers are enumerated", () => {
    const rt = rt0(); let m = SEEDS.midFlightRemoval();
    m = apply(m, { t: "fault.duplicate", requestId: "r0" }, rt).model;
    expect(m.env.flux.requests.map(r => r.requestId)).toContain("r0#dup1");
    m = apply(m, { t: "flux.apply", requestId: "r0" }, rt).model;
    expect(enabled(m, rt).some(x => x.t === "fault.loseAnswer")).toBe(true);
    expect(enabled(m, rt).some(x => x.t === "net.answer")).toBe(true);
  });
});

describe("checker", () => {
  it("state key is time-translation invariant and ignores step counters", () => {
    const a = SEEDS.fresh(), b = SEEDS.fresh(); b.env.nowMs += 5000; b.env.step = 9;
    for (const ib of Object.values(b.env.flux.inboxes)) void ib;
    expect(stateKey(a)).toBe(stateKey(b));
    expect(stateKey(a, "full")).not.toBe(stateKey(toggle(b), "full"));
  });
  const toggle = (m: ReturnType<typeof SEEDS.fresh>) => { const c = structuredClone(m); c.home.proc.phase = "down"; return c; };

  it("BFS with the placeholder explores, finds nothing under pass-all, and is deterministic", () => {
    const a = explore(SEEDS.fresh(), DOMAIN_ONE, placeholderReducer, PASS_ALL, { maxDepth: 2 }), b = explore(SEEDS.fresh(), DOMAIN_ONE, placeholderReducer, PASS_ALL, { maxDepth: 2 });
    expect(a.states).toBeGreaterThan(50); expect(a.states).toBe(b.states); expect(a.violations).toHaveLength(0);
  });
  it("finds the dummy violation with a printable trace", () => {
    const r = explore(SEEDS.fresh(), DOMAIN_ONE, placeholderReducer, DUMMY, { maxDepth: 2 });
    expect(r.violations.length).toBe(1);
    expect(printTrace(r.violations[0].trace)).toContain("flux.close");
  });
  it("random walks are reproducible from the seed", () => {
    const c = { walks: 20, walkDepth: 15, seed: 7 };
    const a = randomWalks(SEEDS.fresh(), DOMAIN_ONE, placeholderReducer, PASS_ALL, c), b = randomWalks(SEEDS.fresh(), DOMAIN_ONE, placeholderReducer, PASS_ALL, c);
    expect(a.coverage.moves).toEqual(b.coverage.moves);
  });
  it("fair recovery reaches quiescent terminals from a mid-flight removal, flux purges included", () => {
    const r = explore(SEEDS.midFlightRemoval(), DOMAIN_ONE, placeholderReducer, PASS_ALL, { maxDepth: 1, recoveryEvery: 1, recoveryMaxSteps: 60 });
    expect(r.recoveries).toBeGreaterThan(0); expect(r.terminals).toBeGreaterThan(0); expect(r.violations).toHaveLength(0);
  });
  it("starvation: a reducer whose tick is always due and changes nothing is reported", () => {
    const stuck: Reducer = { ...placeholderReducer, name: "stuck", wakeups: () => [0] };
    const r = explore(SEEDS.fresh(), DOMAIN_ONE, stuck, PASS_ALL, { maxDepth: 0, recoveryEvery: 1, recoveryMaxSteps: 30 });
    expect(r.violations.map(v => (v.verdict.ok ? "" : v.verdict.invariant))).toContain("fair.obligationNoProgress");
  });
  it("legacy and mid-flight seeds all run", () => {
    for (const n of Object.keys(SEEDS)) expect(explore(SEEDS[n](), n === "legacy1018" || n === "twoAddressForeign" ? DOMAIN_TWO : DOMAIN_ONE, placeholderReducer, PASS_ALL, { maxDepth: 1 }).states).toBeGreaterThan(1);
  });
  it("end to end: runAll runs witnesses first and prints coverage with unfired branch ids", () => {
    const { text, results } = runAll({ predicates: DUMMY, witnesses: DUMMY_WITNESSES, seeds: ["fresh"], check: { maxDepth: 2, walks: 10, walkDepth: 10 } });
    expect(results.length).toBe(2); expect(text).toContain("reducer branch ids never taken"); expect(text).toContain("VIOLATION");
  });
  it("a state cap is reported as incomplete even when no counterexample was found", () => {
    const capped = runAll({ predicates: PASS_ALL, seeds: ["fresh"], check: { maxDepth: 1, maxStates: 1, walks: 0 } });
    expect(capped.results[0].violations).toEqual([]);
    expect(capped.results[0].truncatedStates).toBe(true);
    expect(capped.complete).toBe(false);
    expect(capped.text).toContain("truncatedStates=true");
    expect(capped.text).toContain("INCOMPLETE: state limit reached for fresh");
    expect(capped.text).toContain("Exploration complete within the requested bounds: false");
    const complete = runAll({ predicates: PASS_ALL, seeds: ["fresh"], check: { maxDepth: 0, walks: 0 } });
    expect(complete.complete).toBe(true);
    expect(complete.text).not.toContain("INCOMPLETE:");
  });
});

describe("reducer skeleton", () => {
  it("every event case throws unimplemented", () => {
    const s = SEEDS.fresh().home;
    const evs: HomeEvent[] = [
      { e: "boot", nowMs: 0 }, { e: "bootPrep", nowMs: 0, inject: "none" }, { e: "emailOn", nowMs: 0 }, { e: "settle", nowMs: 0 }, { e: "tick", nowMs: 0 },
      { e: "guardPoll", nowMs: 0, inboxId: "i1" }, { e: "applyEvent", nowMs: 0, event: { eventId: "e", type: "email.inbox.closing", inboxId: "i1", atMs: 0, atStep: 0, deliveredToHome: false, reason: null } },
      { e: "answer", nowMs: 0, requestId: "r", answer: "ok", code: null, fluxStateSeen: null }, { e: "listing", nowMs: 0, inboxes: [], keys: [] },
      { e: "owner", nowMs: 0, action: { t: "owner.viewSurface", principal: "owner_desktop" } }, { e: "backup", nowMs: 0, kind: "desktop_backup" },
      { e: "restoreSwap", nowMs: 0, step: 1, source: "desktop", archiveId: "a0", blind: false, archiveDb: null, archiveTopLevelNames: [], outgoingDb: null }, { e: "restorePrepare", nowMs: 0, step: 1 },
      { e: "restoreJobClear", nowMs: 0, step: 1 }, { e: "restoreArm", nowMs: 0, step: 1, source: "cloud_reset", archiveId: "a0" }, { e: "archiveFetch", nowMs: 0, step: 1, archiveId: "a0", outcome: "verified", forOwner: false },
    ];
    for (const ev of evs) expect(() => reduce(s, ev)).toThrow(/unimplemented/);
  });
  it("coverage lists the declared branch ids never taken", () => {
    expect(formatCoverage(newCoverage())).toContain(BRANCH_IDS[0]);
  });
});

describe("witness runner", () => {
  it("dummy pair passes (reject + accept)", () => {
    expect(runWitnessesOrThrow(DUMMY_WITNESSES, placeholderReducer, DUMMY).every(r => r.ok)).toBe(true);
  });
  it("a mismatch fails the run: flipped kind, unreachable move, and a missing pair", () => {
    const flipped = { ...DUMMY_WITNESSES[0], kind: "must-accept" as const };
    expect(runWitness(flipped, placeholderReducer, DUMMY).ok).toBe(false);
    const unreachable = { ...DUMMY_WITNESSES[1], moves: [{ t: "flux.purge" as const, inboxId: "i1" }] };
    expect(runWitness(unreachable, placeholderReducer, DUMMY).why).toContain("not enabled");
    expect(() => runWitnessesOrThrow([DUMMY_WITNESSES[0]], placeholderReducer, DUMMY)).toThrow(/lacks must-accept/);
    expect(() => runWitnessesOrThrow([flipped, DUMMY_WITNESSES[1]], placeholderReducer, DUMMY)).toThrow(/MUST-ACCEPT/);
  });
  it("witness replay uses the same world the predicates see (toWorld)", () => {
    const rt = rt0(); const { steps } = replay(SEEDS.fresh(), [{ t: "auto.tick" }], rt);
    expect(steps[0].next.proc.phase).toBe("running"); expect(toWorld(SEEDS.fresh()).flux.inboxes.i1.state).toBe("active");
  });
  it("default check config is sane", () => { expect(DEFAULT_CHECK.maxDepth).toBeGreaterThan(0); });
});
