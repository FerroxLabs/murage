// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 gap check H1, the restart half. When the owner's opt-out could not be written to our own key (a full disk), the
// SDK's own persisted opt-out is the only record left. Startup must keep it, not clear it and send app_opened. Only an
// explicit opt-in (our key "0", or turned on this session) clears a stale SDK opt-out. posthog-js is the third-party
// client, faked here; the module under test is the real one.
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), has_opted_out_capturing: vi.fn(() => true) }));
vi.mock("posthog-js", () => ({ default: fake }));
vi.mock("./analytics-active", () => ({ watchActiveDays: vi.fn() }));
vi.mock("./native-shell", () => ({ inNativeShell: () => false }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function boot(stored: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_KEY", "fixture-public-project");
  const storage = new Map(Object.entries(stored));
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
  vi.stubGlobal("navigator", { userAgent: "Electron fixture" });
  const analytics = await import("./analytics");
  analytics.initAnalytics();
  await vi.waitFor(() => expect(fake.init).toHaveBeenCalledOnce());
  return analytics;
}

it("an absent opt-out key with the SDK opted out stays out after restart: no opt-in, no capture, the switch reads Off", async () => {
  const analytics = await boot({});
  expect(fake.opt_in_capturing).not.toHaveBeenCalled();
  expect(fake.capture).not.toHaveBeenCalled();
  expect(analytics.analyticsEnabled()).toBe(false);
});

it("an explicit saved opt-in clears a stale SDK opt-out and counts the launch", async () => {
  await boot({ "murage-analytics-opt-out": "0" });
  expect(fake.opt_in_capturing).toHaveBeenCalledOnce();
  expect(fake.capture).toHaveBeenCalledWith("app_opened", { platform: "desktop" });
});
