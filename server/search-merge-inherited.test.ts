// SPDX-License-Identifier: AGPL-3.0-or-later
// A database a pre-release build opened with the worker merge (automerge=0, deletemerge=0, a search_merge marker row) is settled at open:
// the SQLite default merge settings come back and the owed merge is paid and its marker removed (message-search-index.ts settleInheritedSearchMerge).
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage } from "./message-db.ts";
import { settleInheritedSearchMerge } from "./message-search-index.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: Date.now() });
const config = (db: DatabaseSync) => Object.fromEntries(db.prepare("SELECT k, v FROM messages_fts_config WHERE k IN ('automerge', 'deletemerge')").all().map((row) => [String(row.k), Number(row.v)]));
const marker = (db: DatabaseSync) => db.prepare("SELECT done FROM transcript_index_state WHERE name = 'search_merge'").get();
const optimize = "INSERT INTO messages_fts(messages_fts) VALUES('optimize')";
const checkpoint = "PRAGMA wal_checkpoint(TRUNCATE)";
const maintenance = (sql: string) => /optimize|wal_checkpoint\s*\(TRUNCATE\)|INSERT INTO messages_fts\(messages_fts, rank\)/i.test(sql);

function fixture(done?: number): DatabaseSync {
  const db = database();
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)");
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 0)");
  for (let i = 1; i <= 4; i++) insertMessage("t", msg(`m${i}`, i === 1 ? "alpha bravo charlie" : `deleted posting number ${i}`));
  db.exec("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id IN ('m2', 'm3'))");
  if (done === 1) db.exec(optimize);
  if (done !== undefined) db.prepare("INSERT INTO transcript_index_state(name, done, cursor, skipped) VALUES('search_merge', ?, 0, 0)").run(done);
  closeMessageDb();
  // the app's own checkpointer connection can still be closing: wait until a full scrub gets through, then work on a copy of the file that only
  // this test has open, so the settle's own scrub is not racing a connection of the app's
  const source = new DatabaseSync(join(DATA_DIR, "messages.db"));
  source.exec("PRAGMA busy_timeout=5000");
  for (let i = 0; i < 100 && source.prepare(checkpoint).get()?.busy !== 0; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  source.close();
  const copy = join(DATA_DIR, "inherited.db");
  copyFileSync(join(DATA_DIR, "messages.db"), copy);
  const raw = new DatabaseSync(copy);
  raw.exec("PRAGMA busy_timeout=5000");
  return raw;
}

function observe(db: DatabaseSync, sql: string[], fail?: "busy" | "throw"): DatabaseSync {
  return {
    exec(statement: string) { sql.push(statement); return db.exec(statement); },
    prepare(statement: string) {
      const prepared = db.prepare(statement);
      return new Proxy(prepared, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            sql.push(statement);
            if (statement === checkpoint) {
              expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(0);
              expect(marker(db)).toBeDefined();
            }
            if (statement === checkpoint && fail) {
              if (fail === "throw") throw new Error("injected checkpoint failure");
              return { busy: 1, log: 1, checkpointed: 0 };
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
    },
  } as DatabaseSync;
}

beforeEach(() => {
  closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

describe("a database opened by the worker-merge build", () => {
  for (const done of [0, 1]) {
    it(`gets the default merge settings and loses its marker row (done=${done}) at the next open`, () => {
      const db = fixture(done), sql: string[] = [];
      try {
        db.exec("PRAGMA busy_timeout=1234");
        expect(config(db)).toEqual({ automerge: 0, deletemerge: 0 });
        settleInheritedSearchMerge(observe(db, sql));
        expect(sql.filter((statement) => statement === optimize || statement === checkpoint)).toEqual(done === 0 ? [optimize, checkpoint] : [checkpoint]);
        expect(config(db)).toEqual({ automerge: 4, deletemerge: 10 });
        expect(marker(db)).toBeUndefined();
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1234);
        expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"bra\" AND \"rav\"'").all().length).toBe(1);
      } finally { db.close(); }
    });
  }

  it("an ordinary open writes no merge setting, runs no optimize and no scrub, and keeps working", () => {
    const db = fixture(), sql: string[] = [];
    try {
      db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 4)");
      db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 10)");
      expect(marker(db)).toBeUndefined();
      settleInheritedSearchMerge(observe(db, sql));
      expect(sql.filter(maintenance)).toEqual([]);
      expect(config(db)).toEqual({ automerge: 4, deletemerge: 10 });
      expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"bra\" AND \"rav\"'").all().length).toBe(1);
    } finally { db.close(); }
  });

  it("leftover worker-merge settings without a marker row come back to the defaults with no optimize and no scrub", () => {
    const db = fixture(), sql: string[] = [];
    try {
      expect(config(db)).toEqual({ automerge: 0, deletemerge: 0 });
      settleInheritedSearchMerge(observe(db, sql));
      expect(sql.filter((statement) => statement === optimize || statement === checkpoint)).toEqual([]);
      expect(config(db)).toEqual({ automerge: 4, deletemerge: 10 });
    } finally { db.close(); }
  });

  for (const failure of ["busy", "throw"] as const) {
    it(`keeps its marker row after a ${failure} scrub and settles on retry`, () => {
      const db = fixture(0), sql: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        db.exec("PRAGMA busy_timeout=1234");
        expect(() => settleInheritedSearchMerge(observe(db, sql, failure))).not.toThrow();
        expect(marker(db)?.done).toBe(0);
        expect(sql.filter((statement) => statement === optimize || statement === checkpoint)).toEqual([optimize, checkpoint]);
        expect(warn).toHaveBeenCalledOnce();
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1234);
        sql.length = 0;
        settleInheritedSearchMerge(observe(db, sql));
        expect(sql.filter((statement) => statement === optimize || statement === checkpoint)).toEqual([optimize, checkpoint]);
        expect(marker(db)).toBeUndefined();
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1234);
      } finally { warn.mockRestore(); db.close(); }
    });
  }
});
