// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW WP3 (S6 HIGH): the whole memory downgrade waits for the search index file's own downgrade (downgradeMemoryIndexFile is async).
// A stopped or unfinished index keeps its debt and the downgrade says not ready, with nothing after it run (the 1.0.3 root notes stay);
// a finished index is fully back in 1.0.17's shape when the downgrade returns; no index file at all is a pass.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeInstallationMemorySchema, MEMORY_INDEX_NOT_READY } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const INDEX = () => join(DATA_DIR, "memory-index.db");
const NOTE = () => join(DATA_DIR, "memory-repairs.json"); // a 1.0.3 root note: removeDataDirNamesAfter102 takes it, after the index step
const meta = (key: string) => {
  const db = new DatabaseSync(INDEX(), { readOnly: true });
  try { return (db.prepare("SELECT value FROM index_meta WHERE key=?").get(key) as { value: string } | undefined)?.value; } finally { db.close(); }
};
/** A MEMW-shaped index (as memw-downgrade-premerge.test.ts builds it): `lexical` with keys and the MEMW marker the downgrade removes. */
function index(stopped: boolean) {
  const db = new DatabaseSync(INDEX()); db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
    CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
    CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));
    INSERT INTO index_meta VALUES('lexical_keys_complete','1');
    INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1999);`);
  for (let s = 0; s < 40; s++) {
    db.prepare("INSERT INTO entries VALUES(?,1,'scope:0',?)").run(`memory:${1000 + s}`, `seg${s} common`);
    db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,?)").run(1000 + s, `memory:${1000 + s}`, `seg${s} common`);
    db.prepare("INSERT INTO lexical_keys VALUES(?,1,?)").run(`memory:${1000 + s}`, 1000 + s);
  }
  // the durable stop an overrun leaves (index-wal.ts): the open rule says stopped and the downgrade writes nothing to the file
  if (stopped) db.prepare("INSERT INTO index_meta VALUES('wal_over_stop',?)").run(JSON.stringify({ reason: "test", kind: "fill", seq: 1 }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
}

beforeEach(async () => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database(); closeDatabase();
  writeFileSync(NOTE(), JSON.stringify({ keepallUnwedge103: "x" }));
});
afterEach(async () => { closeDatabase(); });

describe("memory-downgrade waits for the index file's downgrade", () => {
  it("a stopped index: the downgrade is not ready (MEMORY_INDEX_NOT_READY), the stop is kept and nothing after the index step ran", async () => {
    index(true);
    await expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).rejects.toThrow(expect.objectContaining({ code: MEMORY_INDEX_NOT_READY }));
    expect(meta("wal_over_stop")).toBeDefined();
    expect(meta("lexical_keys_complete")).toBe("1");
    expect(existsSync(NOTE())).toBe(true);
    // STAMP LAST: the failed index step left the memory stamp untouched; the rerun performs the downgrade after the stop clears.
    const db = new DatabaseSync(INDEX()); db.exec("DELETE FROM index_meta WHERE key='wal_over_stop'"); db.close();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
    expect(meta("lexical_keys_complete")).toBeUndefined();
    expect(existsSync(NOTE())).toBe(false);
  });

  it("a ready index is fully back in 1.0.17's shape when the downgrade returns", async () => {
    index(false);
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
    expect(meta("lexical_keys_complete")).toBeUndefined();
    expect(existsSync(NOTE())).toBe(false);
  });

  it("no index file is a pass: nothing to finish, the downgrade completes", async () => {
    expect(existsSync(INDEX())).toBe(false);
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
    expect(existsSync(INDEX())).toBe(false);
    expect(existsSync(NOTE())).toBe(false);
  });
});
