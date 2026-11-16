// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import help from "../locales/en-help/screens.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotSettingsPane, type BotSettingsLeave } from "@/components/BotSettingsPane";
import { initialState, reducer, useStore, type Action, type AppState, type Bot } from "@/state/store";
import { SETTINGS_INDEX } from "./settings-index";
import { searchSettingsIndex } from "./settings-search";
import { parseSettingsAddress, settingsAddressFor } from "./settings-address";
import { openSettingsAddress } from "./open-settings-address";
import { setSettingsMode, settingsMode } from "./settings-mode";
import { registerBotPageLeave } from "./settings-leave";

const bridge = vi.hoisted(() => ({ value: null as unknown, listeners: new Set<() => void>(), api: vi.fn() }));
vi.mock("@/state/store", async importOriginal => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  const useStore = () => useSyncExternalStore((fn) => { bridge.listeners.add(fn); return () => { bridge.listeners.delete(fn); }; }, () => bridge.value);
  return { ...actual, useStore, useStoreIfAny: useStore, useStoreActions: () => ({ dispatch }), api: bridge.api };
});
vi.mock("./use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("./bot-email", async importOriginal => ({ ...await importOriginal<typeof import("./bot-email")>(), useEmailStatus: () => ({ kind: "off" }) }));
vi.mock("./use-ensure-task", () => ({ useOlderTasks: () => ({ load: vi.fn(), loading: false, hasMore: false }) }));

const id = "bot.memory.clear-revoked-marks", anchor = "bot-setting-clear-revoked-marks";
const bots = Array.from({ length: 20 }, (_, i) => ({ id: `bot:${i}`, name: i === 0 ? "Nova" : `Bot ${i}`, modelSelection: { instanceId: "fake" }, tasks: [], description: "", title: "", continuity: false, computer: "none" })) as unknown as Bot[];
let state: AppState, root: Root, host: HTMLDivElement;
const leaveRef: { current: BotSettingsLeave | null } = { current: null };
let unregister: () => void;
const dispatch = (action: Action) => {
  state = reducer(state, action); publish();
};
function publish() { bridge.value = { state, dispatch }; bridge.listeners.forEach(fn => fn()); }
function Harness() {
  // The real pane and SettingsPanel are mounted; only API and ambient app state are fixtures.
  const value = useStore();
  const bot = bots.find(bot => bot.id === (value.state.settingsBotId ?? value.state.selectedId))!;
  return createElement(BotSettingsPane, { bot, leaveRef, onClose: () => dispatch({ type: "toggleSettings", open: false }) });
}
async function render() { await act(async () => { publish(); root.render(createElement(Harness)); }); }
async function open(botId = bots[1].id) {
  await act(async () => { openSettingsAddress(parseSettingsAddress(`murage://settings/bot/${encodeURIComponent(botId)}/memory/clear-revoked-marks`)!, { botIds: bots.map(b => b.id), selectedBotId: state.selectedId }, dispatch); });
  await render();
}
function button(label: string) { const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === label); expect(found, label).toBeDefined(); return found!; }

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); setSettingsMode("simple");
  state = { ...initialState, bots, selectedId: bots[0].id, settingsBotId: bots[0].id, settingsOpen: true, botSettingsIntent: { section: "memory" } };
  bridge.api.mockReset(); bridge.api.mockImplementation(async (path: string) => path.endsWith("/memory") ? { text: "saved notes", revision: "r1", topics: [], truncated: false } : {});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.scrollTo = vi.fn();
  unregister = registerBotPageLeave(() => leaveRef.current);
});
afterEach(async () => { await act(async () => root.unmount()); unregister(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("GH18 Settings destination", () => {
  it("gh18_one_home_exact_search_destination", () => {
    const entries = SETTINGS_INDEX.filter(e => e.id === id); expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: "bot", section: "memory", anchor, advanced: true, surface: "desktop" });
    expect(settingsAddressFor(entries[0], bots[0].id)).toBe("murage://settings/bot/bot%3A0/memory/clear-revoked-marks");
    for (const query of ["clear revoked marks", "old memory blocks", "memory blocked", "bot refuses", "reply stuck", "recover memory", "start fresh"]) {
      const result = searchSettingsIndex(`Nova ${query}`, { desktop: true, cloud: false, bots });
      expect(result.hits.some(hit => hit.entry.id === id && hit.bot?.id === bots[0].id), query).toBe(true);
    }
    const actions: Action[] = [];
    expect(openSettingsAddress({ scope: "bot", botId: null, section: "memory", name: "clear-revoked-marks" }, { botIds: bots.map(b => b.id), selectedBotId: null }, a => actions.push(a))).toBe(false);
    expect(actions).toEqual([]);
  });
  it("gh18_simple_deep_link_preserves_bot", async () => {
    await render(); expect(button("Set in Advanced")).toBeDefined();
    await act(async () => button("Set in Advanced").click()); await render();
    expect(state.settingsBotId).toBe(bots[0].id); expect(settingsMode()).toBe("advanced");
    expect(document.querySelectorAll(`[data-setting="${id}"]`)).toHaveLength(1);
    expect(document.getElementById(anchor)).not.toBeNull();
    expect(bridge.api.mock.calls.some(([p]) => String(p).includes("fresh-start"))).toBe(false);
  });
  it("the Simple link returns to the displayed Settings bot when another chat is selected", async () => {
    state = { ...state, settingsBotId: bots[1].id, selectedId: bots[0].id };
    await render(); await act(async () => button("Set in Advanced").click());
    expect(state.settingsBotId).toBe(bots[1].id);
    await act(async () => button("Back").click());
    expect(state.settingsBotId).toBe(bots[1].id); expect(settingsMode()).toBe("simple");
  });
  it("gh18_search_opens_advanced_anchor_via_real_opener", async () => {
    await render(); await open();
    expect(settingsMode()).toBe("advanced"); expect(state.settingsBotId).toBe(bots[1].id);
    const target = document.getElementById(anchor); expect(target).not.toBeNull();
    expect(document.activeElement).toBe(target); expect(target?.classList.contains("ring-accent")).toBe(true);
    expect(state.botSettingsIntent).toBeNull();
    await render();
    expect(state.botSettingsIntent).toBeNull();
  });
  it("gh18_back_restores_simple_mode_and_bot", async () => {
    await render(); await open();
    await act(async () => button("Back").click()); await render();
    expect(settingsMode()).toBe("simple"); expect(state.settingsBotId).toBe(bots[0].id);
    expect(document.querySelector('[data-settings-section="memory"]')?.hasAttribute("hidden")).toBe(false);
    await open();
    await act(async () => document.getElementById(anchor)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await render();
    expect(settingsMode()).toBe("simple"); expect(state.settingsBotId).toBe(bots[0].id);
  });
  it("closing settings clears the temporary Back destination", async () => {
    await render(); await open(); expect(button("Back")).toBeDefined();
    await act(async () => root.render(null));
    state = { ...state, settingsOpen: false }; await render();
    expect([...document.querySelectorAll("button")].some(b => b.textContent === "Back")).toBe(false);
  });
  it("gh18_unsaved_edit_no_keeps_mode", async () => {
    await render();
    const notebook = document.querySelector<HTMLButtonElement>("#bot-setting-notebook button")!;
    await act(async () => notebook.click());
    const text = document.querySelector<HTMLTextAreaElement>("#bot-setting-notebook textarea")!;
    expect(text).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(text, "unsaved words");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open(); expect(confirm).toHaveBeenCalled();
    expect(settingsMode()).toBe("simple"); expect(state.settingsBotId).toBe(bots[0].id);
    expect(document.querySelector('[data-settings-section="memory"]')?.hasAttribute("hidden")).toBe(false);
    expect(text.value).toBe("unsaved words");
  });
  it("gh18_existing_memory_controls_and_help_survive", async () => {
    await render();
    for (const existing of ["bot-setting-memory", "bot-setting-notebook"]) expect(document.getElementById(existing)).not.toBeNull();
    expect(document.body.textContent).toContain("Continuity");
    expect(help["ux.l4a.screen.bot.memory.tip1"]).toBe("Delete a memory and {name} stops using it.");
    expect(help["ux.l4a.screen.bot.memory.intro"]).toContain("Start fresh");
    expect(document.body.textContent).toContain("Legacy notebook");
  });
});
