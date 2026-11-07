// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one way out of a bot's settings page (UX-L3B S7, designs/UX-L3B-S7-CHOKE-1019.md). The store's dispatch asks
// `holdForBotPage` before every action, so any opener anywhere (Cmd/Ctrl+, a Settings link, a header button) that would
// take the page away first gets the page's own unsaved-edit question. Types only from the store: no import cycle.
import type { Action, AppState } from "@/state/store";

/** Runs `operation` once the bot's page may be left (the page's own check: asks on unsaved edits, waits on a save). */
export type BotPageLeave = (operation: () => void) => void;

/** Every reducer case that writes `settingsOpen` (or SHELL_OVERLAYS_CLOSED). A gate test keeps this list complete. */
export const BOT_PAGE_LEAVE_ACTIONS = [
  "toggleSettings", "toggleAppSettings", "toggleComputer", "toggleInspector",
  "showToday", "showNeedsYou", "showHealth", "showRoutines", "showTeamMap", "showAllChats", "showSkillRecorder",
] as const satisfies readonly Action["type"][];

let pageLeave: (() => BotPageLeave | null) | null = null;
let passing = false;

/** The Settings window registers its bot page's check while one shows; the returned function unregisters it. */
export function registerBotPageLeave(get: () => BotPageLeave | null): () => void {
  pageLeave = get;
  return () => { if (pageLeave === get) pageLeave = null; };
}

/** A leave already answered: dispatches made while `operation` runs do not ask again. */
export function passThrough(operation: () => void): void {
  const before = passing;
  passing = true;
  try { operation(); } finally { passing = before; }
}

const askNow = (): BotPageLeave | null => (passing ? null : pageLeave?.() ?? null);

/** Runs `operation` (which may dispatch several actions) after the open bot page's check, or at once when there is none. */
export function leaveBotPage(operation: () => void): void {
  const ask = askNow();
  if (ask) ask(() => passThrough(operation)); else operation();
}

/** Whether `action` would unmount the bot page now showing. */
export function leavesBotPage(state: Pick<AppState, "settingsOpen" | "settingsBotId" | "selectedId" | "appSettingsOpen" | "computerOpen" | "inspectorOpen">, action: Action): boolean {
  if (!state.settingsOpen) return false;
  switch (action.type) {
    case "toggleSettings": {
      if (!(action.open ?? !state.settingsOpen)) return true;
      const shown = state.settingsBotId ?? state.selectedId;
      return action.botId != null && action.botId !== shown;
    }
    case "toggleAppSettings": return action.open ?? !state.appSettingsOpen;
    case "toggleComputer": return action.open ?? !state.computerOpen;
    case "toggleInspector": return action.open ?? !state.inspectorOpen;
    case "showToday": case "showNeedsYou": case "showHealth": case "showRoutines": case "showTeamMap": case "showAllChats": case "showSkillRecorder":
      return true;
    default:
      return false;
  }
}

/** The store's dispatch gate: true when the action was handed to the bot page's check (it is run again, once, on yes). */
export function holdForBotPage(state: Parameters<typeof leavesBotPage>[0], action: Action, run: () => void): boolean {
  const ask = askNow();
  if (!ask || !leavesBotPage(state, action)) return false;
  ask(() => passThrough(run));
  return true;
}

type Focusable = { closest(selector: string): unknown; isConnected?: boolean; focus(): void };
let sessionOpener: Focusable | null = null;

/** What focus goes back to when the Settings window closes. Focus outside the window (and the editors it owns) starts a
 *  session; a window that mounts while focus is still in the one it replaces (app page to bot page) keeps that opener. */
export function settingsOpener<T extends Focusable>(active: T | null | undefined): T | null {
  if (active && typeof active.closest === "function" && !active.closest(".settings-dialog, [data-settings-owned]")) {
    sessionOpener = active;
    return active;
  }
  return sessionOpener && sessionOpener.isConnected !== false ? (sessionOpener as T) : null;
}
