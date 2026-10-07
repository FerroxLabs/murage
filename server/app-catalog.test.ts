// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The whole connected-apps catalog (0.1.61 L17), against a fake broker with
// 1,600 apps that speaks the catalog contract, and against today's broker,
// which only passes the vendor's raw pages through.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import { DATA_DIR } from "./config.ts";
import {
  APP_CATALOG_CACHE_FILE, CATALOG_FRESH_MS, cachedCatalog, catalogApp, catalogPage, CURATED_SLUGS, knownApps,
  loadCatalog, resetAppCatalogState, searchCatalog, type CatalogBackend,
} from "./app-catalog.ts";
import { catalogBackend, listToolkits, setManagedBrokerAccess } from "./composio.ts";
import { fakeCatalogApps, fakeCatalogBroker, OWNER_INVENTORY_SLUGS, type FakeBroker } from "./app-catalog.fixture.ts";

const BROKER = "https://broker.example.test";
const managed = (): AppConfig => ({});
let broker: FakeBroker;
let warn: ReturnType<typeof vi.spyOn>;

function useBroker(fake: FakeBroker, token = "a".repeat(64)) {
  broker = fake;
  vi.stubGlobal("fetch", fake.fetch);
  setManagedBrokerAccess({ url: BROKER, token });
}
const backend = () => catalogBackend(managed()) as CatalogBackend;
const logged = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

beforeEach(() => {
  resetAppCatalogState({ disk: true });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setManagedBrokerAccess(null);
  resetAppCatalogState({ disk: true });
});

describe("Part A: every fallback says why, and is logged", () => {
  it("no backend at all", async () => {
    const view = await listToolkits({});
    expect(view).toMatchObject({ source: "curated", reason: "no-backend" });
    expect(view.featured.map(card => card.slug)).toEqual(CURATED_SLUGS);
    expect(logged()).toContainEqual(expect.stringContaining("(no-backend)"));
  });

  it.each([
    [502, "http"], [503, "http"], [401, "auth"], [403, "auth"], [429, "rate-limited"],
  ])("a broker answering %i falls back with reason %s", async (status, reason) => {
    useBroker(fakeCatalogBroker(undefined, { status }));
    const view = await listToolkits(managed());
    expect(view).toMatchObject({ source: "curated", reason });
    expect(logged()).toContainEqual(expect.stringMatching(new RegExp(`\\(${reason}\\).*HTTP ${status}`)));
    // never upstream text
    expect(JSON.stringify(view)).not.toContain("fixture failure");
  });

  it("a network failure on the first page", async () => {
    useBroker(fakeCatalogBroker(undefined, { failOnPage: 1 }));
    expect(await listToolkits(managed())).toMatchObject({ source: "curated", reason: "network" });
    expect(logged()).toContainEqual(expect.stringContaining("(network)"));
  });

  it("a walk that stops part way, with how much arrived", async () => {
    useBroker(fakeCatalogBroker(undefined, { failOnPage: 3 }));
    const view = await listToolkits(managed());
    expect(view).toMatchObject({ source: "curated", reason: "incomplete", detail: { loaded: 1_000, total: 1_600 } });
    expect(logged()).toContainEqual(expect.stringContaining("(incomplete) after 1,000 of 1,600 apps"));
    // a partial catalog is never kept
    expect(cachedCatalog(backend())).toBeNull();
  });

  it("the whole-walk budget running out (a timeout)", async () => {
    useBroker(fakeCatalogBroker(undefined, { hang: true }));
    const view = await listToolkits(managed(), { signal: AbortSignal.timeout(50) });
    expect(view).toMatchObject({ source: "curated", reason: "timeout" });
    expect(logged()).toContainEqual(expect.stringContaining("(timeout)"));
  });

  it("an answer that is not a catalog", async () => {
    useBroker({ calls: [], options: {}, fetch: async () => new Response("<html>gateway</html>", { status: 200 }) } as FakeBroker);
    expect(await listToolkits(managed())).toMatchObject({ source: "curated", reason: "network" });
    useBroker({ calls: [], options: {}, fetch: async () => Response.json({ nothing: true }) } as FakeBroker);
    resetAppCatalogState();
    expect(await listToolkits(managed())).toMatchObject({ source: "curated", reason: "bad-response" });
  });

  it("the backend changing identity mid-walk", async () => {
    const fake = fakeCatalogBroker();
    useBroker({ ...fake, fetch: async (input, init) => {
      const answer = await fake.fetch(input, init);
      setManagedBrokerAccess({ url: BROKER, token: "b".repeat(64) });
      return answer;
    } });
    expect(await listToolkits(managed())).toMatchObject({ source: "curated", reason: "identity" });
    expect(logged()).toContainEqual(expect.stringContaining("(identity)"));
  });

  it("a first paint that cannot wait for the walk says it is still loading", async () => {
    useBroker(fakeCatalogBroker(undefined, { hang: true }));
    const view = await listToolkits(managed(), { waitMs: 20 });
    expect(view).toMatchObject({ source: "curated", reason: "loading", revalidating: true });
  });

  it("serves the last complete catalog, with the reason, when a Retry fails", async () => {
    useBroker(fakeCatalogBroker());
    expect((await listToolkits(managed())).source).toBe("api");
    broker.options.status = 502;
    const retried = await listToolkits(managed(), { force: true });
    expect(retried).toMatchObject({ source: "cache", reason: "http", total: 1_600 });
    expect(retried.cards).toHaveLength(1_600);
  });
});

