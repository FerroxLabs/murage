// CI gate: the model checker at CI depth, from every CI seed, with the REAL reducer and the REVISED keystore invariants, under BOTH Flux
// profiles (ci = pre-#276 Flux incl. 503; ci-276 = no 503, unbounded reaper lag). 0 counterexamples, 0 reducer failures, 0 cycles each.
import { describe, expect, it } from "vitest";
import { runCheck } from "./checker.ts";
import { CI_DOMAIN, CI_DOMAIN_276 } from "./domain.ts";
import { KEYSTORE_REGISTRY, KEYSTORE_WITNESSES } from "./keystore-witnesses.ts";
import { REDUCER_BRANCHES, reduce } from "./reducer.ts";

describe("keystore reducer: model check at CI depth", () => {
  for (const dom of [CI_DOMAIN, CI_DOMAIN_276]) {
    it(`finds 0 counterexamples with the real reducer (${dom.name})`, { timeout: 1_800_000 }, () => {
      const r = runCheck({ domain: dom, reducer: reduce, invariants: KEYSTORE_REGISTRY, witnesses: KEYSTORE_WITNESSES, requireWitnessPairs: true, declaredBranches: REDUCER_BRANCHES, maxCounterexamples: 25 });
      console.log(`CI depth=${dom.depth} (not exhaustive; exhaustive depth-6 run is separate)`);
      console.log(r.report);
      console.log(`CHECK SUMMARY: profile=${dom.name} phase=${r.phase} violations=${r.violations.length} reducerFailures=${r.reducerFailures.length} cycles=${r.cycles.length} freezes=${r.freezes.length} truncated=${r.truncated} states=${r.coverage.states} transitions=${r.coverage.transitions} stalledCloseTransitions=${r.coverage.stalledCloses} stalledCloseStates=${r.coverage.stalledCloseStates.size}`);
      expect(r.coverage.stalledCloses, "the stalled-take seeds reach a stalled-take CLOSE").toBeGreaterThan(0);
      expect(r.witnessFailures).toEqual([]);
      expect(r.violations.map((v) => v.invariant)).toEqual([]);
      expect(r.reducerFailures.map((f) => f.message)).toEqual([]);
      expect(r.cycles).toEqual([]);
      expect(r.freezes, "time never freezes (r3.2h H2)").toEqual([]);
      // R3 (r3.2g): depth 14 can never finish under the 400k cap (depth 6 alone is ~678k states), so truncation is REPORTED, not forbidden.
      // Exhaustiveness is the separate required gate "RC gate: exhaustive d6" (gate-rc-d6.sh).
      expect(r.report, "truncation is REPORTED").toContain(`truncated at maxStates: ${r.truncated}`);
      expect(r.coverage.stalledCloses, "stalledCloseTransitions > 0").toBeGreaterThan(0);
    });
  }
});
