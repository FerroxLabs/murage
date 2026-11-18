import { it } from "vitest";
import { runCheck } from "./checker.ts";
import { CI_DOMAIN, CI_DOMAIN_276 } from "./domain.ts";
import { KEYSTORE_REGISTRY, KEYSTORE_WITNESSES } from "./keystore-witnesses.ts";
import { REDUCER_BRANCHES, reduce } from "./reducer.ts";
for (const dom of [CI_DOMAIN, CI_DOMAIN_276].filter((d) => (process.env.PROFILES ?? "ci,ci-276").split(",").includes(d.name))) {
  it(`iter ${dom.name}`, { timeout: 1_800_000 }, () => {
    const depth = Number(process.env.DEPTH ?? 8);
    const capEnv = Number(process.env.STATE_CAP ?? 150000); // 0 = unlimited (exhaustive)
    const cap = capEnv === 0 ? Number.MAX_SAFE_INTEGER : capEnv;
    const t0 = Date.now();
    const r = runCheck({ domain: dom, depth, maxStates: cap, reducer: reduce, invariants: KEYSTORE_REGISTRY, witnesses: KEYSTORE_WITNESSES, declaredBranches: REDUCER_BRANCHES, maxCounterexamples: Number(process.env.MAXCX ?? 40) });
    console.log(r.report);
    // r3.2h (H1): the EXACT shape the RC gate anchors on (nothing after stalledCloseTransitions); diagnostics go on a separate line.
    console.log(`CHECK SUMMARY: nonce=${process.env.GATE_NONCE ?? "none"} profile=${dom.name} depth=${depth} violations=${r.violations.length} [${r.violations.map((v) => v.invariant).join(",")}] reducerFailures=${r.reducerFailures.length} cycles=${r.cycles.length} freezes=${r.freezes.length} truncated=${r.truncated} states=${r.coverage.states} transitions=${r.coverage.transitions} stalledCloseTransitions=${r.coverage.stalledCloses}`);
    console.log(`CHECK EXTRA: profile=${dom.name} stalledCloseStates=${r.coverage.stalledCloseStates.size} maxDepth=${r.coverage.maxDepth} stateCap=${capEnv} runtimeSec=${Math.round((Date.now() - t0) / 1000)} heapUsedMB=${Math.round(process.memoryUsage().heapUsed / 1048576)} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`);
  });
}
