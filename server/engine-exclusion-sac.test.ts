import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => vi.resetModules());
const loader = vi.hoisted(() => ({ failure: undefined as unknown, calls: 0 }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, existsSync: (file: unknown) => typeof file === "string" && file.endsWith("engine-exclusion.node") ? true : actual.existsSync(file as string) };
});
vi.mock("node:module", async original => {
  const actual = await original<typeof import("node:module")>();
  return { ...actual, createRequire: (url: string) => {
    const real = actual.createRequire(url);
    return Object.assign((file: string) => {
      if (path.basename(file) === "engine-exclusion.node") { loader.calls++; throw loader.failure; }
      return real(file);
    }, real);
  } };
});
import { exclusionAddonBlockedByWindows, forgetExclusionAddon, loadExclusionAddon } from "./engine-exclusion.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { vi.stubEnv("MURAGE_ENGINE_EXCLUSION_PATH", ""); forgetExclusionAddon(); });
afterEach(() => { vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform); forgetExclusionAddon(); loader.calls = 0; });

it("remembers the real loader's code-integrity failure across cached lookups, without admitting the addon", () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  loader.failure = Object.assign(new Error("LoadLibrary: 0x800711C7"), { code: "ERR_DLOPEN_FAILED" });
  expect(loadExclusionAddon()).toBeNull();
  const calls = loader.calls;
  expect(calls).toBeGreaterThan(0);
  expect(exclusionAddonBlockedByWindows()).toBe(true);
  expect(loader.calls).toBe(calls);
  forgetExclusionAddon();
  loader.failure = Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
  expect(loadExclusionAddon()).toBeNull();
  expect(exclusionAddonBlockedByWindows()).toBe(false);
});

it("never calls a non-Windows load failure a Windows component block", () => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  loader.failure = new Error("Smart App Control fixture");
  expect(loadExclusionAddon()).toBeNull();
  expect(exclusionAddonBlockedByWindows()).toBe(false);
});
