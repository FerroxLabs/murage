// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Catalog response producer and panel consumer owner: catalog-dupes.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { PluginsPanel } from "./PluginsPanel";
import { initialState } from "../state/store";
import type { AppCard } from "../lib/app-catalog";

const stub = vi.hoisted(() => ({ api: vi.fn(), inventory: vi.fn() }));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("../state/store")>(), api: stub.api,
  useStore: () => ({ state: { ...initialState, config: { flux: { configured: true }, composio: { configured: true } } }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/connected-apps-preload", () => ({
  cachedConnectorStatus: null, cachedConnectorStatusAuthoritative: true, inventoryApps: {},
  preloadConnectedApps: () => stub.inventory(), pendingConnectedApps: () => null,
  isCredentialStoreUnreadable: () => false, rememberConnectedApps: vi.fn(),
}));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
const card = (slug: string): AppCard => ({ slug, label: "Market Twin US", blurb: "Trade on prediction markets", logo: null, domain: null });
const cards = [card("market_twin"), card("market_twin_us")];
const renderedSlugs = () => [...document.querySelectorAll("[data-connector-action]")].map(node => node.getAttribute("data-connector-action")).sort();
function respond(items: AppCard[]) {
  stub.api.mockImplementation(async (path: string) => {
    if (path === "/api/connectors/catalog/cached") return { held: false };
    if (path.includes("/catalog/search")) return { items, total: items.length, source: "service" };
    if (path.includes("/catalog/page")) return { items, total: items.length, source: "service", nextCursor: null };
    if (path === "/api/connectors/catalog") return { configured: true, mode: "managed", source: "api", cards: items, total: items.length, allApps: true };
    throw Error(`unexpected panel request: ${path}`);
  });
}
const click = async (text: RegExp) => {
  const button = [...document.querySelectorAll("button")].find(node => text.test((node.textContent ?? "").trim()));
  expect(button, String(text)).toBeTruthy();
  act(() => button!.click()); await settle();
};

describe("rendered marketplace duplicate cards", () => {
  it.each([{ connected: ["market_twin"] }, { connected: ["market_twin", "market_twin_us"] }])("inventory arriving after featured cards restores $connected, including search and All apps", async ({ connected }) => {
    let release!: (value: unknown) => void;
    stub.inventory.mockReturnValue(new Promise(resolve => { release = resolve; }));
    // This models a response selected from an earlier checked-empty inventory.
    // Connected metadata must also restore a discarded alias in the real panel.
    respond([cards[1]!]);
    mount(h<{ embedded?: boolean; readOnly?: boolean }>(PluginsPanel, { embedded: true })); await settle();
    expect(renderedSlugs()).toEqual(["market_twin_us"]);
    await act(async () => release({ services: Object.fromEntries(connected.map(slug => [slug, { connected: true, accounts: [{ id: slug, status: "ACTIVE" }] }])), apps: Object.fromEntries(cards.map(app => [app.slug, app])), authoritative: true }));
    expect(renderedSlugs()).toEqual(connected);
    const calls = stub.api.mock.calls.length;
    await click(/Browse all/);
    expect(renderedSlugs()).toEqual(connected);
    await click(/^Featured$/);
    const input = document.querySelector('input[type="search"]') ?? document.querySelector('input[placeholder]');
    expect(input).toBeTruthy();
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "market twin"); input!.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(renderedSlugs()).toEqual(connected);
    expect(stub.api.mock.calls.slice(calls).filter(([path]) => path === "/api/connectors/catalog")).toHaveLength(0);
    await click(/^Connected/);
    expect(renderedSlugs()).toEqual(connected);
  });

  it("full-description identity survives the actual rendered list despite equal short blurbs", async () => {
    const items = [{ ...cards[0]!, duplicateKey: "a".repeat(64) }, { ...cards[1]!, duplicateKey: "b".repeat(64) }];
    respond(items); stub.inventory.mockResolvedValue({ services: {}, authoritative: true });
    mount(h<{ embedded?: boolean; readOnly?: boolean }>(PluginsPanel, { embedded: true })); await settle();
    expect(renderedSlugs()).toEqual(["market_twin", "market_twin_us"]);
    await click(/Browse all/);
    expect(renderedSlugs()).toEqual(["market_twin", "market_twin_us"]);
  });

  it("featured, search and All apps show one card before any connection", async () => {
    respond(cards);
    stub.inventory.mockResolvedValue({ services: {}, authoritative: true });
    mount(h<{ embedded?: boolean; readOnly?: boolean }>(PluginsPanel, { embedded: true })); await settle();
    expect(renderedSlugs()).toEqual(["market_twin_us"]);
    await click(/Browse all/);
    expect(renderedSlugs()).toEqual(["market_twin_us"]);
  });
});
