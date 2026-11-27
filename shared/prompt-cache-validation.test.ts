// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { legacyTurnUsage, requestUsage } from "./prompt-cache-usage.ts";
import { acpRequestUsage } from "../server/drivers/acp/core.ts";

it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 101])("invalid cached read %s never becomes a measured lower bound", (cached) => {
  for (const u of [requestUsage(100, 1, cached), legacyTurnUsage({ input: 100, output: 1, cachedInput: cached }), acpRequestUsage({ inputTokens: 100, outputTokens: 1, cachedReadTokens: cached }, true)]) {
    expect(u).toEqual({ input: 100, output: 1, usageAccounting: { version: 1, inputComplete: true, cacheComplete: false } });
  }
});

it.each([undefined, NaN, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("an incomplete output report %s cannot support an exact token headline", (output) => {
  expect(requestUsage(100, output, 80)).toEqual({ input: 100, output: 0, cachedInput: 80, usageAccounting: { version: 1, inputComplete: false, cacheComplete: false } });
});
