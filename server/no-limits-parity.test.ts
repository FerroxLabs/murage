// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { atLeastAsStrict } from "./testing/no-limits-parity.ts";

it.each([
  ["run", "run", true],
  ["card:cut", "run", true],
  ["card:root", "card:cut", true],
  ["card:root", "card:word", true],
  ["run", "card:cut", false],
  ["card:cut", "card:word", false],
  ["card:word", "card:root", false],
] as const)("one-sided parity: %s versus %s", (actual, expected, accepted) => {
  expect(atLeastAsStrict(actual, expected)).toBe(accepted);
});

it("rejects unknown verdicts on either side", () => {
  for (const unknown of ["", "card", "card:unknown", "constructor", "__proto__"]) {
    expect(() => atLeastAsStrict(unknown, "run")).toThrow("Unknown parity verdict");
    expect(() => atLeastAsStrict("card:root", unknown)).toThrow("Unknown parity verdict");
  }
});
