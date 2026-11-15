// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the SPEC'S OWN witnesses (witnesses/spec.ts: hand-built World traces, not move lists) through a PredicateSet. Same verdict rule as the
// spec's runWitnesses(): the named predicate is evaluated over the trace; must-reject needs a failure carrying that name, must-accept needs
// none. Evaluating through the PredicateSet (not the spec's verdictOf) proves the harness registration is complete and wired.

import type { TraceStep, Verdict } from "../invariants.current.ts";
import { predicateNames, type PredicateSet } from "../predicates.ts";
import type { Witness as SpecWitness } from "./spec.ts";

export type { SpecWitness };
export interface SpecResult { id: string; invariant: string; expect: "reject" | "accept"; ok: boolean; why: string }

export function verdictViaPredicates(ps: PredicateSet, name: string, trace: readonly TraceStep[], settled: boolean): Verdict {
  const t = ps.trace[name];
  if (t) return t(trace, settled);
  const st = ps.step[name], sa = ps.state[name];
  if (!st && !sa) return { ok: false, invariant: "registration", why: "unknown predicate " + name, step: -1 };
  for (const s of trace) { const v = st ? st(s.prev, s.action, s.next) : sa(s.next); if (!v.ok) return v; }
  return { ok: true };
}

export function runSpecWitnesses(ws: readonly SpecWitness[], ps: PredicateSet): SpecResult[] {
  return ws.map(w => {
    let v: Verdict;
    try { v = verdictViaPredicates(ps, w.invariant, w.trace, w.settled); } catch (e) { return { id: w.id, invariant: w.invariant, expect: w.expect, ok: false, why: "predicate threw: " + (e as Error).message }; }
    const rejected = !v.ok && v.invariant === w.invariant;
    return { id: w.id, invariant: w.invariant, expect: w.expect, ok: w.expect === "reject" ? rejected : v.ok, why: v.ok ? "accepted" : v.why };
  });
}

/** Invariants (by registered name) lacking a reject or an accept witness. */
export function specMissing(ws: readonly SpecWitness[], ps: PredicateSet): string[] {
  const out: string[] = [];
  for (const n of predicateNames(ps)) for (const e of ["reject", "accept"] as const) if (!ws.some(w => w.invariant === n && w.expect === e)) out.push(n + ":" + e);
  return out;
}

export function runSpecWitnessesOrThrow(ws: readonly SpecWitness[], ps: PredicateSet): SpecResult[] {
  const results = runSpecWitnesses(ws, ps), bad = results.filter(r => !r.ok), missing = ws.length ? specMissing(ws, ps) : [];
  if (bad.length || missing.length) throw new Error("spec witness run failed:\n" + [...bad.map(b => b.id + " [" + b.invariant + " expect " + b.expect + "]: " + b.why), ...missing.map(m => "missing " + m)].join("\n"));
  return results;
}
