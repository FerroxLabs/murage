// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE CHECKER. BFS with state hashing (+ seeded random walks), and a controlled FAIR RECOVERY exploration for liveness. No I/O.
//
// HASHING (operational state, not the trace): stateKey() canonicalises the Model (sorted keys) after normalisation: step counters are
// dropped, absolute times are replaced by (time - now) so the same situation at a different absolute time is one state, and now itself
// is bucketed by 30 d. Ghost history stays in the key (it is part of what predicates see). hash mode "full" keeps everything, for
// debugging a suspected merge. Sound for predicates that use history only through relative ordering and elapsed time; a predicate that
// reads absolute step numbers needs mode "full".
//
// FAIRNESS MODEL (written down; the liveness claim is relative to it):
//   Obligations (weakly fair: if continuously enabled they eventually fire, in any interleaving): home boot, boot prep (non-faulty),
//   email-on, settle (once per process), a Flux apply of every held request (delayed, never lost), delivery of every pending answer
//   that was not lost, emission of every Flux event, delivery of every emitted event at least once, the per-account listing when the
//   switch is on, Flux purge when the 30 d horizon is reached, and the home tick when reducer.wakeups() says one is due.
//   NOT fair (adversary/owner/time, never forced): owner actions, every fault (crash, lost answer, duplicate, redelivery), Flux-initiated
//   closings, and clock advances (time passes only when no obligation is enabled, and only to the next deadline).
//   A liveness verdict therefore means: along EVERY fair schedule from this state with no further faults and no owner action, the system
//   reaches a quiescent terminal state in which the trace predicates (settled = true) hold. Violations: terminal trace predicate fails;
//   an obligation that stays enabled with no state change (starvation); a cycle of obligation moves (livelock).
// FAIR RECOVERY: from any explored state (every recoveryEvery-th BFS node, and the end of every random walk) DFS over ALL interleavings
//   of obligation moves with memoisation on the absolute-time state key, to recoveryMaxSteps. Hitting that depth is reported as
//   truncated, never as a pass. This replaces "16 clock steps assumed fair" (Astra 13): scheduling is explicit, depth no longer limits
//   how far a recovery runs, and the exhaustive depths apply to the fault/owner prefix only.

import type { TraceStep, Verdict } from "./invariants.current.ts";
import { type Domain } from "./domain.ts";
import type { Model, Move, Reducer } from "./model.ts";
import { NOOP_CTX, toWorld } from "./model.ts";
import { apply, clone, enabled, isObligation, deadlines, moveKey, type Runtime } from "./moves.ts";
import { evalStep, evalTrace, type PredicateSet } from "./predicates.ts";
import { bump, newCoverage, type Coverage } from "./report.ts";

export interface CheckConfig {
  maxDepth: number; maxStates: number; walks: number; walkDepth: number; seed: number;
  recoveryEvery: number; recoveryMaxSteps: number; hash: "operational" | "full"; maxViolations: number;
}
export const DEFAULT_CHECK: CheckConfig = { maxDepth: 6, maxStates: 200_000, walks: 200, walkDepth: 40, seed: 1, recoveryEvery: 0, recoveryMaxSteps: 200, hash: "operational", maxViolations: 5 };

export interface Violation { kind: "safety" | "liveness" | "harness"; verdict: Verdict; moves: Move[]; trace: TraceStep[] }
export interface CheckResult {
  seed: string; states: number; transitions: number; deepest: number; truncatedStates: boolean; violations: Violation[];
  recoveries: number; recoveryTruncated: number; terminals: number; coverage: Coverage;
}

const DAY30 = 30 * 24 * 3600_000;
const STEPKEY = /(^step$|Step$)/;

function norm(v: unknown, now: number, key: string | null): unknown {
  if (Array.isArray(v)) return v.map(x => norm(x, now, null));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>, out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) { if (STEPKEY.test(k) && typeof o[k] === "number") continue; out[k] = norm(o[k], now, k); }
    return out;
  }
  if (typeof v === "number" && key !== null && /Ms$/.test(key) && key !== "nowMs" && key !== "ms" && v > 0) return v - now;
  return v;
}
export function stateKey(m: Model, mode: "operational" | "full" = "operational", absoluteTime = false): string {
  if (mode === "full") return JSON.stringify(norm(m, 0, null));
  const now = m.env.nowMs;
  const t = absoluteTime ? now : Math.floor(now / DAY30);
  return JSON.stringify(norm({ home: m.home, env: { ...m.env, step: 0, nowMs: 0 }, t, rel: absoluteTime ? 0 : undefined }, now, null));
}

