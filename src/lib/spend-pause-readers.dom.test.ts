// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader/renderer owner: salv-spend. Spend status producer owner: salv-spend.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpendPauseStatus } from "../../shared/spend-pause";
const f = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), spend: { monthlyLimitUsd: 100, headsUpLeft: null, keyFingerprint: "key" as string | null, pauseFingerprint: "inventory" } }));
vi.mock("@/state/store", () => ({ api: f.api, useStore: () => ({ state: { config: { flux: { configured: true }, spend: f.spend } }, dispatch: f.dispatch }) }));
import { resetMeterGatesForTest, useMonthReading, useMonthNeedsRow, useMonthTag } from "../components/today/MonthCard";
let root: Root, host: HTMLDivElement, pause: SpendPauseStatus;
let reading: ReturnType<typeof useMonthReading>, needs: ReturnType<typeof useMonthNeedsRow>, tag: ReturnType<typeof useMonthTag>;
function Probe() {
  reading = useMonthReading(); needs = useMonthNeedsRow(() => {}); tag = useMonthTag();
  return createElement("div", null, JSON.stringify({ total: reading.total, needs, tag }));
}
const mount = async () => { await act(async () => root.render(createElement(Probe))); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetMeterGatesForTest(); f.api.mockReset(); f.spend.keyFingerprint = "key";
  pause = { capability: "on", limitUsd: 100, figure: { month: "2026-11", asOf: "2026-11-14T00:00:00Z", spentUsd: 100 }, headsUpOnlyNotice: false, held: [] };
  f.api.mockImplementation(async () => ({ fingerprint: f.spend.keyFingerprint, pauseFingerprint: "inventory", total: { state: "ok", spentUsd: 100, asOf: "2026-11-14T00:00:00Z", resetsAt: "2026-12-01T00:00:00Z" }, pause }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetMeterGatesForTest(); });
it("Today labels an active account-wide figure as account spend", async () => {
  await mount(); expect(tag?.text).toBe("Account spend through Flux Router: $100 of $100 · 100%");
});
it("a saved Flux connection without a legacy key still shows its account figure", async () => {
  f.spend.keyFingerprint = null; await mount();
  expect(reading.total).toMatchObject({ state: "ok", spentUsd: 100 });
  expect(tag?.text).toContain("Account spend");
});
it("Needs you scopes an email-only hold instead of claiming all Flux work waits", async () => {
  pause.held = [{ credentialId: "bot:fixture", botName: "Sam", emailOnly: true, holds: [{ kind: "flux", limit: "bot_monthly_spend" }] }];
  await mount(); expect(needs?.line).toBe("Only Sam's email waits.");
});
it("an accepted owner action refreshes every mounted reader", async () => {
  pause.held = [{ credentialId: "account", holds: [{ kind: "limit" }] }];
  await mount(); const before = f.api.mock.calls.length;
  expect(before).toBe(3); expect(reading.pause?.held).toHaveLength(1);
  pause = { ...pause, held: [] };
  await act(async () => reading.refresh());
  expect(f.api.mock.calls.length).toBe(before + 3);
  expect(reading.pause?.held).toEqual([]);
});
