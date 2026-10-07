// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a Mod chord is written on this machine. Apart from keyboard-shortcuts.ts
// (the full list the Keyboard shortcuts dialog shows) because tooltips across
// the first paint need these two and nothing else.
export function shortcutPlatformIsMac(): boolean {
  if (typeof window !== "undefined" && window.muragebox?.platform) return window.muragebox.platform === "darwin";
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/** A Mod chord as a tooltip writes it: `⌘F` / `⌘⇧Z` on a Mac, `Ctrl+F` /
 * `Ctrl+Shift+Z` everywhere else. */
export function modShortcut(key: string, { shift = false, mac = shortcutPlatformIsMac() }: { shift?: boolean; mac?: boolean } = {}): string {
  return mac ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}
