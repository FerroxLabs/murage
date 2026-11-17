// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";

/** Offline compatibility work for a pre-worker index. Each merge is a separate,
 * bounded transaction. Never restore automerge until all inherited work is paid:
 * its old value is the durable restart note after a crash. */
export function payDownInheritedSearchPile(db: DatabaseSync): void {
  const changes = db.prepare("SELECT total_changes() AS n");
  let steps = 0;
  for (; steps < 1_000_000; steps++) {
    const before = Number(changes.get()!.n);
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', 16)");
    if (Number(changes.get()!.n) - before < 2) {
      if (steps > 0) console.info(`[message-search] merged inherited index segments in ${steps} bounded steps`);
      return;
    }
  }
  throw new Error("inherited search merge did not settle");
}

/** Only legacy/offline handles enter here; a live worker schema retires the old
 * table instead. Failure retains the stored settings so another open resumes. */
export function settleLegacySearchMerge(db: DatabaseSync): void {
  try {
    const config = new Map(db.prepare("SELECT k,v FROM messages_fts_config WHERE k IN ('automerge','deletemerge')").all().map(row => [String(row.k), Number(row.v)]));
    if (config.has("automerge") && config.get("automerge") !== 4) payDownInheritedSearchPile(db);
    if (config.has("automerge") && config.get("automerge") !== 4) db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 4)");
    if (config.has("deletemerge") && config.get("deletemerge") !== 10) db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 10)");
  } catch (error) {
    console.warn("[message-search] inherited index merge remains unfinished; another open resumes it:", error instanceof Error ? error.message : error);
  }
}
