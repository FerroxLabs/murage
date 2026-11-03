// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppState } from "@/state/store";

/** What, when it changes, closes the phone's sidebar drawer: the person
 * picking a conversation, switching view, or opening something over the chat.
 *
 * A pick is counted (conversationPicks: select, a new bot, switch or new
 * task in a bot or a room), not read off the selection or the open thread.
 * Opening a request from the Inbox switches the already selected Chief to
 * another of its conversations, and the drawer that led to the Inbox stayed
 * over the request (0.1.61 CI, b35-attention-journeys on a phone). But the
 * thread also moves when another surface switches or deletes a task, and the
 * selection when hydration settles it after load or a selected bot is
 * deleted; none of those is this person asking, and a drawer opened in that
 * moment snapped shut. App settings count like bot settings: they open over
 * the chat too, from the Inbox's backup link among others.
 *
 * Today's landing is the same kind of settling: hydration moves a returning
 * owner from the chat to Today once per launch (store.tsx landsOnToday,
 * todayLanding), and setup can hand the view back (cancelTodayLanding).
 * Neither is the person asking, so while the landing holds the view counts
 * as the chat it replaced; a drawer opened during load stays open (1.0.15,
 * threads.human.spec.ts on a phone: the bot list tapped right after a reload
 * snapped shut). The person's own Today press clears todayLanding and closes it. */
export function drawerCloseKey(state: Pick<AppState, "activeView" | "pluginsOpen" | "settingsOpen" | "appSettingsOpen" | "conversationPicks" | "todayLanding">): string {
  const view = state.activeView === "today" && state.todayLanding ? "chat" : state.activeView;
  return JSON.stringify([state.conversationPicks ?? 0, view, state.pluginsOpen, state.settingsOpen, state.appSettingsOpen]);
}

/** A closed drawer below md is off screen; inert keeps its controls out of
 * Tab order, the accessibility tree and hit testing (its slide-out too). The
 * desktop sidebar is always shown and never inert. Its big overlays are
 * portals, outside it. */
export function closedDrawerInert(narrow: boolean, open: boolean): boolean {
  return narrow && !open;
}

/** Closed by an effect (a pick, something opening over the chat) with focus
 * still inside it: focus goes back to the menu button, as the drawer's own
 * close does. Not when something that opened has already taken focus. */
export function focusLeavesClosedDrawer(wasOpen: boolean, open: boolean, focusInside: boolean): boolean {
  return wasOpen && !open && focusInside;
}
