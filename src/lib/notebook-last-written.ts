// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Last written ..." for a bot's notebook (0.1.61 lane M, O5): a notebook
// nobody wrote for a week reads as stale, not as a bot that remembers nothing.

export function notebookLastWrittenLine(lastWrittenAt: number | null, now: number): string {
  if (lastWrittenAt === null) return "Nothing written here yet.";
  const days = Math.floor(Math.max(0, now - lastWrittenAt) / 86_400_000);
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `Last written ${when}.${days >= 7 ? " Nothing new in over a week." : ""}`;
}
