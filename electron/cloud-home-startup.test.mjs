// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CloudHomeError, createCloudHomeClient } from "./cloud-home-client.mjs";
import { registerCloudHomeIpc } from "./cloud-home-ipc.mjs";
import { cleanup, installDOMHarness, mount, settle } from "../src/testing/dom-harness";
import { WorkspaceSwitch } from "../src/components/cloud/WorkspaceSwitch";

let restore;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => { cleanup(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const reconnecting = () => {
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Reconnecting to your Cloud home");
  expect(document.querySelector('[role="alert"]')).toBeNull();
};
const unreachable = () => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Your Cloud home isn't reachable");

async function openHome(activate = vi.fn(async () => { throw new CloudHomeError("unreachable", "Your Cloud home isn't reachable"); })) {
  const handlers = new Map();
  const opened = vi.fn();
  const client = { activate, pairedHomes: async () => [{ homeId: "home-1", origin: "https://home.example" }] };
  registerCloudHomeIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    cloudHome: { client, open: opened }, getCpToken: () => "fixture",
  });
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  const bridge = { state: () => call("cloud-home:state"), open: (id, reconnecting) => call("cloud-home:open", id, ...(reconnecting ? [true] : [])) };
  const view = mount(createElement(WorkspaceSwitch, { bridge }));
  await settle();
  const click = () => act(() => (Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Cloud home")).click());
  click();
  await settle();
  return { activate, opened, click, view };
}

it("cold open through IPC: refused transport reconnects for exactly 150 seconds without opening an unverified window", async () => {
  const fetch = vi.fn(async () => { throw new TypeError("ECONNREFUSED"); });
  const client = createCloudHomeClient({
    store: { load: async () => ({ homeId: "home-1", publicOrigin: "https://home.example", cpEnvironment: "prod" }) },
    fetch, cp: { prod: { jwk: {} } }, appVersion: "1.0.19", confirmStepUp: async () => false,
  });
  const t = await openHome(vi.fn(client.activate));
  expect(fetch).toHaveBeenCalled();
  reconnecting();
  await advance(60_000);
  vi.setSystemTime(Date.now() - 3_600_000);
  t.click(); // repeated clicks cannot renew the same opening attempt
  await advance(89_999);
  reconnecting();
  await advance(1);
  unreachable();
  const calls = fetch.mock.calls.length;
  await advance(150_000);
  unreachable();
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(t.opened).not.toHaveBeenCalled();
});

it("cold open recovers through activation before opening the Cloud window, without an unreachable flash", async () => {
  const t = await openHome();
  await advance(117_000);
  reconnecting();
  t.activate.mockResolvedValue(undefined);
  await advance(3_000);
  expect(t.opened).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="status"], [role="alert"]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["sign-in-refused", "needs-repair", "pin-mismatch", "version-mismatch", "not-paired"])("cold open %s bypasses grace and retries", async code => {
  const t = await openHome(vi.fn(async () => { throw new CloudHomeError(code, "Fixture refusal"); }));
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Fixture refusal");
  await advance(150_000);
  expect(t.activate).toHaveBeenCalledOnce();
  expect(t.opened).not.toHaveBeenCalled();
});

it("cold open expires even when activation is pending, and unmount cancels retry timers", async () => {
  const t = await openHome();
  t.activate.mockImplementation(() => new Promise(() => {}));
  await advance(149_999);
  reconnecting();
  await advance(1);
  unreachable();
  t.view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
