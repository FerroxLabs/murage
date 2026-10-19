import { describe, expect, it } from "vitest";
import { bumpUsageMonth, usageMonthKey, usageMonthTokens, USAGE_MONTHS_KEPT, type UsageMonth } from "./usage-month.ts";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

describe("usage month buckets", () => {
  it("adds replies and tokens to the month and rolls over to a new bucket", () => {
    const months: Record<string, UsageMonth> = {};
    bumpUsageMonth(months, { input: 100, output: 10 }, at(2026, 10, 30));
    bumpUsageMonth(months, { input: 50, output: 5, cachedInput: 20 }, at(2026, 10, 31));
    bumpUsageMonth(months, { input: 7, output: 1 }, at(2026, 11, 1));
    expect(months["2026-10"]).toMatchObject({ replies: 2, input: 150, output: 15, cachedInput: 20, since: at(2026, 10, 30) });
    expect(months["2026-11"]).toMatchObject({ replies: 1, input: 7, output: 1, since: at(2026, 11, 1) });
    expect(usageMonthTokens(months["2026-10"]!)).toBe(130 + 15);
  });
  it("ignores bad numbers and keeps a bounded number of months", () => {
    const months: Record<string, UsageMonth> = {};
    bumpUsageMonth(months, { input: Number.NaN, output: -3 }, at(2026, 1, 5));
    expect(months["2026-01"]).toMatchObject({ replies: 1, input: 0, output: 0 });
    for (let i = 0; i < 30; i += 1) bumpUsageMonth(months, { input: 1, output: 1 }, new Date(2024, i, 15).getTime());
    expect(Object.keys(months)).toHaveLength(USAGE_MONTHS_KEPT);
    expect(usageMonthKey(at(2026, 3, 9))).toBe("2026-03");
  });
});
