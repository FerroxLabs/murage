// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R16 (CONTRACTS-B 1.3): the test-hooks build of the Windows helper (dist-native/engine-exclusion-test, every export starting with
// "anchorTest") is never loaded outside the test-only override and never packaged. Each hook is tested ON ITS OWN against all three
// gates: the server loader, the Electron loader and the after-pack load check. A drift guard ties the list to the C source, so a hook
// added there cannot ship by being left off the list.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ADDON_VERSION, ANCHOR_TEST_EXPORTS, addonIsUsable, type ExclusionAddon } from "./engine-exclusion.ts";
import { windowsAddonIsUsable, WINDOWS_NATIVE_VERSION } from "../electron/windows-native.mjs";
import { loadEngineExclusionResource, requiredAddonFunctions } from "../scripts/engine-exclusion-resource.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** Written out here on purpose: the production list must equal it, and the C source's registered hooks must equal it. */
const HOOKS = ["anchorTestStall", "anchorTestStallOpen", "anchorTestRelease", "anchorTestFail", "anchorTestWhy", "anchorTestDropPrivileges", "anchorTestStallMs", "anchorTestStallExit", "anchorTestStats", "anchorTestCorruptName"];

const scratch = mkdtempSync(join(tmpdir(), "murage-r16-"));
afterAll(() => removeTempDirSync(scratch));

const FUNCTIONS = ["lock", "processes", "renameNoReplace", ...requiredAddonFunctions(process.platform)];
function plainAddon(extra: string[]): Record<string, unknown> {
  const addon: Record<string, unknown> = { version: () => ADDON_VERSION, processes: () => [{ pid: process.pid }] };
  for (const name of FUNCTIONS) addon[name] ??= () => undefined;
  for (const name of extra) addon[name] = () => undefined;
  return addon;
}

describe("R16: every test-hook export is refused by every production gate", () => {
  it("a clean addon is accepted by all three gates (the check can say yes)", () => {
    expect(addonIsUsable(plainAddon([]) as Partial<ExclusionAddon>)).toBe(true);
    expect(WINDOWS_NATIVE_VERSION).toBe(ADDON_VERSION);
    expect(windowsAddonIsUsable(plainAddon([]))).toBe(true);
    const file = join(scratch, "clean.cjs");
    writeFileSync(file, `const f=${JSON.stringify(FUNCTIONS)};const a={version:()=>${ADDON_VERSION},processes:()=>[{pid:process.pid}]};for(const n of f)a[n]??=()=>undefined;module.exports=a;`);
    expect(loadEngineExclusionResource(file, process.platform, process.arch, ADDON_VERSION, run, process.execPath)).toBe("loaded");
  });

  const run = (command: string, args: string[], env: Record<string, string>) => execFileSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8" });

  for (const name of HOOKS) {
    it(`${name}: refused by the server loader unless the test-only override is in force`, () => {
      const addon = plainAddon([name]) as Partial<ExclusionAddon>;
      expect(addonIsUsable(addon, false)).toBe(false);
      expect(addonIsUsable(addon, true)).toBe(true);
    });
    it(`${name}: refused by the Electron loader`, () => {
      expect(windowsAddonIsUsable(plainAddon([name]))).toBe(false);
    });
    it(`${name}: refused by the after-pack load check (ENGINE_EXCLUSION_RESOURCE_TEST_HOOKS)`, () => {
      const file = join(scratch, `hook-${name}.cjs`);
      writeFileSync(file, `const f=${JSON.stringify(FUNCTIONS)};const a={version:()=>${ADDON_VERSION},processes:()=>[{pid:process.pid}],${name}:()=>undefined};for(const n of f)a[n]??=()=>undefined;module.exports=a;`);
      expect(() => loadEngineExclusionResource(file, process.platform, process.arch, ADDON_VERSION, run, process.execPath)).toThrow("ENGINE_EXCLUSION_RESOURCE_TEST_HOOKS");
    });
  }

  it("a hook nobody listed yet (any anchorTest* name) is refused too", () => {
    expect(addonIsUsable(plainAddon(["anchorTestSomethingNew"]) as Partial<ExclusionAddon>)).toBe(false);
    expect(windowsAddonIsUsable(plainAddon(["anchorTestSomethingNew"]))).toBe(false);
  });

  it("drift guard: every hook the C source registers is on the list", () => {
    const source = readFileSync(join(process.cwd(), "native", "engine-exclusion", "anchored-win.c"), "utf8");
    const registered = [...source.matchAll(/add\(env, exports, "(anchorTest\w+)"/g)].map((m) => m[1]!).sort();
    expect(registered).toEqual([...HOOKS].sort());
    expect([...ANCHOR_TEST_EXPORTS].sort()).toEqual([...HOOKS].sort());
  });
});
