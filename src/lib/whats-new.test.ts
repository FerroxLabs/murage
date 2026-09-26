// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { APP_VERSION, WHATS_NEW_BY_VERSION, recordWhatsNewSeen, shouldOpenWhatsNew, whatsNewPage } from "./whats-new";
import { SidebarMoreMenuPanel } from "@/components/SidebarMoreMenu";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const sidebar = readFileSync(new URL("../components/Sidebar.tsx", import.meta.url), "utf8");

describe("what's new pages", () => {
  it("has a page, or an explicit none, for the version being built", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(WHATS_NEW_BY_VERSION[pkg.version], `add "${pkg.version}" to WHATS_NEW_BY_VERSION in src/lib/whats-new.ts, as a page or { kind: "none" }`).toBeDefined();
  });

  it("links every page to its own release notes", () => {
    for (const [version, entry] of Object.entries(WHATS_NEW_BY_VERSION)) {
      if (entry.kind === "page") expect(entry.releaseNotesUrl).toBe(`https://github.com/FerroxLabs/murage-releases/releases/tag/v${version}`);
    }
    expect(whatsNewPage("0.0.1")).toBeNull();
  });

  it("has a page for 0.1.60", () => {
    expect(whatsNewPage("0.1.60")).toEqual({ kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.60" });
  });
});

describe("when the page opens by itself", () => {
  it("asks the server only on the desktop and only for a version with a page", async () => {
    const request = vi.fn(async () => ({ version: "0.1.59", show: true }));
    expect(await shouldOpenWhatsNew(false, request, "0.1.59")).toBe(false);
    expect(await shouldOpenWhatsNew(undefined, request, "0.1.59")).toBe(false);
    expect(await shouldOpenWhatsNew(true, request, "0.0.1")).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(await shouldOpenWhatsNew(true, request, "0.1.59")).toBe(true);
    expect(request).toHaveBeenCalledWith("/api/whats-new?version=0.1.59");
  });

  it("stays shut when the server says seen, or cannot answer", async () => {
    expect(await shouldOpenWhatsNew(true, async () => ({ version: "0.1.59", show: false }), "0.1.59")).toBe(false);
    expect(await shouldOpenWhatsNew(true, async () => { throw new Error("offline"); }, "0.1.59")).toBe(false);
    expect(await shouldOpenWhatsNew(true, async () => null, "0.1.59")).toBe(false);
  });

  it("records the version as seen when the page closes", async () => {
    const request = vi.fn(async () => ({}));
    await recordWhatsNewSeen(true, request, "0.1.59");
    expect(request).toHaveBeenCalledWith("/api/whats-new/seen", { method: "POST", body: JSON.stringify({ version: "0.1.59" }) });
    await recordWhatsNewSeen(false, request, "0.1.59");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(recordWhatsNewSeen(true, async () => { throw new Error("offline"); }, "0.1.59")).resolves.toBeUndefined();
  });
});

describe("reopening from Tools", () => {
  it("offers What's new in the Tools menu and reopens the page from it", () => {
    expect(sidebar).toContain(`{ key: "whats-new", label: "What's new", icon: <Megaphone size={18} />, onSelect: whatsNew.reopen }`);
    expect(sidebar).toContain("const whatsNew = useWhatsNew(desktop, api);");
    expect(sidebar).toContain(`<WhatsNewHost whatsNew={whatsNew} onNavigate={onNavigate} />`);
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(createElement(SidebarMoreMenuPanel, { items: [{ key: "whats-new", label: "What's new", icon: null, onSelect }] }));
    expect(html).toContain('role="menuitem"');
    expect(html).toContain("What&#x27;s new");
  });
});
