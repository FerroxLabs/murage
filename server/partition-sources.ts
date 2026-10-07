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

export function partitionTranscriptMessages(db: DatabaseSync, botId: string, threadId: string, messages: readonly Message[]): Message[] {
  return messages.filter(message => {
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
