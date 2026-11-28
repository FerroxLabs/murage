// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// K17 S2 (#29) G29-W3: the panel opened cold shows the list saved by an earlier launch as remembered, never as confirmed.
// Entry point: the mounted PluginsPanel fed by the real connected-apps-preload.
import { createElement as h, act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { initialState } from "../state/store";

const stub = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("../state/store")>(), api: stub.api,
  useStore: () => ({ state: { ...initialState, config: { flux: { configured: true }, composio: { configured: true } } }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

const NOTICE = /Showing the previous account inventory/;
let release: ((value: unknown) => void) | undefined;
beforeEach(() => {
  release = undefined;
  vi.resetModules();
  stub.api.mockReset();
  stub.api.mockImplementation((path: string) => {
    if (path.startsWith("/api/connectors/connected")) return new Promise(resolve => { release = resolve; });
    if (path === "/api/connectors/catalog/cached") return Promise.resolve({ held: false });
    if (path === "/api/connectors/catalog") return Promise.resolve({ configured: true, mode: "managed", source: "api", cards: [], total: 0, allApps: true });
    return Promise.reject(new Error(`unexpected panel request: ${path}`));
  });
});
const saved = (scope?: string) => localStorage.setItem("murage-connected-apps", JSON.stringify({ at: 1, ...(scope ? { scope } : {}), services: { gmail: { connected: true, accounts: [{ id: "acct-a1", status: "ACTIVE" }] } } }));
/** The owner's own Refresh: the panel asks the server for the checked list. */
async function ask() {
  const button = [...document.querySelectorAll("button")].find(node => /Refresh connections/.test(node.textContent ?? ""));
  expect(button).toBeTruthy();
  act(() => button!.click());
  await settle();
}
async function open() {
  const { PluginsPanel } = await import("./PluginsPanel");
  mount(h<{ embedded?: boolean }>(PluginsPanel, { embedded: true }));
  await settle();
}

it.each([["a saved list with a scope", "0123456789abcdef"], ["a 1.0.22 saved list with no scope", undefined]])("G29-W3 %s: shown with the remembered notice until an answer confirms it", async (name, scope) => {
  saved(scope);
  await open();
  expect(document.body.textContent, name).toMatch(NOTICE);
  await ask();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => release!({ configured: true, known: true, services: { notion: { connected: true } }, inventoryScope: "fedcba9876543210" }));
  await settle();
  expect(document.body.textContent, name).not.toMatch(NOTICE);
});

it("G29-W3 a null answer (the server could not say) leaves the saved list marked remembered", async () => {
  saved("0123456789abcdef");
  await open();
  await ask();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => release!({ configured: false, services: {}, inventoryScope: null }));
  await settle();
  expect(document.body.textContent).toMatch(NOTICE);
});

it("G29-W3c reopening the panel with a list this window confirmed earlier paints it as remembered until the new answer", async () => {
  await open();
  await ask();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => release!({ configured: true, known: true, services: { gmail: { connected: true } }, inventoryScope: "0123456789abcdef" }));
  await settle();
  expect(document.body.textContent).not.toMatch(NOTICE);
  cleanup(); // the modal closes; the owner switches in the process while it is closed
  release = undefined;
  await open(); // the reopen paints the module list before any answer
  expect(document.body.textContent).toMatch(NOTICE);
  await ask();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => release!({ configured: true, known: true, services: { notion: { connected: true } }, inventoryScope: "fedcba9876543210" }));
  await settle();
  expect(document.body.textContent).not.toMatch(NOTICE);
});
