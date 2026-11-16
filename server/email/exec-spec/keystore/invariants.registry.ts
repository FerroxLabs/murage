// Pluggable invariant predicates. UNTIL the revised invariants file lands, the registry is the STUB below: it passes
// everything, so the harness runs end to end. To plug the revised file in (it exports STEP_INVARIANTS and trace/state
// functions): add a NamedInvariant per predicate (use `fromStep` for StepInvariant-shaped ones), give each its must-accept and
// must-reject witnesses (witness.ts), and export them from REGISTRY. The checker fails if an invariant lacks either witness.
import type { StepAction, WorldX } from "./types.ts";

export type StepCheck = (prev: WorldX, action: StepAction, next: WorldX) => boolean;
export type NamedInvariant =
  | { name: string; kind: "step"; check: StepCheck }
  | { name: string; kind: "state"; check: (w: WorldX) => boolean };

/** Wrap spec-shaped predicates (prev, action, next) => boolean. The spec's Action type is narrower than StepAction (it has no
 *  `env` kind): env steps are passed through as allowed, because the spec predicates only constrain the kinds it defines. */
export const fromStep = (name: string, fn: (p: never, a: never, n: never) => boolean): NamedInvariant => ({
  name, kind: "step",
  check: (p, a, n) => (a.kind === "env" ? true : (fn as unknown as StepCheck)(p, a, n)),
});

export const STUB_INVARIANT: NamedInvariant = { name: "stub_passes_everything", kind: "step", check: () => true };
export const REGISTRY: NamedInvariant[] = [STUB_INVARIANT];
