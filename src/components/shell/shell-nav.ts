// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One way to move between the shell's places (HANDOFF-1013-UX-L2A.md).
// Lanes call these instead of dispatching raw actions, so a door's behaviour
// has one definition.
import { useMemo, useRef } from "react";
import { useStore, type Action, type AppState } from "@/state/store";
import { openInboxLink } from "@/lib/open-inbox-link";
import type { NeedsYouTab, ShellDoor, ShellView } from "./shell-contract";

export interface ShellNav {
  showToday: () => void;
  showNeedsYou: (tab?: NeedsYouTab) => void;
  showHealth: () => void;
  openChat: (botId: string, threadId?: string) => void;
  openChats: () => void;
  openRoutines: () => void;
  openUsage: () => void;
}

/** What openChat reads to switch a bot to another of its conversations (the Inbox link's own switch). */
export type ShellNavState = Pick<AppState, "bots" | "groups" | "pageIntent">;

export function shellNav(dispatch: (action: Action) => void, getState?: () => ShellNavState): ShellNav {
  return {
    showToday: () => dispatch({ type: "showToday" }),
    showNeedsYou: (tab) => dispatch(tab ? { type: "showNeedsYou", tab } : { type: "showNeedsYou" }),
    showHealth: () => dispatch({ type: "showHealth" }),
    openChat: (botId, threadId) => {
      const state = getState?.();
      const bot = state?.bots.find((candidate) => candidate.id === botId);
      // Same conversation (or none named): a plain pick.
      if (!threadId || !state || !bot || bot.threadId === threadId) { dispatch({ type: "select", id: botId }); return; }
      // Another of the bot's conversations (a background task, a routine's run): switch the bot to it first,
      // exactly as an Inbox link does. If the switch is refused, open the bot where it is.
      void openInboxLink({ threadId }, state, dispatch).catch(() => dispatch({ type: "select", id: botId }));
    },
    openChats: () => dispatch({ type: "showAllChats" }),
    openRoutines: () => dispatch({ type: "showRoutines" }),
    openUsage: () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }),
  };
}

export function useShellNav(): ShellNav {
  const { state, dispatch } = useStore();
  const latest = useRef<ShellNavState>(state);
  latest.current = state;
  return useMemo(() => shellNav(dispatch, () => latest.current), [dispatch]);
}

/** What leaving Health reads: what was open before it, so Back returns there. */
export type HealthReturnState = Pick<AppState, "bots" | "groups" | "needsYouTab">;

/** Where Health was opened from: the view, and for a chat the bot or room that was open then. */
export interface HealthOrigin {
  view: ShellView;
  chatId?: string | null;
}

/**
 * Leaving Health (Sean 11-02, 1.0.14): Back, the close button and Esc all go to the view the person came from,
 * or Today when that is not known. A chat goes back only to the bot or room that was open when Health opened, and
 * only while it is still here: if it was removed meanwhile the selection moved on to another chat, and a select of
 * an id the client does not have changes nothing, which would leave the person on Health.
 */
export function healthReturn(origin: HealthOrigin | undefined, state: HealthReturnState, recorderAvailable = false): Action {
  switch (origin?.view) {
    case "chat": {
      const id = origin.chatId;
      if (id && (state.bots.some((bot) => bot.id === id) || state.groups.some((group) => group.id === id))) return { type: "select", id };
      return { type: "showToday" };
    }
    case "all-chats": return { type: "showAllChats" };
    case "needs-you": return state.needsYouTab ? { type: "showNeedsYou", tab: state.needsYouTab } : { type: "showNeedsYou" };
    case "routines": return { type: "showRoutines" };
    case "team-map": return { type: "showTeamMap" };
    case "skill-recorder": return recorderAvailable ? { type: "showSkillRecorder" } : { type: "showToday" };
    default: return { type: "showToday" };
  }
}

/** Where Routines' Back goes. All chats is a list of chats, not a place to come back to: it returns to the chat. */
export type CalendarOrigin = Exclude<ShellView, "routines" | "all-chats">;

export interface ShellOrigins {
  calendar: CalendarOrigin;
  health: HealthOrigin | undefined;
}

/**
 * The Back targets of Routines and Health after the view moved from `previous` to `next`. Both pages can open the
 * other, so a return keeps the first origin: Today, Routines, Health, Back lands on Routines and its Back still
 * goes to Today, never back to Health. `selectedId` is the chat open as the view moved.
 */
export function trackShellOrigins(previous: ShellView, next: ShellView, selectedId: string | null | undefined, origins: ShellOrigins): ShellOrigins {
  if (previous === next) return origins;
  if (next === "routines") {
    if (previous === "health" && origins.health?.view === "routines") return origins;
    // previous is never "routines" here (equal views returned above); the check tells the type so.
    return { ...origins, calendar: previous === "all-chats" || previous === "routines" ? "chat" : previous };
  }
  if (next === "health") {
    if (previous === "routines" && origins.calendar === "health") return origins;
    return { ...origins, health: { view: previous, chatId: previous === "chat" ? selectedId ?? null : null } };
  }
  return origins;
}

/** The door that is lit for a view: a chat and All chats both light Chats. Team map and the recorder light none. */
export function doorForView(view: ShellView): ShellDoor | null {
  switch (view) {
    case "today": return "today";
    case "chat":
    case "all-chats": return "chats";
    case "needs-you": return "needs-you";
    case "routines": return "routines";
    default: return null;
  }
}
