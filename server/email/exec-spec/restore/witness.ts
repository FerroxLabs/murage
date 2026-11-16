// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WITNESSES. Every invariant ships with at least one MUST-REJECT trace (the invariant must fail on it) and one MUST-ACCEPT trace (it must
// not fail). They run FIRST; any mismatch fails the whole run (runWitnessesOrThrow), so a predicate that is vacuous, or that rejects a
// correct trace, is caught before any exploration result is believed.
//
// FORMAT (one TypeScript object per witness, in witnesses/*.ts exporting Witness[]; plain data, JSON-serialisable):
//   id         unique id
//   invariant  the predicate name (key in PredicateSet.step / .state / .trace)
//   kind       "must-reject" | "must-accept"
//   seed       a key of SEEDS (seeds.ts); fluxListing optionally overrides the listing switch
//   moves      the exact Move list, replayed strictly (a move that is not enabled at that point is an error: the trace must be reachable)
//   settled    for trace predicates: evaluate with settled = true
//   note       one line: what the trace shows and why the verdict is right

import type { Verdict } from "./invariants.current.ts";
import { DOMAIN_ONE } from "./domain.ts";
import type { FluxConfig, Move, Reducer } from "./model.ts";
import { makeRuntime, replay } from "./checker.ts";
import { evalStep, evalTrace, predicateNames, type PredicateSet } from "./predicates.ts";
import { newCoverage } from "./report.ts";
import { SEEDS, SEED_DOMAIN } from "./seeds.ts";

export interface Witness { id: string; invariant: string; kind: "must-reject" | "must-accept"; seed: string; fluxListing?: FluxConfig["listing"]; moves: Move[]; settled?: boolean; note: string }
export interface WitnessResult { id: string; ok: boolean; why: string }

export function runWitness(w: Witness, reducer: Reducer, ps: PredicateSet): WitnessResult {
  try {
    const cfg: FluxConfig = { listing: w.fluxListing ?? "off" };
    const seed = SEEDS[w.seed](w.fluxListing ? cfg : undefined);
    const rt = makeRuntime(SEED_DOMAIN[w.seed] ?? DOMAIN_ONE, reducer, newCoverage());
    const { steps } = replay(seed, w.moves, rt);
    const failed: Verdict[] = [];
    for (const s of steps) failed.push(...evalStep(ps, s.prev, s.action, s.next));
    failed.push(...evalTrace(ps, steps, w.settled ?? false));
    const hit = failed.some(v => !v.ok && v.invariant === w.invariant);
    if (w.kind === "must-reject") return hit ? { id: w.id, ok: true, why: "rejected as required" } : { id: w.id, ok: false, why: "MUST-REJECT trace was accepted by " + w.invariant };
    return hit ? { id: w.id, ok: false, why: "MUST-ACCEPT trace was rejected by " + w.invariant + ": " + failed.filter(v => !v.ok && v.invariant === w.invariant).map(v => (v.ok ? "" : v.why)).join("; ") } : { id: w.id, ok: true, why: "accepted as required" };
  } catch (e) {
    return { id: w.id, ok: false, why: "replay error: " + (e as Error).message };
  }
}

/** Invariants lacking a must-reject or a must-accept witness. */
export interface Covered { invariant: string; kind: "must-reject" | "must-accept" }
export function missingWitnesses(ps: PredicateSet, ws: readonly Witness[], extra: readonly Covered[] = []): string[] {
  const out: string[] = [];
  for (const n of predicateNames(ps)) for (const k of ["must-reject", "must-accept"] as const) if (!ws.some(w => w.invariant === n && w.kind === k) && !extra.some(w => w.invariant === n && w.kind === k)) out.push(n + " lacks " + k);
  return out;
}

/** `extra` = pairs already covered by another witness family (the spec trace witnesses, witnesses/specRun.ts). */
export function runWitnessesOrThrow(ws: readonly Witness[], reducer: Reducer, ps: PredicateSet, extra: readonly Covered[] = []): WitnessResult[] {
  const results = ws.map(w => runWitness(w, reducer, ps)), bad = results.filter(r => !r.ok), missing = missingWitnesses(ps, ws, extra);
  if (bad.length || missing.length) throw new Error("witness run failed:\n" + [...bad.map(b => b.id + ": " + b.why), ...missing].join("\n"));
  return results;
}
