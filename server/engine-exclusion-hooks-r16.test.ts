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
import { loadEngineExclusionResource, requiredAddonFunctions, validateEngineExclusionReceipt } from "../scripts/engine-exclusion-resource.mjs";
import { buildEngineExclusion } from "../scripts/build-engine-exclusion.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** Written out here on purpose: the production list must equal it, and the C source's registered hooks must equal it. */
const HOOKS = ["anchorTestStall", "anchorTestStallOpen", "anchorTestRelease", "anchorTestFail", "anchorTestWhy", "anchorTestDropPrivileges", "anchorTestStallMs", "anchorTestStallExit", "anchorTestStats", "anchorTestCorruptName", "anchorTestDeadlineAtPost", "anchorTestHeapMark", "anchorTestHeapCheck", "anchorTestHeapLeaks", "anchorTestHeapCanary", "anchorTestSchedule", "anchorTestWaitSettled"];

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

// CONTRACTS-B 1.5 T6'(b'): the settle report is a single zero-timeout read. Deterministic, no timing: the body of anchor_end is checked as text.
describe("R23' (b'): anchor_end never waits", () => {
  const source = readFileSync(join(process.cwd(), "native", "engine-exclusion", "anchored-win.c"), "utf8");
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("static napi_value anchor_end("));
  const end = lines.findIndex((line, i) => i > start && line === "}");
  const body = lines.slice(start, end + 1).join("\n");

  it("finds the body (the check can say yes)", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("end_locked(s)");
  });
  it("has exactly one WaitFor call, WaitForSingleObject(s->closed_all, 0)", () => {
    const waits = body.match(/WaitFor\w*\s*\([^)]*\)/g) ?? [];
    expect(waits).toEqual(["WaitForSingleObject(s->closed_all, 0)"]);
  });
  it.each(["Sleep(", "SleepEx(", "SleepConditionVariable", "napi_create_promise", "napi_create_threadsafe_function"])("does not contain %s", (word) => {
    expect(body).not.toContain(word);
  });
});

// CONTRACTS-B 1.4 R25: a debug CRT exists only in the test-hooks build; a shipped build refuses it, and a package refuses a non-"MT" receipt.
describe("R25: the debug CRT never ships", () => {
  it("the build script refuses debug flags without testHooks", () => {
    expect(() => buildEngineExclusion({ testHooks: false, clFlags: ["/MTd"] })).toThrow("ENGINE_EXCLUSION_DEBUG_CRT_REFUSED");
    expect(() => buildEngineExclusion({ testHooks: false, clFlags: ["/MT", "/Od"] })).toThrow("ENGINE_EXCLUSION_DEBUG_CRT_REFUSED");
  });
  const receipt = (value: unknown, raw?: string) => {
    const file = join(scratch, `receipt-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, raw ?? JSON.stringify(value));
    return file;
  };
  it("a missing receipt is refused", () => {
    expect(() => validateEngineExclusionReceipt(join(scratch, "no-such-build.json"), "win32")).toThrow("ENGINE_EXCLUSION_RECEIPT_MISSING");
    expect(() => validateEngineExclusionReceipt(receipt(null, "not json"), "win32")).toThrow("ENGINE_EXCLUSION_RECEIPT_MISSING");
  });
  it('a receipt with crt "MTd" (or anything but "MT") is refused', () => {
    expect(() => validateEngineExclusionReceipt(receipt({ crt: "MTd" }), "win32")).toThrow("ENGINE_EXCLUSION_RECEIPT_CRT");
    expect(() => validateEngineExclusionReceipt(receipt({ crt: "other" }), "win32")).toThrow("ENGINE_EXCLUSION_RECEIPT_CRT");
    expect(() => validateEngineExclusionReceipt(receipt({}), "win32")).toThrow("ENGINE_EXCLUSION_RECEIPT_CRT");
  });
  it('a receipt with crt "MT" is accepted, and other platforms are not checked', () => {
    expect(() => validateEngineExclusionReceipt(receipt({ crt: "MT" }), "win32")).not.toThrow();
    expect(() => validateEngineExclusionReceipt(join(scratch, "absent.json"), "linux")).not.toThrow();
  });
});
