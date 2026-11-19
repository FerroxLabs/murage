// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("both float entries share the card tree without timers, animation loops or privileged bridges", () => {
  const directory = new URL("./", import.meta.url);
  for (const file of readdirSync(directory).filter(name => !name.includes(".test."))) {
    const text = readFileSync(new URL(file, directory), "utf8");
    expect(text, file).not.toMatch(/\b(?:setInterval|requestAnimationFrame|setTimeout|fetch|XMLHttpRequest|WebSocket)\s*\(|\banimation(?:-iteration-count)?\s*:[^;}]*\binfinite\b|\bwindow\.(?:muragebox|murageNative|close)\b/);
  }
  const panel = readFileSync(new URL("FloatPanel.tsx", directory), "utf8");
  expect(panel).toContain('import { AttentionCard } from "../attention-ui/AttentionCard"');
  for (const kind of ["bubble", "dock"]) {
    const html = readFileSync(new URL(`${kind}.html`, directory), "utf8");
    expect(html).toContain(`data-float-kind="${kind}"`); expect(html).toContain("frame-src 'none'"); expect(html).toContain('src="./main.tsx"');
  }
});
