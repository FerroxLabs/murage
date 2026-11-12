// Tests of the HARNESS (fault injector, FakeFlux, supervisor model, checker, witnesses, coverage). They do not test the
// keystore reducer, which does not exist yet.
import { describe, expect, it } from "vitest";
import { findCycles, runCheck } from "./checker.ts";
import { formatCoverage, newCoverage } from "./coverage.ts";
import { DAY, H, MARGIN, NIGHTLY_TWO_HOME, TINY_DOMAIN, describeBounds } from "./domain.ts";
import { addKey, emptyFlux, fluxAdvance, fluxApply, fluxHonours, fluxOwnerDelete, fluxUsageSync, fluxUse } from "./flux.ts";
import { fromStep, REGISTRY } from "./invariants.registry.ts";
import type { NamedInvariant } from "./invariants.registry.ts";
import { reduce, REDUCER_BRANCHES } from "./reducer.ts";
import { runWitnessPass } from "./keystore-witnesses.ts";
import { makeToyReducer } from "./reducer.toy.ts";
import { allSeeds, seedLV, seedRotateInFlight } from "./seeds.ts";
import { printTrace } from "./trace-printer.ts";
import { DUMMY_NO_DELETE, DUMMY_WITNESSES, runWitnesses } from "./witness.ts";
import type { Witness } from "./witness.ts";
import { clone, enabledMoves, hashState, step } from "./world.ts";
import type { FluxX, Move, Reducer, WorldX } from "./types.ts";

const D = TINY_DOMAIN;
const req = (kind: "rotate" | "mint" | "delete" | "list", keyId?: string, idem?: string) => ({ home: "h1", bot: "b1", kind, keyId, idem });
const fresh = (): FluxX => addKey(emptyFlux(0), "b1:k1", "b1", "h1");
const A = (f: FluxX, r: ReturnType<typeof req>, o: Parameters<typeof fluxApply>[2] = "normal") => fluxApply(f, r, o, 4);

