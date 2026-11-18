// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { perfBudgetDecision, guardPerfBudget, assertPerfReport } from "./perf-budget.mjs";
import { scrubAmbientMurageEnv } from "../../server/testing/murage-env.mjs";

const quiet = { MURAGE_PERF_QUIET_HOST: "1" };

describe("C6 quiet-host policy (injected environment and one-minute load)", () => {
  it.each([0, 0.7, 1.999])("enforces every bound below 2.0 (load %s)", load => {
    expect(perfBudgetDecision(quiet, load)).toEqual({ mode: "enforced", message: "ENFORCED: quiet host" });
  });
  it.each([2, 2.01, 60, NaN, Infinity, -1, undefined])("refuses enforcement at unsafe or unknown load %s", load => {
    const decision = perfBudgetDecision(quiet, load);
    expect(decision.mode).toBe("refused");
    expect(decision.message).toContain("REFUSED:");
    expect(decision.message).not.toContain("ENFORCED:");
  });
  it.each([undefined, "", "0", "true", "01"])("requires the exact opt-in, received %s", marker => {
    const decision = perfBudgetDecision({ MURAGE_PERF_QUIET_HOST: marker }, 0);
    expect(decision.mode).toBe("skipped");
    expect(decision.message).toContain("INFORMATIONAL: not a quiet host");
  });
  it("does not turn a loaded ordinary run into a failure or a quiet-host claim", () => {
    expect(perfBudgetDecision({}, 90).mode).toBe("skipped");
  });
  it("keeps the marker through the test setup's runtime-environment scrub", () => {
    const env = { ...quiet, MURAGE_DATA_DIR: "/live" };
    scrubAmbientMurageEnv(env);
    expect(env).toEqual(quiet);
  });
  it("names each skipped test and prevents its timing body from silently passing", () => {
    const log = vi.fn();
    const skip = vi.fn(message => { throw new Error(message); });
    expect(() => guardPerfBudget("server/example.test.ts > 50 ms bound", skip, {}, 30, log)).toThrow("SKIPPED: server/example.test.ts > 50 ms bound");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("INFORMATIONAL: not a quiet host"));
    expect(skip).toHaveBeenCalledOnce();
  });
  it("does not skip or swallow a failing wall-clock assertion when enforcement is requested", () => {
    const log = vi.fn(), skip = vi.fn();
    expect(() => {
      guardPerfBudget("50 ms bound", skip, quiet, 0.5, log);
      expect(51).toBeLessThan(50);
    }).toThrow();
    expect(skip).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith("ENFORCED: quiet host");
  });
  it("fails before the timing body and prints no enforcement claim on a loaded host", () => {
    const log = vi.fn(), skip = vi.fn(), body = vi.fn();
    expect(() => { guardPerfBudget("50 ms bound", skip, quiet, 2, log); body(); }).toThrow("REFUSED:");
    expect(body).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith("ENFORCED: quiet host");
  });
});

const report = statuses => ({ success: true, numTotalTests: statuses.length, numPassedTests: statuses.filter(s => s === "passed").length,
  testResults: [{ assertionResults: statuses.map(status => ({ status, fullName: "example bound", tags: ["perf-budget"], meta: { perfQuietHost: true } })) }] });
describe("quiet-host receipt requires every collected bound green", () => {
  it("accepts a nonempty all-green report", () => expect(() => assertPerfReport(report(["passed", "passed"]))).not.toThrow());
  it.each(["failed", "pending", "todo", "skipped"])("rejects a %s bound", status => {
    expect(() => assertPerfReport(report(["passed", status]))).toThrow();
  });
  it("rejects a green bound that bypassed the enforcement hook", () => {
    const value = report(["passed"]);
    value.testResults[0].assertionResults[0].meta = {};
    expect(() => assertPerfReport(value)).toThrow("not enforced and green");
  });
  it("ignores non-perf tests excluded by the tag filter", () => {
    const value = report(["passed"]);
    value.testResults[0].assertionResults.push({ status: "skipped", tags: [] });
    expect(assertPerfReport(value)).toBe(1);
  });
  it("rejects an empty run", () => expect(() => assertPerfReport(report([]))).toThrow());
  it("rejects a suite/hook error even with green assertions", () => {
    expect(() => assertPerfReport({ ...report(["passed"]), success: false })).toThrow();
  });
});
