// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { BrowserExtensionPanel } from "./BrowserExtensionPanel";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ dispatch: fixture.dispatch }) }));

const base = "/api/bots/fixture/browser-extension";
const sitesPath = `${base}/sites?profileId=profile`;
const outage = "Fixture connection unavailable. Check the helper, then try again.";
const origin = "https://fixture.example";
const bot = { id: "fixture", name: "Fixture", browserExtensionProfileId: "profile" } as Bot;
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); vi.useRealTimers(); fixture.api.mockReset(); });

function openPanel(failures: { status?: string; sites?: string | Promise<never>; save?: string }) {
  vi.useFakeTimers();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === base) {
      if (failures.status) throw new Error(failures.status);
      return { profiles: [{ profileId: "profile", browser: "Chrome" }], bindings: [], helper: { running: true }, storeUrl: null };
    }
    if (path === sitesPath) {
      if (failures.sites instanceof Promise) return failures.sites;
      if (failures.sites) throw new Error(failures.sites);
      return { sites: [{ origin, rule: "allow" }] };
    }
    if (path === `${base}/sites` && init?.method === "POST") throw new Error(failures.save);
    if (path === `${base}/mode`) return { mode: "step" };
    return {};
  });
  const { container } = mount(createElement(BrowserExtensionPanel, { bot, onChoose: vi.fn() }));
  return {
    container,
    alerts: () => [...container.querySelectorAll('[role="alert"]')].map(alert => alert.textContent),
    revoke: () => container.querySelector<HTMLButtonElement>('[data-action="revoke"]'),
  };
}

const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(2500); });

it("announces a shared status and sites read failure once and reloads the list after recovery", async () => {
  const failures = { status: outage, sites: outage };
  const panel = openPanel(failures);
  await settle();
  expect(fixture.api).toHaveBeenCalledWith(base);
  expect(fixture.api).toHaveBeenCalledWith(sitesPath);
  expect(panel.container.textContent).toContain("Browser connection unavailable");
  expect(panel.alerts()).toEqual([outage]);
  await poll();
  expect(panel.alerts()).toEqual([outage]);

  failures.status = failures.sites = "";
  await poll();
  expect(panel.container.textContent).not.toContain("Browser connection unavailable");
  expect(panel.alerts()).toEqual([]);
  expect(panel.revoke()?.dataset.origin).toBe(origin);
  expect(fixture.api.mock.calls.filter(([path]) => path === sitesPath)).toHaveLength(2);
});

it("shows an independent sites read failure during a status outage", async () => {
  const message = "Approved sites could not be read";
  const panel = openPanel({ status: outage, sites: message });
  await settle();
  expect(panel.alerts()).toEqual([outage, message]);
});

it("ignores a late failure from the sites read that started before recovery", async () => {
  let reject!: (error: Error) => void;
  const slowSitesRead = new Promise<never>((_, fail) => { reject = fail; });
  const failures: Parameters<typeof openPanel>[0] = { status: outage, sites: slowSitesRead };
  const panel = openPanel(failures);
  await settle();
  expect(panel.alerts()).toEqual([outage]);
  failures.status = failures.sites = "";
  await poll();
  expect(panel.revoke()?.dataset.origin).toBe(origin);
  await act(async () => { reject(new Error(outage)); });
  expect(panel.alerts()).toEqual([]);
  expect(panel.revoke()?.dataset.origin).toBe(origin);
});

it("keeps approved sites usable during a status outage and reports a failed revoke", async () => {
  const panel = openPanel({ status: outage, save: outage });
  await settle();
  expect(panel.alerts()).toEqual([outage]);
  expect(panel.revoke()?.dataset.origin).toBe(origin);
  await act(async () => { panel.revoke()!.click(); });
  expect(fixture.api).toHaveBeenCalledWith(`${base}/sites`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ profileId: "profile", origin, rule: "ask" }),
  }));
  expect(panel.alerts()).toEqual([outage, outage]);
  expect(panel.revoke()?.dataset.origin).toBe(origin);
});