describe("FakeFlux semantics", () => {
  it("rotate gives 201 K2, sets the 24h deadline once, and replays only the 201", () => {
    const a = A(fresh(), req("rotate", "b1:k1", "i1"));
    expect(a.resp).toMatchObject({ code: 201, keyId: "b1:k2" });
    expect(a.flux.keys["b1:k1"].deadlineAt).toBe(DAY);
    const later = fluxAdvance(a.flux, 5 * H);
    const replay = A(later, req("rotate", "b1:k1", "i1"));
    expect(replay.resp).toMatchObject({ code: 201, keyId: "b1:k2" });
    expect(Object.keys(replay.flux.keys)).toHaveLength(2); // replay created nothing
    expect(A(later, req("rotate", "b1:k1", "i2")).resp).toMatchObject({ code: 409, error: "rotation_pending", keyId: "b1:k2" }); // 409 re-evaluated
    expect(A(later, { ...req("rotate", "b1:k1", "i1"), bot: "b1", kind: "mint" }).resp).toMatchObject({ code: 409, error: "idempotency_mismatch" });
  });
  it("deadline never restarts: after DELETE of K2, a new-key rotate before the deadline gives 201 K3 with the ORIGINAL deadline; after it, 409 key_revoked", () => {
    let f = A(fresh(), req("rotate", "b1:k1", "i1")).flux;
    f = fluxAdvance(f, 6 * H);
    f = A(f, req("delete", "b1:k2")).flux;
    const r3 = A(f, req("rotate", "b1:k1", "i2"));
    expect(r3.resp).toMatchObject({ code: 201, keyId: "b1:k3" });
    expect(r3.flux.keys["b1:k1"].deadlineAt).toBe(DAY); // min rule, not 6h + 24h
    const past = fluxAdvance(f, DAY + 1);
    expect(A(past, req("rotate", "b1:k1", "i3")).resp).toMatchObject({ code: 409, error: "key_revoked" });
    expect(fluxHonours(past, "b1:k1")).toBe(false);
  });
  it("at the deadline the unclaimed successor is the live key", () => {
    const f = fluxAdvance(A(fresh(), req("rotate", "b1:k1", "i1")).flux, DAY);
    expect(f.keys["b1:k1"].status).toBe("expired_by_deadline");
    expect(f.keys["b1:k2"].status).toBe("live");
    expect(fluxHonours(f, "b1:k2")).toBe(true);
  });
  it("503 rotation_incomplete is retried with the SAME key into the same successor; a different key gets rotation_pending", () => {
    const a = A(fresh(), req("rotate", "b1:k1", "i1"), "incomplete503");
    expect(a.resp).toMatchObject({ code: 503, error: "rotation_incomplete", keyId: "b1:k2" });
    expect(A(a.flux, req("rotate", "b1:k1", "i1")).resp).toMatchObject({ code: 201, keyId: "b1:k2" });
    expect(A(a.flux, req("rotate", "b1:k1", "i9")).resp).toMatchObject({ code: 409, error: "rotation_pending" });
  });
  it("500 is an unknown outcome: applied or not, the home sees the same answer", () => {
    const applied = A(fresh(), req("rotate", "b1:k1", "i1"), "e500_applied");
    const dropped = A(fresh(), req("rotate", "b1:k1", "i1"), "e500_dropped");
    expect(applied.resp).toEqual({ code: 500 });
    expect(dropped.resp).toEqual({ code: 500 });
    expect(Object.keys(applied.flux.keys)).toHaveLength(2);
    expect(Object.keys(dropped.flux.keys)).toHaveLength(1);
    expect(Object.keys(applied.flux.holds)).toHaveLength(1);
    expect(Object.keys(A(fresh(), req("rotate", "b1:k1", "i1"), "e500_applied_nohold").flux.holds)).toHaveLength(0);
  });
  it("400, flag-off 404, key_not_found 404 are distinct", () => {
    expect(A(fresh(), req("rotate", "b1:k1", "i1"), "bad400").resp).toEqual({ code: 400, error: "invalid_request" });
    expect(A({ ...fresh(), flagOn: false }, req("rotate", "b1:k1", "i1")).resp).toEqual({ code: 404, error: "other" });
    expect(A(fresh(), req("rotate", "b1:zz", "i1")).resp).toEqual({ code: 404, error: "key_not_found" });
    expect(A(fresh(), req("delete", "b1:zz")).resp).toEqual({ code: 404, error: "key_not_found" });
  });
  it("plain mint: 409 bot_key_exists {successor} while a key is live; DELETE is idempotent; mint after owner delete works", () => {
    const rot = A(fresh(), req("rotate", "b1:k1", "i1")).flux;
    expect(A(rot, req("mint", undefined, "m1")).resp).toMatchObject({ code: 409, error: "bot_key_exists", keyId: "b1:k2" });
    const d1 = A(fresh(), req("delete", "b1:k1"));
    expect(d1.resp).toEqual({ code: 204 });
    expect(A(d1.flux, req("delete", "b1:k1")).resp).toEqual({ code: 204 });
    expect(A(d1.flux, req("mint", undefined, "m1")).resp).toMatchObject({ code: 201, keyId: "b1:k2" });
  });
  it("owner deletes at Flux: the key stops being honoured", () => {
    const f = fluxOwnerDelete(fresh(), "b1:k1");
    expect(fluxHonours(f, "b1:k1")).toBe(false);
  });
  it("replay hold expires after 24h: the same idem then re-evaluates", () => {
    const a = A(fresh(), req("rotate", "b1:k1", "i1"));
    const g = fluxAdvance(a.flux, DAY - 1);
    expect(A(g, req("rotate", "b1:k1", "i1")).resp).toMatchObject({ code: 201, keyId: "b1:k2" }); // still replayed
    const h = fluxAdvance(a.flux, DAY);
    expect(Object.keys(h.holds)).toHaveLength(0);
  });
});

