// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createTaskAggregateCache, sumTaskUsage } from "./task-window.ts";
import { requestUsage, type CacheUsage } from "../shared/prompt-cache-usage.ts";

const taskUsage = (u: CacheUsage) => ({ ...u, turns: 1, costUsd: null });
it("PC-R2-derived-coverage: missing input and missing cache remain independent, including source removal", () => {
  const known = taskUsage(requestUsage(100, 0, 80));
  const partial = taskUsage(requestUsage(100, 0, undefined));
  const unknown = taskUsage(requestUsage(undefined, undefined, undefined));
  const rows = [known, partial, unknown].map((usage, n) => ({ threadId: `task-${n}`, createdAt: n, usage }));
  expect(sumTaskUsage(rows)).toMatchObject({ input: 200, cachedInput: 80, usageAccounting: { inputComplete: false, cacheComplete: false } });
  const cache = createTaskAggregateCache();
  const get = () => cache.get("bot", rows, "task-0", "revision", 10, () => undefined).usage;
  expect(get().usageAccounting).toEqual({ version: 1, inputComplete: false, cacheComplete: false });
  expect(get().cachedInput).toBe(80);
  // An unrelated complete delta cannot erase the other task's missing input.
  const nextKnown = taskUsage(requestUsage(200, 0, 160));
  cache.noteUsage("bot", known, nextKnown);
  rows[0].usage = nextKnown;
  expect(get().usageAccounting).toEqual({ version: 1, inputComplete: false, cacheComplete: false });
  expect(get().cachedInput).toBe(160);
  const zero = taskUsage(requestUsage(0, 0, undefined));
  cache.noteUsage("bot", unknown, zero);
  rows[2].usage = zero;
  expect(get().usageAccounting).toEqual({ version: 1, inputComplete: true, cacheComplete: false });
  cache.noteUsage("bot", partial, zero);
  rows[1].usage = zero;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().usageAccounting).toEqual({ version: 1, inputComplete: true, cacheComplete: true });
  expect(get().cachedInput).toBe(160);
});
it("PC-R2-derived-legacy: a legacy numeric split does not attest coverage", () => {
  expect(sumTaskUsage([{ usage: { input: 100, output: 0, cachedInput: 80, costUsd: null, turns: 1 } }]).usageAccounting)
    .toEqual({ version: 1, inputComplete: false, cacheComplete: false });
});

it("PC-R2-derived-cache-reads: invalid reads never count and the last valid read can leave", () => {
  const corrupt = taskUsage({ input: 10, output: 0, cachedInput: 20 });
  const known = taskUsage(requestUsage(100, 0, 80));
  const zeroRead = taskUsage(requestUsage(100, 0, 0));
  const missingRead = taskUsage(requestUsage(100, 0, undefined));
  const rows = [corrupt, known].map((usage, n) => ({ threadId: `task-${n}`, createdAt: n, usage }));
  const cache = createTaskAggregateCache();
  const get = () => cache.get("bot", rows, "task-0", "revision", 10, () => undefined).usage;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().cachedInput).toBe(80);
  cache.noteUsage("bot", known, zeroRead);
  rows[1].usage = zeroRead;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().cachedInput).toBe(0);
  cache.noteUsage("bot", zeroRead, missingRead);
  rows[1].usage = missingRead;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get()).not.toHaveProperty("cachedInput");
  expect(get().usageAccounting).toEqual({ version: 1, inputComplete: false, cacheComplete: false });
});

it("keeps a reloaded overflow unavailable in a bot subtotal until its source is replaced", () => {
  const overflow = JSON.parse(JSON.stringify(taskUsage({ input: Number.NaN, output: 3 }))) as ReturnType<typeof taskUsage>;
  const known = taskUsage(requestUsage(10, 0, 8));
  const rows = [overflow, known].map((usage, n) => ({ threadId: `task-${n}`, createdAt: n, usage }));
  const cache = createTaskAggregateCache();
  const get = () => cache.get("bot", rows, "task-0", "revision", 10, () => undefined).usage;
  expect(overflow.input).toBeNull();
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().input).toBeNaN();
  expect(get()).toMatchObject({ output: 3, turns: 2, cachedInput: 8, usageAccounting: { inputComplete: false, cacheComplete: false } });

  const nextKnown = taskUsage(requestUsage(20, 0, 16));
  cache.noteUsage("bot", known, nextKnown);
  rows[1].usage = nextKnown;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().input).toBeNaN();
  const zero = taskUsage(requestUsage(0, 0, undefined));
  cache.noteUsage("bot", overflow, zero);
  rows[0].usage = zero;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get()).toMatchObject({ input: 20, output: 0, usageAccounting: { inputComplete: true, cacheComplete: true } });
});

it("checks bot subtotal arithmetic on both the initial sum and cached deltas", () => {
  const max = taskUsage(requestUsage(Number.MAX_SAFE_INTEGER, 0, 0));
  const zero = taskUsage(requestUsage(0, 0, 0));
  const one = taskUsage(requestUsage(1, 0, 0));
  const rows = [max, zero].map((usage, n) => ({ threadId: `task-${n}`, createdAt: n, usage }));
  const cache = createTaskAggregateCache();
  const get = () => cache.get("bot", rows, "task-0", "revision", 10, () => undefined).usage;
  expect(get().input).toBe(Number.MAX_SAFE_INTEGER);
  cache.noteUsage("bot", zero, one);
  rows[1].usage = one;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().input).toBeNaN();
  cache.noteUsage("bot", one, zero);
  rows[1].usage = zero;
  expect(get()).toEqual(sumTaskUsage(rows));
  expect(get().input).toBe(Number.MAX_SAFE_INTEGER);
});
