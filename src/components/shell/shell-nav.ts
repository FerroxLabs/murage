// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One way to move between the shell's places (handoffs/HANDOFF-1013-UX-L2A.md).
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
