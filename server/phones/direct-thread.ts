// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one definition of "the owner's own 1:1 thread" (S32): a task of that bot, not a project desk, not shared work, not a room
// or any room's task, and bound to no human other than the owner. Anything unknown is false, so callers fail closed.
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.ts";
import { OWNER, threadHumanPrincipal } from "../human-principals.ts";

export function isDirectOwnerThread(store: Store, db: DatabaseSync, botId: string, threadId: string): boolean {
  try {
    const bot = store.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return false;
    if (task.channelProjectDesk || task.sharedWork) return false;
    // A room record: the thread is a room's own thread or one of its tasks.
    if (store.groupByThread(threadId)) return false;
    // Another bot's task carrying the same thread id, or a thread one of its members shares.
    if (store.bots.some((other) => other.id !== botId && (other.threadId === threadId || other.tasks?.some((t) => t.threadId === threadId)))) return false;
    return JSON.stringify(threadHumanPrincipal(threadId, db)) === JSON.stringify(OWNER);
  } catch { return false; }
}
