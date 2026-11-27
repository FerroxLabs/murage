import { describe, expect, it } from "vitest";
import { addCacheUsage, coverage, legacyTurnUsage, requestUsage, splitRequestUsage, usageAccounting } from "./prompt-cache-usage.ts";
import { bumpUsageMonth, usageMonthKey } from "./usage-month.ts";

const known = { version: 1, inputComplete: true, cacheComplete: true };
const partial = { version: 1, inputComplete: true, cacheComplete: false };
const unknown = { version: 1, inputComplete: false, cacheComplete: false };

describe("prompt cache usage contract (UP-PROMPT-CACHE-1020 S0)", () => {
  it("a request with input and a cache read count is complete for both", () => {
    expect(requestUsage(100, 3, 80)).toEqual({ input: 100, output: 3, cachedInput: 80, usageAccounting: known });
  });
  it("a request with input but no cache count is input-complete only", () => {
    expect(requestUsage(100, 3, undefined)).toEqual({ input: 100, output: 3, usageAccounting: partial });
  });
  it("a proven zero-input request needs no cache count", () => {
    expect(requestUsage(0, 0, undefined).usageAccounting).toEqual(known);
  });
  it("an absent input is never read as zero", () => {
    expect(requestUsage(undefined, undefined, undefined)).toEqual({ input: 0, output: 0, usageAccounting: unknown });
    expect(requestUsage(Number.NaN, 1, 0).usageAccounting).toEqual(unknown);
    expect(requestUsage(-1, 1, 0).usageAccounting).toEqual(unknown);
  });
  it("a cache count above the input is not a valid cache report", () => {
    expect(requestUsage(10, 0, 20)).toEqual({ input: 10, output: 0, usageAccounting: partial });
  });
  it("never lets more input from another source validate a malformed cache count", () => {
    const corrupt = { input: 10, output: 0, cachedInput: 20 };
    const valid = requestUsage(100, 0, 80);
    expect(addCacheUsage(corrupt, valid)).toEqual({ input: 110, output: 0, cachedInput: 80, usageAccounting: unknown });
    expect(addCacheUsage(valid, corrupt)).toEqual({ input: 110, output: 0, cachedInput: 80, usageAccounting: unknown });
  });
  it("PC-R2-unreported-request-is-not-upper-bound: an unreported round after 100/80 leaves both unknown", () => {
    const total = addCacheUsage(requestUsage(100, 0, 80), requestUsage(undefined, undefined, undefined));
    expect(total).toEqual({ input: 100, output: 0, cachedInput: 80, usageAccounting: unknown });
    const reversed = addCacheUsage(requestUsage(undefined, undefined, undefined), requestUsage(100, 0, 80));
    expect(reversed.usageAccounting).toEqual(unknown);
  });
  it("PC-R2-known-input-missing-cache-upper-bound: complete input, incomplete cache", () => {
    const total = addCacheUsage(requestUsage(100, 0, 80), requestUsage(100, 0, undefined));
    expect(total).toEqual({ input: 200, output: 0, cachedInput: 80, usageAccounting: partial });
  });
  it("legacy totals with no metadata are unknown for both, with no historical inference", () => {
    expect(coverage({ input: 100, output: 0, cachedInput: 80 })).toEqual(unknown);
    expect(addCacheUsage({ input: 100, output: 0, cachedInput: 80 }, requestUsage(10, 0, 10)).usageAccounting).toEqual(unknown);
    expect(usageAccounting({ version: 2, inputComplete: true, cacheComplete: true })).toEqual(unknown);
    expect(usageAccounting({ version: 1, inputComplete: false, cacheComplete: true })).toEqual(unknown);
  });
  it("an overflowing sum is not a known total", () => {
    const big = requestUsage(Number.MAX_SAFE_INTEGER, 0, 0);
    expect(addCacheUsage(big, requestUsage(1, 0, 0)).usageAccounting).toEqual(unknown);
  });
  it("an overflowed accumulator stays unavailable after another report and after reload", () => {
    const max = requestUsage(Number.MAX_SAFE_INTEGER, 0, 0);
    const overflow = addCacheUsage(max, requestUsage(1, 0, 0));
    const restored = JSON.parse(JSON.stringify(overflow)) as typeof overflow;
    for (const prior of [overflow, restored]) {
      const total = addCacheUsage(prior, requestUsage(10, 2, 4));
      expect(total.input).toBeNaN();
      expect(total.output).toBe(2);
      expect(total.usageAccounting).toEqual(unknown);
    }
  });
  it("PC-R2-antigravity-cache-split: reads beside fresh input are added to input once", () => {
    expect(splitRequestUsage(20, 5, 80)).toEqual({ input: 100, output: 5, cachedInput: 80, usageAccounting: known });
    expect(splitRequestUsage(20, 5, 80, 10)).toEqual({ input: 110, output: 5, cachedInput: 80, usageAccounting: known });
    expect(splitRequestUsage(20, 5, undefined)).toEqual({ input: 20, output: 5, usageAccounting: partial });
    expect(splitRequestUsage(undefined, 5, 80).usageAccounting).toEqual(unknown);
    expect(splitRequestUsage(20, 5, -1).usageAccounting).toEqual(unknown);
  });
  it("a turn with no metadata is read from its numbers; an oversized cache count is rejected and leaves reuse incomplete", () => {
    expect(legacyTurnUsage({ input: 100, output: 20, cachedInput: 40 })).toEqual({ input: 100, output: 20, cachedInput: 40, usageAccounting: known });
    expect(legacyTurnUsage({ input: 10, output: 0, cachedInput: 20 })).toEqual({ input: 10, output: 0, usageAccounting: partial });
    expect(legacyTurnUsage({}).usageAccounting).toEqual(unknown);
  });
  it("PC-R2-unreported-request-is-not-upper-bound in the month bucket, in either order", () => {
    const at = Date.UTC(2026, 10, 17);
    for (const turns of [[{ input: 100, output: 0, cachedInput: 80 }, {}], [{}, { input: 100, output: 0, cachedInput: 80 }]]) {
      const months = {};
      for (const turn of turns) bumpUsageMonth(months, turn, at);
      expect(months[usageMonthKey(at)]).toMatchObject({ replies: 2, input: 100, cachedInput: 80, usageAccounting: unknown });
    }
    const complete = {};
    bumpUsageMonth(complete, { input: 100, output: 0, cachedInput: 80 }, at);
    expect(complete[usageMonthKey(at)].usageAccounting).toEqual(known);
  });
  it("a month bucket written before accounting existed stays unknown after a new turn", () => {
    const at = Date.UTC(2026, 10, 17);
    const months = { [usageMonthKey(at)]: { replies: 3, input: 300, output: 3, cachedInput: 200, since: at } };
    bumpUsageMonth(months, { input: 100, output: 0, cachedInput: 80 }, at);
    expect(months[usageMonthKey(at)]).toMatchObject({ replies: 4, input: 400, cachedInput: 280, usageAccounting: unknown });
  });
});
