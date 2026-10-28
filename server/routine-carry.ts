// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-M: may the last run's report start the next run of a routine? The manager (routines.ts carriedReport) decides everything
// that lives in the routine and its runs; this answers the part that lives in the conversation and in memory: the reply row
// that produced the report is still there, was captured as a memory source, has not been forgotten, and the conversation was
// not deleted. Anything unprovable answers false (a run then carries nothing).
import { database } from "./database.ts";
import { scanTextLinesNewest } from "./message-db.ts";
import { threadDenied } from "./memory/deny.ts";
import { messageSourceForgotten } from "./memory/replay-lineage.ts";

/** The newest bot text row written in [from, to] in the thread, or null. */
function replyRow(threadId: string, from: number, to: number): string | null {
  let found: string | null = null;
  scanTextLinesNewest(threadId, (message) => {
    if (message.at < from) return true;
    if (message.at > to || message.role !== "bot" || message.kind !== "text") return false;
    found = message.id;
    return true;
  });
  return found;
}

export function priorReplyCarryable(threadId: string, from: number, to: number): boolean {
  try {
    const db = database();
    if (threadDenied(db, threadId)) return false;
    const id = replyRow(threadId, from, to);
    if (!id) return false;
    const captured = db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(`message:${threadId}:${id}`);
    if (!captured) return false;
    return !messageSourceForgotten(threadId, id);
  } catch {
    return false;
  }
}

/** Bot email (BOT-EMAIL-MURAGE-109 5.4): whether a bot text row written in [from, to] in the thread is marked (written after reading outside
 *  mail): the carried report is then handed on fenced, kind email-derived. Anything unreadable answers true (fenced is the careful side). */
export function priorReplyEmailDerived(threadId: string, from: number, to: number): boolean {
  try {
    let marked = false;
    scanTextLinesNewest(threadId, (message) => {
      if (message.at < from) return true;
      if (message.at > to || message.role !== "bot" || message.kind !== "text") return false;
      if (message.externalContent === "email") { marked = true; return true; }
      return false;
    });
    return marked;
  } catch {
    return true;
  }
}
