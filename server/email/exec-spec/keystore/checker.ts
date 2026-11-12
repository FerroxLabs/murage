// The model checker core. BFS over the operational state graph (hash = canonical state, NOT the trace), configurable depth,
// pluggable invariants, explicit cycle detection (Tarjan SCC over the recorded graph), witnesses run FIRST, coverage and
// counterexample printing. No I/O: callers print `report`.
import { branchHits, formatCoverage, newCoverage, resetBranchHits, tally } from "./coverage.ts";
import type { CoverageData } from "./coverage.ts";
import { describeBounds } from "./domain.ts";
import type { Domain } from "./domain.ts";
import { REGISTRY } from "./invariants.registry.ts";
import type { NamedInvariant } from "./invariants.registry.ts";
import { placeholderReduce } from "./reducer.ts";
import { allSeeds } from "./seeds.ts";
import type { Seed } from "./seeds.ts";
import { printTrace } from "./trace-printer.ts";
import { FAULT_MOVES } from "./types.ts";
import type { Move, Reducer, WorldX } from "./types.ts";
import { runWitnesses } from "./witness.ts";
import type { Witness, WitnessFailure } from "./witness.ts";
import { enabledMoves, hashState, step } from "./world.ts";
import type { StepResult } from "./world.ts";

export interface CheckOptions {
  domain: Domain;
  reducer?: Reducer; // default: the placeholder (identity)
  invariants?: NamedInvariant[]; // default: the stub registry
  witnesses?: Witness[];
  requireWitnessPairs?: boolean; // every invariant needs a must-accept and a must-reject witness
  seeds?: Seed[];
  /** the enabled-move generator (default: the world's). A seam for the no-freeze test. */
  movesFn?: (w: WorldX, d: Domain) => Move[];
  depth?: number;
  maxStates?: number;
  maxCounterexamples?: number;
  stopOnViolation?: boolean;
  /** ids of declared reducer branches for the coverage report (default: all declared) */
  declaredBranches?: readonly string[];
}
export interface Violation { invariant: string; seed: string; depth: number; trace: string; moves: Move[] }
export interface ReducerFailure { seed: string; message: string; trace: string }
export interface Cycle { states: number; moves: string[] }
export interface Freeze { seed: string; depth: number; trace: string }
/** r3.2h (H2): time may not freeze. A state with clock budget left must enable at least one clock move. */
export function isFrozen(w: WorldX, moves: Move[]): boolean { return w.budget.clock > 0 && !moves.some((m) => m.k === "clock"); }
export interface CheckResult {
  ok: boolean;
  phase: "witness" | "explore";
  witnessFailures: WitnessFailure[];
  violations: Violation[];
  reducerFailures: ReducerFailure[];
  cycles: Cycle[];
  freezes: Freeze[];
  selfLoops: number;
  truncated: boolean; // hit maxStates
  coverage: CoverageData;
  report: string;
}

interface Node { world: WorldX; parent: string | null; move: Move | null; depth: number; seed: number }

/** Tarjan SCC over edges (hash -> hashes). Returns components with more than one state, or a single state with a self edge. */
export function findCycles(edges: Map<string, { to: string; label: string }[]>): { nodes: string[]; labels: string[] }[] {
  let idx = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [];
  const out: { nodes: string[]; labels: string[] }[] = [];
  const nodesAll = new Set<string>([...edges.keys(), ...[...edges.values()].flatMap((e) => e.map((x) => x.to))]);
  for (const root of nodesAll) {
    if (index.has(root)) continue;
    // iterative Tarjan
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, idx); low.set(root, idx); idx++; stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const es = edges.get(top.v) ?? [];
      if (top.i < es.length) {
        const w = es[top.i++].to;
        if (!index.has(w)) { index.set(w, idx); low.set(w, idx); idx++; stack.push(w); onStack.add(w); work.push({ v: w, i: 0 }); }
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p)!, low.get(top.v)!)); }
        if (low.get(top.v) === index.get(top.v)) {
          const comp: string[] = [];
          let x: string;
          do { x = stack.pop()!; onStack.delete(x); comp.push(x); } while (x !== top.v);
          if (comp.length > 1) {
            const set = new Set(comp);
            out.push({ nodes: comp, labels: [...new Set(comp.flatMap((n) => (edges.get(n) ?? []).filter((e) => set.has(e.to)).map((e) => e.label)))].sort() });
          }
        }
      }
    }
  }
  return out;
}

