// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Existing catalog APIs only: runnable against the unfixed integration base.
import { afterEach, beforeEach, expect, it } from "vitest";
import { catalogApp, catalogPage, loadCatalog, resetAppCatalogState, searchCatalog, type CatalogBackend } from "./app-catalog.ts";
import { fakeCatalogApps } from "./app-catalog.fixture.ts";
const items = ["market_twin", "market_twin_us"].map(slug => ({ slug, name: "Market Twin US", description: "Trade on prediction markets" }));
const backend: CatalogBackend = { kind: "broker", cacheKey: "behavior-fixture", identity: "behavior-fixture", current: () => "behavior-fixture",
  request: async () => Response.json({ contract: 2, items, total_items: 2, next_cursor: null }) };
beforeEach(() => resetAppCatalogState({ disk: true }));
afterEach(() => resetAppCatalogState({ disk: true }));
it("search shows one real app through the existing API", async () => {
  expect((await searchCatalog(backend, "market twin")).items.map(app => app.slug)).toEqual(["market_twin_us"]);
});
it("featured shows one real app through the existing API", async () => {
  expect((await loadCatalog(backend)).featured.filter(app => app.label === "Market Twin US").map(app => app.slug)).toEqual(["market_twin_us"]);
});
it("All apps shows one real app through the existing API", async () => {
  expect((await catalogPage(backend)).items.map(app => app.slug)).toEqual(["market_twin_us"]);
});
it("both bot slug lookups still resolve through the existing API", async () => {
  for (const item of items) expect((await catalogApp(backend, item.slug)).slug).toBe(item.slug);
});
it("reports a measured duplicate count for the available synthetic catalog", () => {
  const apps = fakeCatalogApps().filter(app => !/composio/i.test(app.slug));
  const groups = new Map<string, number>();
  for (const app of apps) {
    const key = JSON.stringify([app.name, app.blurb].map(text => text.replace(/\s+/g, " ").trim().toLowerCase()));
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const pairs = [...groups.values()].reduce((count, size) => count + size * (size - 1) / 2, 0);
  expect(apps).toHaveLength(1600); expect(pairs).toBe(0);
  console.log("CATALOG_FIXTURE_COUNT " + JSON.stringify({ kind: "synthetic", apps: apps.length, duplicatePairs: pairs, vendorCatalog: "unavailable" }));
});
