// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { learningReviewReason, storedReviewReason } from "./automatic-learning.ts";

const codes = ["needs-owner-approval", "private-into-shared", "cross-partition", "cross-scope", "retired-partition", "default-review", "review-mode", "automatic-off", "correction-review", "origin-x", "unknown"];

describe("review reasons say Needs you", () => {
  it("never show Needs review to the owner", () => {
    for (const code of codes) {
      const text = learningReviewReason(code);
      expect(text).not.toMatch(/needs review/i);
      expect(text).not.toMatch(/[—]|\bsafe|unsafe/i);
    }
    expect(learningReviewReason("default-review")).toContain("Needs you");
  });
  it("reads a reason stored before 1.0.2 in the same words", () => {
    expect(storedReviewReason("Review this memory in Needs review before using it.")).toBe("This memory needs you before it is used.");
    expect(storedReviewReason("Open Needs review to approve this memory.")).toBe("Open Needs you to approve this memory.");
  });
});
