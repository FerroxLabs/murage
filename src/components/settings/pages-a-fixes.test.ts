// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra round 1 on Settings pages 1-7 (lane A): a link or a fix never lands on a card the page does not mount.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("Settings pages A: no dead-end links", () => {
  it("every Open local models link names the card, so Simple turns Advanced on first", () => {
    for (const file of ["components/EnginesSettings.tsx", "components/EngineSetup.tsx", "components/ModelPicker.tsx"]) {
      expect(src(file), file).toMatch(/section:\s*["']models["'],\s*anchor:\s*["']local-models-heading["']/);
    }
  });
  it("the raise-the-limit action on the Memory page goes to Usage, not to a card Memory does not mount", () => {
    const memory = src("components/MemorySection.tsx");
    expect(src("lib/learning-limit.ts")).toContain('LEARNING_LIMIT_ANCHOR = "memory-limit-heading"');
    expect(memory).toMatch(/section:\s*"usage",\s*anchor:\s*LEARNING_LIMIT_ANCHOR/);
  });
  it("an engine fix with no setup card lands on the engine command lines instead of doing nothing", () => {
    expect(src("components/EnginesSettings.tsx")).toContain('anchor: "engine-command-lines-heading"');
  });
  // 1.0.21: the path left the row in every mode (the command lines in Advanced still show it); the rendered witness is
  // models-engines-polish.test.ts "shows no raw file path, even in Advanced".
  it("an engine row gives its line the full width on a phone and shows no file path", () => {
    expect(src("components/EngineRow.tsx")).toContain("basis-full");
    // The row is EngineBlock; the Advanced command lines (EngineCommandLine) keep the path on purpose.
    const engines = src("components/EnginesSettings.tsx");
    const row = engines.slice(engines.indexOf("function EngineBlock("), engines.indexOf("function EngineCommandLine("));
    expect(row.length).toBeGreaterThan(0);
    expect(row).not.toContain("font-mono text-[11.5px] text-accent");
  });
  it("the pages lane commits no runner logs", () => {
    expect(() => readFileSync(new URL("../../../.pw.log", import.meta.url))).toThrow();
  });
});
