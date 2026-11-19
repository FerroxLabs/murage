import { beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
const budgetModule = await import(new URL("./release-budget.ts", import.meta.url).href).catch(() => null);
beforeEach(() => expect(budgetModule, "T-RELEASE-BUDGET requires generation-owned monotonic reservations").not.toBeNull());
const budgetUrl = new URL("./release-budget.ts", import.meta.url);
const budgetApi = existsSync(budgetUrl) ? await import(budgetUrl.href) as typeof import("./release-budget.ts") : undefined;
const RELEASE_LIMITS = budgetModule?.RELEASE_LIMITS ?? { attempts: 4096, bytes: 67108864, work: 16777216, statements: 65536 };
const ReleaseBudget = function(...args: ConstructorParameters<typeof import("./release-budget.ts").ReleaseBudget>) {
  expect(budgetApi?.ReleaseBudget, "§12.4 requires generation-owned monotonic attempt/byte/work/statement counters").toBeTypeOf("function");
  return new budgetApi!.ReleaseBudget(...args);
} as unknown as typeof import("./release-budget.ts").ReleaseBudget;
const chargeUpstream: typeof import("./release-budget.ts").chargeUpstream = (...args) => {
  expect(budgetApi?.chargeUpstream, "upstream staging must reserve bytes before decoding").toBeTypeOf("function");
  return budgetApi!.chargeUpstream(...args);
};

it("cached statements preserve ordinary all instrumentation and meter later scoped reads", () => {
  const all = vi.fn(() => [1, 2]);
  const iterate = vi.fn(function* () { yield 1; yield 2; });
  const statement = budgetApi!.accountedStatement({ all, iterate });
  expect(statement.all()).toEqual([1, 2]);
  expect(all).toHaveBeenCalledOnce();
  expect(iterate).not.toHaveBeenCalled();
  const budget = new ReleaseBudget(vi.fn());
  expect(budgetApi!.withReleaseBudgets([budget], () => statement.all())).toEqual([1, 2]);
  expect(all).toHaveBeenCalledOnce();
  expect(iterate).toHaveBeenCalledOnce();
  expect(budget.counts.statements).toBe(1);
  expect(budget.counts.work).toBe(4);
  expect(statement.all()).toEqual([1, 2]);
  expect(all).toHaveBeenCalledTimes(2);
});

// red-at-4df086541: T-RELEASE-BUDGET, no aggregate generation budget existed.
it.each(["attempts", "bytes", "work", "statements"] as const)("refuses the exact %s crossing without refund", key => {
  const stop = vi.fn(), budget = new ReleaseBudget(stop);
  budget.charge({ [key]: RELEASE_LIMITS[key] });
  expect(() => budget.charge({ [key]: 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(budget.counts[key]).toBe(RELEASE_LIMITS[key]);
  expect(stop).toHaveBeenCalled();
});

// red-at-4df086541: a failed charge must latch terminal refusal and must never
// turn negative, fractional or non-finite values into a budget refund.
it.each([-1, 0.5, NaN, Infinity])("T-RELEASE-BUDGET invalid cost %s seals once", amount => {
  const stop = vi.fn(), budget = new ReleaseBudget(stop);
  expect(() => budget.charge({ bytes: amount })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => budget.charge({ bytes: 0 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(budget.counts.bytes).toBe(0); expect(stop).toHaveBeenCalledOnce();
});
// control: published timing/cap contracts cannot be loosened to make stress
// tests pass. This source-independent tuple also runs at the baseline.
it("T-RELEASE-BUDGET fixes the design limits", () => {
  expect(RELEASE_LIMITS).toEqual({ attempts: 4096, bytes: 67108864, work: 16777216, statements: 65536 });
});
// red-at-4df086541: T-UPSTREAM-BUDGET, bytes without a downstream frame are charged.
it.each([false, true])("refuses oversized upstream staging before decoding (%s)", collection => {
  const stop = vi.fn(), budget = new ReleaseBudget(stop);
  expect(() => chargeUpstream([budget], 1, (collection ? 8 : 1) * 1024 * 1024 + 1, collection)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(stop).toHaveBeenCalled();
});
// control: legitimate under-cap input is admitted.
it("charges upstream bytes even before a release exists", () => {
  const budget = new ReleaseBudget(vi.fn());
  chargeUpstream([budget], 100, 100);
  expect(budget.counts).toEqual({ bytes: 100, work: 1, attempts: 0, statements: 0 });
});

// red-at-4df086541: failed shared reservations did not debit the other members.
it("T-BUDGET-MERGED-MEMBERS debits every member even if the first cannot pay", () => {
  const a = new ReleaseBudget(vi.fn()), b = new ReleaseBudget(vi.fn());
  a.charge({ bytes: RELEASE_LIMITS.bytes });
  expect(() => budgetModule!.reserveRelease([a, b, b], { bytes: 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(a.counts.bytes).toBe(RELEASE_LIMITS.bytes);
  expect(b.counts.bytes).toBe(1);
});
// red-at-4df086541: new allowances/waits had no persistent generation counters.
it("T-BUDGET-NO-RESET preserves counters across scopes and capacity waits", async () => {
  const stop = vi.fn(), budget = new ReleaseBudget(stop);
  budget.charge({ work: RELEASE_LIMITS.work - 1 });
  budgetModule!.withReleaseBudgets([budget], () => budgetModule!.chargeReleaseWork());
  await Promise.resolve();
  expect(() => budgetModule!.withReleaseBudgets([budget], () => budgetModule!.chargeReleaseWork())).toThrow();
  expect(() => budget.charge({})).toThrow();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(budget.terminal()).toBe(true); expect(budget.terminal()).toBe(false);
  expect(budget.counts.work).toBe(RELEASE_LIMITS.work);
});
// control: exact caps admit a zero-cost reservation until a crossing seals them.
it.each([0, 1, "cap"] as const)("admits %s serialized bytes at or below cap", value => {
  const bytes = value === "cap" ? RELEASE_LIMITS.bytes : value;
  const budget = new ReleaseBudget(vi.fn()); budget.charge({ bytes }); budget.charge({});
  expect(budget.counts.bytes).toBe(bytes);
});
