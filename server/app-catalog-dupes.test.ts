// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One card per real app: the vendor lists some apps under two slugs with the
// same name and description, and the marketplace must not show two cards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import {
  catalogApp, catalogPage, collapseDuplicates, knownApps, resetAppCatalogState, searchCatalog, setConnectedSlugsSource, type CatalogBackend,
} from "./app-catalog.ts";
import { catalogBackend, listToolkits, setManagedBrokerAccess } from "./composio.ts";
import { fakeCatalogApps, fakeCatalogBroker, type FakeApp } from "./app-catalog.fixture.ts";

const managed = (): AppConfig => ({});
const backend = () => catalogBackend(managed()) as CatalogBackend;
const WORDS = "Trade on prediction markets";

function twin(slug: string, blurb = WORDS): FakeApp {
  return { slug, name: "Market Twin US", blurb, logo: `https://logos.example.test/${slug}.png`, noAuth: false, managed: false, rank: 0 };
}

function useTwins(second = twin("market_twin_us")) {
  const apps = fakeCatalogApps();
  apps.splice(2, 0, twin("market_twin"), second);
  vi.stubGlobal("fetch", fakeCatalogBroker(apps).fetch);
  setManagedBrokerAccess({ url: "https://broker.example.test", token: "a".repeat(64) });
}

async function allPages(): Promise<string[]> {
  const slugs: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await catalogPage(backend(), { cursor });
    slugs.push(...page.items.map((item) => item.slug));
    cursor = page.nextCursor;
  } while (cursor);
  return slugs;
}

beforeEach(() => {
  resetAppCatalogState({ disk: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setConnectedSlugsSource(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setManagedBrokerAccess(null);
  resetAppCatalogState({ disk: true });
});

describe("two toolkits with the same name and description are one card", () => {
  it("search shows one, the slug that matches the name", async () => {
    useTwins();
    const found = await searchCatalog(backend(), "market twin");
    expect(found.items.map((item) => item.slug)).toEqual(["market_twin_us"]);
    expect(found.total).toBe(1);
  });

  it("featured first paint shows one", async () => {
    useTwins();
    const view = await listToolkits(managed());
    expect(view.featured.filter((card) => card.label === "Market Twin US").map((card) => card.slug)).toEqual(["market_twin_us"]);
  });

  it("All apps shows one, from the held copy and from the service's own paging", async () => {
    useTwins();
    await listToolkits(managed());
    expect((await catalogPage(backend())).source).toBe("local");
    expect((await allPages()).filter((slug) => slug.startsWith("market_twin"))).toEqual(["market_twin_us"]);
    resetAppCatalogState({ disk: true });
    useTwins();
    const first = await catalogPage(backend(), { limit: 200 });
    expect(first.source).toBe("service");
    expect(first.items.filter((item) => item.slug.startsWith("market_twin")).map((item) => item.slug)).toEqual(["market_twin_us"]);
  });

  it("falls to the lowest slug when no slug matches the name", () => {
    const apps = [
      { slug: "zeta_two", label: "Zeta", blurb: "Same words" },
      { slug: "alpha_one", label: "Zeta", blurb: "same   WORDS" },
    ];
    expect(collapseDuplicates(apps).map((app) => app.slug)).toEqual(["alpha_one"]);
  });
});

describe("a connection is never hidden", () => {
  it("the connected slug wins the card, in search, featured and All apps", async () => {
    useTwins();
    setConnectedSlugsSource(() => new Set(["market_twin"]));
    expect((await searchCatalog(backend(), "market twin")).items.map((item) => item.slug)).toEqual(["market_twin"]);
    const view = await listToolkits(managed());
    expect(view.featured.filter((card) => card.label === "Market Twin US").map((card) => card.slug)).toEqual(["market_twin"]);
    expect((await allPages()).filter((slug) => slug.startsWith("market_twin"))).toEqual(["market_twin"]);
  });

  it("both connected: both stay", async () => {
    useTwins();
    setConnectedSlugsSource(() => new Set(["market_twin", "market_twin_us"]));
    expect((await searchCatalog(backend(), "market twin")).items.map((item) => item.slug).sort()).toEqual(["market_twin", "market_twin_us"]);
  });
});

describe("different apps stay different", () => {
  it("different descriptions stay two cards", async () => {
    useTwins(twin("market_twin_us", "Something else entirely"));
    expect((await searchCatalog(backend(), "market twin")).items.map((item) => item.slug).sort()).toEqual(["market_twin", "market_twin_us"]);
    expect((await allPages()).filter((slug) => slug.startsWith("market_twin")).sort()).toEqual(["market_twin", "market_twin_us"]);
  });

  it("two cards with no description are not assumed to be the same app", () => {
    const apps = [{ slug: "a", label: "Same", blurb: "" }, { slug: "b", label: "Same", blurb: "" }];
    expect(collapseDuplicates(apps)).toHaveLength(2);
  });
});

describe("looking an app up by slug is unchanged", () => {
  it("both slugs still resolve, from the held copy and for the Connected tab", async () => {
    useTwins();
    await listToolkits(managed());
    expect((await catalogApp(backend(), "market_twin")).slug).toBe("market_twin");
    expect((await catalogApp(backend(), "market_twin_us")).slug).toBe("market_twin_us");
    expect(Object.keys(knownApps(backend(), ["market_twin", "market_twin_us"])).sort()).toEqual(["market_twin", "market_twin_us"]);
    expect(knownApps(backend(), ["market_twin"]).market_twin).toMatchObject({ label: "Market Twin US" });
  });
});

// 1.0.21 polish (Sean's live 1.0.20 walk): the vendor's old "twitter" toolkit, with an encyclopedia description, sat
// beside the curated "X (Twitter)" card. A renamed app is one card; the slug the person knows wins.
describe("a renamed app listed under its old slug is one card", () => {
  const ENCYCLOPEDIA = "Twitter, Inc. was an American social media company based in San Francisco, California, which operated";
  function useRenamed() {
    const apps = fakeCatalogApps();
    apps.splice(1, 0, { slug: "twitter", name: "Twitter", blurb: ENCYCLOPEDIA, logo: "https://logos.example.test/twitter.png", noAuth: false, managed: true, rank: 1 });
    vi.stubGlobal("fetch", fakeCatalogBroker(apps).fetch);
    setManagedBrokerAccess({ url: "https://broker.example.test", token: "a".repeat(64) });
  }
  it("featured first paint shows X (Twitter) once and no Twitter, Inc. card", async () => {
    useRenamed();
    const view = await listToolkits(managed());
    const slugs = view.featured.map((card) => card.slug);
    expect(slugs).toContain("x");
    expect(slugs).not.toContain("twitter");
    expect(view.featured.some((card) => card.blurb.startsWith("Twitter, Inc."))).toBe(false);
  });
  it("collapses the pair everywhere, and keeps the old slug only when the person is connected on it", () => {
    const pair = [
      { slug: "twitter", label: "Twitter", blurb: ENCYCLOPEDIA },
      { slug: "x", label: "X (Twitter)", blurb: "Post and read on X" },
    ];
    expect(collapseDuplicates(pair).map((card) => card.slug)).toEqual(["x"]);
    expect(collapseDuplicates(pair, new Set(["twitter"])).map((card) => card.slug)).toEqual(["twitter"]);
    expect(collapseDuplicates(pair, null).map((card) => card.slug)).toEqual(["twitter", "x"]);
  });
});
