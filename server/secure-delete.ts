// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (MAIN-RULING SQLITE-1022 item 1a; owner: q1022-sqlite-opus): messages.db's server connection runs secure_delete=FAST
// (database.ts), which zeroes deleted cells only inside pages a write touches anyway; a page freed whole (an emptied leaf, the overflow
// pages of a long message) would go to the free list with its text. A transaction that removes owner-visible text (a conversation delete,
// a memory forget/revoke purge, the scrub rewrite) runs with secure_delete=ON on its connection for that transaction, through this helper.
import type { DatabaseSync } from "node:sqlite";

const modeOf = (db: DatabaseSync): number => Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete?: number } | undefined)?.secure_delete);
/** Turns secure_delete ON on `db` and returns the restore. Fail-closed: a mode that cannot be read back is left ON. */
export function secureDeleteOn(db: DatabaseSync): () => void {
  let prior: number;
  try { prior = modeOf(db); } catch { prior = -1; }
  if (prior === 1) return () => {};
  // an unreadable mode: turned ON and left ON (no restore to a mode nobody read)
  if (prior !== 0 && prior !== 2) { try { db.exec("PRAGMA secure_delete=ON"); } catch { /* the handle is gone */ } return () => {}; }
  db.exec("PRAGMA secure_delete=ON");
  return () => { try { db.exec(`PRAGMA secure_delete=${prior === 2 ? "FAST" : prior === 0 ? "OFF" : "ON"}`); } catch { /* handle closed: nothing to restore */ } };
}
/** True when `next` drops words `prior` held: a string anywhere in the prior value (a JSON row's text, a card's draft) or a key that is gone,
 * or a string that is not a prefix of the string at the same place in `next`. A value that only grows (a streamed reply) drops nothing. */
export function dropsWords(prior: unknown, next: unknown): boolean {
  if (typeof prior === "string") return prior !== "" && !(typeof next === "string" && next.startsWith(prior));
  if (prior === null || typeof prior !== "object") return false;
  if (next === null || typeof next !== "object") return hasWords(prior);
  const into = next as Record<string, unknown>;
  // a key that is gone is dropped words too (a key can hold text: {"owner words": 1})
  for (const [key, value] of Object.entries(prior as Record<string, unknown>)) if (!(key in into) || dropsWords(value, into[key])) return true;
  return false;
}
const hasWords = (value: unknown): boolean => typeof value === "string" ? value !== "" : value !== null && typeof value === "object" && Object.values(value).some(hasWords);
/** Runs `run` (which may open and commit its own transaction, or run inside the caller's) with secure_delete=ON on `db`. */
export function withSecureDelete<T>(db: DatabaseSync, run: () => T): T {
  const restore = secureDeleteOn(db);
  try { return run(); } finally { restore(); }
}
