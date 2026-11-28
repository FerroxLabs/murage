// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (MAIN-RULING SQLITE-1022 item 1a, "witness per site"; owner: q1022-sqlite-opus). Records the connection's live
// secure_delete mode at every row a real site removes or rewrites: a TEMP trigger on the site's table calls a function that reads
// PRAGMA secure_delete on the same connection while the statement runs (0 OFF, 1 ON, 2 FAST). W1a-SITE (sqlite-cost-items12-1022.test.ts)
// proves ON zeroes the freed pages on disk; a site row proves its own transaction ran at ON.
import type { DatabaseSync } from "node:sqlite";

let probes = 0;
export interface SecureDeleteProbe { readonly modes: number[]; stop(): void }
/** Watches `table` (DELETE, or UPDATE of `column`) on `db` until stop(). */
export function probeSecureDelete(db: DatabaseSync, table: string, on: "DELETE" | { update: string } = "DELETE"): SecureDeleteProbe {
  const name = `sd_probe_${++probes}`, modes: number[] = [];
  db.function(name, () => { modes.push(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete)); return null; });
  const event = on === "DELETE" ? "DELETE" : `UPDATE OF ${on.update}`;
  db.exec(`CREATE TEMP TRIGGER ${name} AFTER ${event} ON main.${table} BEGIN SELECT ${name}(); END`);
  return { modes, stop: () => { try { db.exec(`DROP TRIGGER IF EXISTS temp.${name}`); } catch { /* handle closed */ } } };
}