describe("Part D: the whole catalog against a fake 1,600-app broker (contract 2)", () => {
  it("walks it in pages of 500, keeps it on disk, and never lists the service itself", async () => {
    useBroker(fakeCatalogBroker());
    const view = await listToolkits(managed());
    expect(view).toMatchObject({ source: "api", total: 1_600, serviceSearch: true });
    expect(view.cards).toHaveLength(1_600);
    expect(view.cards.some(card => /composio/i.test(card.slug))).toBe(false);
    expect(broker.calls.map(url => url.searchParams.get("limit"))).toEqual(["500", "500", "500", "500"]);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, APP_CATALOG_CACHE_FILE), "utf8"));
    expect(disk.apps).toHaveLength(1_600);
    expect(JSON.stringify(disk)).not.toContain("a".repeat(64));
    // featured: the most used, then the rest of the curated set
    expect(view.featured.slice(0, 3).map(card => card.slug)).toEqual(["gmail", "slack", "github"]);
    expect(view.featured.map(card => card.slug)).toEqual(expect.arrayContaining(CURATED_SLUGS));
    expect(view.featured.find(card => card.slug === "gmail")?.logo).toBe("https://logos.example.test/gmail.png");
  });

  it("pages All apps A to Z from the held catalog, 200 at a time, every app exactly once", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    const calls = broker.calls.length;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await catalogPage(backend(), { cursor, limit: 200 });
      expect(page).toMatchObject({ source: "local", total: 1_600 });
      seen.push(...page.items.map(item => item.slug));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(8);
    expect(new Set(seen).size).toBe(1_600);
    expect(broker.calls.length).toBe(calls);
    const labels = seen.slice(0, 5);
    expect(labels[0]).toBe("airtable");
  });

  it("pages from the service itself before anything is held", async () => {
    useBroker(fakeCatalogBroker());
    const first = await catalogPage(backend(), { limit: 100 });
    expect(first).toMatchObject({ source: "service", total: 1_600 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^s:/);
    expect(broker.calls[0].searchParams.get("sort")).toBe("name");
    const second = await catalogPage(backend(), { cursor: first.nextCursor, limit: 100 });
    expect(second.items[0].slug).not.toBe(first.items[0].slug);
  });

  it("searches the service as you type, reaching the long tail", async () => {
    useBroker(fakeCatalogBroker());
    const calendly = await searchCatalog(backend(), "calendly");
    expect(calendly).toMatchObject({ source: "service", total: 1 });
    expect(calendly.items[0]).toMatchObject({ slug: "calendly", label: "Calendly", signIn: "managed" });
    const tail = await searchCatalog(backend(), "tail app 1599");
    expect(tail.items.map(item => item.slug)).toEqual(["tail_app_1599"]);
    expect(broker.calls.at(-1)?.searchParams.get("search")).toBe("tail app 1599");
    const supabase = await searchCatalog(backend(), "Supabase");
    expect(supabase.items[0]).toMatchObject({ slug: "supabase", signIn: "own" });
  });

  it("falls back to searching what is held when the service cannot answer", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    broker.options.status = 503;
    const result = await searchCatalog(backend(), "freshdesk");
    expect(result).toMatchObject({ source: "local", reason: "http" });
    expect(result.items[0].slug).toBe("freshdesk");
  });

  it("finds one app's card for a connect card without walking the catalog", async () => {
    useBroker(fakeCatalogBroker());
    const card = await catalogApp(backend(), "tail_app_1200");
    expect(card).toMatchObject({ slug: "tail_app_1200", label: "Tail app 1200", signIn: "own" });
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0].searchParams.get("search")).toBe("tail_app_1200");
    // an app nobody knows is a monogram, never a failure
    expect(await catalogApp(backend(), "nowhere_app")).toMatchObject({ slug: "nowhere_app", label: "Nowhere App", logo: null });
  });
});

