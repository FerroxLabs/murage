// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Marks what takes focus back when an overlay's opener cannot: the phone
 * drawer's menu button (OpenBotListButton). */
export const FOCUS_FALLBACK_ATTRIBUTE = "data-focus-fallback";

/** Give focus back to what opened an overlay as it closes. An opener in the
 * closed phone drawer is inert (Sidebar) and cannot take it, and focus fell
 * to the page; the menu button that reopens the drawer takes it instead. An
 * opener that is gone is left alone, as before. */
export function returnFocus(opener: Element | null | undefined, doc: Pick<Document, "querySelector"> = document): void {
  if (!(opener instanceof Object) || !("focus" in opener) || !opener.isConnected) return;
  if (opener.closest("[inert]")) doc.querySelector<HTMLElement>(`[${FOCUS_FALLBACK_ATTRIBUTE}]`)?.focus();
  else (opener as HTMLElement).focus();
}
