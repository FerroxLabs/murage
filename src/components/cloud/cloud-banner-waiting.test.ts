// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// J5b r8 T20 (ruling 8, customer status line): the Cloud window's status band says plainly that some activity updates are waiting to be saved while the home's
// /api/health opsAlertsWaiting is above 0, and clears at the first poll that reads 0. Drives the REAL CloudUnreachableBanner with mocked reachability and api.
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, installDOMHarness, mount } from "../../testing/dom-harness";

const LINE = "Some activity updates are waiting to be saved; nothing to do";
const state = { waiting: 0, failRead: false, reachable: true, healthGate: undefined as Promise<void> | undefined };
vi.mock("@/lib/cloud-workspace", () => ({ checkReachable: async () => state.reachable ? { ok: true } : { ok: false, code: "unreachable", message: "offline" }, isCloudOrigin: () => true }));
vi.mock("@/state/store", () => ({ api: vi.fn(async () => { if (state.healthGate) await state.healthGate; if (state.failRead) throw new Error("offline"); return { opsAlertsWaiting: state.waiting }; }) }));

let restore = () => undefined as void;
beforeAll(() => { restore = installDOMHarness() as () => void; });
afterAll(() => restore());
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.waiting = 0; state.failRead = false; state.reachable = true; state.healthGate = undefined; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = async () => { const { act } = await import("react"); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const advance = async (ms: number) => { const { act } = await import("react"); await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const band = () => document.querySelector('[role="status"]');

describe("T20 owner line follows outboxDegraded", () => {
  it("health reporting keeps polling reachability while a health read is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    let release = () => {};
    state.healthGate = new Promise<void>(resolve => { release = resolve; });
    const { api } = await import("@/state/store");
    const { CloudUnreachableBanner } = await import("./CloudUnreachableBanner");
    try {
      mount(createElement(CloudUnreachableBanner));
      await flush();
      expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
      state.reachable = false;
      await advance(30_000);
      expect(band()?.textContent).toBe("Reconnecting to your Cloud home");
      await advance(150_000);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Your Cloud home isn't reachable");
      expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await flush();
    }
  });

  it("shows the exact line in a polite status band while opsAlertsWaiting is above 0, and clears at the next poll that reads 0", async () => {
    state.waiting = 2;
    const { CloudUnreachableBanner } = await import("./CloudUnreachableBanner");
    mount(createElement(CloudUnreachableBanner));
    await flush();
    expect(band()?.textContent, "the line is shown (base renders nothing when the home answers)").toBe(LINE);
    expect(band()?.getAttribute("aria-live")).toBe("polite");
    state.waiting = 0;
    await advance(30_000);
    expect(band(), "MU-H3: the line clears at 0").toBeNull();
  });
  it("shows nothing while opsAlertsWaiting is 0 (guard)", async () => {
    const { CloudUnreachableBanner } = await import("./CloudUnreachableBanner");
    mount(createElement(CloudUnreachableBanner));
    await flush();
    expect(band()).toBeNull();
  });
  it("a failed health read keeps the line for one tick, then shows nothing", async () => {
    state.waiting = 1;
    const { CloudUnreachableBanner } = await import("./CloudUnreachableBanner");
    mount(createElement(CloudUnreachableBanner));
    await flush();
    state.failRead = true;
    await advance(30_000);
    expect(band()?.textContent).toBe(LINE);
    await advance(30_000);
    expect(band()).toBeNull();
  });
});
