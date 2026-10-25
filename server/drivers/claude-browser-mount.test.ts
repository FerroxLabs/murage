// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { claudeBrowserMount } from "./claude-browser-mount.ts";

describe("Claude browser mount", () => {
  const browser = Object.freeze({ command: "browser-proxy", args: [], env: {} });

  it.each([undefined, false, true])("sets alwaysLoad only for preload=%s", preloadBrowserTools => {
    const config = claudeBrowserMount({ integrations: { browser }, preloadBrowserTools });
    expect(config).toEqual({ ...browser, ...(preloadBrowserTools ? { alwaysLoad: true } : {}) });
    expect(browser).not.toHaveProperty("alwaysLoad");
    expect(browser).not.toHaveProperty("preloadBrowserTools");
  });

  it("omits alwaysLoad on prewarm even when the remembered turn requested it", () => {
    expect(claudeBrowserMount({ integrations: { browser }, preloadBrowserTools: true, prewarm: true }))
      .toEqual(browser);
  });

  it("does not add a browser mount when absent this turn", () => {
    expect(claudeBrowserMount({ preloadBrowserTools: true })).toBeUndefined();
    expect(claudeBrowserMount({ integrations: {}, preloadBrowserTools: true })).toBeUndefined();
  });
});
