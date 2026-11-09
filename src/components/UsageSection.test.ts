// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/settings-copy";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: vi.fn() }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ dispatch }) }));
import { api } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { UsageLearningCard } from "./UsageSection";

const status = (inputUsed = 2_000_000) => ({ learning: {
  ceiling: { month: "2026-11", input: 100_000_000, output: 15_000_000, inputUsed, outputUsed: 300_000, paused: false },
  connection: { source: "chosen", label: "Fixture" },
} });
async function click(name: string) {
  const button = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === name);
  expect(button, name).toBeDefined();
  await act(async () => { button!.click(); });
}
const bars = () => Array.from(document.querySelectorAll('[role="progressbar"]'), (bar) => ({ label: bar.getAttribute("aria-label"), value: bar.getAttribute("aria-valuenow") }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { vi.mocked(api).mockReset(); dispatch.mockReset(); vi.mocked(useDesktopSurface).mockReturnValue(true); });
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("Usage learning read states", () => {
  it("reads phone learning usage and renders bars without a change-limit button", async () => {
    vi.mocked(useDesktopSurface).mockReturnValue(false);
    vi.mocked(api).mockResolvedValue(status());
    mount(createElement(UsageLearningCard)); await settle();
    expect(bars()).toEqual([{ label: "Read: 2M of 100M", value: "2" }, { label: "Written: 300k of 15M", value: "2" }]);
    expect(document.body.textContent).toContain("Runs on Fixture.");
    expect(document.body.textContent).not.toContain("Change the limit");
    expect(document.querySelector('[data-setting-control="usage-learning-heading"]')).toBeNull();
    await click("Refresh");
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls.every(([path, init]) => path === "/api/memory/learning-usage" && !init?.method)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("waits for the surface before requesting learning usage", () => {
    vi.mocked(useDesktopSurface).mockReturnValue(undefined);
    mount(createElement(UsageLearningCard));
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(api).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Change the limit");
  });

  it("announces loading, then shows an unavailable surface without invented meters", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mount(createElement(UsageLearningCard));
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(document.body.textContent).toContain("Memory learning this month");
    expect(bars()).toEqual([]);
    await act(async () => { resolve({}); });
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Not available here.");
    expect(bars()).toEqual([]);
  });

  it.each([403, 404, 410])("names an unavailable surface for HTTP %s", async (code) => {
    vi.mocked(api).mockRejectedValue(Object.assign(new Error("Unavailable"), { status: code }));
    mount(createElement(UsageLearningCard)); await settle();
    expect(document.body.textContent).toContain("Not available here.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(bars()).toEqual([]);
  });

  it.each([undefined, 401, 500])("retries a failed initial read (%s) and preserves the limit link", async (code) => {
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error("offline"), { status: code })).mockResolvedValueOnce(status());
    mount(createElement(UsageLearningCard)); await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not load learning usage. Try again.");
    expect(document.body.textContent).not.toContain("Not available here.");
    expect(bars()).toEqual([]);
    await click("Retry");
    expect(bars()).toEqual([{ label: "Read: 2M of 100M", value: "2" }, { label: "Written: 300k of 15M", value: "2" }]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await click("Change the limit");
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "usage", anchor: "memory-limit-heading" });
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls.every(([path, init]) => path === "/api/memory/status" && !init?.method)).toBe(true);
  });

  it("keeps the last values, connection and timestamp after refresh fails, then recovers", async () => {
    const checkedAt = Date.UTC(2026, 10, 10, 12);
    const clock = vi.spyOn(Date, "now").mockReturnValue(checkedAt);
    vi.mocked(api).mockResolvedValueOnce(status()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(status(3_000_000));
    mount(createElement(UsageLearningCard)); await settle();
    const previous = bars();
    clock.mockReturnValue(checkedAt + 60_000);
    await click("Refresh");
    expect(bars()).toEqual(previous);
    const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("Could not load learning usage.");
    expect(alert).toMatch(/Showing last-known values from .+\. They may be out of date\./);
    expect(alert).toContain(new Date(checkedAt).toLocaleString());
    expect(document.body.textContent).toContain("Runs on Fixture.");
    await click("Retry");
    expect(bars()[0]).toEqual({ label: "Read: 3M of 100M", value: "3" });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("last-known");
  });

  it("aborts the pending read when the card unmounts", async () => {
    vi.mocked(api).mockImplementationOnce(() => new Promise(() => {}));
    const app = mount(createElement(UsageLearningCard));
    const signal = vi.mocked(api).mock.calls[0]![1]?.signal;
    expect(signal?.aborted).toBe(false);
    app.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
