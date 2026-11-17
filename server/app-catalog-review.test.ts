// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Catalog producer and renderer consumer owner: catalog-dupes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogApp, catalogPage, knownApps, loadCatalog, resetAppCatalogState, searchCatalog, setConnectedSlugsSource, slimApp, type CatalogBackend } from "./app-catalog.ts";
import { rememberedConnectedSlugs } from "./composio.ts";
import { collapseCatalogCards as collapseDuplicateCards } from "../shared/catalog-card-identity.ts";

type Raw = { slug: string; name: string; description: string; active?: boolean; tools_count?: number };
const twin = (slug: string, description = "Trade on prediction markets"): Raw => ({ slug, name: "Market Twin US", description });
function fixture(apps: Raw[], pageSize = 500): CatalogBackend {
  return {
    kind: "broker", cacheKey: "review-fixture", identity: "review-identity", current: () => "review-identity",
    request: vi.fn(async (query: URLSearchParams) => {
      const q = query.get("search")?.toLowerCase() ?? "";
      const pool = apps.filter(app => `${app.name} ${app.slug} ${app.description}`.toLowerCase().includes(q));
      if (query.get("sort") === "name") pool.sort((a, b) => a.name.localeCompare(b.name));
      const offset = Number(query.get("cursor") ?? 0);
      const limit = Math.min(pageSize, Number(query.get("limit") ?? 500));
      return Response.json({ contract: 2, items: pool.slice(offset, offset + limit), total_items: pool.length,
        next_cursor: offset + limit < pool.length ? String(offset + limit) : null });
    }),
  };
}
const slugs = (apps: { slug: string }[]) => apps.map(app => app.slug).sort();
const twinsOnly = <T extends { slug: string }>(apps: T[]) => apps.filter(app => app.slug.startsWith("market_twin"));
beforeEach(() => { resetAppCatalogState({ disk: true }); setConnectedSlugsSource(() => new Set()); });
afterEach(() => { resetAppCatalogState({ disk: true }); setConnectedSlugsSource(null); vi.restoreAllMocks(); });

