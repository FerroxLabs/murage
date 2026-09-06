import { describe, expect, it } from "vitest";

import { goalWaitMaxMs } from "./goal-wait.ts";

describe("goalWaitMaxMs", () => {
  it.each([undefined, "", "  ", "nonsense", "1500ms", "NaN", "Infinity", "-Infinity", "1e309", "0", "-0", "-1"])(
    "uses the five-minute default for invalid or nonpositive %j",
    (raw) => expect(goalWaitMaxMs(raw)).toBe(300_000),
  );

  it.each([
    ["0.5", 1_000],
    ["1", 1_000],
    ["999", 1_000],
    ["1000", 1_000],
    ["1500", 1_500],
    [" 1500 ", 1_500],
    ["1500.9", 1_500],
    ["300000", 300_000],
    ["600000", 600_000],
    ["2147483647", 2_147_483_647],
    ["2147483647.9", 2_147_483_647],
    ["2147483648", 2_147_483_647],
    ["9007199254740991", 2_147_483_647],
    ["1e100", 2_147_483_647],
  ] as const)("normalizes positive configured wait %s to %i ms", (raw, expected) => {
    const actual = goalWaitMaxMs(raw);
    expect(actual).toBe(expected);
    expect(Number.isInteger(actual)).toBe(true);
    expect(actual).toBeGreaterThanOrEqual(1_000);
    expect(actual).toBeLessThanOrEqual(2_147_483_647);
  });
});
