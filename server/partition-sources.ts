import { continuationResults, roomRequest, type RoomRequest } from "./room-requests.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "./store.ts";
import { projectRequestSourceMessages } from "./project-envelope.ts";
import type { DatabaseSync } from "node:sqlite";
import { authorizeWork, executionStore, requestSourceThread, sameThreadPartition } from "./execution-audience.ts";

/** A citation and all copied ancestors must belong to the consuming turn. */
export function partitionSourcesAllowed(db: DatabaseSync, botId: string, threadId: string, messageIds: readonly string[]): boolean {
  const bot = executionStore()?.bot(botId);
  if (!bot || bot.partitionedAt === undefined) return true;
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return true;
    if (seen.size >= 500) return false;
    seen.add(id);
    const row = db.prepare("SELECT thread_id,json FROM messages WHERE id=?").get(id);
    if (!row || !sameThreadPartition(bot, threadId, String(row.thread_id))) return false;
    try {
      const copy = JSON.parse(String(row.json)).copyOf;
      return !copy || typeof copy.threadId === "string" && sameThreadPartition(bot, threadId, copy.threadId) && Array.isArray(copy.messageIds) && copy.messageIds.every((id: unknown) => typeof id === "string" && visit(id));
    } catch { return false; }
  };
  return messageIds.every(visit);
}

export function requestReturnsTo(db: DatabaseSync, requestId: string, threadId: string): boolean {
  return requestSourceThread(requestId, db) === threadId;
}

/** Every original a copy stands on, and every original those were copied from, is still stored and not withheld from bots. A copy whose original
 * was deleted is not shown to any bot, in any memory mode, partitioned or not. A chain past the limits is not established. */
export function copyChainPresent(db: DatabaseSync, copy: { threadId: string; messageIds: readonly string[] }): boolean {
  const seen = new Set<string>();
  let level: Array<{ threadId: string; messageIds: readonly string[] }> = [copy];
  for (let depth = 0; level.length; depth += 1) {
    if (depth > 8) return false;
    const next: Array<{ threadId: string; messageIds: readonly string[] }> = [];
    for (const group of level) for (const id of group.messageIds) {
      const key = `${group.threadId}\u0000${id}`;
      if (seen.has(key)) continue;
      if (seen.size >= 64) return false;
      seen.add(key);
      const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(group.threadId, id);
      if (!row) return false;
      try {
        const stored = JSON.parse(String(row.json));
        if (stored.withheldFromBots !== undefined && stored.withheldFromBots !== false) return false;
        const further = stored.copyOf;
        if (further) {
          if (typeof further.threadId !== "string" || !Array.isArray(further.messageIds) || !further.messageIds.every((m: unknown) => typeof m === "string")) return false;
          next.push({ threadId: further.threadId, messageIds: further.messageIds });
        }
      } catch { return false; }
    }
    level = next;
  }
  return true;
}

export function partitionTranscriptMessages(db: DatabaseSync, botId: string, threadId: string, messages: readonly Message[]): Message[] {
  return messages.filter(message => {
    if (message.copyOf && !copyChainPresent(db, message.copyOf)) return false;
    if (message.copyOf && !partitionSourcesAllowed(db, botId, threadId, [message.id])) return false;
    return message.kind !== "activity" || !message.requestId || partitionSourcesAllowed(db, botId, threadId, projectRequestSourceMessages(db, message.requestId));
  });
}

/** Recheck each result's requesting thread before exposing text or outcome notes. */
export function continuationResultsForThread(db: DatabaseSync, wake: RoomRequest, threadId: string) {
  return continuationResults(wake).filter(result => {
    if (!requestReturnsTo(db, result.requestId, threadId)) return false;
    const source = roomRequest(db, result.requestId);
    if (!source?.toBotId) return false;
    return authorizeWork({ edge: "deliver", requestId: source.id, fromBotId: source.toBotId, destinationThreadId: threadId }).ok;
  });
}
