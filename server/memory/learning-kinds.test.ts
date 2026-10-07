// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { learningEventLabel } from "../../src/lib/memory-learning.ts";
import { LEARNING_EVENT_KINDS_V4, LEARNING_EVENT_KINDS_V5 } from "./learning-kinds.ts";

it("v5 adds exactly the section 12 kinds after the v4 list", () => {
  expect(LEARNING_EVENT_KINDS_V5.slice(0, LEARNING_EVENT_KINDS_V4.length)).toEqual([...LEARNING_EVENT_KINDS_V4]);
  expect(LEARNING_EVENT_KINDS_V5.slice(LEARNING_EVENT_KINDS_V4.length)).toEqual([
    "feedback-detected", "outcome-marked", "lesson-learned", "lesson-edited", "lesson-undone",
    "guide-suggested", "guide-applied", "guide-undone", "run-completed"]);
});

it("every kind has a plain label without banned words", () => {
  for (const kind of LEARNING_EVENT_KINDS_V5) {
    const label = learningEventLabel(kind);
    expect(label, kind).not.toBe("Memory updated");
    expect(label).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|composio/i);
  }
});
