// SPDX-License-Identifier: AGPL-3.0-or-later
// C6 policy: inputs are explicit so decision tests never depend on runner load.
export function perfBudgetDecision(env, load1) {
  if (env.MURAGE_PERF_QUIET_HOST !== "1") {
    return { mode: "skipped", message: "INFORMATIONAL: not a quiet host (MURAGE_PERF_QUIET_HOST=1 required)" };
  }
  if (!Number.isFinite(load1) || load1 < 0 || load1 >= 2) {
    return { mode: "refused", message: `REFUSED: quiet-host performance run requires 1-minute load < 2.0 (load=${load1})` };
  }
  return { mode: "enforced", message: "ENFORCED: quiet host" };
}

export function guardPerfBudget(name, skip, env, load1, log = console.log) {
  const decision = perfBudgetDecision(env, load1);
  if (decision.mode === "refused") throw new Error(decision.message);
  if (decision.mode === "skipped") {
    const message = `${decision.message}; SKIPPED: ${name} (all wall-clock bounds in this perf-budget test)`;
    log(message);
    skip(message);
    return;
  }
  log(decision.message);
}

// Vitest's JSON also contains tests excluded by the tag filter. Only perf-budget
// rows are C6 bounds; each must have reached the enforcement hook and passed.
export function assertPerfReport(report) {
  const tests = report.testResults?.flatMap(file => file.assertionResults ?? [])
    .filter(test => test.tags?.includes("perf-budget")) ?? [];
  if (report.success !== true || !tests.length) throw new Error("REFUSED: no successful perf-budget suite");
  const incomplete = tests.filter(test => test.status !== "passed" || test.meta?.perfQuietHost !== true);
  if (incomplete.length) throw new Error(`REFUSED: bounds not enforced and green: ${incomplete.map(test => `${test.fullName} (${test.status})`).join("; ")}`);
  return tests.length;
}
