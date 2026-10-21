import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { browserSurfaceSupported } = require("./browser-platform.cjs");

describe("built-in browser platform gate", () => {
  it("keeps the sandboxed surface available on verified desktop platforms", () => {
    expect(browserSurfaceSupported("darwin")).toBe(true);
    expect(browserSurfaceSupported("linux")).toBe(true);
  });

  it("offers the surface on Windows (Electron 43.7.7 no longer crashes)", () => {
    expect(browserSurfaceSupported("win32")).toBe(true);
  });

  it("keeps the inline preload predicate in step with the shared helper", () => {
    const preload = readFileSync(fileURLToPath(new URL("./preload.cjs", import.meta.url)), "utf8");
    const m = preload.match(/const browserSurfaceSupported = ([^;\n]+);/);
    expect(m).not.toBeNull();
    const inline = (platform) => new Function("process", `return ${m[1]};`)({ platform });
    for (const platform of ["darwin", "linux", "win32", "freebsd", "aix"]) {
      expect(inline(platform), platform).toBe(browserSurfaceSupported(platform));
    }
  });

  it("has no Windows-only 'unavailable' copy left in Settings", () => {
    const settings = readFileSync(fileURLToPath(new URL("../src/components/SettingsModal.tsx", import.meta.url)), "utf8");
    expect(settings).not.toMatch(/browserBlockedOnWindows|Temporarily unavailable on Windows/);
  });

  it("fails closed on unknown platforms", () => {
    expect(browserSurfaceSupported("freebsd")).toBe(false);
  });

  it("keeps the sandboxed preload free of local module imports", () => {
    const preload = readFileSync(fileURLToPath(new URL("./preload.cjs", import.meta.url)), "utf8");
    expect(preload).not.toMatch(/require\(["']\.\//);
  });
});
