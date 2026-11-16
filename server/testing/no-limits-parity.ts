// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN r1.3a: conservative readers may strengthen a verdict, never weaken it.
// Effect priority is the oracle's order, also used by finalDecision.
const strictness: Readonly<Record<string, number>> = {
  run: 0, "card:cut": 1, "card:word": 2, "card:fork": 3,
  "card:disk": 4, "card:system": 5, "card:home": 6, "card:root": 7,
};

export function atLeastAsStrict(actual: string, expected: string): boolean {
  if (!Object.hasOwn(strictness, actual) || !Object.hasOwn(strictness, expected)) {
    throw new Error("Unknown parity verdict");
  }
  return strictness[actual]! >= strictness[expected]!;
}
