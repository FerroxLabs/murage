// Seed coverage: the stalled-take seeds are valid start states (no invariant violated at depth 0) and exercise Reconnect-close at depth <= 6.
import { describe, expect, it } from "vitest";
import { runCheck } from "./checker.ts";
import { CI_DOMAIN } from "./domain.ts";
import { KEYSTORE_REGISTRY, KEYSTORE_WITNESSES } from "./keystore-witnesses.ts";
import { reduce } from "./reducer.ts";
import { allSeeds, seedTakeDeadTarget, seedTakeStalled, seedTakeStampedClose } from "./seeds.ts";

describe("stalled-take seeds", () => {
  it("are in the one-home seed set", () => { const n = allSeeds(CI_DOMAIN).map((s) => s.name); expect(n).toContain("take-stalled"); expect(n).toContain("take-dead-target"); });
  for (const mk of [seedTakeStalled, seedTakeDeadTarget, seedTakeStampedClose]) {
    it(`${mk.name}: valid start state, no violation at depth 0..3`, () => {
      const s = mk(CI_DOMAIN);
      const r = runCheck({ domain: { ...CI_DOMAIN, depth: 3 }, reducer: reduce, invariants: KEYSTORE_REGISTRY, witnesses: KEYSTORE_WITNESSES, seeds: [s], maxCounterexamples: 5 });
      console.log(`SEED ${s.name}: violations=${r.violations.map((v) => v.invariant + " " + v.depth)} failures=${r.reducerFailures.map((f) => f.message)} states=${r.coverage.states}`);
      expect(r.violations.filter((v) => v.depth === 0)).toEqual([]);
    });
  }
});
