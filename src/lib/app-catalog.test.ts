// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { appCountLabel, appsClaimFor, catalogNotice, catalogSections, connectedCards, inCategory, rankCategories, type AppCard, type CatalogFallbackReason } from "./app-catalog";

describe("the live app count", () => {
  it("rounds down so the claim stays true", () => {
    expect(appCountLabel(1_600)).toBe("1,600+ apps");
    expect(appCountLabel(1_634)).toBe("1,600+ apps");
    expect(appCountLabel(1_599)).toBe("1,500+ apps");
    expect(appCountLabel(42)).toBe("42 apps");
    expect(appCountLabel(null)).toBeNull();
    expect(appCountLabel(0)).toBeNull();
  });
  it("uses the standing claim until the service reports a count", () => {
    expect(appsClaimFor(null, "500+ apps, including Gmail")).toBe("500+ apps, including Gmail");
    expect(appsClaimFor(1_523, "x")).toBe("1,500+ apps, including Gmail, Slack, Notion and GitHub");
  });
});

describe("every catalog fallback says why and offers Retry (Part A)", () => {
  const reasons: CatalogFallbackReason[] = ["no-backend", "timeout", "cancelled", "network", "http", "auth", "rate-limited", "bad-response", "incomplete", "identity"];
  it.each(reasons)("%s", (reason) => {
    const notice = catalogNotice({ source: "curated", reason });
    expect(notice).toMatchObject({ tone: "warning", retry: true });
    expect(notice!.text).toMatch(/^Showing featured apps only\. \S/);
    expect(notice!.text).not.toMatch(/composio|—/i);
  });
  it("says how much arrived when the list stopped part way", () => {
    expect(catalogNotice({ source: "curated", reason: "incomplete", detail: { loaded: 1_000, total: 1_600 } })!.text)
      .toBe("Showing featured apps only. The full list stopped loading after 1,000 of 1,600 apps.");
  });
  it("names a saved copy served because a check failed", () => {
    expect(catalogNotice({ source: "cache", reason: "http" })).toMatchObject({ retry: true, text: expect.stringMatching(/^Showing the app list saved earlier\./) });
  });
  it("is quiet for a complete catalog, and plain while still loading", () => {
    expect(catalogNotice({ source: "api" })).toBeNull();
    expect(catalogNotice({ source: "cache" })).toBeNull();
    expect(catalogNotice({ source: "curated", reason: "loading" })).toMatchObject({ tone: "muted", retry: false });
  });
});

describe("the Connected tab is built from the inventory (Part B)", () => {
  it("shows every connection, with a monogram for an app no list carries", () => {
    const status = {
      gmail: { connected: true },
      googlesuper: { connected: true, accounts: [{}] },
      freshdesk: { connected: false, accounts: [{}] },
      notion: { connected: false },
      composio_search: { connected: true },
    };
    const cards = connectedCards(status, [[{ slug: "gmail", label: "Gmail", blurb: "", logo: null, domain: null }], null]);
    expect(cards.map(card => card.slug)).toEqual(["freshdesk", "gmail", "googlesuper"]);
    expect(cards.find(card => card.slug === "googlesuper")).toMatchObject({ label: "Googlesuper", logo: null });
  });
});

describe("audit round 1: the Browse all count keeps its thousands", () => {
  it("is the whole number", () => {
    expect(appCountLabel(1_634)).toBe("1,600+ apps");
  });
});

describe("connected apps grouped by category (item 152)", () => {
  const app = (slug: string, categories?: string[]): AppCard => ({ slug, label: slug, blurb: "", logo: null, domain: null, ...(categories ? { categories } : {}) });
  const apps = [
    app("slack", ["Communication"]), app("gmail", ["Communication", "Email"]), app("discord", ["Communication"]),
    app("github", ["Developer tools"]), app("linear", ["Developer tools", "Project management"]),
    app("notion", ["Productivity"]), app("none"),
  ];

  it("ranks groups by app count, ties alphabetical, with the rest under More", () => {
    expect(rankCategories(apps, 2)).toEqual({ inline: ["Communication", "Developer tools"], more: ["Email", "Productivity", "Project management"] });
    expect(rankCategories(apps)).toEqual({ inline: ["Communication", "Developer tools", "Email", "Productivity", "Project management"], more: [] });
  });

  it("counts an app once per group and matches groups without case", () => {
    expect(rankCategories([app("a", ["Chat", "chat"])]).inline).toEqual(["Chat"]);
    expect(inCategory(apps[0]!, "communication")).toBe(true);
    expect(inCategory(apps[0]!, "")).toBe(false);
    expect(inCategory(apps[6]!, "Communication")).toBe(false);
  });

  it("puts connected apps first, then busy-group previews without repeating them, then everything", () => {
    const sections = catalogSections(apps, new Set(["slack"]), { previews: 2, perPreview: 2 });
    expect(sections.map((section) => section.id)).toEqual(["connected", "category:Communication", "category:Developer tools", "all"]);
    expect(sections[0]!.apps.map((a) => a.slug)).toEqual(["slack"]);
    expect(sections[1]!.apps.map((a) => a.slug)).toEqual(["gmail", "discord"]);
    expect(sections[3]!.apps).toHaveLength(apps.length);
  });

  it("leaves empty sections out, and is just connected plus everything when the service sends no categories", () => {
    expect(catalogSections([], new Set()).length).toBe(0);
    const plain = [app("a"), app("b")];
    expect(catalogSections(plain, new Set(["a"])).map((section) => section.id)).toEqual(["connected", "all"]);
    expect(catalogSections(plain, new Set()).map((section) => section.id)).toEqual(["all"]);
  });
});