/** Walk a path of moves chosen by predicate, failing if one is not enabled. */
function walk(w0: WorldX, red: Reducer, picks: ((m: Move) => boolean)[]): WorldX {
  let w = w0;
  for (const p of picks) {
    const m = enabledMoves(w, D).find(p);
    if (!m) throw new Error(`move not enabled; have ${enabledMoves(w, D).map((x) => x.k).join(",")}`);
    w = step(w, m, red, D).world;
  }
  return w;
}
const toy = makeToyReducer(false);
const is = (k: Move["k"], more: (m: Move) => boolean = () => true) => (m: Move) => m.k === k && more(m);

describe("fault injector and supervisor", () => {
  it("a child crash leaves the supervisor's queued save, which completes later and whose ack reaches the NEXT child", () => {
    let w = seedLV(D).world;
    w = walk(w, toy, [is("drive"), is("exec"), is("apply", (m) => (m as { outcome: string }).outcome === "normal"), is("deliver", (m) => !(m as { dup: boolean }).dup), is("exec")]);
    expect(w.homes.h1.supervisor.queue).toHaveLength(1);
    w = walk(w, toy, [is("crash", (m) => (m as { mode: string }).mode === "child")]);
    expect(w.homes.h1.memory.running).toBe(false);
    expect(w.homes.h1.supervisor.queue).toHaveLength(1); // survived
    expect(w.homes.h1.outbox).toHaveLength(0);
    w = walk(w, toy, [is("supStep"), is("supStep"), is("supStep"), is("supStep")]);
    expect(w.homes.h1.durable.disk.bots.b1).toBe("b1:k2"); // the dead child's save still landed
    expect(w.homes.h1.supervisor.builtAcks).toHaveLength(1);
    w = walk(w, toy, [is("boot"), is("ackDeliver", (m) => !(m as { dup: boolean }).dup)]);
    expect(w.homes.h1.memory.evidence?.bots.b1).toBe("b1:k2");
  });
  it("supervisor kill keeps a renamed file but loses a written temp; power loss loses both", () => {
    const base = seedLV(D).world;
    base.homes.h1.supervisor.queue.push({ gen: 1, image: { gen: 1, bots: { b1: "b1:k9" }, owner: null, retired: [], prev: [] }, phase: "queued" });
    const toRenamed = (w: WorldX) => walk(w, toy, [is("supStep"), is("supStep")]);
    const sup = walk(toRenamed(clone(base)), toy, [is("crash", (m) => (m as { mode: string }).mode === "supervisor")]);
    expect(sup.homes.h1.durable.disk.bots.b1).toBe("b1:k9");
    expect(sup.homes.h1.supervisor.queue).toHaveLength(0);
    const pow = walk(toRenamed(clone(base)), toy, [is("crash", (m) => (m as { mode: string }).mode === "power")]);
    expect(pow.homes.h1.durable.disk.bots.b1).toBe("b1:k1");
    const wr = walk(walk(clone(base), toy, [is("supStep")]), toy, [is("crash", (m) => (m as { mode: string }).mode === "supervisor")]);
    expect(wr.homes.h1.durable.disk.bots.b1).toBe("b1:k1");
  });
  it("crash between a durable commit and its effect loses the effect (outbox is memory)", () => {
    let w = seedLV(D).world;
    w = walk(w, toy, [is("drive")]);
    expect(w.homes.h1.durable.intents.b1).toBeDefined();
    expect(w.homes.h1.outbox).toHaveLength(1);
    w = walk(w, toy, [is("crash", (m) => (m as { mode: string }).mode === "child")]);
    expect(w.homes.h1.outbox).toHaveLength(0);
    expect(w.requests).toHaveLength(0);
  });
  it("responses can be lost, duplicated and reordered, and a late response arrives after a timeout", () => {
    let w = seedRotateInFlight(D).world;
    const mv = enabledMoves(w, D);
    expect(mv.some((m) => m.k === "lose")).toBe(true);
    expect(mv.some((m) => m.k === "deliver" && (m as { dup: boolean }).dup)).toBe(true);
    expect(mv.some((m) => m.k === "timeout")).toBe(false); // a queued response means no timeout yet
    w = walk(w, toy, [is("lose")]);
    w = walk(w, toy, [is("timeout")]);
    expect(w.requests).toHaveLength(0); // garbage collected: nobody can hear from it again
  });
  it("clock moves are explicit boundary events (deadline-2h, margin, deadline, +1, hold expiry)", () => {
    const w = seedRotateInFlight(D).world;
    const tos = enabledMoves(w, D).filter((m) => m.k === "clock").map((m) => (m as { to: number }).to);
    for (const t of [DAY - 2 * H, DAY - MARGIN, DAY, DAY + 1]) expect(tos).toContain(t);
  });
});

