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
 * the chat too, from the Inbox's backup link among others. */
export function drawerCloseKey(state: Pick<AppState, "activeView" | "pluginsOpen" | "settingsOpen" | "appSettingsOpen" | "conversationPicks">): string {
  return JSON.stringify([state.conversationPicks ?? 0, state.activeView, state.pluginsOpen, state.settingsOpen, state.appSettingsOpen]);
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
