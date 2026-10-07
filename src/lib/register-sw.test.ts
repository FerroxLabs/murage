// Inside the phone app a service worker does harm: public/sw.js answers a
// failed navigation with its cached shell, so an Android WebView would show
// yesterday's page instead of the app's can't-reach screen. WKWebView does
// not run one for this origin at all. So the app gets none, and any worker an
// older build left behind is removed.
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker, shouldRegisterServiceWorker } from "./register-sw";

afterEach(() => vi.unstubAllGlobals());

const base = { supported: true, secure: true, desktop: false, dev: false, native: false };

describe("whether to register the worker", () => {
  it("registers in a phone or desktop browser", () => {
    expect(shouldRegisterServiceWorker(base)).toBe(true);
  });

  it("never inside the phone app", () => {
    expect(shouldRegisterServiceWorker({ ...base, native: true })).toBe(false);
  });

  it("keeps the existing exclusions", () => {
    expect(shouldRegisterServiceWorker({ ...base, desktop: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, dev: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, secure: false })).toBe(false);
  });
});

describe("inside the phone app", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("removes a worker an older build registered, and registers nothing", async () => {
    // vitest's DEV mode already blocks registration on its own, which would
    // let this test pass without the native check ever running. Force
    // production mode so this really exercises that path (preflight R5/P6-a).
    vi.stubEnv("DEV", false);
    const unregister = vi.fn(async () => true);
    const register = vi.fn();
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) MurageApp/1.0.0 (android)",
      serviceWorker: { getRegistrations: async () => [{ unregister }], register },
    });
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { isSecureContext: true, addEventListener });
    registerServiceWorker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unregister).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
