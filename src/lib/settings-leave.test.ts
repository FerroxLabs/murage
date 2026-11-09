// The one way out of a bot's settings page (UX-L3B S7, designs/UX-L3B-S7-CHOKE-1019.md): with unsaved edits on the page,
// every opener that would take it away (Cmd/Ctrl+, the avatar card's "settings", a Settings address, the shell's pages)
// asks the page's question first; "No" changes nothing, "Yes" runs the opener once.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reducer, initialState, type Action, type AppState } from "@/state/store";
import { BOT_PAGE_LEAVE_ACTIONS, holdForBotPage, leaveBotPage, leavesBotPage, passThrough, registerBotPageLeave, settingsOpener, type BotPageLeave } from "./settings-leave";
import { openSettingsAddress } from "./open-settings-address";
import { parseSettingsAddress } from "./settings-address";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const bots = [{ id: "nova", name: "Nova" }, { id: "pepper", name: "Pepper" }] as unknown as AppState["bots"];
const base = { ...initialState, bots, selectedId: "nova" } as AppState;
const open = reducer(base, { type: "toggleSettings", open: true });

/** A dirty bot page whose question is answered `answer`; returns how often it asked. */
function dirtyPage(answer: boolean) {
  const asked = vi.fn();
  // Mirrors BotSettingsPane's navigate: ask on unsaved edits, then run through passThrough.
  const page: BotPageLeave = (operation) => { asked(); if (answer) passThrough(operation); };
  const unregister = registerBotPageLeave(() => page);
  return { asked, unregister };
}

