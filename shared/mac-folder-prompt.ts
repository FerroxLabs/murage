// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// macOS's own folder-access prompt holds a process in `openat` on Documents, Desktop or Downloads. The engine sends
// nothing while it waits, so no ask ever reaches Murage (designs/MAC-FOLDER-PROMPT-1013.md). What the server and the
// transcript share about the line that says so: which folders, how a tool call names one, the words, how long it shows.

export const MAC_PROMPT_FOLDERS = ["Documents", "Desktop", "Downloads"] as const;
export type MacPromptFolder = (typeof MAC_PROMPT_FOLDERS)[number];

/** The notice is written once a named folder has gone this long with no ask and no result. */
export const FOLDER_PROMPT_DELAY_MS = 20_000;
/** The longest a turn lives silent. Past it a row no server is watching (a crash mid-wait) stops being drawn. */
export const FOLDER_PROMPT_MAX_MS = 60 * 60_000;

/** The folder a person sees, whatever case the call used (APFS is case-blind). */
const canonical = new Map<string, MacPromptFolder>(MAC_PROMPT_FOLDERS.map((folder) => [folder.toLowerCase(), folder]));

// A home mark, then the folder as a whole path segment: ~/Documents/x and "/Users/sam/Desktop" name one;
// ~/Documents-old, /Volumes/x/Users/sam/Desktop and ~/work/Documents do not. The optional quotes are "$HOME"/Downloads and ~/"Documents/x".
const NAMED = /(?<![\w./~$-])(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s"'`\\]+)(?:\\?["'])?\/(?:\\?["'])?(documents|desktop|downloads)(?![\w.-])/gi;

/** The prompt folders a tool call's text names, each once. */
export function macFoldersNamed(text: string): MacPromptFolder[] {
  const named = new Set<MacPromptFolder>();
  for (const match of text.matchAll(NAMED)) named.add(canonical.get(match[1].toLowerCase())!);
  return [...named];
}

export function macFolderPromptLine(folder: MacPromptFolder): string {
  return `Your Mac is asking whether Murage can open your ${folder} folder. Look for the pop-up, or turn it on in System Settings, Privacy & Security, Files & Folders.`;
}

/** Whether a transcript draws the row: until it is cleared, and never past the longest a wait can last. */
export function folderPromptShowing(message: { at: number; folderPrompt?: { folder: string; done?: boolean } }, now: number): boolean {
  return Boolean(message.folderPrompt) && !message.folderPrompt?.done && now - message.at < FOLDER_PROMPT_MAX_MS;
}
