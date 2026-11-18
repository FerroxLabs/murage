// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from 'node:sqlite';

/** Core secure_delete wipes freed database pages; FTS5's separate option removes
 * a deleted row's postings in place instead of leaving delete keys for a full
 * merge. Both are needed to erase rolled checkpoints without rewriting history.
 * Node 24 and the supported Electron runtimes use SQLite newer than 3.42. */
export function secureDeleteFts(db: DatabaseSync, table: 'lexical' | 'lexical_age'): void {
  if (Number(db.prepare(`SELECT v FROM ${table}_config WHERE k='secure-delete'`).get()?.v) !== 1) {
    db.exec(`INSERT INTO ${table}(${table},rank) VALUES('secure-delete',1)`);
  }
}