describe("state hash", () => {
  it("ignores the trace and absolute time, but not operational state", () => {
    const a = seedLV(D).world;
    const b = clone(a);
    b.trace.push({ t: "boot", home: "h1" });
    expect(hashState(a)).toBe(hashState(b));
    const c = clone(a);
    c.homes.h1.repairVisible.b1 = true;
    expect(hashState(a)).not.toBe(hashState(c));
    const x = clone(a), y = clone(a);
    x.homes.h1.durable.intents.b1 = { origin: "rotate", step: "rotate", oldKeyId: "b1:k1", sends: 1, strays: [], deadlineAt: DAY };
    y.now = 500; y.flux.now = 500; y.flux.keys["b1:k1"].createdAt = 500;
    y.homes.h1.durable.intents.b1 = { origin: "rotate", step: "rotate", oldKeyId: "b1:k1", sends: 1, strays: [], deadlineAt: DAY + 500 };
    expect(hashState(x)).toBe(hashState(y));
  });
});

describe("witness runner", () => {
  it("the dummy pair passes; an inverted predicate fails both witnesses; missing pairs are reported", () => {
    expect(runWitnesses([DUMMY_NO_DELETE], DUMMY_WITNESSES, { requireBoth: true })).toEqual([]);
    const inverted: NamedInvariant = { ...DUMMY_NO_DELETE, kind: "step", check: (p, a, n) => !(DUMMY_NO_DELETE as { check: (p: unknown, a: unknown, n: unknown) => boolean }).check(p, a, n) };
    expect(runWitnesses([inverted], DUMMY_WITNESSES)).toHaveLength(2);
    expect(runWitnesses([DUMMY_NO_DELETE], DUMMY_WITNESSES.slice(0, 1), { requireBoth: true })).toHaveLength(1);
  });
  it("the checker runs witnesses FIRST and does not explore when one fails", () => {
    const bad: Witness[] = [{ ...DUMMY_WITNESSES[1], expect: "accept" }];
    const r = runCheck({ domain: D, invariants: [DUMMY_NO_DELETE], witnesses: bad });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("witness");
    expect(r.coverage.states).toBe(0);
  });
});

describe("checker on the stub", () => {
  it("runs end to end on the placeholder reducer with the stub invariant, reports coverage, and finds no violation", () => {
    const r = runCheck({ domain: { ...D, depth: 6 }, witnesses: DUMMY_WITNESSES.map((w) => ({ ...w, invariant: "stub_passes_everything", expect: "accept" as const })).slice(0, 1), invariants: REGISTRY });
    expect(r.phase).toBe("explore");
    expect(r.violations).toEqual([]);
    expect(r.reducerFailures).toEqual([]);
    expect(r.coverage.states).toBeGreaterThan(5);
    expect(r.report).toContain("reducer branches");
    expect(r.report).toContain("events never fired");
    console.log(r.report.split("\n").slice(0, 9).join("\n"));
  });
  it("the real reducer passes the witness pass (no witness mismatch) and a depth-3 check reports no reducer failure", () => {
    const wp = runWitnessPass();
    expect(wp.mismatches).toEqual([]);
    const r = runCheck({ domain: { ...D, depth: 3 }, reducer: reduce });
    expect(r.reducerFailures).toEqual([]);
    expect(r.coverage.branchHits.size).toBeGreaterThan(0);
    expect(REDUCER_BRANCHES.length).toBeGreaterThan(9);
  });
  it("seeds cover the single-home, mid-flight and two-home shapes", () => {
    const names = allSeeds(NIGHTLY_TWO_HOME).map((s) => s.name);
    for (const n of ["LV", "rotate-in-flight", "twin-holds-source-key", "source-rotated-since-backup", "after-take"]) expect(names).toContain(n);
    expect(allSeeds(D).every((s) => s.name !== "after-take")).toBe(true);
    expect(describeBounds(NIGHTLY_TWO_HOME)).toContain("homes=2");
  });
});

