import { afterEach, describe, expect, it, vi } from "vitest";

import { isPhoneClient, phoneClientFrom, phonePollMs, resetPhoneClientForTest, type PhoneProbe } from "./phone-client";

afterEach(() => {
  resetPhoneClientForTest();
  vi.unstubAllGlobals();
});

const iphone: PhoneProbe = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", coarsePointer: true, shortSide: 390, desktopBridge: false };

describe("phoneClientFrom", () => {
  it("is a phone for the native shell whatever the screen says", () => {
    expect(phoneClientFrom({ ...iphone, userAgent: `${iphone.userAgent} MurageApp/1.0.0 (ios)`, coarsePointer: false, shortSide: 1024 })).toBe(true);
  });

  it("is a phone for a touch screen whose short side is phone-sized", () => {
    expect(phoneClientFrom(iphone)).toBe(true);
  });

  it("stays a phone held sideways: the short side does not rotate", () => {
    // 844x390 in landscape is wider than md, which a viewport query would
    // read as a tablet; the screen's short side is still 390.
    expect(phoneClientFrom({ ...iphone, shortSide: 390 })).toBe(true);
  });

  it("is not a phone for a tablet", () => {
    expect(phoneClientFrom({ ...iphone, shortSide: 820 })).toBe(false);
  });

  it("is not a phone for an iPad mini: 744 short side, coarse pointer", () => {
    expect(phoneClientFrom({ ...iphone, shortSide: 744 })).toBe(false);
  });

  it("is a phone for a 430 short side", () => {
    expect(phoneClientFrom({ ...iphone, shortSide: 430 })).toBe(true);
  });

  it("is a phone for the native shell regardless of screen size", () => {
    expect(phoneClientFrom({ ...iphone, userAgent: `${iphone.userAgent} MurageApp/1.0.0 (ios)`, coarsePointer: false, shortSide: 820 })).toBe(true);
  });

  it("is not a phone for a narrow desktop window: the pointer is fine", () => {
    expect(phoneClientFrom({ ...iphone, userAgent: "Mozilla/5.0 (Macintosh) Chrome/140", coarsePointer: false, shortSide: 390 })).toBe(false);
  });

  it("is never a phone inside the desktop app, even on a touch laptop", () => {
    expect(phoneClientFrom({ ...iphone, desktopBridge: true })).toBe(false);
  });
});

describe("phonePollMs", () => {
  it("halves the rate on a phone and leaves the desktop alone", () => {
    expect(phonePollMs(4000, true)).toBe(8000);
    expect(phonePollMs(30_000, true)).toBe(60_000);
    expect(phonePollMs(4000, false)).toBe(4000);
  });
});

describe("isPhoneClient", () => {
  const stubEnv = (opts: { userAgent: string; coarse: boolean; width: number; height: number; muragebox?: unknown }) => {
    vi.stubGlobal("navigator", { userAgent: opts.userAgent });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse") ? opts.coarse : false }));
    vi.stubGlobal("screen", { width: opts.width, height: opts.height });
    if (opts.muragebox !== undefined) vi.stubGlobal("muragebox", opts.muragebox);
  };

  it("reads the live environment for a phone-sized touch screen", () => {
    stubEnv({ userAgent: iphone.userAgent, coarse: true, width: 390, height: 844 });
    expect(isPhoneClient()).toBe(true);
  });

  it("reads the live environment for a desktop", () => {
    stubEnv({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/140", coarse: false, width: 1440, height: 900 });
    expect(isPhoneClient()).toBe(false);
  });

  it("memoises the first answer for the page's life, ignoring later environment changes", () => {
    stubEnv({ userAgent: iphone.userAgent, coarse: true, width: 390, height: 844 });
    expect(isPhoneClient()).toBe(true);
    // The environment now describes a desktop, but the memoised answer holds.
    stubEnv({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/140", coarse: false, width: 1440, height: 900 });
    expect(isPhoneClient()).toBe(true);
  });
});