export function makeRuntime(domain: Domain, reducer: Reducer, cov: Coverage): Runtime {
  const wrapped: Reducer = { ...reducer, reduce: (s, e, c) => { bump(cov.events, e.e); return reducer.reduce(s, e, c); } };
  return {
    domain, reducer: wrapped,
    ctx: { hit: id => { if (id.startsWith("harness.crash.")) bump(cov.crashPoints, id.slice("harness.crash.".length)); else bump(cov.branches, id); } },
    onMove: mv => { bump(cov.moves, mv.t); cov.transitions++; },
  };
}

export function replay(seed: Model, moves: readonly Move[], rt: Runtime, strict = true): { steps: TraceStep[]; model: Model } {
  let m = seed; const steps: TraceStep[] = [];
  for (const mv of moves) {
    if (strict && !enabled(m, rt).some(x => moveKey(x) === moveKey(mv))) throw new Error("move not enabled: " + JSON.stringify(mv) + " at step " + (steps.length + 1));
    const r = apply(m, mv, rt); steps.push(...r.steps); m = r.model;
  }
  return { steps, model: m };
}

function check(prevM: Model, r: { steps: TraceStep[]; model: Model }, ps: PredicateSet, seenHarness: number): Violation[] | null {
  const bad: Violation[] = [];
  for (const s of r.steps) for (const v of evalStep(ps, s.prev, s.action, s.next)) bad.push({ kind: "safety", verdict: v, moves: [], trace: [] });
  for (const h of r.model.env.ext.harnessViolations.slice(seenHarness)) bad.push({ kind: "harness", verdict: { ok: false, invariant: h.name, why: h.why, step: h.step }, moves: [], trace: [] });
  void prevM; void toWorld;
  return bad.length ? bad : null;
}

interface Ctx { rt: Runtime; ps: PredicateSet; cfg: CheckConfig; seedModel: Model; res: CheckResult }

function record(c: Ctx, found: Violation[], moves: Move[], prefixSteps: TraceStep[]): void {
  for (const v of found) {
    if (c.res.violations.length >= c.cfg.maxViolations) return;
    if (c.res.violations.some(x => x.verdict.ok === false && v.verdict.ok === false && x.verdict.invariant === v.verdict.invariant)) continue;
    c.res.violations.push({ ...v, moves: [...moves], trace: [...prefixSteps] });
  }
}

/** Fair recovery from m (see header). prefix = moves that led here. */
export function recover(c: Ctx, start: Model, prefix: Move[], prefixSteps: TraceStep[]): void {
  const { rt, ps, cfg } = c, visited = new Set<string>(), onStack = new Set<string>();
  c.res.recoveries++;
  let truncated = false;
  const path: Move[] = [], steps: TraceStep[] = [...prefixSteps];
  const dfs = (m: Model, depth: number): void => {
    if (c.res.violations.length >= cfg.maxViolations) return;
    const key = stateKey(m, "operational", true);
    if (visited.has(key)) return;
    visited.add(key); onStack.add(key);
    if (depth >= cfg.recoveryMaxSteps) { truncated = true; onStack.delete(key); return; }
    const obl = enabled(m, rt).filter(mv => isObligation(mv, m, rt));
    const succ: Move[] = obl.length ? obl : [];
    if (!obl.length) {
      const dl = deadlines(m, rt).filter(t => t <= rt.domain.maxNowMs)[0];
      if (dl !== undefined) succ.push({ t: "clock.advance", ms: dl - m.env.nowMs });
    }
    if (!succ.length) {
      c.res.terminals++;
      const vs = evalTrace(ps, steps, true);
      if (vs.length) record(c, vs.map(v => ({ kind: "liveness" as const, verdict: v, moves: [], trace: [] })), [...prefix, ...path], steps);
    }
    for (const mv of succ) {
      const hSeen = m.env.ext.harnessViolations.length;
      const r = apply(m, mv, rt), nk = stateKey(r.model, "operational", true);
      const found = check(m, r, ps, hSeen);
      path.push(mv); const n0 = steps.length; steps.push(...r.steps);
      if (found) record(c, found, [...prefix, ...path], steps);
      if (nk === key && mv.t !== "clock.advance") {
        record(c, [{ kind: "liveness", verdict: { ok: false, invariant: "fair.obligationNoProgress", why: "obligation " + mv.t + " stays enabled with no state change", step: r.model.env.step }, moves: [], trace: [] }], [...prefix, ...path], steps);
      } else if (onStack.has(nk)) {
        record(c, [{ kind: "liveness", verdict: { ok: false, invariant: "fair.cycle", why: "cycle of fair moves through " + mv.t, step: r.model.env.step }, moves: [], trace: [] }], [...prefix, ...path], steps);
      } else dfs(r.model, depth + 1);
      steps.length = n0; path.pop();
    }
    onStack.delete(key);
  };
  dfs(start, 0);
  if (truncated) c.res.recoveryTruncated++;
}

