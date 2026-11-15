// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";
import type { Reachability } from "../../lib/cloud-workspace";
import { CloudUnreachableBanner } from "./CloudUnreachableBanner";

vi.mock("../../lib/cloud-workspace", async (original) => ({
  ...await original<typeof import("../../lib/cloud-workspace")>(),
  isCloudOrigin: () => true,
}));

const down: Reachability = { ok: false, code: "unreachable", message: "Your Cloud home isn't reachable" };
let answer: Reachability;
let reachable: ReturnType<typeof vi.fn>;
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.setSystemTime(0);
  answer = down;
  reachable = vi.fn(async () => answer);
  Object.defineProperty(window, "muragecloud", { configurable: true, value: { reachable } });
});
afterEach(() => {
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  Reflect.deleteProperty(window, "muragecloud");
});

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const start = async () => { mount(createElement(CloudUnreachableBanner)); await settle(); };
const reconnecting = () => {
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Reconnecting to your Cloud home");
  expect(document.querySelector('[role="alert"]')).toBeNull();
};
const unreachable = () => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Your Cloud home isn't reachable");
const networkChange = async () => { act(() => window.dispatchEvent(new Event("online"))); await settle(); };

describe("Cloud reconnect grace in the mounted banner", () => {
  it("a refused connection at desktop startup reconnects until exactly 150 seconds, then stays unreachable", async () => {
    await start();
    reconnecting();
    await advance(149_999);
    reconnecting();
    await advance(1);
    unreachable();
    await advance(150_000);
    unreachable();
  });

  it("a wall-clock rollback cannot extend the 150-second grace", async () => {
    await start();
    await advance(60_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await advance(89_999);
    reconnecting();
    await advance(1);
    unreachable();
    await networkChange();
    unreachable();
  });

  it("losing a reachable home during a restart, update or restore starts a fresh 150 seconds", async () => {
    answer = { ok: true };
    await start();
    expect(document.body.textContent).toBe("");
    answer = down;
    await advance(30_000);
    reconnecting();
    await advance(149_999);
    reconnecting();
    await advance(1);
    unreachable();
  });

  it("recovery during the boot wait returns to normal without an unreachable flash", async () => {
    await start();
    for (let elapsed = 0; elapsed < 117_000; elapsed += 3_000) {
      await advance(3_000);
      reconnecting();
    }
    answer = { ok: true };
    await advance(3_000);
    expect(document.body.textContent).toBe("");
    await advance(60_000);
    expect(document.body.textContent).toBe("");
    // Recovery rearms grace for a later, separate outage.
    answer = down;
    await advance(30_000);
    reconnecting();
  });

  it.each(["sign-in-refused", "needs-repair", "pin-mismatch", "version-mismatch", "not-paired"])("%s skips grace and cannot be softened by network events", async code => {
    answer = { ok: false, code, message: "Fixture refusal" };
    await start();
    unreachable();
    expect(document.body.textContent).toContain("Fixture refusal");
    await networkChange();
    unreachable();
    answer = down;
    await advance(8_000);
    unreachable();
  });

  it("a hard failure reported during grace ends it immediately", async () => {
    await start();
    reconnecting();
    answer = { ok: false, code: "sign-in-refused", message: "Fixture refusal" };
    await advance(3_000);
    unreachable();
  });

  it.each(["online", "offline", "wake"])("the existing %s path stays at 60 seconds", async event => {
    answer = { ok: true };
    await start();
    answer = down;
    if (event === "wake") {
      vi.setSystemTime(120_000);
      await advance(5_000);
    } else {
      act(() => window.dispatchEvent(new Event(event)));
      await settle();
    }
    reconnecting();
    await advance(59_999);
    reconnecting();
    await advance(1);
    unreachable();
  });

  it("repeated network changes cannot renew an outage's grace", async () => {
    await start();
    await advance(120_000);
    await networkChange();
    await advance(30_000);
    unreachable();
    await networkChange();
    unreachable();
  });

  it("the deadline still expires while a reachability check is pending", async () => {
    await start();
    await advance(147_000);
    let finish!: (value: Reachability) => void;
    reachable.mockImplementation(() => new Promise<Reachability>(resolve => { finish = resolve; }));
    await advance(3_000);
    unreachable();
    await advance(30_000);
    unreachable();
    await act(async () => { finish({ ok: true }); });
    expect(document.body.textContent).toBe("");
  });
});
