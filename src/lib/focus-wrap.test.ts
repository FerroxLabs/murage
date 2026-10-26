// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";

import { wrapTabTarget } from "./focus-wrap";

it("wraps Tab at the ends and leaves the middle alone", () => {
  expect(wrapTabTarget(3, 2, false)).toBe(0);
  expect(wrapTabTarget(3, 0, true)).toBe(2);
  expect(wrapTabTarget(3, 1, false)).toBeNull();
  expect(wrapTabTarget(3, -1, false)).toBe(0);
  expect(wrapTabTarget(3, -1, true)).toBe(2);
  expect(wrapTabTarget(0, -1, false)).toBeNull();
  expect(wrapTabTarget(1, 0, false)).toBe(0);
});
