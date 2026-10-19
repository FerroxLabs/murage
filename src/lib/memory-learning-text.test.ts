// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { LEARNING_EVENT_KINDS_V5 } from "../../server/memory/learning-kinds.ts";
import { learningEventLabel } from "./memory-learning-text";

it("every kind has a plain label without banned words", () => {
  for (const kind of LEARNING_EVENT_KINDS_V5) {
    const label = learningEventLabel(kind);
    expect(label, kind).not.toBe("Memory updated");
    expect(label).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|composio/i);
  }
});
