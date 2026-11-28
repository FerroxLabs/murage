// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Whether a process other than this one holds `path` open (its current inode). */
export function heldByOtherProcess(path: string): boolean;
/** How many renames onto `path` this process attempted while the rule was installed (refused ones included). */
export function replaceAttempts(path: string): number;
/** Put the Windows replace rule on fs.renameSync; returns the uninstall. */
export function installWindowsReplaceRule(options?: { beforeReplace?: (to: string, from: string) => void }): () => void;