describe("catalog review regressions", () => {
  it("H1 real inventory source distinguishes unknown from checked empty", () => {
    expect(rememberedConnectedSlugs({})).toBeNull();
  });

  it.each([{ connected: ["market_twin"] }, { connected: ["market_twin", "market_twin_us"] }])("H1 delayed inventory preserves candidates for $connected without another catalog request", async ({ connected }) => {
    const backend = fixture([twin("market_twin"), twin("market_twin_us")]);
    let inventory: ReadonlySet<string> | null = rememberedConnectedSlugs({});
    setConnectedSlugsSource(() => inventory);
    const search = await searchCatalog(backend, "market twin");
    const page = await catalogPage(backend);
    const view = await loadCatalog(backend);
    for (const candidates of [search.items, page.items, twinsOnly(view.featured)]) {
      expect(slugs(candidates)).toEqual(["market_twin", "market_twin_us"]);
      // This is the panel's JSON boundary: the same response must reconcile
      // when inventory finishes, including when BOTH aliases are connected.
      inventory = new Set(connected);
      expect(slugs(collapseDuplicateCards(JSON.parse(JSON.stringify(candidates)), inventory))).toEqual([...connected].sort());
      inventory = null;
    }
  });

  it("H1 both connected featured aliases survive even across the top-N boundary", async () => {
    const filler = Array.from({ length: 30 }, (_, n) => ({ slug: `filler_${n}`, name: `Filler ${n}`, description: "Other app" }));
    const backend = fixture([twin("market_twin"), ...filler, twin("market_twin_us")]);
    setConnectedSlugsSource(() => new Set(["market_twin", "market_twin_us"]));
    expect(slugs(twinsOnly((await loadCatalog(backend)).featured))).toEqual(["market_twin", "market_twin_us"]);
  });

  it("H2 differing full-description suffixes survive fetching, disk reload, search and renderer", async () => {
    const prefix = "Shared description ".repeat(8);
    const backend = fixture([twin("market_twin", prefix + "one"), twin("market_twin_us", prefix + "two")]);
    const found = await searchCatalog(backend, "market twin");
    expect(slugs(found.items)).toEqual(["market_twin", "market_twin_us"]);
    expect(slugs(collapseDuplicateCards(JSON.parse(JSON.stringify(found.items))))).toEqual(["market_twin", "market_twin_us"]);
    await loadCatalog(backend);
    resetAppCatalogState(); // retain the actual disk copy; fetch is now forbidden
    backend.request = vi.fn(async () => { throw Error("disk fixture must not fetch"); });
    expect(slugs(twinsOnly((await catalogPage(backend)).items))).toEqual(["market_twin", "market_twin_us"]);
    expect(slugs(twinsOnly((await loadCatalog(backend)).featured))).toEqual(["market_twin", "market_twin_us"]);
    expect((await catalogApp(backend, "market_twin")).slug).toBe("market_twin");
    expect(Object.keys(knownApps(backend, ["market_twin", "market_twin_us"])).sort()).toEqual(["market_twin", "market_twin_us"]);
  });

  it("M1 twins split across service pages are collapsed before limit one, independent of input order", async () => {
    for (const apps of [[twin("market_twin"), twin("market_twin_us")], [twin("market_twin_us"), twin("market_twin")]]) {
      resetAppCatalogState({ disk: true });
      const backend = fixture(apps, 1);
      const first = await catalogPage(backend, { limit: 1 });
      expect(slugs(first.items)).toEqual(["market_twin_us"]);
      expect(first.total).toBe(1);
      expect(first.nextCursor).toBeNull();
      expect(slugs((await searchCatalog(backend, "market twin", { limit: 1 })).items)).toEqual(["market_twin_us"]);
    }
  });

  it("M2 a connected curated alias does not resurrect the discarded Gmail fallback", async () => {
    const backend = fixture([{ slug: "gmail", name: "Gmail", description: "Email for bots" }, { slug: "gmail_alias", name: "Gmail", description: "Email for bots" }]);
    setConnectedSlugsSource(() => new Set(["gmail_alias"]));
    expect(slugs((await loadCatalog(backend)).featured.filter(app => app.label === "Gmail"))).toEqual(["gmail_alias"]);
  });

  it.each(["", "  ", "Composio helper", "Compare price plans"])("M3 equal descriptions collapse even when display copy is empty: %s", async description => {
    const backend = fixture([twin("market_twin", description), twin("market_twin_us", description)]);
    expect(slugs((await searchCatalog(backend, "market twin")).items)).toEqual(["market_twin_us"]);
  });

  it("H2 filtered descriptions that differ are not equal just because both blurbs are empty", async () => {
    const backend = fixture([twin("market_twin", "Compare price plans"), twin("market_twin_us", "Compare price options")]);
    const cards = (await searchCatalog(backend, "market twin")).items;
    expect(slugs(collapseDuplicateCards(cards))).toEqual(["market_twin", "market_twin_us"]);
  });

  it("M4 active status then most tools break ties before the lowest slug, across cache and UI", async () => {
    const backend = fixture([{ ...twin("alpha"), active: false, tools_count: 99 }, { ...twin("zeta"), active: true, tools_count: 44 }, { ...twin("omega"), active: true, tools_count: 12 }]);
    expect(slugs((await searchCatalog(backend, "market twin")).items)).toEqual(["zeta"]);
    const cards = [slimApp({ ...twin("alpha"), active: false, tools_count: 99 })!, slimApp({ ...twin("zeta"), active: true, tools_count: 44 })!];
    expect(slugs(collapseDuplicateCards(cards))).toEqual(["zeta"]);
    await loadCatalog(backend); resetAppCatalogState();
    expect(slugs(twinsOnly((await catalogPage(backend)).items))).toEqual([]);
    expect(slugs((await catalogPage(backend)).items)).toEqual(["zeta"]);
  });

  it("disk reload keeps identical aliases available for either connection and slug lookup", async () => {
    const backend = fixture([twin("market_twin"), twin("market_twin_us")]);
    await loadCatalog(backend); resetAppCatalogState();
    backend.request = vi.fn(async () => { throw Error("disk fixture must not fetch"); });
    expect(slugs((await catalogPage(backend)).items)).toEqual(["market_twin_us"]);
    setConnectedSlugsSource(() => new Set(["market_twin"]));
    expect(slugs((await catalogPage(backend)).items)).toEqual(["market_twin"]);
    setConnectedSlugsSource(() => new Set(["market_twin", "market_twin_us"]));
    expect(slugs((await catalogPage(backend)).items)).toEqual(["market_twin", "market_twin_us"]);
    for (const slug of ["market_twin", "market_twin_us"]) expect((await catalogApp(backend, slug)).slug).toBe(slug);
    expect(backend.request).not.toHaveBeenCalled();
  });

  it("M6 connection-source failure preserves all aliases instead of guessing nobody connected", async () => {
    const backend = fixture([twin("market_twin"), twin("market_twin_us")]);
    setConnectedSlugsSource(() => { throw Error("inventory unavailable"); });
    const found = await searchCatalog(backend, "market twin");
    expect(slugs(found.items)).toEqual(["market_twin", "market_twin_us"]);
    expect(slugs((await catalogPage(backend)).items)).toEqual(["market_twin", "market_twin_us"]);
    expect(slugs(twinsOnly((await loadCatalog(backend)).featured))).toEqual(["market_twin", "market_twin_us"]);
  });
});
