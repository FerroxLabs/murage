// CI gate: the WITNESS PASS for the revised keystore invariants. Every must-reject witness must be rejected by its predicate
// and every must-accept accepted. Mismatches are the designer's to resolve (the invariants file is the spec); until then they
// are pinned in KNOWN_MISMATCHES so CI stays green but ANY change (a new mismatch, or a fixed one) fails this test and forces
// the list to be updated deliberately. An empty list is the goal.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCheck } from "./checker.ts";
import { TINY_DOMAIN } from "./domain.ts";
import * as spec from "./invariants.current.ts";
import { KEYSTORE_REGISTRY, KEYSTORE_WITNESSES, runWitnessPass } from "./keystore-witnesses.ts";
import { runWitnesses } from "./witness.ts";
import type { NamedInvariant } from "./invariants.registry.ts";
import type { StepAction, WorldX } from "./types.ts";
import { placeholderReduce } from "./reducer.ts";
import * as r2 from "./invariants.r2.ts";
import * as r31 from "./invariants.r31.ts";
import { CI_DOMAIN, DAY } from "./domain.ts";
import { step, emptyWorld, takeable } from "./world.ts";
import type { Reducer, HomeAction, Move } from "./types.ts";
import { fromStep } from "./invariants.registry.ts";
import { liftWorld } from "./keystore-witnesses.ts";
import { seedLV } from "./seeds.ts";

/** "<witness> | <invariant>" for each witness whose actual result differs from the designer's expectation. */
const KNOWN_MISMATCHES: string[] = [];

