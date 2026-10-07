// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// server/model-vision.json is derived from src/data/model-metadata.json and
// must never drift from it: the server reads only the table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, SNAPSHOT_FILE, VISION_TABLE_FILE, buildVisionTable, renderVisionTable, visionKey } from "./build-model-metadata.mjs";

describe("the server's vision table", () => {
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, SNAPSHOT_FILE), "utf8"));
  const expected = renderVisionTable(buildVisionTable(snapshot));

  it("is exactly what the snapshot renders", () => {
    expect(readFileSync(join(REPO_ROOT, VISION_TABLE_FILE), "utf8")).toBe(expected);
  });

  it("keys ids without a vendor path, and leaves out ids the listings disagree on", () => {
    expect(visionKey("deepseek-ai/DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    const table = buildVisionTable({ digest: "d", providers: {
      a: { models: { "x/one": { vision: true }, two: {}, three: { vision: true }, four: {}, "minicpm-v-4.5": {} } },
      b: { models: { one: { vision: true }, two: {}, three: {}, four: {}, "minicpm-v-4.5": {} } },
      c: { models: { two: {}, "minicpm-v-4.5": {} } },
    } });
    // `four` has two silent listings: silence, not a "no". `minicpm-v-4.5`
    // has three, but its name says vision.
    expect(table).toEqual({ source: "d", vision: ["one"], textOnly: ["two"] });
  });

  it("never rules a vision-named model text only (audit: minicpm-v, nemotron omni, phi multimodal)", () => {
    const table = JSON.parse(expected);
    for (const id of ["minicpm-v-4.5", "nemotron-3-nano-omni@eu", "nemotron-3-nano-omni-30b-a3b-reasoning-bf16", "phi-4-multimodal-instruct"]) expect(table.textOnly).not.toContain(id);
  });

  it("knows the model from the 0.1.61 report is text only, and a Claude model sees", () => {
    const table = JSON.parse(expected);
    expect(table.textOnly).toContain("deepseek-v4-pro");
    expect(table.vision.some((id) => id.startsWith("claude-"))).toBe(true);
  });
});
