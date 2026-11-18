// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// G9 gap check H4 (LOCKED section 6): on one bot's page the app-wide search is there, and it reaches another bot's
// engine and an app-wide setting. The bot pane stays mounted under the results, so its unsaved edits survive.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";
import { initialState, reducer, type Action, type Bot } from "@/state/store";
import { resetSettingsModeForTest, setSettingsMode } from "@/lib/settings-mode";
import { LazyOverlay } from "../LazyOverlay";
import { SettingsModal } from "../SettingsModal";

const fixture = vi.hoisted(() => ({ state: {} as typeof initialState, dispatch: vi.fn<(action: Action) => void>() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: vi.fn(async () => { throw new Error("No network in the bot-page search fixture"); }),
}));
vi.mock("@/lib/use-surface", () => ({ useSurfaceState: () => ({ desktop: true, confirmed: true }), useDesktopSurface: () => true }));
// The bot pane itself is not under test: a stand-in that holds an unsaved draft.
vi.mock("@/lib/bot-settings-pane-load", () => {
  const Pane = ({ bot }: { bot: { name: string } }) => h("div", { "data-bot-pane-stub": bot.name }, h("input", { "aria-label": "Draft", defaultValue: "" }));
  return { loadBotSettingsPane: async () => ({ BotSettingsPane: Pane }), loadedBotSettingsPane: () => Pane };
});

// Basil is listed first, so only the open-bot ranking can put Pepper's rows above Basil's.
const bots = [{ id: "fixture-basil", name: "Basil" }, { id: "fixture-pepper", name: "Pepper" }] as unknown as Bot[];
const pepper = bots[1]!;
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  resetSettingsModeForTest();
  setSettingsMode("advanced");
  fixture.state = { ...initialState, bots, appSettingsOpen: false };
  fixture.dispatch.mockImplementation((action) => { fixture.state = reducer(fixture.state, action); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); resetSettingsModeForTest(); });

const window_ = () => h(LazyOverlay, { name: "settings", kind: "window", covers: "always", onDismiss: vi.fn(), onRetry: vi.fn() }, h(BotSettingsWindow, { bot: pepper }));
// SettingsModal's props default to {}, which createElement's overloads cannot see through; this names them.
const BotSettingsWindow = SettingsModal as (props: { bot?: Bot; onBotClose?: () => void }) => ReturnType<typeof SettingsModal>;
const search = () => document.querySelector<HTMLInputElement>("#settings-search");
async function type(value: string) {
  const input = search()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

describe("H4: one search on a bot's page", () => {
  it("is visible on Pepper's page and finds Basil's engine", async () => {
    mount(window_());
    await settle();
    const box = search();
    expect(box).not.toBeNull();
    expect(box!.closest("[hidden]")).toBeNull();
    expect(box!.closest(".hidden")).toBeNull();
    await type("engine");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-settings-result]")];
    expect(rows.some((row) => row.dataset.settingsResultBot === "fixture-basil" && row.dataset.settingsResult === "bot.model.model")).toBe(true);
    // Pepper's own row ranks above Basil's.
    const pepper = rows.findIndex((row) => row.dataset.settingsResultBot === "fixture-pepper");
    const basil = rows.findIndex((row) => row.dataset.settingsResultBot === "fixture-basil");
    expect(pepper).toBeGreaterThanOrEqual(0);
    expect(pepper).toBeLessThan(basil);
  });

  it("finds an app-wide setting, and the bot pane with its draft stays mounted under the results", async () => {
    mount(window_());
    await settle();
    const draft = document.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
    draft.value = "unsaved words";
    await type("language");
    expect([...document.querySelectorAll<HTMLElement>("[data-settings-result]")].some((row) => row.dataset.settingsResult === "general.language" && !row.dataset.settingsResultBot)).toBe(true);
    expect(document.querySelector('[data-bot-pane-stub="Pepper"]')?.closest("[hidden]")).not.toBeNull();
    await type("");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!.value).toBe("unsaved words");
    expect(document.querySelector('[data-bot-pane-stub="Pepper"]')?.closest("[hidden]")).toBeNull();
  });
});
