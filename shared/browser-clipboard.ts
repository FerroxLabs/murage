// SPDX-License-Identifier: AGPL-3.0-or-later
// Clipboard editing is never something a bot may do in the owner's browser: a paste would
// carry whatever the owner last copied (a secret, a code) into a page, and a copy or select-all
// would overwrite it. The extension refuses these and the server refuses them before any card.
const CLIPBOARD_COMMAND = /^(paste|copy|cut|selectall|pasteandmatchstyle|pasteasplaintext|pasteasrichtext|copyurl)$/i;
const LETTERS = new Map([["v", 86], ["c", 67], ["x", 88], ["a", 65]]);
const CODES = new Map([["keyv", "v"], ["keyc", "c"], ["keyx", "x"], ["keya", "a"]]);
/** True when this CDP Input call would paste, copy, cut or select all. */
export function isClipboardInput(method: string, params: Record<string, unknown> | undefined): boolean {
  if (method !== "Input.dispatchKeyEvent" || !params || typeof params !== "object") return false;
  const commands = params.commands;
  if (Array.isArray(commands) && commands.some(command => typeof command === "string" && CLIPBOARD_COMMAND.test(command.trim()))) return true;
  const modifiers = Number.isSafeInteger(params.modifiers) ? (params.modifiers as number) : 0;
  const control = (modifiers & 2) !== 0 || (modifiers & 4) !== 0, shift = (modifiers & 8) !== 0;
  const key = typeof params.key === "string" ? params.key.toLowerCase() : "";
  const code = typeof params.code === "string" ? params.code.toLowerCase() : "";
  if (control) {
    const letter = LETTERS.has(key) ? key : CODES.get(code);
    if (letter) return true;
    for (const value of LETTERS.values()) if (params.windowsVirtualKeyCode === value) return true;
    if (key === "insert") return true;
  }
  if (shift && (key === "insert" || key === "delete")) return true;
  return false;
}

/** The same rule for a key name as the tool takes it ("Control+v", "Meta+Shift+C", "Shift+Insert"). */
export function isClipboardKeyName(key: unknown): boolean {
  if (typeof key !== "string") return false;
  const parts = key.split("+").map(part => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return false;
  const last = parts.at(-1)!, mods = new Set(parts.slice(0, -1));
  if (!mods.size && ["paste", "copy", "cut"].includes(last)) return true;
  const control = ["control", "ctrl", "meta", "cmd", "command", "controlormeta", "super"].some(name => mods.has(name));
  if (control && ["v", "c", "x", "a", "insert"].includes(last)) return true;
  if (mods.has("shift") && ["insert", "delete"].includes(last)) return true;
  return false;
}
