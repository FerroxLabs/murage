// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which conversation to reopen at launch. Idea from OpenMaus (Apache-2.0, src/lib/last-conversation.ts); the
// workspace key and the "onboarding is finished" guard are ours.
//
// One id, never a thread id (the server already remembers each conversation's current thread), kept in this
// browser only. It is a preference that sits AHEAD of the Chief fallback in the hydrate reducer, so a first run
// (nothing stored) and a person who quit part way through setup (nothing written, see `shouldRemember`) both
// still land on the Chief. The key carries the workspace so a Cloud home never receives a local bot id.

const KEY_PREFIX = "murage.lastConversation.v1:";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** "local" for the desktop's own workspace, the home id for a Cloud home. */
export function workspaceKey(homeId: string | null | undefined): string {
  return homeId ? `home:${homeId}` : "local";
}

export function lastConversationKey(workspace: string): string {
  return `${KEY_PREFIX}${workspace}`;
}

/** Whether to keep (and later resume) the open conversation: only once the setup flow has finished.
 *  `firstRun` is the server's `view.firstRun`; an unknown answer (null) remembers nothing. */
export function shouldRemember(firstRun: boolean | null | undefined): boolean {
  return firstRun === false;
}

export function readLastConversation(storage: Store | undefined, workspace: string): string | undefined {
  try {
    const value = storage?.getItem(lastConversationKey(workspace));
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastConversation(storage: Store | undefined, workspace: string, id: string): void {
  try {
    if (!storage) return;
    if (id) storage.setItem(lastConversationKey(workspace), id);
    else storage.removeItem(lastConversationKey(workspace));
  } catch { /* storage refused: the Chief is the landing, as before */ }
}

/** Where a hydrate lands. Pure; the reducer calls it.
 *  Order: the selection already held, then the remembered conversation (if it is listed and not hidden), then the
 *  Chief, then the first visible one. */
export function landingId(input: {
  selectedId: string;
  known: (id: string) => boolean;
  resumeId?: string;
  resumable: (id: string) => boolean;
  fallback: string;
}): string {
  if (input.selectedId && input.known(input.selectedId)) return input.selectedId;
  if (input.resumeId && input.resumable(input.resumeId)) return input.resumeId;
  return input.fallback;
}

/** What to save when the setup view is announced: the open conversation, the moment `firstRun` turns false.
 *  Returns the id to write, or null when nothing should be written yet. */
export function idToSaveOnSetupView(detail: { firstRun?: unknown } | undefined, hydrated: boolean, selectedId: string): string | null {
  return shouldRemember(typeof detail?.firstRun === "boolean" ? detail.firstRun : null) && hydrated && selectedId ? selectedId : null;
}