export function explore(seedModel: Model, domain: Domain, reducer: Reducer, ps: PredicateSet, cfgIn: Partial<CheckConfig> = {}, seedName = "seed"): CheckResult {
  const cfg = { ...DEFAULT_CHECK, ...cfgIn }, cov = newCoverage(), rt = makeRuntime(domain, reducer, cov);
  const res: CheckResult = { seed: seedName, states: 0, transitions: 0, deepest: 0, truncatedStates: false, violations: [], recoveries: 0, recoveryTruncated: 0, terminals: 0, coverage: cov };
  const c: Ctx = { rt, ps, cfg, seedModel, res };
  const seen = new Set<string>([stateKey(seedModel, cfg.hash)]);
  interface Node { model: Model; moves: Move[] }
  let frontier: Node[] = [{ model: seedModel, moves: [] }], n = 0;
  if (cfg.recoveryEvery > 0) recover(c, seedModel, [], []);
  for (let depth = 0; depth < cfg.maxDepth && frontier.length; depth++) {
    const next: Node[] = [];
    for (const nd of frontier) {
      if (cfg.recoveryEvery > 0 && nd.moves.length > 0 && n++ % cfg.recoveryEvery === 0) recover(c, nd.model, nd.moves, replay(seedModel, nd.moves, rt).steps);
      for (const mv of enabled(nd.model, rt)) {
        const hSeen = nd.model.env.ext.harnessViolations.length, r = apply(nd.model, mv, rt);
        const found = check(nd.model, r, ps, hSeen);
        if (found) record(c, found, [...nd.moves, mv], replay(seedModel, [...nd.moves, mv], rt, false).steps);
        const k = stateKey(r.model, cfg.hash);
        if (seen.has(k)) continue;
        if (seen.size >= cfg.maxStates) { res.truncatedStates = true; continue; }
        seen.add(k); next.push({ model: r.model, moves: [...nd.moves, mv] }); res.deepest = depth + 1;
      }
    }
    frontier = next;
  }
  res.states = seen.size; cov.states = seen.size; res.transitions = cov.transitions;
  return res;
}

export function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Seeded random walks (seed printed by the caller); each walk ends with a fair recovery when recoveryEvery > 0. */
export function randomWalks(seedModel: Model, domain: Domain, reducer: Reducer, ps: PredicateSet, cfgIn: Partial<CheckConfig> = {}, seedName = "seed"): CheckResult {
  const cfg = { ...DEFAULT_CHECK, ...cfgIn }, cov = newCoverage(), rt = makeRuntime(domain, reducer, cov);
  const res: CheckResult = { seed: seedName, states: 0, transitions: 0, deepest: 0, truncatedStates: false, violations: [], recoveries: 0, recoveryTruncated: 0, terminals: 0, coverage: cov };
  const c: Ctx = { rt, ps, cfg, seedModel, res };
  for (let w = 0; w < cfg.walks && res.violations.length < cfg.maxViolations; w++) {
    const rnd = mulberry32(cfg.seed * 1_000_003 + w); let m = seedModel; const moves: Move[] = [], steps: TraceStep[] = [];
    for (let i = 0; i < cfg.walkDepth; i++) {
      const en = enabled(m, rt); if (!en.length) break;
      const mv = en[Math.floor(rnd() * en.length)], hSeen = m.env.ext.harnessViolations.length, r = apply(m, mv, rt);
      moves.push(mv); steps.push(...r.steps);
      const found = check(m, r, ps, hSeen); if (found) { record(c, found, moves, steps); break; }
      m = r.model; res.deepest = Math.max(res.deepest, i + 1);
    }
    if (cfg.recoveryEvery > 0) recover(c, m, moves, steps);
    res.states++;
  }
  cov.states = res.states; res.transitions = cov.transitions;
  return res;
}
export { NOOP_CTX, clone };
