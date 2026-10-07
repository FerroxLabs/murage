// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { notebookLastWrittenLine } from "./notebook-last-written";

const DAY = 86_400_000, NOW = Date.UTC(2026, 8, 29, 12);
it("says when the notebook was last written, and says so plainly after a week", () => {
  expect(notebookLastWrittenLine(null, NOW)).toBe("Nothing written here yet.");
  expect(notebookLastWrittenLine(NOW - 3_600_000, NOW)).toBe("Last written today.");
  expect(notebookLastWrittenLine(NOW - DAY, NOW)).toBe("Last written yesterday.");
  expect(notebookLastWrittenLine(NOW - 6 * DAY, NOW)).toBe("Last written 6 days ago.");
  expect(notebookLastWrittenLine(NOW - 12 * DAY, NOW)).toBe("Last written 12 days ago. Nothing new in over a week.");
});
