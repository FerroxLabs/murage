// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { servedModelDiffers, servedModelLine } from "./served-model";

describe("the answered-by line", () => {
  it("appears when Flux answered with another model than the one picked", () => {
    const line = servedModelLine({ routed: "claude-sonnet-5", requested: "deepseek-v4" });
    expect(line).toBe("Answered by Claude Sonnet 5 (you picked DeepSeek V4)");
    expect(line).not.toMatch(/—|–|error|fail|sorry/i);
  });

  it("does not appear when the models match, by any spelling of the same id", () => {
    expect(servedModelLine({ routed: "deepseek-v4", requested: "deepseek-v4" })).toBeNull();
    expect(servedModelLine({ routed: "DeepSeek-V4", requested: "deepseek-v4" })).toBeNull();
    expect(servedModelLine({ routed: "deepseek/deepseek-v4", requested: "deepseek-v4" })).toBeNull();
    expect(servedModelDiffers({ routed: "deepseek-v4", requested: "deepseek-v4" })).toBe(false);
  });

  it("does not appear without both models", () => {
    expect(servedModelLine(undefined)).toBeNull();
    expect(servedModelLine({ routed: "", requested: "deepseek-v4" })).toBeNull();
  });

  it("names a Flux tier pick by its tier", () => {
    expect(servedModelLine({ routed: "kimi-k2-6", requested: "flux-auto" })).toMatch(/^Answered by .+ \(you picked .+\)$/);
  });
});
