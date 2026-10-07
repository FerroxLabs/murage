// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Places a screen can ask to open when it does not own them. What's new and
// the Keyboard shortcuts dialog live in the Sidebar and the command palette
// owns its own open state, but Settings > Help & updates and the sidebar's
// search field open them too. A window event keeps those screens from
// importing each other (Settings is its own lazy chunk).
export const OPEN_WHATS_NEW_EVENT = "murage:open-whats-new";
export const OPEN_SHORTCUTS_EVENT = "murage:open-shortcuts";
export const OPEN_PALETTE_EVENT = "murage:open-palette";

function fire(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export const openWhatsNew = (): void => fire(OPEN_WHATS_NEW_EVENT);
export const openKeyboardShortcuts = (): void => fire(OPEN_SHORTCUTS_EVENT);
/** `query` starts the palette with that text typed, as when the sidebar's
 *  own search hands a word over to look for it in Settings too. */
export const openCommandPalette = (query?: string): void => fire(OPEN_PALETTE_EVENT, query ? { query } : undefined);
