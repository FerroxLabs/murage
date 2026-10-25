// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Mark every conversation under one bot as read. The unread threads are
// listed once up front and read one after another; each confirmed read comes
// back to the roster the way a single read does. The first failure stops the
// run, and the reads already confirmed stay read.
import type { Bot } from "@/state/store";

export type ReadSource = Pick<Bot, "threadId" | "unread" | "tasks">;

/** The thread ids that carry an unread mark. */
export function botUnreadThreadIds(bot: ReadSource): string[] {
  const tasks = bot.tasks ?? [];
  const ids = tasks.filter((task) => task.unread).map((task) => task.threadId);
  // A bot flagged unread whose task list is not loaded still has its open thread to read
  if (bot.unread && ids.length === 0 && tasks.length === 0 && bot.threadId) ids.push(bot.threadId);
  return ids;
}

export interface MarkReadResult {
  read: string[];
  failed: { threadId: string; message: string } | null;
}

export async function markBotRead(
  bot: ReadSource,
  post: (threadId: string) => Promise<unknown>,
): Promise<MarkReadResult> {
  const read: string[] = [];
  for (const threadId of botUnreadThreadIds(bot)) {
    try {
      await post(threadId);
      read.push(threadId);
    } catch (error) {
      return { read, failed: { threadId, message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { read, failed: null };
}
