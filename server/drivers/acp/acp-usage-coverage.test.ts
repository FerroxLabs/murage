import { expect, it } from "vitest";
import { acpRequestUsage } from "./core.ts";

it("UP-PROMPT-CACHE-1020: a settled prompt's usage says whether its input and its cache reuse are fully reported", () => {
  const known = { version: 1, inputComplete: true, cacheComplete: true };
  const partial = { version: 1, inputComplete: true, cacheComplete: false };
  const unknown = { version: 1, inputComplete: false, cacheComplete: false };
  expect(acpRequestUsage({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 90 }, false)).toEqual({ input: 100, output: 5, cachedInput: 90, usageAccounting: known });
  expect(acpRequestUsage({ inputTokens: 10, outputTokens: 5 }, false)).toEqual({ input: 10, output: 5, usageAccounting: partial });
  expect(acpRequestUsage({ inputTokens: 0, outputTokens: 0 }, false).usageAccounting).toEqual(known);
  expect(acpRequestUsage({ inputTokens: 10, outputTokens: 50, cachedReadTokens: 30 }, true)).toEqual({ input: 10, output: 50, usageAccounting: partial });
  expect(acpRequestUsage({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 90, usageIsIncomplete: true }, false).usageAccounting).toEqual(unknown);
  expect(acpRequestUsage({ outputTokens: 5, cachedReadTokens: 90 }, false).usageAccounting).toEqual(unknown);
});

it("keeps beside-input overflow unavailable after ACP cache normalization", () => {
  const raw = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cachedReadTokens: 1 };
  expect(acpRequestUsage(raw, true)).toEqual({
    input: Number.MAX_SAFE_INTEGER, output: 0, cachedInput: 1,
    usageAccounting: { version: 1, inputComplete: true, cacheComplete: true },
  });
  const overflow = acpRequestUsage(raw, false);
  expect(overflow.usageAccounting).toEqual({ version: 1, inputComplete: false, cacheComplete: false });
  expect(overflow.input).toBeNaN();
  expect(overflow).not.toHaveProperty("cachedInput");
});
