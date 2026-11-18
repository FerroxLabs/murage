// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 gap check H5: two of the bar's tasks open the card that answers them, proved on the rendered card, not by id.
// "What have I spent" lands on the card that shows the month's amount in dollars; "use my Chrome" lands on the control
// that picks the owner's Chrome, not on the built-in browser's permission switch. The landing helper is the real one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchSettingsIndex } from "./settings-search";
import { landingControl } from "./settings-landing";
import { setLocale, t } from "./i18n";
import { readFileSync } from "node:fs";

const choose = vi.fn();

// The month reading is the meter's own hook (GET /api/spend); here it answers with a known amount.
vi.mock("@/components/today/MonthCard", async (original) => ({
  ...await original<typeof import("@/components/today/MonthCard")>(),
  useMonthReading: () => ({
    show: true, refresh: vi.fn(), pause: null,
    total: { state: "ok", spentUsd: 12.34, asOf: "2026-11-18T03:00:00Z", resetsAt: "2026-12-01T00:00:00Z" },
    state: { limitUsd: null, percent: null },
  }),
}));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: vi.fn(async () => ({})), useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }) }));

import { SpendLimitCard } from "@/components/SpendLimitCard";
import { BrowserChoiceView } from "@/components/BrowserChoice";

const CONTEXT = { desktop: true, cloud: false, bots: [{ id: "b-nova", name: "Nova" }] };
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("H5: the named tasks open the answer", () => {
  it("'what have I spent' opens the card that shows this month's amount in dollars", async () => {
    const hit = searchSettingsIndex("what have I spent", CONTEXT).hits[0]!;
    expect(hit.entry.id).toBe("usage.spend-limit");
    // The card the hit lands on, mounted the way the Usage page mounts it (anchor = the hit's anchor).
    await act(async () => { root.render(<section id={hit.entry.anchor}><SpendLimitCard /></section>); });
    const card = container.querySelector(`#${hit.entry.anchor}`)!;
    expect(card.querySelector('[data-testid="spend-month"]')?.textContent).toMatch(/\$12\.34/);
  });

  it("'use my Chrome' lands on the Browser choice row that holds Your Chrome, not on the built-in browser switch", async () => {
    const hit = searchSettingsIndex("use my chrome", CONTEXT).hits[0]!;
    expect(hit.entry.id).toBe("bot.access.browser-choice");
    expect(hit.entry.anchor).toBe("bot-setting-browser-choice");
    // The bot page renders this row id around the Browser choice (SettingsPanel.tsx), apart from #bot-setting-browser.
    const panel = readFileSync("src/components/SettingsPanel.tsx", "utf8"); // vitest runs at the repo root
    expect(panel).toMatch(/<div id="bot-setting-browser-choice" data-setting="bot.access.browser-choice"><BrowserChoice /);
    await act(async () => { root.render(<div id={hit.entry.anchor}><BrowserChoiceView name="Nova" mode="builtin" choose={choose} /></div>); });
    const landed = landingControl(container.querySelector<HTMLElement>(`#${hit.entry.anchor}`)!, document) as HTMLElement;
    const chrome = [...landed.querySelectorAll("button")].find((button) => button.textContent === t("browser.BrowserChoice.2"))!;
    expect(chrome).toBeTruthy();
    await act(async () => { chrome.click(); });
    expect(choose).toHaveBeenCalledWith({ mode: "your-chrome" });
  });
});
