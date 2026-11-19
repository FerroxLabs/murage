// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PLUGGABLE NAMED PREDICATES. The checker knows nothing about invariants by name: it evaluates a PredicateSet. Until the revised
// invariants land, ACTIVE_PREDICATES was a pass-all stub; it now registers the revised spec (invariants.current.ts, 34 invariants).
// The dummy set exists only so the witness runner has something real to reject/accept end to end.

import type { Action, StateInvariant, StepInvariant, TraceStep, Verdict, World } from "./invariants.current.ts";
import { CHECKER, STATE_INVARIANTS, STEP_INVARIANTS, TRACE_INVARIANTS } from "./invariants.current.ts";
import { toWorld, type Model } from "./model.ts";

export type TraceCheck = (trace: readonly TraceStep[], settled: boolean) => Verdict;
export interface PredicateSet { name: string; step: Record<string, StepInvariant>; state: Record<string, StateInvariant>; trace: Record<string, TraceCheck> }

export const PASS_ALL: PredicateSet = { name: "pass-all (stub)", step: {}, state: {}, trace: {} };

/** Adapter for the invariants module registries (STEP_INVARIANTS, STATE_INVARIANTS, plus trace checks by name). */
export function fromRegistries(name: string, step: Record<string, StepInvariant>, state: Record<string, StateInvariant>, trace: Record<string, TraceCheck> = {}): PredicateSet {
  return { name, step, state, trace };
}

const OKV: Verdict = { ok: true };

/** Dummy: a Flux-initiated closing must never coexist with a DELETE-caused one on the same inbox (always true), and no inbox may be closed by Flux (witness-only toy). */
export const DUMMY: PredicateSet = {
  name: "dummy",
  step: {},
  state: {
    "dummy.noFluxInitiatedClosing": (w: World): Verdict => {
      for (const ib of Object.values(w.flux.inboxes)) if (ib.closingCause?.kind === "flux") return { ok: false, invariant: "dummy.noFluxInitiatedClosing", why: "inbox " + ib.inboxId + " closed by Flux", step: w.step };
      return OKV;
    },
  },
  trace: {},
};

/** Trace-level predicates of the revised spec, by name (keepEndsActive takes `settled`; quiescenceReachable takes the spec liveness bound). */
export const SPEC_TRACE_CHECKS: Record<string, TraceCheck> = {
  keepEndsActive: (t, settled) => TRACE_INVARIANTS.keepEndsActive(t, settled),
  quiescenceReachable: t => TRACE_INVARIANTS.quiescenceReachable(t, CHECKER.livenessBound),
  heldInputDrains: t => TRACE_INVARIANTS.heldInputDrains(t, CHECKER.livenessBound), // r3.4d (page L3)
};

/** The revised restore-park predicates: every registered invariant (34 = step + state + trace), nothing stubbed. */
export const ACTIVE_PREDICATES: PredicateSet = fromRegistries("restore-park spec r3.1", STEP_INVARIANTS, STATE_INVARIANTS, SPEC_TRACE_CHECKS);

const bad = (vs: Verdict[]): Verdict[] => vs.filter(v => !v.ok);

export function evalStep(ps: PredicateSet, prev: World, action: Action, next: World): Verdict[] {
  const out: Verdict[] = [];
  for (const f of Object.values(ps.step)) out.push(f(prev, action, next));
  for (const f of Object.values(ps.state)) out.push(f(next));
  return bad(out);
}
export function evalTrace(ps: PredicateSet, trace: readonly TraceStep[], settled: boolean): Verdict[] {
  return bad(Object.values(ps.trace).map(f => f(trace, settled)));
}
export const predicateNames = (ps: PredicateSet): string[] => [...Object.keys(ps.step), ...Object.keys(ps.state), ...Object.keys(ps.trace)];
export { toWorld };
export type { Model };
