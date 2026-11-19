// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance, declared recoveries: BOOT_STEPS (read-only-start.ts) is the one list of boot steps. This reads the server source, so a boot step
// that loses its guard, gains a computed name, or is added without being declared fails here by name instead of waiting for a write trace to show it.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

import { BOOT_STEPS } from "./read-only-start.ts";

const SERVER = import.meta.dirname;
const CALL = /\b(bootStep|bootStepAsync|bootCaught|lowDiskStep)\(\s*("([^"\\]+)")?/g;
/** Every production source file under server/: tests, test support and the module that defines the helpers are not call sites. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "testing" && entry.name !== "node_modules") sources(path, out); }
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") && path !== join(SERVER, "read-only-start.ts")) out.push(path);
  }
  return out;
}
function calls(): Array<{ at: string; helper: string; name: string | undefined }> {
  const found: Array<{ at: string; helper: string; name: string | undefined }> = [];
  for (const file of sources(SERVER)) {
    const text = readFileSync(file, "utf8");
    if (!/bootStep|bootCaught|lowDiskStep/.test(text)) continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import\b/.test(line)) return;
      const code = line.replace(/\/\/.*$/, "");
      for (const match of code.matchAll(CALL)) found.push({ at: `${relative(SERVER, file)}:${index + 1}`, helper: match[1]!, name: match[3] });
    });
  }
  // the scheduler is named at its own line, not through a helper
  const index = readFileSync(join(SERVER, "index.ts"), "utf8");
  for (const match of index.matchAll(/skippedAtStart\.push\("([^"]+)"\)/g)) found.push({ at: "index.ts", helper: "skippedAtStart.push", name: match[1] });
  return found;
}

it("W6 every boot step call names a declared step with a literal", () => {
  const found = calls();
  expect(found.length).toBeGreaterThan(30);
  expect(found.filter(call => call.name === undefined).map(call => `${call.at} ${call.helper}`)).toEqual([]);
  const declared = new Set<string>(BOOT_STEPS);
  expect(found.filter(call => !declared.has(call.name!)).map(call => `${call.at} ${call.name}`)).toEqual([]);
});

it("W6 every declared step still has its guarded call (a removed guard leaves its name unused)", () => {
  const used = new Set(calls().map(call => call.name));
  expect(BOOT_STEPS.filter(name => !used.has(name))).toEqual([]);
  expect(new Set(BOOT_STEPS).size).toBe(BOOT_STEPS.length);
});

it("W7 the listen callback closes the boot recoveries before anything else in it", () => {
  const index = readFileSync(join(SERVER, "index.ts"), "utf8");
  const listens = [...index.matchAll(/\bserver\.listen\([^\n]*\n\s*([^\n]*)/g)];
  expect(listens).toHaveLength(1);
  expect(listens[0]![1]).toMatch(/^store\.closeBootRecoveries\(\);/);
});
