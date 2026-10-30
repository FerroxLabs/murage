import { describe, expect, it } from "vitest";
import { FLUX_DESKTOP_SIGNIN_DEFAULT, fluxDesktopSigninOn } from "./flux-desktop-signin-default.mjs";

describe("fluxDesktopSignin default", () => {
  it("ships on (1.0.11): unset means on, explicit false still turns it off", () => {
    expect(FLUX_DESKTOP_SIGNIN_DEFAULT).toBe(true);
    expect(fluxDesktopSigninOn(undefined)).toBe(true);
    expect(fluxDesktopSigninOn({})).toBe(true);
    expect(fluxDesktopSigninOn({ fluxDesktopSignin: false })).toBe(false);
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
