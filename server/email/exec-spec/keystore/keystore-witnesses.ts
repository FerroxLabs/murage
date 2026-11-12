// The REVISED keystore invariants (invariants.current.ts, copied unchanged from the designer's file) plugged into the harness:
// the registry of named invariants, the designer's witnesses lifted into the harness witness format, and the WITNESS PASS.
// Nothing here edits a predicate or a witness. Spec worlds (prev/next as the designer wrote them, without the harness's
// scheduler bookkeeping) are lifted into WorldX by adding neutral defaults; predicates only read spec fields.
import * as spec from "./invariants.current.ts";
import { fromStep } from "./invariants.registry.ts";
import type { NamedInvariant } from "./invariants.registry.ts";
import { clone } from "./world.ts";
import { runWitnesses } from "./witness.ts";
import type { Witness, WitnessFailure } from "./witness.ts";
import type { WorldX } from "./types.ts";

/** One NamedInvariant per exported step predicate, named exactly as the spec's STEP_INVARIANTS keys. */
export const KEYSTORE_REGISTRY: NamedInvariant[] = Object.entries(spec.STEP_INVARIANTS).map(([name, fn]) => fromStep(name, fn as never));

/** Checked on continuations / quiescent states by their own runner (not step or per-state predicates). */
export const LIVE_INVARIANT_NAMES = ["I9_liveness", "I9b_reconnectRecovers", "I10_noLeakAtQuiescence"] as const;

const zeroBudget = { calls: 0, dups: 0, lost: 0, crashes: 0, clock: 0, owner: 0, fence: 0, ownerDeletes: 0, fluxFaults: 0, flag: 0, uses: 0 };
/** Spec World -> WorldX: add the harness's bookkeeping with neutral values. */
export function liftWorld(w: spec.World): WorldX {
  const c = clone(w) as unknown as WorldX;
  c.flux = { ...c.flux, seq: {}, incomplete: {} };
  for (const h of Object.values(c.homes)) { h.outbox = []; h.nextSaveId = 1; }
  c.requests = c.requests.map((r) => ({ ...r, dupLeft: 0, answered: false, timedOut: false, dropped: false }));
  c.nextReq = 1;
  c.budget = { ...zeroBudget };
  return c;
}

/** A step witness as a harness Witness: seed = prev, one step whose `apply` turns the clone into `next`. */
export function liftStepWitness(sw: spec.StepWitness): Witness {
  return {
    invariant: sw.inv, name: sw.id, expect: sw.expect, rejectAt: sw.expect === "reject" ? 0 : undefined,
    seed: () => liftWorld(sw.prev),
    steps: [{ action: sw.action, apply: (w) => { const n = liftWorld(sw.next) as unknown as Record<string, unknown>; const t = w as unknown as Record<string, unknown>; for (const k of Object.keys(t)) delete t[k]; Object.assign(t, n); } }],
  };
}
export const KEYSTORE_WITNESSES: Witness[] = spec.STEP_WITNESSES.map(liftStepWitness);

export interface Mismatch { witness: string; invariant: string; expected: string; actual: string }

/** Run the designer's continuation / quiescence witnesses (I9, I9b, I10). */
export function runLiveWitnesses(): Mismatch[] {
  const out: Mismatch[] = [];
  for (const lw of spec.LIVE_WITNESSES) {
    if (lw.inv === "I10_noLeakAtQuiescence") {
      const actual = spec.I10_noLeakAtQuiescence(lw.world);
      if (actual !== lw.expect) out.push({ witness: lw.id, invariant: lw.inv, expected: lw.expect, actual });
      continue;
    }
    const target = lw.target;
    // the witness fixes `enabled`; q1 for I9b means quiescent with no repair shown and no automatic action
    const quiescent = (w: spec.World) => spec.isQuiescent(w, () => lw.enabled);
    const isQ1 = (w: spec.World) => quiescent(w) && Object.values(w.homes).every((h) => Object.values(h.repairVisible).every((v) => !v) && Object.keys(h.durable.intents).length === 0);
    const ok = lw.inv === "I9_liveness"
      ? spec.I9_liveness(lw.continuation, lw.bound, quiescent)
      : spec.I9b_reconnectRecovers(lw.continuation, lw.bound, target === "q1" ? isQ1 : quiescent);
    const actual = ok ? "accept" : "reject";
    if (actual !== lw.expect) out.push({ witness: lw.id, invariant: lw.inv, expected: lw.expect, actual });
  }
  return out;
}

/** The WITNESS PASS: every must-reject rejected, every must-accept accepted, for steps and live witnesses. */
export function runWitnessPass(): { total: number; passed: number; mismatches: Mismatch[] } {
  const stepFails: WitnessFailure[] = runWitnesses(KEYSTORE_REGISTRY, KEYSTORE_WITNESSES, { requireBoth: true });
  const stepMism: Mismatch[] = stepFails.map((f) => {
    const w = KEYSTORE_WITNESSES.find((x) => x.name === f.witness);
    const expected = w ? `must-${w.expect}` : f.why;
    return { witness: f.witness, invariant: f.invariant, expected, actual: f.why };
  });
  const live = runLiveWitnesses();
  const total = spec.STEP_WITNESSES.length + spec.LIVE_WITNESSES.length;
  const mismatches = [...stepMism.filter((m) => m.witness !== "(missing)"), ...live];
  return { total, passed: total - mismatches.length, mismatches: [...stepMism.filter((m) => m.witness === "(missing)"), ...mismatches] };
}
