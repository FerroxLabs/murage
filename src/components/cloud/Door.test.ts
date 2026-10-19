// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Door.tsx: the opening screen, the /enter bounce to the site, and the "/" screen for a browser with no device.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorageBlocked, StorageRefused, doorCopy } from "@/lib/cloud-door";
import { CloudDoor, CloudDoorView, runDoor, type DoorEnv } from "./Door";

const BIND = "ab".repeat(32);
const SITE = "https://murage.ai";

function env(over: Partial<DoorEnv> = {}) {
  const calls = { history: [] as string[], bounced: [] as string[], reports: [] as string[], entered: [] as string[], ensured: 0 };
  const value: DoorEnv = {
    meta: { homeId: "home-1", siteOrigin: SITE },
    pathname: "/", hash: "",
    replaceHistory: (path) => { calls.history.push(path); },
    bounce: (url) => { calls.bounced.push(url); },
    enterWithTicket: async (ticket) => { calls.entered.push(ticket); return "signed-in"; },
    ensureDevice: async () => { calls.ensured++; return { deviceId: null, publicKey: {} as CryptoKey }; },
    bindOf: async () => BIND,
    refreshSession: async () => false,
    report: (stage) => { calls.reports.push(stage); },
    ...over,
  };
  return { env: value, calls };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("CloudDoor", () => {
  it("opens on the opening screen, not the app, before anything is known", () => {
    vi.stubGlobal("document", { querySelector: () => null, documentElement: { dataset: {} } });
    const html = renderToStaticMarkup(createElement(CloudDoor, null, createElement("div", null, "the app")));
    expect(html).toContain('data-murage-door="working"');
    expect(html).toContain(doorCopy.opening);
    expect(html).not.toContain("the app");
    expect(html).not.toContain("<button");
  });

  it("/enter with no ticket and no sign-in bounces to the site's open page for this browser's key", async () => {
    const { env: e, calls } = env({ pathname: "/enter" });
    expect(await runDoor(e)).toBeNull();
    expect(calls.bounced).toEqual([`${SITE}/home/cloud/open?home=home-1&auto=1&k=${BIND}`]);
    expect(calls.history).toEqual(["/enter"]);
    expect(calls.ensured).toBe(1);
  });

  it("/enter with a device that still signs in shows the app and does not bounce", async () => {
    const { env: e, calls } = env({ pathname: "/enter", ensureDevice: async () => ({ deviceId: "d1", publicKey: {} as CryptoKey }), refreshSession: async () => true });
    expect(await runDoor(e)).toEqual({ kind: "app" });
    expect(calls.bounced).toEqual([]);
  });

  it("/enter with a ticket clears it from the address bar first and never bounces", async () => {
    const { env: e, calls } = env({ pathname: "/enter", hash: "#t=abc.def" });
    expect(await runDoor(e)).toEqual({ kind: "app" });
    expect(calls.entered).toEqual(["abc.def"]);
    expect(calls.history).toEqual(["/enter", "/"]);
    expect(calls.bounced).toEqual([]);
  });

  it("\"/\" with no device never leaves the origin and shows the one button back to the site", async () => {
    const { env: e, calls } = env();
    const state = await runDoor(e);
    expect(state).toEqual({ kind: "openFromSite", button: true });
    expect(calls.bounced).toEqual([]);
    expect(calls.ensured).toBe(0);
    const html = renderToStaticMarkup(createElement(CloudDoorView, { state: state as { kind: "openFromSite"; button: boolean }, onGo: () => {} }));
    expect(html).toContain('data-murage-door="continue"');
    expect(html).toContain(doorCopy.openFromSite);
    expect(html).toContain(`>${doorCopy.goButton}</button>`);
  });

  it("\"/\" without a usable site origin shows the screen with no button", async () => {
    const { env: e } = env({ meta: { homeId: "home-1", siteOrigin: "http://murage.ai" } });
    const state = await runDoor(e);
    expect(state).toEqual({ kind: "openFromSite", button: false });
    const html = renderToStaticMarkup(createElement(CloudDoorView, { state: state as { kind: "openFromSite"; button: boolean }, onGo: () => {} }));
    expect(html).not.toContain("<button");
  });

  it("a key store held by another tab shows the other-tab line with Try again, and the next run carries on", async () => {
    let blocked = true;
    const { env: e, calls } = env({ pathname: "/enter", ensureDevice: async () => { if (blocked) throw new StorageBlocked(); return { deviceId: null, publicKey: {} as CryptoKey }; } });
    const state = await runDoor(e);
    expect(state).toEqual({ kind: "blocked" });
    expect(calls.reports).toEqual([]); // cloud-door already reported device_open
    const html = renderToStaticMarkup(createElement(CloudDoorView, { state: state as { kind: "blocked" }, onGo: () => {}, onRetry: () => {} }));
    expect(html).toContain('data-murage-door="blocked"');
    expect(html).toContain(doorCopy.tabOpen);
    expect(html).toContain(`>${doorCopy.tryAgain}</button>`);
    blocked = false;
    expect(await runDoor(e)).toBeNull();
    expect(calls.bounced).toEqual([`${SITE}/home/cloud/open?home=home-1&auto=1&k=${BIND}`]);
  });

  it("a key store that never answers leaves the spinner for the storage line, on every path", async () => {
    for (const over of [
      { pathname: "/enter", ensureDevice: async () => { throw new StorageRefused(); } },
      { pathname: "/enter", hash: "#t=abc.def", enterWithTicket: async () => { throw new StorageRefused(); } },
      { pathname: "/", refreshSession: async () => { throw new StorageRefused(); } },
    ] as Partial<DoorEnv>[]) {
      const { env: e, calls } = env(over);
      expect(await runDoor(e)).toEqual({ kind: "message", text: doorCopy.storage });
      expect(calls.reports).toEqual([]);
    }
    const { env: e } = env({ refreshSession: async () => { throw new StorageBlocked(); } });
    expect(await runDoor(e)).toEqual({ kind: "blocked" });
  });

  it("the other-tab copy matches the shared client copy", () => {
    expect(doorCopy.tabOpen).toBe("Another Murage tab for this home is open. Close it, then try again.");
    expect(doorCopy.tryAgain).toBe("Try again");
  });
});
