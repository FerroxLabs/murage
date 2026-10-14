// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { referenceLine, type BundleRecord } from "./bundle.ts";

const base: BundleRecord = { id: "r1", version: 1, scopeId: "s", text: "I want the red one", assertion: "assistant-inference", pinned: false, kind: "checkpoint", evidence: [] };

describe("referenceLine checkpoint label", () => {
  it("renders a checkpoint as working notes, not assistant inference", () => {
    const line = referenceLine(base, 1);
    expect(line).toContain("(working notes; checkpoint)");
    expect(line).not.toContain("earlier assistant inference");
  });
  it("leaves other assistant inferences unchanged", () => {
    expect(referenceLine({ ...base, kind: "fact" }, 1)).toContain("(earlier assistant inference; fact)");
  });
});