/** The store's wrapped dispatch, reduced to its first line and the reducer. */
function storeDispatch(start: AppState) {
  let state = start;
  const applied: Action[] = [];
  const dispatch = (action: Action): void => {
    if (holdForBotPage(state, action, () => dispatch(action))) return;
    applied.push(action);
    state = reducer(state, action);
  };
  return { dispatch, applied, get state() { return state; } };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe("one way out of a bot's settings page", () => {
  it("the store's dispatch asks first, the window registers its bot page, and the page runs an answered leave through passThrough", () => {
    expect(read("../state/store.tsx")).toContain("if (holdForBotPage(stateRef.current, action, () => wrapped(action))) return;");
    expect(read("../components/SettingsModal.tsx")).toContain("registerBotPageLeave(() => botLeave.current)");
    expect(read("../components/BotSettingsPane.tsx")).toContain("passThrough(operation);");
    // Cmd/Ctrl+, and the avatar card's settings button dispatch through the store (no private path round it).
    expect(read("../App.tsx")).toContain('dispatch({ type: "toggleAppSettings", open: true });');
    expect(read("../components/BotProfileAvatarCard.tsx")).toContain('dispatch({ type: "toggleAppSettings", open: true, section: "models" })');
  });

  it("BOT_PAGE_LEAVE_ACTIONS lists every reducer case that closes the bot window", () => {
    const store = read("../state/store.tsx");
    const body = store.slice(store.indexOf("function reduceState("), store.indexOf("/** Newest screen frames"));
    const parts = body.split(/\n {4}case "([A-Za-z]+)":/);
    const writers = new Set<string>();
    for (let i = 1; i < parts.length; i += 2) if (/settingsOpen\s*:|SHELL_OVERLAYS_CLOSED/.test(parts[i + 1] ?? "")) writers.add(parts[i]);
    expect(writers.size).toBeGreaterThan(5);
    expect([...writers].sort()).toEqual([...BOT_PAGE_LEAVE_ACTIONS].sort());
  });

  const entryPoints: [string, Action][] = [
    ["Cmd/Ctrl+, (App.tsx)", { type: "toggleAppSettings", open: true }],
    ["the avatar card's settings (BotProfileAvatarCard.tsx)", { type: "toggleAppSettings", open: true, section: "models" }],
    ["Close", { type: "toggleSettings", open: false }],
    ["another bot", { type: "toggleSettings", open: true, botId: "pepper" }],
    ["the computer", { type: "toggleComputer", open: true }],
    ["the inspector", { type: "toggleInspector", open: true }],
    ["Today", { type: "showToday" }],
    ["Needs you", { type: "showNeedsYou" }],
    ["Health", { type: "showHealth" }],
    ["Routines", { type: "showRoutines" }],
    ["the Team map", { type: "showTeamMap" }],
    ["All chats", { type: "showAllChats" }],
    ["the skill recorder", { type: "showSkillRecorder" }],
  ];
  it.each(entryPoints)("%s with unsaved edits asks; No keeps the page, Yes runs it once", (_name, action) => {
    expect(leavesBotPage(open, action)).toBe(true);
    const no = dirtyPage(false); cleanup = no.unregister;
    const kept = storeDispatch(open);
    kept.dispatch(action);
    expect(no.asked).toHaveBeenCalledTimes(1);
    expect(kept.applied).toEqual([]);
    expect(kept.state.settingsOpen).toBe(true);
    no.unregister();
    const yes = dirtyPage(true); cleanup = yes.unregister;
    const left = storeDispatch(open);
    left.dispatch(action);
    expect(yes.asked).toHaveBeenCalledTimes(1);
    expect(left.applied).toEqual([action]);
  });

  it("every leave action is covered by an entry point above", () => {
    expect(new Set(entryPoints.map(([, action]) => action.type))).toEqual(new Set(BOT_PAGE_LEAVE_ACTIONS));
  });

  it("a Settings address naming another bot asks once for the whole open, and opens that bot, not the one in view", () => {
    const address = parseSettingsAddress("murage://settings/bot/pepper/access/folder")!;
    const context = { botIds: ["nova", "pepper"], selectedBotId: "nova" };
    const no = dirtyPage(false); cleanup = no.unregister;
    const kept = storeDispatch(open);
    expect(openSettingsAddress(address, context, kept.dispatch)).toBe(true);
    expect(no.asked).toHaveBeenCalledTimes(1);
    expect(kept.applied).toEqual([]);
    no.unregister();
    const yes = dirtyPage(true); cleanup = yes.unregister;
    const left = storeDispatch(open);
    openSettingsAddress(address, context, left.dispatch);
    expect(yes.asked).toHaveBeenCalledTimes(1);
    expect(left.applied.map((action) => action.type)).toEqual(["select", "toggleSettings"]);
    expect(left.state.settingsBotId).toBe("pepper");
  });

  it("what stays on the page is never held: a section of the same bot, a chat switch, closing app Settings, a clean page", () => {
    expect(leavesBotPage(open, { type: "toggleSettings", open: true, intent: { section: "identity" } })).toBe(false);
    expect(leavesBotPage(open, { type: "toggleSettings", open: true, botId: "nova" })).toBe(false);
    expect(leavesBotPage(open, { type: "select", id: "pepper" })).toBe(false);
    expect(leavesBotPage(open, { type: "toggleAppSettings", open: false })).toBe(false);
    expect(leavesBotPage(base, { type: "showToday" })).toBe(false);
    // No page registered (or a clean one): nothing asks.
    const free = storeDispatch(open);
    free.dispatch({ type: "showToday" });
    expect(free.applied).toEqual([{ type: "showToday" }]);
    // An answered leave does not ask again for what it dispatches.
    const yes = dirtyPage(true); cleanup = yes.unregister;
    const run = storeDispatch(open);
    leaveBotPage(() => { run.dispatch({ type: "toggleSettings", open: false }); run.dispatch({ type: "showToday" }); });
    expect(yes.asked).toHaveBeenCalledTimes(1);
    expect(run.applied.length).toBe(2);
  });

  it("the window is pinned to its bot: a chat switch behind it does not swap the page", () => {
    expect(open.settingsBotId).toBe("nova");
    const switched = reducer(open, { type: "select", id: "pepper" });
    expect(switched.selectedId).toBe("pepper");
    expect(switched.settingsBotId).toBe("nova");
  });

  it("an editor over the page (team instructions) counts as unsaved edits, and its portal stays in the Settings session", () => {
    const dialog = read("../components/SectionContextDialog.tsx");
    expect(dialog).toContain('useBotSettingsDraft("section-context", dirty, saving);');
    expect(dialog).toContain('data-settings-owned={inBotSettings ? "" : undefined}');
  });

  it("focus goes back to the original opener after moving between app and bot pages", () => {
    const element = (inside: boolean) => ({ closest: (selector: string) => (inside && selector.includes(".settings-dialog") && selector.includes("[data-settings-owned]") ? {} : null), isConnected: true, focus: () => {} });
    const opener = element(false);
    expect(settingsOpener(opener)).toBe(opener);
    // The new window renders while focus is still in the old one (or in an editor it owns): the opener is kept.
    expect(settingsOpener(element(true))).toBe(opener);
    // Gone from the page: nothing to go back to.
    opener.isConnected = false;
    expect(settingsOpener(element(true))).toBeNull();
    const app = read("../App.tsx");
    expect(app).toContain("if (settingsIsOpen && !settingsWasOpen.current)");
    expect(app).toContain("settingsOpener(document.activeElement as HTMLElement | null)");
    for (const name of ["settings", "bot-settings"]) expect(app).toContain(`<LazyOverlay name="${name}" kind="window" covers="always" opener={settingsSession.current}`);
  });
});
