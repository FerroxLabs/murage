// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test fixtures: the message a memory source cites, stored. The anchor check (murage-anchor.ts, LINEAGE-DESIGN-S6 rules 23 and 24) reads
// an anchor it cannot read (no such row) as withheld, so a fixture that captures a source from a message must store that message too.
import type { DatabaseSync } from "node:sqlite";

/** Store the plain (not Murage-voice) message a source is anchored at, unless a row with that id is already in the thread. */
export function storeAnchorMessage(db: DatabaseSync, threadId: string, messageId: string, text = "", role: "user" | "bot" = "user", at = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO messages(thread_id, id, at, role, kind, text, json) VALUES(?,?,?,?,'text',?,?)")
    .run(threadId, messageId, at, role, text, JSON.stringify({ id: messageId, role, kind: "text", text, at }));
}
