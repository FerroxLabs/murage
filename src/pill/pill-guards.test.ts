// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("pill, tray and shared attention renderers have no timers or repeating animation", () => {
  const walk = (directory: URL): URL[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? walk(file) : [file];
  });
  for (const directory of ["./", "../tray-panel/", "../attention-ui/"]) {
    for (const file of walk(new URL(directory, import.meta.url)).filter(file => !/\.test\./.test(file.pathname))) {
      expect(readFileSync(file, "utf8"), file.pathname).not.toMatch(/\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(|\banimation(?:-iteration-count)?\s*:[^;}]*\binfinite\b/);
    }
  }
});
