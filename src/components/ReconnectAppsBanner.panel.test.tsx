// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE RECONNECT LINE CAN BE PUT AWAY AND IT REMINDS (1.0.20, owner report on
// 1.0.19: "it's in the way ... remind people if they don't do it"). The real
// band, polled through a mocked api(): the X and Later put it away; it comes
// back at the first of Murage starting again or a day, a restart reminds at
// most once a day per app, a new failure brings it back at once, nothing asks
// the server for anything, and while any app needs signing in the Needs you
// door, Needs you and Settings, Connections lead to Reconnect.
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocks.api, openNotificationTarget: vi.fn(), useStore: () => ({ state: {}, dispatch: mocks.dispatch }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));

const DAY = 24 * 60 * 60_000;
const freshdesk = { slug: "freshdesk", label: "Freshdesk", incidentId: "inc-fd-a", incidentIds: ["inc-fd-a", "inc-fd-b"], accounts: [{ id: "fd-a", alias: "work" }, { id: "fd-b", alias: "home" }] };
const gmail = { slug: "gmail", label: "Gmail", incidentId: "inc-gm", incidentIds: ["inc-gm"], accounts: [{ id: "gm" }] };
let answer: { apps: unknown[]; notifications: unknown[] };
let root: Root, container: HTMLDivElement;
type Module = typeof import("./ReconnectAppsBanner");
let module: Module;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));
  answer = { apps: [freshdesk, gmail], notifications: [] };
  mocks.api.mockReset(); mocks.api.mockImplementation(async () => answer); mocks.dispatch.mockReset();
  window.localStorage.clear(); window.sessionStorage.clear();
  await start();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

