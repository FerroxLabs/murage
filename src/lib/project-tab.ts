// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which face of a project the owner is looking at: its chat or its overview.
// A project is a channel, and the owner comes back to it to talk, so it opens
// on Chat. Whatever tab the owner last chose for a project is remembered for
// that project. GroupView is keyed by channel id and remounts on every visit,
// so the choice lives here rather than in component state.
import { z } from "zod";

export type ProjectTab = "chat" | "board" | "overview" | "files" | "memory" | "activity";

export const PROJECT_TAB_KEY = "murage.projectTabs.v1";
const MAX_REMEMBERED = 200;

const storedSchema = z.record(z.string().min(1).max(240), z.unknown());

// Kept for this session even when storage refuses (a private window, a
// locked-down webview): the choice then survives a remount but not a relaunch.
let session: Map<string, ProjectTab> | null = null;

function target(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined) {
  try {
    return storage === undefined ? (globalThis.localStorage ?? null) : storage;
  } catch {
    return null;
  }
}

function read(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): Map<string, ProjectTab> {
  if (session) return session;
  const tabs = new Map<string, ProjectTab>();
  try {
    const raw = target(storage)?.getItem(PROJECT_TAB_KEY);
    const parsed = storedSchema.safeParse(raw ? JSON.parse(raw) : {});
    if (parsed.success) {
      for (const [id, tab] of Object.entries(parsed.data)) {
        if (["chat", "board", "overview", "files", "memory", "activity"].includes(String(tab))) tabs.set(id, tab as ProjectTab);
      }
    }
  } catch {
    // Unreadable or refused: start from nothing, as a new install would.
  }
  session = tabs;
  return tabs;
}

function write(tabs: Map<string, ProjectTab>, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): void {
  try {
    target(storage)?.setItem(PROJECT_TAB_KEY, JSON.stringify(Object.fromEntries(tabs)));
  } catch {
    // The session copy above still answers until the app restarts.
  }
}

export function loadProjectTab(groupId: string, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): ProjectTab {
  return read(storage).get(groupId) ?? "chat";
}

export function saveProjectTab(groupId: string, tab: ProjectTab, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): void {
  const tabs = read(storage);
  // Newest last, so trimming drops the projects visited longest ago.
  tabs.delete(groupId);
  tabs.set(groupId, tab);
  while (tabs.size > MAX_REMEMBERED) tabs.delete(tabs.keys().next().value!);
  write(tabs, storage);
}

export function forgetProjectTab(groupId: string, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): void {
  const tabs = read(storage);
  if (!tabs.delete(groupId)) return;
  write(tabs, storage);
}

/** The tab actually shown. A project still being set up always shows its
 * setup card, which lives in the chat pane: the tabs are hidden until setup
 * is done, so a remembered Overview would leave no way to reach it. */
export function projectViewTab({ remembered, setupPending }: { remembered: ProjectTab; setupPending: boolean }): ProjectTab {
  return setupPending ? "chat" : remembered;
}

export function resetProjectTabsForTest(): void {
  session = null;
}
