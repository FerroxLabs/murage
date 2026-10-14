// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one decision about whether earlier memory may be used right now. Until 1.0.2 each writer carried its own copy of the check, added after
// the decision it protected had already been made (an Apply published a changed skill, and only the ledger write behind it refused). Every use
// of memory that has an effect outside the function that asks (a published change, a lesson, a feedback row, a ledger row, a prompt block, a
// replayed reply) now asks here first, and this is the only module that reads the hold flag of the connection.
//
//   held:CODE   a source row did not match what the proofs expect: memory is set aside and EVERY use is refused.
//   pending     the background pass has not finished: uses that would read memory written before it began are refused (publishing or undoing a
//               procedure change, replaying an earlier reply); new writes of this session are allowed, because they do not depend on earlier rows.
//   ok          go ahead.
//
// The order that keeps an external effect honest, for Apply and Undo: gate, every SQL write that can fail, gate again, and only then the external
// publish or rollback as the LAST statement of the transaction, so a refusal or a throw leaves the files and the rows exactly as they were.
import type { DatabaseSync } from "node:sqlite";
import { integrityFlags, integrityHoldCode } from "./integrity-flags.ts";

export type MemoryUse =
  | "publish-procedure" | "rollback-procedure" | "lesson-write" | "feedback-write" | "ledger-write"
  | "render-learned" | "replay" | "capture" | "bring-in" | "default-connection";
export type MemoryGateResult = "ok" | "pending" | `held:${string}`;

/** Said to the owner when memory is set aside: plain words, nothing is lost, chats are unaffected. */
export const MEMORY_HELD_MESSAGE = "Murage has set memory aside for now, so what it learned cannot be changed. Your chats work as usual and nothing was deleted.";
/** Said while the background pass is still going over earlier memory. */
export const MEMORY_PENDING_MESSAGE = "Murage is still going over earlier memory after the upgrade, so this cannot be done yet. Your chats work as usual; try again in a few minutes.";

/** Uses that read memory written before the pass began, and so wait for it. */
const WAITS_FOR_PASS: ReadonlySet<MemoryUse> = new Set(["publish-procedure", "rollback-procedure", "replay"]);

/** The uses this module knows, for the structural test. */
export const MEMORY_USES: readonly MemoryUse[] = ["publish-procedure", "rollback-procedure", "lesson-write", "feedback-write", "ledger-write", "render-learned", "replay", "capture", "bring-in", "default-connection"];

export function memoryGate(db: DatabaseSync | object, use: MemoryUse, options: { eventId?: string } = {}): MemoryGateResult {
  const hold = integrityHoldCode(db);
  if (hold !== null) return `held:${hold}`;
  const flags = integrityFlags(db);
  if (!flags.pending || !WAITS_FOR_PASS.has(use)) return "ok";
  // Undo of a change recorded after the pass began rests only on this session's own rows.
  if (use === "rollback-procedure" && options.eventId !== undefined && flags.eventsFloor !== null) {
    try {
      const row = (db as DatabaseSync).prepare("SELECT rowid r FROM memory_learning_events WHERE id=?").get(options.eventId);
      if (row && Number(row.r) > flags.eventsFloor) return "ok";
    } catch { /* unreadable: it waits */ }
  }
  return "pending";
}

export const memoryGateRefusal = (result: MemoryGateResult): Error =>
  Object.assign(new Error(result === "pending" ? MEMORY_PENDING_MESSAGE : MEMORY_HELD_MESSAGE), { status: 409, code: result === "pending" ? "MEMORY_PENDING" : "MEMORY_HELD" });

/** Throws a 409 when the use may not go ahead. */
export function assertMemoryGate(db: DatabaseSync | object, use: MemoryUse, options: { eventId?: string } = {}): void {
  const result = memoryGate(db, use, options);
  if (result !== "ok") throw memoryGateRefusal(result);
}

/** The code of a hold, for the status answer and the lineage flag (not a decision: ask memoryGate for those). */
export function memoryHeldCode(db: object): string | null { return integrityHoldCode(db); }
