// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The desktop clipboard bridge behind window.muragebox.copyText: write text,
// nothing else. Text only, capped at 1 MB, and nothing here reads the
// clipboard. Who may call it is decided before this runs, by the owned-main
// IPC gate in main.mjs (the main Murage window's top frame on its own origin);
// the check is repeated here so the function is safe on its own.
import { isOwnedMainSender } from "./main-trust.mjs";

export const CLIPBOARD_MAX_BYTES = 1024 * 1024;

/**
 * @param {{ sender?: any, senderFrame?: any } | null | undefined} event IPC event
 * @param {unknown} text
 * @param {{ clipboard: { writeText(text: string): void }, window: any, origin: string | null | undefined }} deps
 * @returns {boolean} true when the text reached the clipboard
 */
export function writeClipboardText(event, text, { clipboard, window, origin }) {
  if (!isOwnedMainSender(event, { window, origin })) return false;
  if (typeof text !== "string" || text.length === 0) return false;
  if (Buffer.byteLength(text, "utf8") > CLIPBOARD_MAX_BYTES) return false;
  try {
    clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
