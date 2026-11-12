// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WEB_GLOBAL_BYTES = 128 * 1024 * 1024;
export const WEB_BOT_BYTES = 32 * 1024 * 1024;
/** Shared by server, Chrome executors and stdio browser processes for this OS
 * user. Only byte reservations live on disk, never URLs or page text. SQLite
 * transactions keep the aggregate ceiling valid across concurrent processes.
 * A stalled live process keeps its reservation; expiry cannot hide its memory. */
export class WebDocumentBudget {
  private db: DatabaseSync;
  private global: number;
  private perBot: number;
  constructor(path: string, global = WEB_GLOBAL_BYTES, perBot = WEB_BOT_BYTES) {
    this.global = global; this.perBot = perBot;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL, bytes INTEGER NOT NULL)');
    this.sweep();
  }
  sweep() {
    const rows = this.db.prepare('SELECT DISTINCT pid FROM reservations').all() as { pid: number }[];
    for (const { pid } of rows) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') this.db.prepare('DELETE FROM reservations WHERE pid=?').run(pid); }
    }
  }
  reserve(id: string, owner: string, bytes: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total, COALESCE(SUM(CASE WHEN owner=? THEN bytes ELSE 0 END),0) AS bot, COUNT(*) AS count FROM reservations').get(owner) as { total: number; bot: number; count: number };
      if (row.total + bytes > this.global || row.bot + bytes > this.perBot || row.count >= 4096) throw Error('Web document storage is full. No partial document was saved.');
      this.db.prepare('INSERT INTO reservations VALUES (?,?,?,?)').run(id, process.pid, owner, bytes);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  release(id: string) { this.db.prepare('DELETE FROM reservations WHERE id=? AND pid=?').run(id, process.pid); }
  close() { this.db.close(); }
}
let shared: WebDocumentBudget | undefined;
export function sharedWebDocumentBudget() {
  if (!shared) {
    // Independent of per-engine HOME, data dir and temporary directory overrides.
    // On Windows the user temp folder is the common user-owned runtime root.
    const root = join(process.platform === 'win32' ? tmpdir() : '/tmp', `murage-web-budget-${process.getuid?.() ?? 'user'}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    shared = new WebDocumentBudget(join(root, 'reservations.sqlite'));
    const timer = setInterval(() => { try { shared?.sweep(); } catch { /* busy ledger: keep reservations and retry next sweep */ } }, 60_000); timer.unref();
  }
  return shared;
}
