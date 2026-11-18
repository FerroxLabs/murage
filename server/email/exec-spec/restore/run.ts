// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Entry points: runAll() = witnesses FIRST (throws on any mismatch), then BFS + random walks + fair recovery per seed, then the report.
// Called from tests; a CLI wrapper is: node --experimental-strip-types run.ts (not needed in CI).

import { DOMAIN_ONE } from "./domain.ts";
import { explore, randomWalks, type CheckConfig, type CheckResult } from "./checker.ts";
import type { Reducer } from "./model.ts";
import { ACTIVE_PREDICATES, type PredicateSet } from "./predicates.ts";
import { formatCoverage, printTrace } from "./report.ts";
import { placeholderReducer } from "./reducer.ts";
import { SEEDS, SEED_DOMAIN } from "./seeds.ts";
import { runWitnessesOrThrow, type Witness } from "./witness.ts";
import { runSpecWitnessesOrThrow, type SpecWitness } from "./witnesses/specRun.ts";
import { toWorld } from "./model.ts";

export interface RunOptions { reducer?: Reducer; predicates?: PredicateSet; witnesses?: readonly Witness[]; specWitnesses?: readonly SpecWitness[]; seeds?: string[]; check?: Partial<CheckConfig>; listing?: "off" | "per_account"; branchIds?: readonly string[] }

export function runAll(o: RunOptions = {}): { results: CheckResult[]; text: string; complete: boolean } {
  const reducer = o.reducer ?? placeholderReducer, ps = o.predicates ?? ACTIVE_PREDICATES;
  runSpecWitnessesOrThrow(o.specWitnesses ?? [], ps); // FIRST: hand-built spec traces
  runWitnessesOrThrow(o.witnesses ?? [], reducer, ps, (o.specWitnesses ?? []).map(w => ({ invariant: w.invariant, kind: w.expect === "reject" ? "must-reject" as const : "must-accept" as const }))); // FIRST: a mismatch aborts everything
  const results: CheckResult[] = [], text: string[] = ["predicates=" + ps.name + " reducer=" + reducer.name + " seed=" + (o.check?.seed ?? 1)];
  for (const name of o.seeds ?? Object.keys(SEEDS)) {
    const seed = SEEDS[name](o.listing ? { listing: o.listing } : undefined); if (reducer.renderSeedSurface) seed.home.surface = reducer.renderSeedSurface(seed.home, seed.env.nowMs); const d = SEED_DOMAIN[name] ?? DOMAIN_ONE;
    for (const r of [explore(seed, d, reducer, ps, o.check, name), randomWalks(seed, d, reducer, ps, o.check, name)]) {
      results.push(r);
      text.push("== " + name + ": states=" + r.states + " transitions=" + r.transitions + " deepest=" + r.deepest + " recoveries=" + r.recoveries + " truncatedStates=" + r.truncatedStates + " recoveryTruncated=" + r.recoveryTruncated + " violations=" + r.violations.length);
      if (r.truncatedStates) text.push("INCOMPLETE: state limit reached for " + name + "; unseen states were not explored.");
      if (r.recoveryTruncated) text.push("INCOMPLETE: recovery depth limit reached for " + name + ".");
      for (const v of r.violations) text.push("  VIOLATION " + (v.verdict.ok ? "" : v.verdict.invariant + ": " + v.verdict.why) + "\n" + printTrace(v.trace, toWorld(seed)));
      text.push(formatCoverage(r.coverage, o.branchIds));
    }
  }
  const complete = results.every(r => !r.truncatedStates && r.recoveryTruncated === 0);
  text.push("Exploration complete within the requested bounds: " + complete);
  return { results, text: text.join("\n"), complete };
}