describe("degrading cleanly to today's broker (raw pages, no contract)", () => {
  it("walks the raw pages and serves the same 1,600 apps", async () => {
    useBroker(fakeCatalogBroker(undefined, { contract: 1 }));
    const view = await listToolkits(managed());
    expect(view).toMatchObject({ source: "api", total: 1_600, serviceSearch: false });
    expect(view.cards).toHaveLength(1_600);
    expect(view.cards.find(card => card.slug === "stripe_mcp")).toMatchObject({ label: "Stripe MCP", signIn: "own" });
  });

  it("searches on this computer once it sees the broker ignored the search", async () => {
    useBroker(fakeCatalogBroker(undefined, { contract: 1 }));
    await listToolkits(managed());
    const before = broker.calls.length;
    const first = await searchCatalog(backend(), "calendly");
    expect(first.items.map(item => item.slug)).toEqual(["calendly"]);
    expect(first.source).toBe("local");
    expect(first.reason).toBeUndefined();
    await searchCatalog(backend(), "supabase");
    // the walk already learned the broker is old: no search request at all
    expect(broker.calls.length).toBe(before);
  });

  it("pages All apps locally", async () => {
    useBroker(fakeCatalogBroker(undefined, { contract: 1 }));
    await listToolkits(managed());
    const page = await catalogPage(backend(), { limit: 50 });
    expect(page).toMatchObject({ source: "local", total: 1_600 });
  });

  it("learns from one ignored search that the broker is old, before any walk", async () => {
    useBroker(fakeCatalogBroker(undefined, { contract: 1 }));
    await searchCatalog(backend(), "calendly");
    const searches = () => broker.calls.filter(url => url.searchParams.has("search")).length;
    expect(searches()).toBe(1);
    await searchCatalog(backend(), "supabase");
    expect(searches()).toBe(1);
  });

  it("says it is still loading while nothing is held, and starts the walk", async () => {
    useBroker(fakeCatalogBroker(undefined, { contract: 1 }));
    const search = await searchCatalog(backend(), "calendly");
    expect(search).toMatchObject({ source: "curated", reason: "loading" });
    await vi.waitFor(() => expect(cachedCatalog(backend())).not.toBeNull());
  });
});

describe("the disk cache: first paint, stale while it revalidates", () => {
  it("paints from disk in under a second while the broker hangs", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    // A later launch: nothing in memory, the copy on disk is a day old, and
    // the broker never answers.
    const file = join(DATA_DIR, APP_CATALOG_CACHE_FILE);
    const disk = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...disk, savedAt: Date.now() - CATALOG_FRESH_MS - 60_000 }));
    resetAppCatalogState();
    broker.options.hang = true;
    const started = performance.now();
    const cached = cachedCatalog(backend());
    const view = await loadCatalog(backend(), { waitMs: 8_000 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(cached).toMatchObject({ source: "cache", total: 1_600, revalidating: true });
    expect(view).toMatchObject({ source: "cache", total: 1_600, revalidating: true });
    expect(view.featured.length).toBeGreaterThanOrEqual(24);
  });

  it("serves a fresh copy without asking the broker again", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    resetAppCatalogState();
    const before = broker.calls.length;
    expect(await listToolkits(managed())).toMatchObject({ source: "api", total: 1_600 });
    expect(broker.calls.length).toBe(before);
  });

  it("checks again under a new broker token, serving the old copy meanwhile", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    setManagedBrokerAccess({ url: BROKER, token: "c".repeat(64) });
    const view = await loadCatalog(backend(), { waitMs: 0 });
    expect(view).toMatchObject({ source: "cache", revalidating: true });
  });

  it("ignores a damaged cache file", async () => {
    writeFileSync(join(DATA_DIR, APP_CATALOG_CACHE_FILE), "{not json");
    useBroker(fakeCatalogBroker());
    expect(cachedCatalog(backend())).toBeNull();
    expect((await listToolkits(managed())).source).toBe("api");
  });
});