describe("keystore invariants: witness pass", () => {
  it("registers every spec step invariant exactly once", () => {
    expect(KEYSTORE_REGISTRY.map((i) => i.name).sort()).toEqual(Object.keys(spec.STEP_INVARIANTS).sort());
    expect(KEYSTORE_REGISTRY).toHaveLength(23);
  });
  it("every registered invariant has a must-accept and a must-reject witness", () => {
    for (const inv of KEYSTORE_REGISTRY) {
      const mine = KEYSTORE_WITNESSES.filter((w) => w.invariant === inv.name);
      expect(mine.some((w) => w.expect === "accept"), `${inv.name} must-accept`).toBe(true);
      expect(mine.some((w) => w.expect === "reject"), `${inv.name} must-reject`).toBe(true);
    }
  });
  it("runs all 164 witnesses (step + live); mismatches equal the pinned list", () => {
    const r = runWitnessPass();
    console.log(`WITNESS PASS: ${r.passed}/${r.total} passed; mismatches=${r.mismatches.length}`);
    for (const m of r.mismatches) console.log(`  MISMATCH ${m.witness} [${m.invariant}] expected ${m.expected}, actual ${m.actual}`);
    expect(r.total).toBe(spec.STEP_WITNESSES.length + spec.LIVE_WITNESSES.length);
    expect(r.total).toBe(164);
    expect(r.mismatches.map((m) => `${m.witness} | ${m.invariant}`).sort()).toEqual([...KNOWN_MISMATCHES].sort());
  });
  it("is not vacuous: inverting every predicate makes every step witness fail", () => {
    const inverted: NamedInvariant[] = KEYSTORE_REGISTRY.map((i) => (i.kind === "step" ? { name: i.name, kind: "step" as const, check: (p: WorldX, a: StepAction, n: WorldX) => !i.check(p, a, n) } : i));
    expect(runWitnesses(inverted, KEYSTORE_WITNESSES)).toHaveLength(KEYSTORE_WITNESSES.length);
  });
  it("the checker accepts the registry and the lifted witnesses as input (witnesses run first)", () => {
    const r = runCheck({ domain: { ...TINY_DOMAIN, depth: 1 }, invariants: KEYSTORE_REGISTRY, witnesses: KEYSTORE_WITNESSES, requireWitnessPairs: true, reducer: placeholderReduce, seeds: [seedLV(TINY_DOMAIN)] });
    // with mismatches pinned the checker stops at the witness phase; with none it explores and the placeholder may violate invariants
    expect(["witness", "explore"]).toContain(r.phase);
  });

  it("over-strict MUTANT: for every step invariant, a mutant that rejects its PERMITTED action fails a listed must-accept", () => {
    const survivors: string[] = [];
    for (const inv of KEYSTORE_REGISTRY) {
      const pa = spec.PERMITTED_ACTIONS[inv.name];
      expect(pa, `${inv.name} has PERMITTED_ACTIONS`).toBeDefined();
      const listed = pa.witnesses.map((id) => spec.STEP_WITNESSES.find((w) => w.id === id));
      for (const [i, w] of listed.entries()) { expect(w, `${inv.name}: ${pa.witnesses[i]} exists`).toBeDefined(); expect(w!.inv).toBe(inv.name); expect(w!.expect).toBe("accept"); }
      const keys = listed.map((w) => JSON.stringify([liftWorld(w!.prev), w!.action]));
      if (inv.kind !== "step") continue;
      const mutant: NamedInvariant = { name: inv.name, kind: "step", check: (p, a, n) => (keys.includes(JSON.stringify([p, a])) ? false : inv.check(p, a, n)) };
      const killed = runWitnesses([mutant], KEYSTORE_WITNESSES.filter((w) => w.invariant === inv.name && w.expect === "accept")).some((f) => f.why.startsWith("must-accept"));
      if (!killed) survivors.push(inv.name);
    }
    console.log(`MUTANT: ${KEYSTORE_REGISTRY.length - survivors.length}/${KEYSTORE_REGISTRY.length} killed; survivors=${survivors.join(",") || "(none)"}`);
    expect(survivors).toEqual([]);
  });
  it("r2-escape: the NEW r3 must-reject witnesses run against the r2 predicates", () => {
    const r2ids = new Set(r2.STEP_WITNESSES.map((w) => w.id));
    const r2reg = Object.entries(r2.STEP_INVARIANTS).map(([n, fn]) => fromStep(n, fn as never));
    const fresh = spec.STEP_WITNESSES.filter((w) => w.expect === "reject" && !r2ids.has(w.id));
    const escaped: string[] = [], threw: string[] = [], bit: string[] = [];
    for (const w of fresh) {
      const inv = r2reg.find((i) => i.name === w.inv);
      if (!inv) { escaped.push(`${w.id} (no r2 predicate)`); continue; }
      try { (inv.check(liftWorld(w.prev), w.action as StepAction, liftWorld(w.next)) ? escaped : bit).push(w.id); } catch { threw.push(w.id); }
    }
    console.log(`R2-ESCAPE: new r3 must-rejects=${fresh.length}; r2 wrongly accepts=${escaped.length}; r2 rejects=${bit.length}; r2 threw=${threw.length}`);
    console.log(`  r2 accepts: ${escaped.join(", ")}\n  r2 threw: ${threw.join(", ")}\n  r2 rejects: ${bit.join(", ")}`);
    expect(fresh.length).toBeGreaterThan(0);
  });

  it("I11 per-clause mutants: removing ONLY clause (a)/(b)/(c)/(d)/(kind) makes exactly that clause's must-reject witness fail", async () => {
    const src = readFileSync(new URL("./invariants.current.ts", import.meta.url), "utf8");
    const dir = new URL("./__mutants__/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    const clauses: { id: string; witness: string; from: string; to: string }[] = [
      { id: "a", witness: "I11-rej-usage-a-used-true", from: "if (row.used !== false || row.lastUsedAt !== null) return false; // (a)", to: "" },
      { id: "b", witness: "I11-rej-usage-b-local-recent", from: "if (defined(local) && local > prev.now - SYNC_LAG) return false; // (b) recent local use", to: "" },
      { id: "c", witness: "I11-rej-usage-c-younger-24h", from: "if (!(prev.now > row.createdAt + H24)) return false; // (c)", to: "" },
      { id: "d", witness: "I11-rej-usage-d-not-in-mintlog", from: "return !!entry && !entry.wasDurable; // (d)", to: "return true;" },
      { id: "kind", witness: "I11-rej-email-bot-used-false", from: "if (!defined(row.kind) || NEVER_USAGE_PRUNE_KINDS.includes(row.kind)) return false; // email:bot never", to: "" },
    ];
    const out: string[] = [];
    try {
      for (const c of clauses) {
        expect(src.split(c.from).length, `clause ${c.id} source line found once`).toBe(2);
        const file = `mutant-${c.id}.ts`;
        writeFileSync(new URL(file, dir), src.replace(c.from, c.to));
        const mod = (await import(/* @vite-ignore */ `./__mutants__/mutant-${c.id}.ts`)) as typeof spec;
        const mut = fromStep("I11_reconcileNeverPrunesUnknownLive", mod.I11_reconcileNeverPrunesUnknownLive as never);
        const res = runWitnesses([mut], KEYSTORE_WITNESSES.filter((w) => w.invariant === mut.name)).map((x) => x.witness).sort();
        out.push(`${c.id}: fails ${res.join(",") || "(nothing)"}`);
        expect(res, `removing only clause ${c.id}`).toContain(c.witness); // extras are reported in the log line: other witnesses that also depend on the clause
      }
    } finally { console.log(`I11 CLAUSE MUTANTS: ${out.join(" | ")}`); rmSync(dir, { recursive: true, force: true }); }
  });

  it("r3.2a quiescence mutant: restoring the time bound on crashed-home unknown ops fails exactly the crash-past-hold witness", async () => {
    const src = readFileSync(new URL("./invariants.current.ts", import.meta.url), "utf8");
    const from = 'o.home === h.id && o.outcome === "unknown")';
    expect(src.split(from).length).toBe(2);
    const dir = new URL("./__mutants__/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(new URL("mutant-q.ts", dir), src.replace(from, 'o.home === h.id && o.outcome === "unknown" && w.now < holdEnd(o))'));
      const mod = (await import(/* @vite-ignore */ `./__mutants__/${"mutant-q"}.ts`)) as typeof spec;
      const failed: string[] = [];
      for (const lw of spec.LIVE_WITNESSES) {
        if (lw.inv !== "I9_liveness") continue;
        const ok = mod.I9_liveness(lw.continuation, lw.bound, (w) => mod.isQuiescent(w, () => lw.enabled));
        if ((ok ? "accept" : "reject") !== lw.expect) failed.push(lw.id);
      }
      console.log(`QUIESCENCE MUTANT: fails ${failed.join(",") || "(nothing)"}`);
      expect(failed).toContain("I9-rej-forgo-crash-past-hold");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("r3.1-escape: the tagged r3.2 witnesses give the WRONG verdict on the r3.1 predicates (fail-before) and the right one on r3.2 (pass-after)", () => {
    const src = readFileSync(new URL("./invariants.current.ts", import.meta.url), "utf8").split("\n");
    const ids: string[] = [];
    const tagged = new Set<string>();
    src.forEach((l, i) => { if (/^\s*\/\/ r3\.1-escape: A\d|r3\.1-escape: A2$/.test(l)) { for (let j = i + 1; j < i + 4; j++) { const m = /(?:W\(|id: )"([A-Za-z0-9-]+)"/.exec(src[j]); if (m) { tagged.add(m[1]); break; } } } });
    ids.push(...tagged);
    // the A1 neighbour (a list page naming K1 ends the exemption) is the fourth r3.1-escape witness: r3.1 never carried the exemption
    ids.push("I1-rej-unobserved-ends-on-named-list");
    const uniq = [...new Set(ids)];
    const lines: string[] = [];
    let wrongBefore = 0;
    for (const id of uniq) {
      const sw = spec.STEP_WITNESSES.find((x) => x.id === id), lw = spec.LIVE_WITNESSES.find((x) => x.id === id);
      let before: string, after: string, want: string;
      if (sw) {
        want = sw.expect;
        const f = (m: typeof spec | typeof r31) => { const fn = (m.STEP_INVARIANTS as Record<string, (p: never, a: never, n: never) => boolean>)[sw.inv]; try { return fn(liftWorld(sw.prev) as never, sw.action as never, liftWorld(sw.next) as never) ? "accept" : "reject"; } catch { return "threw"; } };
        before = f(r31); after = f(spec);
      } else if (lw && lw.inv === "I10_noLeakAtQuiescence") {
        want = lw.expect;
        before = (r31 as unknown as { I10_noLeakAtQuiescence: (w: unknown) => string }).I10_noLeakAtQuiescence(lw.world);
        after = spec.I10_noLeakAtQuiescence(lw.world);
      } else throw new Error(`tagged witness ${id} not found`);
      lines.push(`${id}: want ${want}; r3.1 gives ${before}; r3.2 gives ${after}`);
      expect(after, `${id} right on r3.2`).toBe(want);
      if (before !== want) wrongBefore++;
    }
    console.log(`R31-ESCAPE: ${wrongBefore}/${uniq.length} give the wrong verdict on r3.1\n  ${lines.join("\n  ")}`);
    expect(uniq.length).toBe(4);
    expect(wrongBefore).toBe(4);
  });
});

// HARNESS plumbing for the sticky replayForgone (r3.2, A2) and replayLost: driven through the real scheduler `step`.
describe("replayForgone plumbing", () => {
  const D = { ...CI_DOMAIN, budgets: { ...CI_DOMAIN.budgets, calls: 4, lost: 3, clock: 4 } };
  /** sends one rotate (idem i1) on drive; retries on `lost` iff `retry`. */
  const reducer = (retry: boolean): Reducer => (home, ev) => {
    const h = structuredClone(home);
    const actions: HomeAction[] = [];
    const call = (): HomeAction => ({ a: "call", bot: "b1", kind: "rotate", idem: "i1", actor: "auto", at: (h.durable.intents.b1 as { at?: number } | undefined)?.at }); // r3.2h: every rotate/mint call carries intent.at
    if (ev.t === "drive" && ev.bot === "b1" && !h.durable.intents.b1) {
      h.durable.intents.b1 = { origin: "rotate", step: "rotate", oldKeyId: null, rotateIdem: "i1", at: ev.now, sends: 1, strays: [] } as never;
      actions.push(call());
    } else if (ev.t === "lost" && retry) actions.push(call());
    return { actions, state: h };
  };
  const setup = () => {
    const w = emptyWorld(D); const h = w.homes[Object.keys(w.homes)[0]];
    h.durable.bindings.b1 = { state: "active" } as never; h.memory.evidence = { gen: 0, bots: {} } as never;
    return { w, hid: h.id };
  };
  const run = (retry: boolean, moves: (hid: string, w: ReturnType<typeof setup>["w"]) => Move[]) => {
    let { w, hid } = setup(); const red = reducer(retry); const seen: (boolean | undefined)[] = [];
    for (const m of moves(hid, w)) {
      const m2 = m.k === "clock" && m.to === -1 ? { ...m, to: Object.values(w.ops).map((o) => o.firstSentAt + DAY).sort()[0] } as Move : m;
      const r = step(w, m2, red, D); expect(r.error).toBeUndefined(); w = r.world;
      seen.push(Object.values(w.ops)[0]?.replayForgone);
    }
    return { w, seen, op: Object.values(w.ops)[0] };
  };
  it("both allowed attempts sent and both dropped: replayForgone stays UNSET, replayLost is set (true) at holdEnd", () => {
    const { seen, op } = run(true, (hid) => [
      { k: "drive", home: hid, bot: "b1" }, { k: "exec", home: hid }, { k: "dropReq", reqId: 1 }, { k: "exec", home: hid }, { k: "dropReq", reqId: 2 }, { k: "clock", to: -1 },
    ]);
    expect(seen.every((x) => !x)).toBe(true);
    expect(op.replayForgone).toBeFalsy();
    expect(op.replayLost).toBe(true);
  });
  it("takeable and the home does nothing: replayForgone is set", () => {
    const { seen, op } = run(false, (hid) => [
      { k: "drive", home: hid, bot: "b1" }, { k: "exec", home: hid }, { k: "dropReq", reqId: 1 }, { k: "clock", to: 1000 }, { k: "clock", to: -1 },
    ]);
    expect(seen.slice(0, 3).every((x) => !x)).toBe(true); // pending request, then the step that ends it: not yet takeable at their prev
    expect(op.replayForgone).toBe(true);
  });
  it("take-predicate is exactly: running + proven + unfenced + nothing pending + attempts left + queue empty for the bot", () => {
    const { w } = run(false, (hid) => [{ k: "drive", home: hid, bot: "b1" }, { k: "exec", home: hid }, { k: "dropReq", reqId: 1 }]);
    const red = reducer(false); const o = () => Object.values(w.ops)[0]; const h = () => Object.values(w.homes)[0];
    const ok = () => takeable(w, o(), red);
    expect(ok()).toBe(true);
    h().memory.running = false; expect(ok()).toBe(false); h().memory.running = true;
    const ev0 = h().memory.evidence; h().memory.evidence = null; expect(ok()).toBe(false); h().memory.evidence = ev0;
    h().durable.fenced = true; expect(ok()).toBe(false); h().durable.fenced = false;
    w.requests.push({ reqId: 99, opId: o().opId, appliedAtFlux: false, inbound: [], dupLeft: 0, answered: false, timedOut: false, dropped: false }); expect(ok()).toBe(false); w.requests.pop();
    h().outbox.push({ a: "call", bot: "b1", kind: "rotate", idem: "i1", actor: "auto", at: 0 }); expect(ok()).toBe(false); h().outbox.pop();
    (o() as unknown as { sends: number }).sends = 2; expect(ok()).toBe(false);
    (o() as unknown as { sends: number }).sends = 1; expect(ok()).toBe(true);
  });
});
