// WITNESSES. Every invariant ships with traces it MUST accept and traces it MUST reject; the checker runs them before any
// exploration and fails if a predicate rejects a must-accept trace or accepts a must-reject one. This pins a predicate to its
// intent so a weakened or inverted predicate cannot pass quietly.
//
// FORMAT: a witness is a seed world plus an ordered list of steps. A step is { action, apply }: `apply` edits a CLONE of the
// previous world to produce the next one (so a witness only spells out what changes). Step invariants are evaluated on each
// (prev, action, next); state invariants on every world including the seed.
//   expect "accept": the predicate must hold on every step.
//   expect "reject": the predicate must fail on at least one step (or on exactly `rejectAt` when given).
import type { NamedInvariant } from "./invariants.registry.ts";
import type { StepAction, WorldX } from "./types.ts";
import { clone } from "./world.ts";

export interface WitnessStep { action: StepAction; apply: (w: WorldX) => void }
export interface Witness {
  invariant: string;
  name: string;
  expect: "accept" | "reject";
  rejectAt?: number; // 0-based step index (state invariants: 0 = the seed, i+1 = after step i)
  seed: () => WorldX;
  steps: WitnessStep[];
}
export interface WitnessFailure { witness: string; invariant: string; why: string }

export function evalWitness(inv: NamedInvariant, wit: Witness): { failedAt: number[] } {
  const failedAt: number[] = [];
  let cur = wit.seed();
  if (inv.kind === "state" && !inv.check(cur)) failedAt.push(0);
  wit.steps.forEach((s, i) => {
    const next = clone(cur);
    s.apply(next);
    if (inv.kind === "step" ? !inv.check(cur, s.action, next) : !inv.check(next)) failedAt.push(inv.kind === "step" ? i : i + 1);
    cur = next;
  });
  return { failedAt };
}

export function runWitnesses(invs: NamedInvariant[], wits: Witness[], opts: { requireBoth?: boolean } = {}): WitnessFailure[] {
  const fails: WitnessFailure[] = [];
  const byName = new Map(invs.map((i) => [i.name, i]));
  for (const w of wits) {
    const inv = byName.get(w.invariant);
    if (!inv) { fails.push({ witness: w.name, invariant: w.invariant, why: "no such invariant registered" }); continue; }
    const { failedAt } = evalWitness(inv, w);
    if (w.expect === "accept" && failedAt.length) fails.push({ witness: w.name, invariant: w.invariant, why: `must-accept trace was rejected at step ${failedAt.join(",")}` });
    if (w.expect === "reject") {
      if (!failedAt.length) fails.push({ witness: w.name, invariant: w.invariant, why: "must-reject trace was accepted" });
      else if (w.rejectAt !== undefined && !failedAt.includes(w.rejectAt)) fails.push({ witness: w.name, invariant: w.invariant, why: `rejected at ${failedAt.join(",")}, expected ${w.rejectAt}` });
    }
  }
  if (opts.requireBoth) {
    for (const inv of invs) {
      const mine = wits.filter((w) => w.invariant === inv.name);
      for (const e of ["accept", "reject"] as const) if (!mine.some((w) => w.expect === e)) fails.push({ witness: "(missing)", invariant: inv.name, why: `no must-${e} witness` });
    }
  }
  return fails;
}

// ───────── example: a trivial dummy predicate with one witness pair ─────────
/** Dummy: "no DELETE call is ever sent". Stands in for a real predicate until the revised invariants land. */
export const DUMMY_NO_DELETE: NamedInvariant = {
  name: "dummy_noDeleteEver", kind: "step",
  check: (_p, a) => !(a.kind === "call" && a.call.kind === "delete"),
};
const dummySeed = (): WorldX => ({ now: 0, flux: { keys: {}, holds: {}, flagOn: true, now: 0, seq: {}, incomplete: {} }, homes: {}, ops: {}, requests: [], unobserved: {}, trace: [], nextReq: 1, budget: { calls: 1, dups: 0, lost: 0, crashes: 0, clock: 1, owner: 0, fence: 0, ownerDeletes: 0, fluxFaults: 0, flag: 0, uses: 0 }, alerts: [] });
export const DUMMY_WITNESSES: Witness[] = [
  { invariant: "dummy_noDeleteEver", name: "clock jump is fine", expect: "accept", seed: dummySeed,
    steps: [{ action: { kind: "clock", to: 5 }, apply: (w) => { w.now = 5; w.flux.now = 5; } }] },
  { invariant: "dummy_noDeleteEver", name: "a DELETE call is rejected", expect: "reject", rejectAt: 0, seed: dummySeed,
    steps: [{ action: { kind: "call", call: { home: "h1", bot: "b1", kind: "delete", keyId: "b1:k1", bodyHash: "h", opId: "op1", actor: "auto", cause: { by: "retire" } } }, apply: () => {} }] },
];
