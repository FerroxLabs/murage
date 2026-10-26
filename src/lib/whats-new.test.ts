// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { APP_VERSION, WHATS_NEW_BY_VERSION, changelogUrl, recordWhatsNewSeen, shouldOpenWhatsNew, whatsNewPage, whatsNewTarget } from "./whats-new";
import { SidebarYouMenuPanel } from "@/components/SidebarYouMenuPanel";

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

  it("has a page for 0.1.61", () => {
    expect(whatsNewPage("0.1.61")).toEqual({ kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.61" });
  });

  it("has a page for 1.0.6", () => {
    expect(whatsNewPage("1.0.6")).toEqual({ kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v1.0.6" });
  });

  it("has a page for 1.0.2", () => {
    expect(whatsNewPage("1.0.2")).toEqual({ kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v1.0.2" });
  });
});

describe("what the menu item opens", () => {
  it("opens the version's own page when it has one", () => {
    expect(whatsNewTarget("0.1.61")).toEqual({ kind: "page", version: "0.1.61", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.61" });
    expect(whatsNewTarget("1.0.2")).toMatchObject({ kind: "page", version: "1.0.2" });
  });

  it("opens the newest page of the same major line for a version with none", () => {
    expect(whatsNewTarget("1.0.3")).toMatchObject({ kind: "page", version: "1.0.2" });
    expect(whatsNewTarget("1.0.5")).toMatchObject({ kind: "page", version: "1.0.2" });
    expect(whatsNewTarget("1.0.7")).toMatchObject({ kind: "page", version: "1.0.6" });
    expect(whatsNewTarget("1.1.0")).toMatchObject({ kind: "page", version: "1.0.6" });
    expect(whatsNewTarget("0.1.62")).toMatchObject({ kind: "page", version: "0.1.61" });
  });

  it("opens the docs release notes when the major line has no page yet", () => {
    expect(whatsNewTarget("1.0.1")).toEqual({ kind: "notes", url: "https://docs.murage.ai/docs/changelog/v1-0-1" });
    expect(whatsNewTarget("2.0.0")).toEqual({ kind: "notes", url: "https://docs.murage.ai/docs/changelog/v2-0-0" });
    expect(changelogUrl("1.0.2")).toBe("https://docs.murage.ai/docs/changelog/v1-0-2");
  });

  it("points at a changelog page that exists in the docs", () => {
    for (const version of Object.keys(WHATS_NEW_BY_VERSION).filter((v) => v.startsWith("1."))) {
      const slug = changelogUrl(version).split("/").pop()!;
      expect(() => readFileSync(new URL(`../../apps/docs/content/docs/changelog/${slug}.mdx`, import.meta.url)), slug).not.toThrow();
    }
  });

  it("is in the menu and in Settings for every desktop version, none included", () => {
    expect(sidebar).toContain("...(whatsNew.available ? [{ key: \"whats-new\"");
    const hook = readFileSync(new URL("./whats-new.ts", import.meta.url), "utf8");
    expect(hook).toContain("available: desktop === true }");
    expect(hook).not.toMatch(/available: [^}]*whatsNewPage/);
    const settings = readFileSync(new URL("../components/SettingsModal.tsx", import.meta.url), "utf8");
    expect(settings).toMatch(/function WhatsNewRow\(\) \{[\s\S]*?if \(desktop !== true\) return null;/);
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

  it("never opens by itself for a version with no page, though the menu item is there", async () => {
    const request = vi.fn(async () => ({ show: true }));
    expect(await shouldOpenWhatsNew(true, request, "1.0.1")).toBe(false);
    expect(await shouldOpenWhatsNew(true, request, "1.0.3")).toBe(false);
    await recordWhatsNewSeen(true, request, "1.0.1");
    expect(request).not.toHaveBeenCalled();
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

describe("reopening from the You menu", () => {
  it("offers What's new in the You menu and reopens the page from it", () => {
    expect(sidebar).toContain(`{ key: "whats-new", label: t("settings.about.whatsNewTitle"), icon: <Megaphone size={17} />, onSelect: whatsNew.reopen }`);
    expect(sidebar).toContain("const whatsNew = useWhatsNew(desktop, api);");
    expect(sidebar).toContain(`<WhatsNewHost whatsNew={whatsNew} onNavigate={onNavigate} />`);
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(createElement(SidebarYouMenuPanel, { items: [{ key: "whats-new", label: "What's new", icon: null, onSelect }] }));
    expect(html).toContain('role="menuitem"');
    expect(html).toContain("What&#x27;s new");
  });
});
