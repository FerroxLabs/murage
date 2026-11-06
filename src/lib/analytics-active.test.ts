// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// C25 (upstream 09f39e5e3, #3337): one app_active a day while the app is in use, never while hidden or with analytics off.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_CHECK_MS, ACTIVE_DAY_KEY, claimActiveDay, localDay, resetActiveDaysForTest, watchActiveDays } from "./analytics-active";

const store = new Map<string, string>();
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

let listeners: Record<string, Array<() => void>>;
const page = { visibilityState: "visible", focused: true };

beforeEach(() => {
  store.clear();
  resetActiveDaysForTest();
  listeners = {};
  page.visibilityState = "visible";
  page.focused = true;
  const on = (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { get visibilityState() { return page.visibilityState; }, hasFocus: () => page.focused, addEventListener: on });
  vi.stubGlobal("window", { addEventListener: on });
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fire = (type: string) => { for (const fn of listeners[type] ?? []) fn(); };

describe("daily active installs", () => {
  it("sends once on start and not again the same day, on focus, view or the ten-minute check", () => {
    const send = vi.fn();
    const now = new Date(2026, 10, 6, 9);
    watchActiveDays({ canSend: () => true, send, now: () => now });
    expect(send).toHaveBeenCalledTimes(1);
    fire("focus");
    fire("visibilitychange");
    vi.advanceTimersByTime(ACTIVE_CHECK_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get(ACTIVE_DAY_KEY)).toBe("2026-11-06");
  });

  it("sends again when the ten-minute check finds a new day while in view and focused", () => {
    const send = vi.fn();
    let now = new Date(2026, 10, 6, 23, 55);
    watchActiveDays({ canSend: () => true, send, now: () => now });
    now = new Date(2026, 10, 7, 0, 5);
    page.focused = false;
    vi.advanceTimersByTime(ACTIVE_CHECK_MS);
    expect(send).toHaveBeenCalledTimes(1);
    page.focused = true;
    vi.advanceTimersByTime(ACTIVE_CHECK_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never sends while the page is hidden, and sends when it comes into view", () => {
    const send = vi.fn();
    page.visibilityState = "hidden";
    watchActiveDays({ canSend: () => true, send });
    vi.advanceTimersByTime(ACTIVE_CHECK_MS * 2);
    expect(send).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    fire("visibilitychange");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing and claims no day while analytics is off", () => {
    const send = vi.fn();
    let on = false;
    watchActiveDays({ canSend: () => on, send });
    expect(send).not.toHaveBeenCalled();
    expect(store.has(ACTIVE_DAY_KEY)).toBe(false);
    on = true;
    fire("focus");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a day already stored by an earlier launch is not sent again; broken storage still sends once a page", () => {
    store.set(ACTIVE_DAY_KEY, localDay());
    expect(claimActiveDay(localDay())).toBe(false);
    resetActiveDaysForTest();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(claimActiveDay("2026-11-06")).toBe(true);
    expect(claimActiveDay("2026-11-06")).toBe(false);
  });

  it("a clock or time zone moved back to a day already sent sends nothing (Nov 6, Nov 7, Nov 6 is two events)", () => {
    expect(claimActiveDay("2026-11-06")).toBe(true);
    expect(claimActiveDay("2026-11-07")).toBe(true);
    expect(claimActiveDay("2026-11-06")).toBe(false);
    expect(store.get(ACTIVE_DAY_KEY)).toBe("2026-11-06,2026-11-07");
    resetActiveDaysForTest();
    expect(claimActiveDay("2026-11-06")).toBe(false);
    expect(claimActiveDay("2026-11-07")).toBe(false);
  });

  it("an earlier single-day value still counts, and only the recent days are kept", () => {
    store.set(ACTIVE_DAY_KEY, "2026-11-01");
    expect(claimActiveDay("2026-11-01")).toBe(false);
    for (let d = 2; d <= 30; d++) claimActiveDay(`2026-11-${String(d).padStart(2, "0")}`);
    expect(store.get(ACTIVE_DAY_KEY)!.split(",")).toHaveLength(14);
  });

  it("turning analytics off after the watch started stops the next day's event", () => {
    const send = vi.fn();
    let on = true;
    let now = new Date(2026, 10, 6, 9);
    watchActiveDays({ canSend: () => on, send, now: () => now });
    expect(send).toHaveBeenCalledTimes(1);
    on = false;
    now = new Date(2026, 10, 7, 9);
    vi.advanceTimersByTime(ACTIVE_CHECK_MS);
    fire("focus");
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get(ACTIVE_DAY_KEY)).toBe("2026-11-06");
  });

  it("is wired from the analytics start as its own chunk, behind the switch", () => {
    const src = readFileSync(new URL("./analytics.ts", import.meta.url), "utf8");
    expect(src).toContain('import("./analytics-active")');
    expect(src).toContain("canSend: () => ready && analyticsEnabled()");
    expect(src).toContain('capture("app_active", { platform })');
    expect(src).not.toMatch(/^import .*analytics-active/m);
  });
});
