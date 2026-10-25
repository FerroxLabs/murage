// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Flux Memory number hold (PASTE-CAPTURE-FIX r2.2). Flux Memory keeps
// what it sees in an engine request unless the request says capture off, and
// a CLI engine resends a thread's whole history with every request. So once a
// bank, card, account or personal id number is written in a thread, by the
// owner or in a bot's reply, every later request of that thread is sent with
// capture off and inject still on. The hold is written in the same transaction
// as the row (message-db.ts), before the turn that carries the number is
// dispatched, whatever the memory mode: it is about Flux, not local memory. It
// is never lifted for the thread's life. A new thread has no hold.
import type { DatabaseSync } from "node:sqlite";
import { containsFinancialIdentifier } from "../shared/financial-ids.ts";
import { isMurageVoice } from "./murage-voice.ts";
import type { Message } from "./store.ts";

// The table is created with the transcript tables (message-tables.ts).

/** Inside the caller's transaction: a user text row, or a bot text row (a piece
 * of a reply, the whole turn being the pieces), that holds a number. */
export function noteFluxCaptureHold(db: DatabaseSync, threadId: string, message: Message): void {
  if (message.kind !== "text" || isMurageVoice(message)) return;
  if (message.role !== "user" && message.role !== "bot") return;
  if (!containsFinancialIdentifier(message.text ?? "")) return;
  db.prepare("INSERT OR IGNORE INTO flux_capture_hold(thread_id, message_id, at) VALUES(?,?,?)").run(threadId, message.id, Date.now());
}

/** True when the thread holds a number, or the turn's own text does (the
 * second half covers a turn built from words not yet stored as a row). */
export function fluxCaptureHeld(db: DatabaseSync, threadId: string, turnText?: string): boolean {
  if (db.prepare("SELECT 1 FROM flux_capture_hold WHERE thread_id=?").get(threadId)) return true;
  return typeof turnText === "string" && containsFinancialIdentifier(turnText);
}
