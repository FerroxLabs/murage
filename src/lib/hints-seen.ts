// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hints once (UX overhaul slice 4, lane L4C). A coach mark is shown at most
// once on this device: `help.seen.<screen>.<mark>` in localStorage. Blocked or
// full storage never throws; a hint that cannot be remembered is not shown, so
// it can never come back on every launch. "Show hints again" in the help panel
// clears every mark at once.

export const HINT_KEY_PREFIX = "help.seen.";

type HintStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function store(): HintStore | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export const hintKey = (screen: string, mark: string): string => `${HINT_KEY_PREFIX}${screen}.${mark}`;

/** True when the hint was shown before, or when nothing could be remembered (then it is never shown). */
export function hintSeen(screen: string, mark: string, storage: HintStore | null = store()): boolean {
  if (!storage) return true;
  try { return storage.getItem(hintKey(screen, mark)) !== null; } catch { return true; }
}

/** Remembers the hint. Returns false when storage refused, so the caller does not show it. */
export function markHintSeen(screen: string, mark: string, storage: HintStore | null = store()): boolean {
  if (!storage) return false;
  try { storage.setItem(hintKey(screen, mark), "1"); return true; } catch { return false; }
}

/** "Show hints again": forgets every hint, so each shows once more. */
export function resetHints(storage: HintStore | null = store()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(HINT_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch { /* blocked storage: nothing was remembered either */ }
}

/** Hints are never drawn on a window narrower than this. */
export const HINT_MIN_WIDTH = 400;
/** Never at launch: the app settles first. */
export const HINT_DELAY_MS = 2500;

export interface HintContext {
  width: number;
  /** First run owns the screen. */
  firstRun: boolean;
  /** Another hint is on screen now. */
  showing: boolean;
  /** The help panel, a menu or a modal window is open. */
  covered: boolean;
}

/** The coach-mark rules: once, never under 400 px, never two at once, never in first run or under a window. */
export function hintAllowed(screen: string, mark: string, context: HintContext, storage: HintStore | null = store()): boolean {
  if (context.firstRun || context.showing || context.covered) return false;
  if (!(context.width >= HINT_MIN_WIDTH)) return false;
  return !hintSeen(screen, mark, storage);
}

/** Something already covers the page: help, an open menu or a window. */
export function pageCovered(root: Pick<Document, "querySelector"> = document): boolean {
  return Boolean(root.querySelector("[data-help-panel], [role='menu'], [role='listbox'], dialog[open], [aria-modal='true']"));
}