describe("Part B: a card for every connection", () => {
  it("describes all 13 of the owner's connections, six outside the curated 24", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    const cards = knownApps(backend(), [...OWNER_INVENTORY_SLUGS]);
    expect(Object.keys(cards)).toHaveLength(13);
    const outside = OWNER_INVENTORY_SLUGS.filter(slug => !CURATED_SLUGS.includes(slug));
    expect(outside).toEqual(["googlesuper", "stripe_mcp", "supabase", "calendly", "slackbot", "freshdesk"]);
    for (const slug of outside) expect(cards[slug].label).not.toBe("");
    expect(cards.calendly.label).toBe("Calendly");
  });

  it("falls back to a monogram with nothing held, and never names the service", () => {
    const cards = knownApps(null, ["googlesuper", "gmail", "composio"]);
    expect(cards.googlesuper).toMatchObject({ label: "Googlesuper", logo: null });
    expect(cards.gmail.label).toBe("Gmail");
    expect(cards.composio).toBeUndefined();
  });
});

describe("a fake 1,600-app catalog", () => {
  it("is 1,600 apps plus the service's own toolkit", () => {
    const apps = fakeCatalogApps();
    expect(apps).toHaveLength(1_601);
    expect(apps.filter(app => !/composio/i.test(app.slug))).toHaveLength(1_600);
  });
});

// Cross-audit round 1 (gpt-6-astra, 2026-09-27): each finding reproduced
// here first, then fixed.
describe("audit round 1", () => {
  it("A1: paints the disk copy on a cold launch, before the Flux broker's readiness is known", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    const cacheKey = backend().cacheKey;
    resetAppCatalogState();
    setManagedBrokerAccess(null);
    // The same broker named, its health not probed yet: no active backend.
    const { applyManagedBrokerMessage, catalogCacheTarget } = await import("./composio.ts");
    applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: BROKER, fluxAccess: { url: BROKER, token: "f".repeat(64) } });
    expect(catalogBackend(managed())).toBeNull();
    const target = catalogCacheTarget(managed());
    expect(target?.cacheKey).toBe(cacheKey);
    expect(cachedCatalog(target)).toMatchObject({ source: "cache", total: 1_600 });
  });

  it("A4: a failed background check reaches the panel with its reason and Retry, and is not retried on every open", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    const file = join(DATA_DIR, APP_CATALOG_CACHE_FILE);
    const disk = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...disk, savedAt: Date.now() - CATALOG_FRESH_MS - 60_000 }));
    resetAppCatalogState();
    broker.options.status = 502;
    expect(await listToolkits(managed(), { waitMs: 8_000 })).toMatchObject({ source: "cache", revalidating: true });
    await vi.waitFor(async () => expect(await listToolkits(managed(), { waitMs: 8_000 })).toMatchObject({ source: "cache", reason: "http", revalidating: false }));
    const calls = broker.calls.length;
    await listToolkits(managed(), { waitMs: 8_000 });
    expect(broker.calls.length).toBe(calls);
  });

  it("A6: a broker serving its previous list is kept, not called current, and asked again soon", async () => {
    const fake = fakeCatalogBroker();
    useBroker({ ...fake, fetch: async (input, init) => {
      const answer = await fake.fetch(input, init);
      return Response.json({ ...(await answer.json() as Record<string, unknown>), stale: true });
    } });
    const view = await listToolkits(managed());
    expect(view).toMatchObject({ source: "cache", total: 1_600 });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, APP_CATALOG_CACHE_FILE), "utf8"));
    expect(Date.now() - disk.savedAt).toBeGreaterThan(CATALOG_FRESH_MS - 16 * 60_000);
  });

  it("A7: a connect card on today's broker still learns an app needs its own sign-in details", async () => {
    useBroker(fakeCatalogBroker(undefined, { contract: 1 }));
    expect(await catalogApp(backend(), "supabase")).toMatchObject({ label: "Supabase", signIn: "own" });
  });

  it("A9: an app's own description obeys the copy rules", async () => {
    const { slimApp } = await import("./app-catalog.ts");
    expect(slimApp({ slug: "a", name: "A", meta: { description: "Automate work — fast" } })?.blurb).toBe("Automate work, fast");
    expect(slimApp({ slug: "b", name: "B", meta: { description: "Safe automation" } })?.blurb).toBe("");
    expect(slimApp({ slug: "c", name: "C", meta: { description: "Compare price plans" } })?.blurb).toBe("");
    expect(slimApp({ slug: "d", name: "D — Pro" })?.label).toBe("D - Pro");
  });
});

