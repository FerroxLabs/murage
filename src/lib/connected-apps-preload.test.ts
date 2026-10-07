// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api }));
beforeEach(() => { vi.resetModules(); api.mockReset(); });

it("shares the warm-up with a panel opened during the request", async () => {
  const inventory = await import("./connected-apps-preload");
  let resolve!: (value: unknown) => void;
  api.mockReturnValue(new Promise((done) => { resolve = done; }));
  const first = inventory.preloadConnectedApps();
  expect(inventory.preloadConnectedApps()).toBe(first);
  expect(inventory.pendingConnectedApps()).toBe(first);
  resolve({ configured: true, services: { calendar: { connected: true } } });
  await expect(first).resolves.toMatchObject({ authoritative: true, services: { calendar: { connected: true } } });
  await inventory.preloadConnectedApps();
  expect(api).toHaveBeenCalledTimes(1);
  expect(inventory.pendingConnectedApps()).toBeNull();
});

it("does not cache an unavailable backend and retries only when asked", async () => {
  const inventory = await import("./connected-apps-preload");
  api.mockResolvedValueOnce({ configured: false }).mockResolvedValueOnce({ services: { calendar: { connected: true } } });
  await expect(inventory.preloadConnectedApps()).resolves.toMatchObject({ authoritative: false, backendReady: false });
  expect(api).toHaveBeenCalledTimes(1);
  await expect(inventory.preloadConnectedApps()).resolves.toMatchObject({ authoritative: true });
  expect(api).toHaveBeenCalledTimes(2);
});

it("serves what the server remembered and says it is still being refreshed", async () => {
  const inventory = await import("./connected-apps-preload");
  api.mockResolvedValueOnce({ configured: true, known: true, revalidating: true, services: { calendar: { connected: true } } })
    .mockResolvedValueOnce({ configured: true, known: true, revalidating: false, services: { calendar: { connected: true } } });
  await expect(inventory.preloadConnectedApps()).resolves.toMatchObject({ authoritative: true, revalidating: true, services: { calendar: { connected: true } } });
  // A list still being refreshed is not held for 30 s: the next ask goes out.
  await expect(inventory.preloadConnectedApps()).resolves.toMatchObject({ revalidating: false });
  expect(api).toHaveBeenCalledTimes(2);
});

it("treats a server that has nothing yet as not known, never as empty", async () => {
  const inventory = await import("./connected-apps-preload");
  api.mockResolvedValueOnce({ configured: true, known: false, revalidating: true, services: {} });
  await expect(inventory.preloadConnectedApps()).resolves.toMatchObject({ authoritative: false, revalidating: true });
});

it("asks the server to refresh for the panel's Retry", async () => {
  const inventory = await import("./connected-apps-preload");
  api.mockResolvedValue({ configured: true, services: {} });
  await inventory.preloadConnectedApps(true);
  expect(api).toHaveBeenCalledWith("/api/connectors/connected?force=1");
  await inventory.preloadConnectedApps(true, false);
  expect(api).toHaveBeenLastCalledWith("/api/connectors/connected");
});

it("review F14: the panel remembering a refreshing list does not restamp it as fresh", async () => {
  const inventory = await import("./connected-apps-preload");
  api.mockResolvedValueOnce({ configured: true, known: true, revalidating: true, services: { calendar: { connected: true } } })
    .mockResolvedValueOnce({ configured: true, services: { calendar: { connected: true } } });
  await inventory.preloadConnectedApps();
  inventory.rememberConnectedApps({ calendar: { connected: true } }, true); // what the panel's effect does
  await inventory.preloadConnectedApps(); // a reopen must still ask the server
  expect(api).toHaveBeenCalledTimes(2);
});
