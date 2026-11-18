// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Renderer owner: salv-spend. Endpoint/status owner: salv-spend.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpendPauseStatus } from "../../shared/spend-pause";

const f = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), pause: null as SpendPauseStatus | null }));
vi.mock("@/state/store", () => ({ api: f.api }));
vi.mock("@/components/today/MonthCard", () => ({
  useMonthReading: () => ({ show: true, pause: f.pause, total: { state: "pending" }, state: { limitUsd: 100 }, refresh: f.refresh }),
  monthLine: () => "Spending pending",
}));
vi.mock("@/components/today/MonthCardView", () => ({ asOfLine: () => "" }));
import { SpendPauseCard, ComposerSpendPause } from "../components/SpendPauseCard";
import { SpendLimitCard } from "../components/SpendLimitCard";

const held = (): SpendPauseStatus => ({ capability: "on", limitUsd: 100, figure: null, headsUpOnlyNotice: false, held: [{ credentialId: "account", holds: [{ kind: "limit" }] }] });
let root: Root, host: HTMLDivElement;
const button = (name: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === name);
  expect(found, name).toBeDefined(); return found!;
};
const click = async (name: string) => { await act(async () => button(name).click()); };
const renderCard = async () => { await act(async () => root.render(createElement(SpendPauseCard, { status: f.pause, onOpenUsage: vi.fn(), onRefresh: f.refresh }))); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.api.mockReset(); f.refresh.mockReset(); f.pause = held();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("Check again waits for the server and never hides a still-held card optimistically", async () => {
  let settle!: () => void;
  f.api.mockImplementation(() => new Promise<void>(resolve => { settle = resolve; }));
  await renderCard(); await click("Check again");
  expect(f.api).toHaveBeenCalledExactlyOnceWith("/api/spend/check", { method: "POST", body: "{}" });
  expect(button("Checking…").disabled).toBe(true);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(host.textContent).toContain("You reached your $100 monthly limit.");
  await act(async () => settle());
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(host.querySelector("[data-spend-pause]")).not.toBeNull();
});

it("a failed check shows plain recovery copy, keeps the card and allows another check", async () => {
  f.api.mockRejectedValueOnce(new Error("Cannot read properties of undefined at /internal/worker.ts:7"));
  await renderCard(); await click("Check again");
  // MAIN RULING INT-CONFLICT-DEFAULT: pin the existing translated fallback, retaining the raw-path/error redaction assertion.
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not save that. Try again.");
  expect(host.textContent).not.toContain("/internal/worker.ts");
  expect(button("Check again").disabled).toBe(false);
  expect(f.refresh).not.toHaveBeenCalled();
  f.api.mockResolvedValueOnce({}); await click("Check again");
  expect(f.refresh).toHaveBeenCalledTimes(1);
});

it("Raise limit focuses the saved owner control; Save and Remove use the guarded endpoint and refresh readers", async () => {
  f.api.mockResolvedValue({});
  await act(async () => root.render(createElement(SpendLimitCard)));
  await click("Raise limit");
  expect(document.activeElement).toBe(host.querySelector("input"));
  await click("Save limit");
  expect(f.api).toHaveBeenLastCalledWith("/api/spend/limit", { method: "PUT", body: '{"monthlyLimitUsd":100}' });
  await click("Remove limit");
  expect(f.api).toHaveBeenLastCalledWith("/api/spend/limit", { method: "PUT", body: '{"monthlyLimitUsd":null}' });
  expect(f.refresh).toHaveBeenCalledTimes(2);
});

it("acknowledging capability loss uses its guarded endpoint and refreshes after acceptance", async () => {
  f.pause = { ...held(), capability: "off", held: [], headsUpOnlyNotice: true };
  f.api.mockResolvedValue({}); await renderCard(); await click("OK");
  expect(f.api).toHaveBeenCalledExactlyOnceWith("/api/spend/notice/dismiss", { method: "POST", body: "{}" });
  expect(f.refresh).toHaveBeenCalledTimes(1);
});

it("the composer shows only its current credential and never a different account's hold", async () => {
  f.pause!.held.push({ credentialId: "bank:secondary", holds: [{ kind: "unknown" }] });
  await act(async () => root.render(createElement(ComposerSpendPause, { model: "native", onOpenUsage: vi.fn() })));
  expect(host.querySelector("[data-spend-pause]")).toBeNull();
  await act(async () => root.render(createElement(ComposerSpendPause, { model: "flux-fast", connectionId: "secondary", onOpenUsage: vi.fn() })));
  expect(host.textContent).toContain("cannot read Flux Router");
  expect(host.textContent).not.toContain("You reached");
  await act(async () => root.render(createElement(ComposerSpendPause, { model: "flux-fast", onOpenUsage: vi.fn() })));
  expect(host.textContent).toContain("You reached");
  expect(host.textContent).not.toContain("cannot read Flux Router");
});