/** Step-invariant verdict for one step. Harness rule (suspect predicate I6d, see suspect-predicates.md): a step that changes a home's durable state
 *  carries BOTH its primary action and a `commit`; I6d's deferred-close branch (a commit carrying a valid Reconnect capability) can never hold for the
 *  primary action (a drive/ack/boot is not an owner press), so AND-ing the two made a legitimate stamped close unsatisfiable. For I6d alone, when the
 *  step carries commits they are the verdict (owner presses never carry commits, so the press-time rules still see the primary). */
function stepPasses(inv: { name: string; check: (p: never, a: never, n: never) => boolean }, prev: unknown, r: { action: unknown; world: unknown; commits: unknown[] }): boolean {
  const ck = (a: unknown) => inv.check(prev as never, a as never, r.world as never);
  if (inv.name === "I6d_takeDisownsFirst" && r.commits.length > 0) return r.commits.every(ck);
  return ck(r.action) && r.commits.every(ck);
}

export function runCheck(opts: CheckOptions): CheckResult {
  const d = opts.domain;
  const red = opts.reducer ?? placeholderReduce;
  const invs = opts.invariants ?? REGISTRY;
  const depthMax = opts.depth ?? d.depth;
  const maxStates = opts.maxStates ?? d.maxStates;
  const cov = newCoverage(d.name);
  const emptyResult = (over: Partial<CheckResult>): CheckResult => ({ ok: true, phase: "explore", witnessFailures: [], violations: [], reducerFailures: [], cycles: [], freezes: [], selfLoops: 0, truncated: false, coverage: cov, report: "", ...over });

  // 1. witnesses FIRST
  const wf = runWitnesses(invs, opts.witnesses ?? [], { requireBoth: opts.requireWitnessPairs });
  if (wf.length) {
    return emptyResult({ ok: false, phase: "witness", witnessFailures: wf, report: `WITNESS FAILURES (${wf.length}); exploration skipped\n` + wf.map((f) => `  [${f.invariant}] ${f.witness}: ${f.why}`).join("\n") });
  }

  // 2. explore
  resetBranchHits();
  const seeds = opts.seeds ?? allSeeds(d);
  const nodes = new Map<string, Node>();
  const edges = new Map<string, { to: string; label: string }[]>();
  const seedHash: string[] = [];
  const violations: Violation[] = [];
  const reducerFailures: ReducerFailure[] = [];
  const freezes: Freeze[] = [];
  const movesOf = opts.movesFn ?? enabledMoves;
  const seenInv = new Set<string>();
  const maxCx = opts.maxCounterexamples ?? 10;
  let selfLoops = 0, truncated = false;
  let frontier: string[] = [];

  const rebuild = (h: string): { seedWorld: WorldX; steps: StepResult[]; seedName: string } => {
    const chain: Node[] = [];
    for (let c: string | null = h; c; c = nodes.get(c)!.parent) chain.unshift(nodes.get(c)!);
    const seedWorld = seeds[chain[0].seed].world;
    const steps: StepResult[] = [];
    let w = seedWorld;
    for (const n of chain.slice(1)) { const r = step(w, n.move!, red, d); steps.push(r); w = r.world; }
    return { seedWorld, steps, seedName: seeds[chain[0].seed].name };
  };

  const checkState = (h: string, w: WorldX) => {
    for (const inv of invs) if (inv.kind === "state" && !seenInv.has(inv.name) && !inv.check(w)) report(inv.name, h);
  };
  const report = (name: string, h: string, extra?: StepResult) => {
    seenInv.add(name);
    if (violations.length >= maxCx) return;
    const r = rebuild(h);
    const steps = extra ? [...r.steps, extra] : r.steps;
    violations.push({ invariant: name, seed: r.seedName, depth: steps.length, moves: steps.map((s) => s.move), trace: printTrace(`VIOLATION of ${name}`, r.seedName, r.seedWorld, steps) });
  };

  let queue: string[] = [];
  seeds.forEach((s, si) => {
    const h = `${si}:${hashState(s.world)}`;
    // seeds are keyed by their own hash; identical shapes from two seeds merge but keep the first
    const key = hashState(s.world);
    if (!nodes.has(key)) { nodes.set(key, { world: s.world, parent: null, move: null, depth: 0, seed: si }); queue.push(key); checkState(key, s.world); }
    seedHash.push(key); void h;
  });
  cov.states = nodes.size;

  outer: for (let depth = 0; queue.length; depth++) {
    cov.maxDepth = depth;
    if (depth >= depthMax) { frontier = queue; break; }
    const nextQ: string[] = [];
    for (const h of queue) {
      const n = nodes.get(h)!;
      const moves = movesOf(n.world, d);
      if (isFrozen(n.world, moves) && freezes.length < maxCx) { const b = rebuild(h); freezes.push({ seed: b.seedName, depth: b.steps.length, trace: printTrace("TIME FROZEN (clock budget left, no clock move enabled)", b.seedName, b.seedWorld, b.steps) }); }
      for (const m of moves) {
        const r = step(n.world, m, red, d);
        cov.transitions++; tally(cov.moves, m.k);
        if (!r.error) for (const hid of Object.keys(n.world.homes)) for (const b of Object.keys(n.world.homes[hid].durable.intents)) {
          const pi = n.world.homes[hid].durable.intents[b], ni = r.world.homes[hid]?.durable.intents[b];
          if (pi?.origin === "take" && ni?.origin === "reconnect" && r.world.homes[hid].durable.takeAuth[b] === undefined && pi.disowned !== undefined && r.world.homes[hid].durable.disk.prev.includes(pi.disowned)) { cov.stalledCloses++; cov.stalledCloseStates.add(hashState(r.world)); }
        }
        for (const rd of r.reductions) tally(cov.events, rd.event.t);
        if (r.error) {
          if (!reducerFailures.some((f) => f.message === r.error)) {
            const b = rebuild(h);
            reducerFailures.push({ seed: b.seedName, message: r.error, trace: printTrace(`REDUCER THREW on ${JSON.stringify(m)}`, b.seedName, b.seedWorld, [...b.steps, r]) });
          }
          continue;
        }
        for (const inv of invs) if (inv.kind === "step" && !seenInv.has(inv.name) && !stepPasses(inv, n.world, r)) { report(inv.name, h, r); if (opts.stopOnViolation) break outer; }
        const h2 = hashState(r.world);
        const label = m.k;
        (edges.get(h) ?? edges.set(h, []).get(h)!).push({ to: h2, label: FAULT_MOVES.has(m.k) ? `~${label}` : label });
        if (h2 === h) { selfLoops++; continue; }
        if (!nodes.has(h2)) {
          if (nodes.size >= maxStates) { truncated = true; continue; }
          nodes.set(h2, { world: r.world, parent: h, move: m, depth: depth + 1, seed: n.seed });
          nextQ.push(h2); cov.states = nodes.size;
          checkState(h2, r.world);
        }
      }
    }
    queue = nextQ;
    if (!queue.length) cov.maxDepth = depth;
  }
  cov.frontier = frontier.length;
  cov.branchHits = branchHits();

  // 3. explicit cycle detection on the progress-only subgraph (adversary/fault moves removed: a cycle there is a livelock candidate)
  const prog = new Map<string, { to: string; label: string }[]>();
  for (const [k, v] of edges) { const p = v.filter((e) => !e.label.startsWith("~") && e.to !== k); if (p.length) prog.set(k, p); }
  const cycles = findCycles(prog).map((c) => ({ states: c.nodes.length, moves: c.labels }));

  const failed = violations.length > 0 || reducerFailures.length > 0 || cycles.length > 0 || freezes.length > 0;
  const report_ = [
    describeBounds(d),
    `invariants: ${invs.map((i) => i.name).join(", ")}`,
    `seeds: ${seeds.map((s) => s.name).join(", ")}`,
    formatCoverage(cov, opts.declaredBranches),
    `progress cycles (livelock candidates, fault moves excluded): ${cycles.length}; no-op self-loops: ${selfLoops}; truncated at maxStates: ${truncated}`,
    ...violations.map((v) => v.trace),
    `time freezes: ${freezes.length}`,
    ...reducerFailures.map((f) => f.trace),
    ...freezes.map((f) => f.trace),
  ].join("\n");
  return { ok: !failed, phase: "explore", witnessFailures: [], violations, reducerFailures, cycles, freezes, selfLoops, truncated, coverage: cov, report: report_ };
}
