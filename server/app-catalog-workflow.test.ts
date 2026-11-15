// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Catalog route producer and panel response consumer owner: catalog-dupes.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { collapseCatalogCards as collapseDuplicateCards } from "../shared/catalog-card-identity.ts";
import type { CatalogApp as AppCard } from "./app-catalog.ts";

it("isolated catalog routes preserve delayed connections and select one or both connected aliases", async () => {
  const items = ["market_twin", "market_twin_us"].map(slug => ({ slug, name: "Market Twin US", description: "Trade on prediction markets", tools_count: 44 }));
  let release!: () => void;
  let inventoryCalls = 0;
  let connectedSlugs = ["market_twin"];
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const broker = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://fixture.test");
    if (url.pathname.endsWith("/health")) return void res.end(JSON.stringify({ ready: true }));
    if (url.pathname.endsWith("/v1/catalog")) return void res.end(JSON.stringify({ contract: 2, items, total_items: 2, next_cursor: null }));
    if (url.pathname.endsWith("/v1/connectors/connected")) {
      inventoryCalls++;
      await waiting;
      return void res.end(JSON.stringify({ services: Object.fromEntries(connectedSlugs.map(slug => [slug, { connected: true, accounts: [{ id: `fixture-${slug}`, status: "ACTIVE" }] }])) }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const port = (broker.address() as { port: number }).port;
  const moduleUrl = new URL("./composio.ts", import.meta.url).href;
  const proof = "ab".repeat(32);
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_DEV_DESKTOP_SECRET = ${JSON.stringify(proof)};
    const { applyManagedBrokerMessage, primeBrokerReadiness } = await import(${JSON.stringify(moduleUrl)});
    applyManagedBrokerMessage({ type: "murage:managed-composio", access: null,
      fluxBrokerUrl: "http://127.0.0.1:${port}/composio", fluxAccess: { url: "http://127.0.0.1:${port}/composio", token: "c".repeat(64) },
      fluxOwner: "a".repeat(16), legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    await primeBrokerReadiness();
  ` });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const get = async (path: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const slugs = (cards: AppCard[]) => cards.map(card => card.slug).sort();
  try {
    const inventory = get("/api/connectors/connected?force=1");
    await vi.waitFor(() => expect(inventoryCalls).toBeGreaterThan(0));
    const before = await get("/api/connectors/catalog/search?q=market%20twin");
    expect(slugs(before.items)).toEqual(["market_twin", "market_twin_us"]);
    const featuredBefore = await get("/api/connectors/catalog");
    expect(slugs(featuredBefore.cards.filter((card: AppCard) => card.label === "Market Twin US"))).toEqual(["market_twin", "market_twin_us"]);
    const allBefore = await get("/api/connectors/catalog/page?limit=200");
    expect(slugs(allBefore.items)).toEqual(["market_twin", "market_twin_us"]);
    evidence.push({ delayed: { search: before, featured: featuredBefore.cards, page: allBefore } });
    release();
    await inventory;
    const connected = await get("/api/connectors/connected?force=1");
    expect(connected.services.market_twin.connected).toBe(true);
    // The already-delivered response reconciles without another search.
    expect(slugs(collapseDuplicateCards(before.items, new Set(["market_twin"])))).toEqual(["market_twin"]);
    const after = await get("/api/connectors/catalog/search?q=market%20twin");
    expect(slugs(after.items)).toEqual(["market_twin"]);
    const featured = await get("/api/connectors/catalog");
    expect(slugs(featured.cards.filter((card: AppCard) => card.label === "Market Twin US"))).toEqual(["market_twin"]);
    const page = await get("/api/connectors/catalog/page?limit=1");
    expect(slugs(page.items)).toEqual(["market_twin"]);
    expect(page.nextCursor).toBeNull();
    evidence.push({ connected: { search: after, featured: featured.cards, page, inventory: connected } });
    connectedSlugs = ["market_twin", "market_twin_us"];
    const bothInventory = await get("/api/connectors/connected?force=1");
    expect(Object.keys(bothInventory.services).sort()).toEqual(connectedSlugs);
    const bothSearch = await get("/api/connectors/catalog/search?q=market%20twin");
    const bothFeatured = await get("/api/connectors/catalog");
    const bothPage = await get("/api/connectors/catalog/page?limit=200");
    expect(slugs(bothSearch.items)).toEqual(connectedSlugs);
    expect(slugs(bothFeatured.cards.filter((card: AppCard) => card.label === "Market Twin US"))).toEqual(connectedSlugs);
    expect(slugs(bothPage.items)).toEqual(connectedSlugs);
    evidence.push({ bothConnected: { search: bothSearch, page: bothPage, inventory: bothInventory } });

  } finally {
    release();
    console.log("CATALOG_WORKFLOW_EVIDENCE " + JSON.stringify(evidence));
    console.log("CATALOG_FIXTURE_LOG " + readFileSync(fixture.info.logPath, "utf8"));
    await fixture.close();
    await new Promise<void>(resolve => broker.close(() => resolve()));
  }
}, 180_000);