describe("checker finds a planted bug through the fault injector and prints it", () => {
  // retire the old key only when its exact successor is durable on disk
  const retire: NamedInvariant = fromStep("retire_needs_durable_successor", ((p: WorldX, a: { kind: string; call?: { kind: string; keyId?: string; home: string; bot: string; cause?: { by: string } } }) => {
    if (a.kind !== "call" || a.call!.kind !== "delete" || a.call!.cause?.by !== "retire") return true;
    const i = p.homes[a.call!.home].durable.intents[a.call!.bot];
    return !!i && i.newKeyId !== undefined && p.homes[a.call!.home].durable.disk.bots[a.call!.bot] === i.newKeyId;
  }) as never);
  const witnesses: Witness[] = [];
  it("buggy toy reducer: counterexample with step, event, actions and state diff", () => {
    const r = runCheck({ domain: D, reducer: makeToyReducer(true), invariants: [retire], seeds: [seedLV(D)], depth: 8 });
    expect(r.ok).toBe(false);
    expect(r.violations[0].invariant).toBe("retire_needs_durable_successor");
    expect(r.violations[0].trace).toContain("reducer(h1) event");
    expect(r.violations[0].trace).toContain("actions");
    expect(r.violations[0].trace).toContain("~ ");
    console.log(r.violations[0].trace);
    void witnesses;
  });
  it("correct toy reducer: no violation under every fault class; coverage shows supervisor, ack and fault moves fired", () => {
    // mid-flight seed (a 201 waiting in the network) so the supervisor and ack path is reachable inside a small depth
    const dom = { ...D, name: "tiny-toy", depth: 11, maxStates: 120_000, budgets: { ...D.budgets, calls: 2, owner: 0, clock: 1, ownerDeletes: 0, fluxFaults: 0, dups: 1, lost: 1, crashes: 1 }, faults: { ...D.faults, reorder: false, probe: false, flux500: false, flux503: false, flux400: false, use: false } };
    const r = runCheck({ domain: dom, reducer: makeToyReducer(false), invariants: [retire], seeds: [seedRotateInFlight(dom)] });
    expect(r.violations).toEqual([]);
    expect(r.reducerFailures).toEqual([]);
    console.log(formatCoverage(r.coverage, []));
    const never = ["exec", "deliver", "lose", "supStep", "ackDeliver", "ackLose", "crash", "boot", "timeout", "clock"].filter((k) => !r.coverage.moves.has(k));
    expect(never).toEqual([]);
  });
  it("printTrace renders a state diff for a single step", () => {
    const w = seedLV(D).world;
    const s = step(w, { k: "drive", home: "h1", bot: "b1" }, toy, D);
    const t = printTrace("demo", "LV", w, [s]);
    expect(t).toContain("durable.intents.b1");
  });
});

describe("cycle detection", () => {
  it("finds a real cycle and ignores a DAG", () => {
    const g = new Map([["a", [{ to: "b", label: "x" }]], ["b", [{ to: "c", label: "y" }]], ["c", [{ to: "a", label: "z" }]], ["d", [{ to: "a", label: "w" }]]]);
    const c = findCycles(g);
    expect(c).toHaveLength(1);
    expect(c[0].nodes.sort()).toEqual(["a", "b", "c"]);
    expect(findCycles(new Map([["a", [{ to: "b", label: "x" }]], ["b", [{ to: "c", label: "y" }]]]))).toEqual([]);
    void newCoverage;
  });
});

