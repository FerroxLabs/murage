// SPDX-License-Identifier: AGPL-3.0-or-later
// The reviewed search-file design (5d5a791f19) rebuilds asynchronously.
// Raw SQL fixtures must explicitly wait for that worker, rather than relying on
// the old synchronous messages.db FTS fill.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { messageSearchIndexReady, rebuildMessageSearchIndex, startSearchIndex, stopSearchIndex } from "../message-search-index.ts";

export async function rebuildSearchFixture(db = database()): Promise<void> {
  await stopSearchIndex();
  rebuildMessageSearchIndex(db);
  startSearchIndex(db, join(DATA_DIR, "messages.db"));
  await waitSearchFixture(db);
}

export async function waitSearchFixture(db = database()): Promise<void> {
  await vi.waitFor(() => {
    expect(messageSearchIndexReady(db), "search worker reader opened").toBe(true);
    const reader = new DatabaseSync(join(DATA_DIR, "search.db"), { readOnly: true });
    try {
      const state = reader.prepare("SELECT (SELECT v FROM search_state WHERE k='owner') AS owner,(SELECT v FROM search_state WHERE k='applied_seq') AS applied,EXISTS(SELECT 1 FROM search_state WHERE k='built') AS building").get()!;
      expect(state.owner).toBe(String(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done));
      expect(state.building, "search worker finished rebuilding").toBe(0);
      const newest = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM search_intents").get()!.n);
      expect(Number(state.applied), "search worker applied every fixture intent").toBeGreaterThanOrEqual(newest);
    } finally { reader.close(); }
  }, { timeout: 60_000, interval: 20 });
}

export interface SearchStatement { sql: string; rows: number; calls: number }
/** Observe both the serving handle and its separate, read-only search reader. */
export function watchSearch<T>(run: () => T): { out: T; statements: SearchStatement[] } {
  const db = database(), statements: SearchStatement[] = [];
  const wrap = (statement: ReturnType<DatabaseSync["prepare"]>, sql: string) => {
    const entry = { sql, rows: 0, calls: 0 }; statements.push(entry);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = value.apply(target, args);
        if (key === "all" || key === "get") entry.calls++;
        if (key === "all") entry.rows += out.length; else if (key === "get") entry.rows += out ? 1 : 0;
        return out;
      };
    } });
  };
  const ownPrepare = db.prepare.bind(db), prototypePrepare = DatabaseSync.prototype.prepare;
  const own = vi.spyOn(db, "prepare").mockImplementation(sql => wrap(ownPrepare(sql), sql));
  const reader = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    const statement = prototypePrepare.call(this, sql);
    return this !== db ? wrap(statement, sql) : statement;
  });
  try { return { out: run(), statements }; } finally { reader.mockRestore(); own.mockRestore(); }
}

/** Model writes queued while the derived reader is unavailable, without FTS. */
export async function pendingSearchFixture(db = database()): Promise<void> {
  await stopSearchIndex();
  const { syncMessageSearchRow } = await import("../message-search-index.ts");
  for (const row of db.prepare("SELECT rowid FROM messages ORDER BY rowid").all()) {
    syncMessageSearchRow(db, Number(row.rowid), null);
  }
}
