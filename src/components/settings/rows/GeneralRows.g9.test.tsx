// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 gap check H1 and H2, on the rendered rows. H1: an analytics choice the computer could not save says so, with a
// retry, instead of a switch that looks as if it stuck. H2: blurring a profile field writes nothing before the profile
// has been read, and nothing when no field changed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
let config: { profile?: { name: string; email: string } } | null = null;
const dispatch = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ state: { config }, dispatch }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));

import { AnalyticsRow, ProfileFields } from "./GeneralRows";
import { ANALYTICS_NOT_SAVED, analyticsEnabled } from "@/lib/analytics";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  api.mockReset();
  config = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
});
const mount = async (node: React.ReactNode) => { await act(async () => { root.render(node); }); };
const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const blur = async (node: HTMLElement) => { await act(async () => { node.focus(); node.blur(); }); };
const type = async (node: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("H1: an analytics choice that could not be saved", () => {
  it("turning analytics off on a full disk shows the switch Off, says it lasts only until restart, and retries", async () => {
    await mount(<AnalyticsRow />);
    const sw = container.querySelector('[aria-label="Send usage analytics"]') as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    await act(async () => { sw.click(); });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(analyticsEnabled()).toBe(false); // held for this session
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(ANALYTICS_NOT_SAVED);
    // Space freed: Try again saves the same choice (still Off) and the warning goes.
    full.mockRestore();
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => { retry.click(); });
    expect(localStorage.getItem("murage-analytics-opt-out")).toBe("1");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("a choice that saved shows no warning", async () => {
    await mount(<AnalyticsRow />);
    const sw = container.querySelector('[aria-label="Send usage analytics"]') as HTMLButtonElement;
    const wasOn = sw.getAttribute("aria-checked") === "true"; // the module keeps the previous test's session choice
    await act(async () => { sw.click(); });
    expect(localStorage.getItem("murage-analytics-opt-out")).toBe(wasOn ? "1" : "0");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("H2: profile fields never write without an edit", () => {
  it("before the profile is read, the fields are read-only and a blur writes nothing", async () => {
    await mount(<ProfileFields />);
    expect(input("Your name").readOnly).toBe(true);
    await blur(input("Your name"));
    await blur(input("Your email"));
    // Even a typed name is not sent before the read: it would go out with an empty email over the saved one.
    await type(input("Your name"), "Ann");
    await blur(input("Your name"));
    expect(api).not.toHaveBeenCalled();
  });

  it("after the read, focusing and leaving a field without an edit writes nothing, even with no saved profile", async () => {
    config = {}; // read, and this owner has no profile yet
    await mount(<ProfileFields />);
    await blur(input("Your name"));
    config = { profile: { name: "Ann Example ", email: "Ann@Example.test" } };
    await mount(<ProfileFields />);
    await blur(input("Your name"));
    await blur(input("Your email"));
    expect(api).not.toHaveBeenCalled();
  });

  it("an edited field is saved, with the other field kept as read", async () => {
    config = { profile: { name: "Ann", email: "ann@example.test" } };
    api.mockResolvedValue({ profile: { name: "Ann B", email: "ann@example.test" } });
    await mount(<ProfileFields />);
    await type(input("Your name"), "Ann B");
    await blur(input("Your name"));
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(api.mock.calls[0]![1].body)).toEqual({ profile: { name: "Ann B", email: "ann@example.test" } });
  });
});