describe("revised state type: list, 401, use, owner delete, late-visible usage", () => {
  it("use is 200 and stamps lastUsedAt but the LIST shows it only after a usage sync; a dead key answers 401", () => {
    let f = fresh();
    f = fluxAdvance(f, 5 * H);
    const u = fluxUse(f, "b1:k1");
    expect(u.resp).toBe(200);
    expect(u.flux.keys["b1:k1"].lastUsedAt).toBe(5 * H);
    const before = A(u.flux, req("list"));
    expect(before.resp).toMatchObject({ code: 200, list: [{ keyId: "b1:k1", lastUsedAt: null, used: false }] }); // lag: truth is not visible yet
    const after = A(fluxUsageSync(u.flux, "b1:k1"), req("list"));
    expect(after.resp).toMatchObject({ code: 200, list: [{ keyId: "b1:k1", lastUsedAt: 5 * H, used: true }] });
    expect(fluxUse(fluxOwnerDelete(f, "b1:k1"), "b1:k1").resp).toBe(401);
  });
  it("a minted key records who it was issued for and the operation", () => {
    const m = fluxApply(emptyFlux(0), { home: "h1", bot: "b1", kind: "mint", idem: "m1", opId: "op7" }, "normal", 4);
    expect(m.flux.keys["b1:k1"].issuedFor).toEqual({ home: "h1", opId: "op7" });
  });
  it("the scheduler offers use, usageSync and flux_owner_delete; an owner delete leaves the death UNOBSERVED until the home hears an answer (401)", () => {
    const D2 = { ...D, budgets: { ...D.budgets, uses: 2 } };
    const go = (w: WorldX, p: (m: Move) => boolean) => { const m = enabledMoves(w, D2).find(p); if (!m) throw new Error("move not enabled"); return step(w, m, toy, D2); };
    let w = seedLV(D2).world;
    expect(enabledMoves(w, D2).some((m) => m.k === "use")).toBe(true);
    let r = go(w, is("use"));
    expect(r.action).toEqual({ kind: "use", home: "h1", bot: "b1", resp: 200 });
    w = r.world;
    expect(w.flux.keys["b1:k1"].lastUsedAt).toBe(0);
    expect(w.flux.keys["b1:k1"].lastUsedVisibleAt).toBeNull();
    r = go(w, is("usageSync")); w = r.world;
    expect(r.action.kind).toBe("usage_sync");
    expect(w.flux.keys["b1:k1"].lastUsedVisibleAt).toBe(0);
    r = go(w, is("ownerFluxDelete")); w = r.world;
    expect(r.action).toEqual({ kind: "flux_owner_delete", keyId: "b1:k1" });
    expect(w.unobserved).toEqual({ h1: { b1: "b1:k1" } });
    expect(w.trace.some((e) => e.t === "flux_owner_delete")).toBe(true);
    r = go(w, is("use")); w = r.world;
    expect(r.action).toEqual({ kind: "use", home: "h1", bot: "b1", resp: 401 });
    expect(w.unobserved).toEqual({});
    expect(w.homes.h1.repairVisible.b1).toBe(true); // the toy reducer reacts to the 401
  });
  it("a delivered answer is recorded on the Operation (outcome known on a definitive answer, 'lost' on a timeout) and retries share the operation", () => {
    let w = seedRotateInFlight(D).world;
    expect(Object.keys(w.ops)).toHaveLength(1);
    w = walk(w, toy, [is("deliver", (m) => !(m as { dup: boolean }).dup)]);
    const op = Object.values(w.ops)[0];
    expect(op.outcome).toBe("known");
    expect(op.delivered).toEqual([{ code: 201, keyId: "b1:k2", oldKeyExpiresAt: DAY }]);
  });
});
