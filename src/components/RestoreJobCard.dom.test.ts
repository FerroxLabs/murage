// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The restore status card, live: the surface check, the OK press, and the re-read on a reconnect or a Check again (Fable M2). No interval polling.
import { act, createElement as h, useSyncExternalStore } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return { api: vi.fn(), desktop: true, connected: true, listeners, set(value: boolean) { fixture.connected = value; listeners.forEach(l => l()); } };
});
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStoreSelector: (selector: (s: { connected: boolean }) => unknown) => useSyncExternalStore(
    l => { fixture.listeners.add(l); return () => fixture.listeners.delete(l); }, () => selector({ connected: fixture.connected })),
}));
vi.mock("@/lib/surface", () => ({ isDesktopSurface: async () => fixture.desktop }));
import { RestoreJobCard } from "./RestoreJobCard";

const action = { label: "OK", method: "POST", path: "/api/restore-job/dismiss" };
const abortedStatus = { state: "aborted", code: "aborted", line: "x", action };
const none = { state: "none", code: null, line: null, action: null };
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.desktop = true; fixture.connected = true; fixture.api.mockReset().mockResolvedValue(abortedStatus); });
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); vi.useRealTimers(); });

const reads = () => fixture.api.mock.calls.filter(([path, init]) => path === "/api/restore-job/status" && !init).length;
const button = () => document.querySelector("[data-restore-job] button") as HTMLButtonElement | null;
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); await settle(); }

describe("RestoreJobCard live", () => {
  it("S1: a desktop surface gets OK, a phone gets the line and no button", async () => {
    mount(h(RestoreJobCard)); await settle(); await settle();
    expect(button()?.textContent).toBe("OK");
    cleanup(); fixture.desktop = false;
    mount(h(RestoreJobCard)); await settle(); await settle();
    expect(document.querySelector("[data-restore-job]")).not.toBeNull();
    expect(button()).toBeNull();
    expect(document.querySelector("[data-restore-job]")!.textContent).toContain("The owner can select OK in Murage on their computer");
  });
  it("S4: OK is disabled while the press is in flight, then the card hides", async () => {
    let release!: (v: unknown) => void;
    fixture.api.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST" ? new Promise(r => { release = r; }) : abortedStatus);
    mount(h(RestoreJobCard)); await settle(); await settle();
    act(() => { button()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(button()!.disabled).toBe(true);
    await act(async () => { release(none); });
    await settle(); await settle();
    expect(document.querySelector("[data-restore-job]")).toBeNull();
    expect(fixture.api).toHaveBeenCalledWith("/api/restore-job/dismiss", { method: "POST" });
  });
  it("S3: a refused press re-reads and the card keeps the aborted line", async () => {
    fixture.api.mockImplementation(async (_path: string, init?: RequestInit) => { if (init?.method === "POST") throw new Error("409"); return abortedStatus; });
    mount(h(RestoreJobCard)); await settle(); await settle();
    await click(button()!);
    expect(document.querySelector("[data-restore-job]")).not.toBeNull();
    expect(reads()).toBe(2);
  });
  it("M2: reads once on mount, again on the rising edge of connected, never on a fall or a steady state", async () => {
    mount(h(RestoreJobCard)); await settle(); await settle();
    expect(reads()).toBe(1);
    await act(async () => { fixture.set(true); }); await settle();
    expect(reads()).toBe(1);
    await act(async () => { fixture.set(false); }); await settle(); await settle();
    expect(reads()).toBe(1);
    fixture.api.mockResolvedValue(none);
    await act(async () => { fixture.set(true); }); await settle(); await settle();
    expect(reads()).toBe(2);
    expect(document.querySelector("[data-restore-job]")).toBeNull();
  });
  it("M2: a new refreshKey (Check again) re-reads once", async () => {
    const app = mount(h(RestoreJobCard, { refreshKey: 0 })); await settle(); await settle();
    expect(reads()).toBe(1);
    app.rerender(h(RestoreJobCard, { refreshKey: 0 })); await settle();
    expect(reads()).toBe(1);
    app.rerender(h(RestoreJobCard, { refreshKey: 1 })); await settle(); await settle();
    expect(reads()).toBe(2);
  });
  it("M2: no interval polling", async () => {
    vi.useFakeTimers();
    mount(h(RestoreJobCard)); await settle(); await settle();
    const before = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
    expect(reads()).toBe(before);
  });
});