// Cross-audit round 1 (Kimi, 2026-09-27).
describe("audit round 1, second auditor", () => {
  it("K2: a service page failing mid-scroll carries on from the held copy", async () => {
    useBroker(fakeCatalogBroker());
    const first = await catalogPage(backend(), { limit: 100 });
    expect(first.source).toBe("service");
    await listToolkits(managed());
    broker.options.status = 503;
    const next = await catalogPage(backend(), { cursor: first.nextCursor, limit: 100 });
    expect(next).toMatchObject({ source: "local", total: 1_600, nextCursor: "o:100" });
  });

  it("K3: an odd answer does not mark the broker old; a raw page does, and only for a while", async () => {
    const fake = fakeCatalogBroker();
    let odd = true;
    useBroker({ ...fake, fetch: async (input, init) => odd ? Response.json({ error: "proxy page" }) : fake.fetch(input, init) });
    expect((await searchCatalog(backend(), "calendly")).source).not.toBe("service");
    odd = false;
    expect((await searchCatalog(backend(), "calendly")).source).toBe("service");
    broker.options.contract = 1;
    await searchCatalog(backend(), "calendly");
    broker.options.contract = 2;
    expect((await searchCatalog(backend(), "calendly")).source).not.toBe("service");
    vi.useFakeTimers({ now: Date.now() + 31 * 60_000, toFake: ["Date"] });
    try {
      expect((await searchCatalog(backend(), "calendly")).source).toBe("service");
    } finally {
      vi.useRealTimers();
    }
  });

  it("K4: a disk copy for another catalog is read once, not on every call", async () => {
    useBroker(fakeCatalogBroker());
    await listToolkits(managed());
    const fs = await import("node:fs");
    resetAppCatalogState();
    const other = { cacheKey: "another-catalog", identity: "x" };
    const spy = vi.spyOn(JSON, "parse");
    cachedCatalog(other);
    const parses = spy.mock.calls.length;
    cachedCatalog(other);
    cachedCatalog(other);
    expect(spy.mock.calls.length).toBe(parses);
    void fs;
  });

  it("K5: one catalog's newer refresh never discards another catalog's walk", async () => {
    const a = fakeCatalogBroker(fakeCatalogApps(600));
    const b = fakeCatalogBroker(fakeCatalogApps(700), { contract: 1 });
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => (String(input).includes("broker-b") ? b : a).fetch(input, init));
    const make = (name: string): CatalogBackend => ({
      kind: "broker", identity: name, cacheKey: name, current: () => name,
      request: (query, signal) => fetch(`https://${name}.example.test/v1/catalog?${query}`, { signal }),
    });
    const first = loadCatalog(make("broker-a"));
    const second = loadCatalog(make("broker-b"));
    const [one, two] = await Promise.all([first, second]);
    expect(one.total).toBe(600);
    expect(two.total).toBe(700);
    expect(cachedCatalog({ cacheKey: "broker-b", identity: "broker-b" })?.total).toBe(700);
    // the older walk, for another catalog, was kept too
    expect(cachedCatalog({ cacheKey: "broker-a", identity: "broker-a" })?.total).toBe(600);
  });

  it("K6: a connect card for a failing broker is logged and does not wait on a walk", async () => {
    useBroker(fakeCatalogBroker(undefined, { status: 503 }));
    const started = performance.now();
    expect(await catalogApp(backend(), "tail_app_0999")).toMatchObject({ slug: "tail_app_0999", logo: null });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(logged()).toContainEqual(expect.stringContaining("(http) while describing tail_app_0999"));
  });

  it("K9: a slug named like an object key is kept", () => {
    expect(Object.keys(knownApps(null, ["__proto__", "gmail"]))).toEqual(["__proto__", "gmail"]);
  });
});
