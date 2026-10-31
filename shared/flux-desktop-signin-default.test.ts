import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FLUX_DESKTOP_SIGNIN_DEFAULT, fluxDesktopSigninOn } from "./flux-desktop-signin-default.mjs";

describe("fluxDesktopSignin default", () => {
  it("ships on (1.0.11): unset means on, explicit false still turns it off", () => {
    expect(FLUX_DESKTOP_SIGNIN_DEFAULT).toBe(true);
    expect(fluxDesktopSigninOn(undefined)).toBe(true);
    expect(fluxDesktopSigninOn({})).toBe(true);
    expect(fluxDesktopSigninOn({ fluxDesktopSignin: false })).toBe(false);
  });
  it("is one constant for Mac, Windows and Linux: no per-OS hold anywhere the switch is read", () => {
    const OS = /process\.platform|navigator\.platform|platform|\bwin32\b|\bdarwin\b|\blinux\b/;
    for (const file of ["./flux-desktop-signin-default.mjs", "../electron/flux-desktop-signin.mjs"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(OS);
    }
    // every reader of the switch is the shared function on config.features, nothing else
    const body = (file: string, start: string) => { const text = readFileSync(new URL(file, import.meta.url), "utf8"); const at = text.indexOf(start); expect(at, file).toBeGreaterThan(-1); return text.slice(at, text.indexOf("}", at)); };
    for (const [file, start, call] of [
      ["../server/config.ts", "export function fluxDesktopSigninEnabled", "return fluxDesktopSigninOn(cfg.features);"],
      ["../src/lib/feature-flags.ts", "export function fluxDesktopSigninEnabled", "return fluxDesktopSigninOn(config?.features);"],
    ] as const) {
      const reader = body(file, start);
      expect(reader, file).toContain(call);
      expect(reader, file).not.toMatch(OS);
    }
  });
  it("follows the single default constant when unset or malformed", () => {
    for (const features of [undefined, null, {}, { fluxDesktopSignin: "true" }]) expect(fluxDesktopSigninOn(features)).toBe(FLUX_DESKTOP_SIGNIN_DEFAULT);
  });
  it("works with the default off", () => {
    expect(fluxDesktopSigninOn({}, false)).toBe(false);
    expect(fluxDesktopSigninOn({ fluxDesktopSignin: true }, false)).toBe(true);
    expect(fluxDesktopSigninOn({ fluxDesktopSignin: false }, false)).toBe(false);
  });
  it("works with the default on", () => {
    expect(fluxDesktopSigninOn({}, true)).toBe(true);
    expect(fluxDesktopSigninOn(undefined, true)).toBe(true);
    expect(fluxDesktopSigninOn({ fluxDesktopSignin: false }, true)).toBe(false);
    expect(fluxDesktopSigninOn({ fluxDesktopSignin: true }, true)).toBe(true);
  });
});