/** A fresh window: new module state. `restart` is Murage starting again (a new session); without it, a reload of the window. localStorage is kept. */
async function start(restart = false) {
  if (root) { await act(async () => root.unmount()); container.remove(); }
  if (restart) window.sessionStorage.clear();
  vi.resetModules();
  module = await import("./ReconnectAppsBanner");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(module.ReconnectAppsBanner, { enabled: true })));
}
const band = () => container.querySelector("[data-reconnect-line]");
const poll = async () => { await act(async () => { window.dispatchEvent(new Event("focus")); }); };
const methods = () => mocks.api.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}`);

it("the X is a labelled, focusable button; it puts the line away until Murage starts again (a reload is not a start) and asks the server for nothing", async () => {
  expect(band()).not.toBeNull();
  const close = container.querySelector<HTMLButtonElement>("button[data-reconnect-close]");
  expect(close).not.toBeNull();
  expect(close!.getAttribute("aria-label")).toBe("Dismiss");
  expect(close!.disabled).toBe(false);
  close!.focus(); expect(document.activeElement).toBe(close);
  await act(async () => { close!.click(); });
  expect(band()).toBeNull();
  await poll();
  expect(band()).toBeNull();
  // Dismissing disconnects nothing: only the status reads were made.
  expect(new Set(methods())).toEqual(new Set(["GET /api/connectors/needs-reconnect"]));
  expect(mocks.dispatch).not.toHaveBeenCalled();
  // A reload of the window is the same run: still away.
  await start();
  expect(band()).toBeNull();
  // Murage starting again reminds.
  await start(true);
  expect(band()).not.toBeNull();
});

it("Later reminds at the first of a restart or a day, a restart reminds at most once a day per app, and a new failure comes back at once", async () => {
  const later = () => container.querySelector<HTMLButtonElement>("button[data-reconnect-later]")!;
  expect(later().textContent).toBe("Later");
  await act(async () => { later().click(); });
  expect(band()).toBeNull();
  // The same failures again, an hour on: still away.
  vi.setSystemTime(Date.now() + 60 * 60_000); await poll();
  expect(band()).toBeNull();
  // Murage starts again: the first reminder.
  await start(true);
  expect(band()).not.toBeNull();
  // Later again, then another start the same day: no second reminder from a restart.
  await act(async () => { later().click(); });
  const putAway = Date.now();
  vi.setSystemTime(putAway + 2 * 60 * 60_000);
  await start(true);
  expect(band()).toBeNull();
  // ...but a day after it was put away, it reminds while Murage is running.
  vi.setSystemTime(putAway + DAY); await poll();
  expect(band()).not.toBeNull();
  // Put away again; a connection that was not on the line fails: back at once, without waiting for a restart or a day.
  await act(async () => { later().click(); });
  await poll(); expect(band()).toBeNull();
  const stripe = { slug: "mcp-stripe", label: "Stripe", incidentId: "inc-st", incidentIds: ["inc-st"], accounts: [{ id: "st" }] };
  answer = { apps: [freshdesk, gmail, stripe], notifications: [] };
  await poll();
  expect(band()).not.toBeNull();
  // A new failure of an app already shown (a new incident) comes back at once too.
  await act(async () => { later().click(); });
  answer = { apps: [{ ...gmail, incidentId: "inc-gm-2", incidentIds: ["inc-gm-2"] }, freshdesk, stripe], notifications: [] };
  await poll();
  expect(band()).not.toBeNull();
  expect(methods().every(call => call === "GET /api/connectors/needs-reconnect")).toBe(true);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it("with no restart at all, a day after it was put away it reminds while Murage runs", async () => {
  await act(async () => { container.querySelector<HTMLButtonElement>("button[data-reconnect-later]")!.click(); });
  vi.setSystemTime(Date.now() + DAY - 60_000); await poll();
  expect(band()).toBeNull();
  vi.setSystemTime(Date.now() + 60_000); await poll();
  expect(band()).not.toBeNull();
});

it("the next restart a day after the last reminder reminds again", async () => {
  await act(async () => { container.querySelector<HTMLButtonElement>("button[data-reconnect-close]")!.click(); });
  await start(true); expect(band()).not.toBeNull();
  await act(async () => { container.querySelector<HTMLButtonElement>("button[data-reconnect-close]")!.click(); });
  vi.setSystemTime(Date.now() + DAY - 60_000);
  await start(true); expect(band()).toBeNull();
  vi.setSystemTime(Date.now() + 2 * 60_000);
  await start(true); expect(band()).not.toBeNull();
});

it("one row and one Reconnect per app, and Reconnect opens that app's incident", async () => {
  const rows = [...container.querySelectorAll("[data-reconnect-app]")].map(row => row.getAttribute("data-reconnect-app"));
  expect(rows).toEqual(["freshdesk", "gmail"]);
  const reconnects = [...container.querySelectorAll("button[aria-label^='Reconnect']")].map(button => button.textContent);
  expect(reconnects).toEqual(["Reconnect Freshdesk", "Reconnect Gmail"]);
  expect(container.textContent!.match(/Freshdesk needs you to sign in again/g)).toHaveLength(1);
  await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Reconnect Freshdesk']")!.click(); });
  expect(mocks.dispatch).toHaveBeenCalledWith({ type: "openConnectorReconnect", incidentId: "inc-fd-a" });
});

it("while any app needs signing in, shown or put away, the Needs you door carries a dot and Needs you lists each app with its Reconnect", async () => {
  const { RailDoors } = await import("./shell/RailDoors");
  const { useReconnectLine, ReconnectAppsNeedsYou, reconnectNotice } = module;
  function Door() {
    const line = useReconnectLine();
    // As Sidebar.tsx passes it (witnessed against the source below).
    return createElement(RailDoors, { lit: null, needs: { count: 0, stale: false }, reconnect: reconnectNotice(line.apps), onOpen: () => {} });
  }
  const side = document.createElement("div"); document.body.append(side);
  const sideRoot = createRoot(side);
  await act(async () => sideRoot.render(createElement("div", null, createElement(Door), createElement(ReconnectAppsNeedsYou, { dispatch: mocks.dispatch, label: "Connections" }))));
  const door = () => side.querySelector<HTMLButtonElement>("button[data-door='needs-you']")!;
  // Shown: the quiet way back is there already.
  expect(door().querySelector("[data-needs-you-reconnect]")).not.toBeNull();
  expect(side.querySelector("[data-reconnect-needs-you]")).not.toBeNull();
  await act(async () => { container.querySelector<HTMLButtonElement>("button[data-reconnect-later]")!.click(); });
  expect(band()).toBeNull();
  expect(door().querySelector("[data-needs-you-reconnect]")).not.toBeNull();
  expect(door().getAttribute("aria-label")).toContain("Freshdesk needs you to sign in again");
  const listed = side.querySelector("[data-reconnect-needs-you]")!;
  expect([...listed.querySelectorAll("[data-reconnect-app]")].map(row => row.getAttribute("data-reconnect-app"))).toEqual(["freshdesk", "gmail"]);
  expect(listed.querySelector("button[data-reconnect-later], button[data-reconnect-close]")).toBeNull();
  await act(async () => { listed.querySelector<HTMLButtonElement>("button[aria-label='Reconnect Gmail']")!.click(); });
  expect(mocks.dispatch).toHaveBeenCalledWith({ type: "openConnectorReconnect", incidentId: "inc-gm" });
  // Signed in again everywhere: the dot and the entry go.
  answer = { apps: [], notifications: [] }; await poll();
  expect(door().querySelector("[data-needs-you-reconnect]")).toBeNull();
  expect(side.querySelector("[data-reconnect-needs-you]")).toBeNull();
  await act(async () => sideRoot.unmount()); side.remove();
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  expect(sidebar).toContain("reconnect={reconnectNotice(reconnectLine.apps)}");
});

it("Settings, Connections lists each app to sign in again with its Reconnect, put away or not", async () => {
  // The catalog itself (and its own per-account Reconnect) is PluginsPanel's, witnessed in its own suites.
  vi.doMock("./PluginsPanel", () => ({ PluginsPanel: () => null }));
  const { ConnectedAppsCard } = await import("./settings/pages/ConnectionsPage");
  await act(async () => { container.querySelector<HTMLButtonElement>("button[data-reconnect-close]")!.click(); });
  expect(band()).toBeNull();
  const page = document.createElement("div"); document.body.append(page);
  const pageRoot = createRoot(page);
  await act(async () => pageRoot.render(createElement(ConnectedAppsCard)));
  const listed = page.querySelector("[data-reconnect-needs-you]");
  expect(listed).not.toBeNull();
  expect([...listed!.querySelectorAll("[data-reconnect-app]")].map(row => row.getAttribute("data-reconnect-app"))).toEqual(["freshdesk", "gmail"]);
  await act(async () => { listed!.querySelector<HTMLButtonElement>("button[aria-label='Reconnect Freshdesk']")!.click(); });
  expect(mocks.dispatch).toHaveBeenCalledWith({ type: "openConnectorReconnect", incidentId: "inc-fd-a" });
  await act(async () => pageRoot.unmount()); page.remove();
});

it("the line is a band in the app's top stack, never a box fixed over the rail and the composer", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const mount = app.indexOf("<ReconnectAppsBanner enabled />");
  expect(mount).toBeGreaterThan(0);
  expect(app.indexOf("<ReconnectAppsBanner", mount + 1)).toBe(-1);
  // Mounted before the row that holds the rail and the main view, so it takes its own height above both.
  const main = app.indexOf('<div className="relative flex min-h-0 flex-1">');
  expect(main).toBeGreaterThan(mount);
  expect(app.slice(app.lastIndexOf("\n", mount), mount)).not.toMatch(/fixed|absolute/);
  const view = readFileSync("src/components/ReconnectAppsBanner.tsx", "utf8");
  expect(view).not.toMatch(/className="[^"]*\b(fixed|absolute|sticky)\b/);
  // Needs you hosts the way back.
  const inbox = readFileSync("src/components/Inbox.tsx", "utf8");
  expect(inbox).toMatch(/<ReconnectAppsNeedsYou /);
});
