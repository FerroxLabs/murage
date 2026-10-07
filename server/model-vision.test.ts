// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { knownModelVision, modelVisionKey, turnModelVision } from "./model-vision.ts";

describe("model vision facts (G11)", () => {
  it("keys an id however an engine or catalog spells it", () => {
    expect(modelVisionKey("flux::deepseek-ai/DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    expect(modelVisionKey("flux-pinned-claude-opus-5")).toBe("claude-opus-5");
  });

  it("knows deepseek-v4-pro is text only and a Claude model sees; an alias stays unknown", () => {
    expect(knownModelVision("deepseek-v4-pro")).toBe(false);
    expect(knownModelVision("claude-opus-5")).toBe(true);
    expect(knownModelVision("opus")).toBeUndefined();
    expect(knownModelVision(undefined)).toBeUndefined();
  });

  it("an engine-managed turn (no catalog row) goes by the table: the Flux 400 case", () => {
    expect(turnModelVision(undefined, "deepseek-v4-pro")).toBe(false);
    expect(turnModelVision(undefined, "opus")).toBeUndefined();
  });

  it("a catalog row's own fact wins, and a silent row falls back to the table, then to no", () => {
    expect(turnModelVision({ capabilities: { vision: true } }, "deepseek-v4-pro")).toBe(true);
    expect(turnModelVision({ capabilities: { vision: false } }, "claude-opus-5")).toBe(false);
    expect(turnModelVision({ capabilities: {} }, "claude-opus-5")).toBe(true);
    expect(turnModelVision({ capabilities: {} }, "some-private-model")).toBe(false);
  });
});
