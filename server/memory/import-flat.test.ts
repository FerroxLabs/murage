// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A notebook import (a new MEMORY.md, or an edit to a tracked one) reads no whole table: the same statements and rows with 10 and with 200,000
// evidence rows and disclosures from other sources (before, each import scanned memory_evidence by source and memory_disclosures by state, 6-17 s
// on the main thread on a 77 MB file). And the source id no longer depends on where the data dir is, so a moved data dir imports nothing again.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { migrateDetectedMemoryNotebooks, syncTrackedMemoryImports } from "./import.ts";
import { ensureDisclosuresLiveIndex } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
});
function walk() {
  let cursor: string | undefined, imported = 0;
  do { const result = migrateDetectedMemoryNotebooks(roster, cursor); imported += result.imported; cursor = result.nextCursor; } while (cursor);
  return imported;
}
function fill(others: number): void {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF"); // the rows need no record or source here: only their number matters
  db.exec("BEGIN");
  db.prepare("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_evidence SELECT 'other-r'||n,1,'other-s'||n,1,0,1 FROM c").run(others);
  db.prepare("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_disclosures SELECT 'other-b'||n,'t','d',NULL,'[]','[]','[]',1,0,0,'revoked',1 FROM c").run(others);
  db.exec("COMMIT");
}

type Seen = { sql: string; rows: number };
/** Records every statement an action runs and the rows it read or changed. */
function record(action: () => void): Seen[] {
  const db = database(), seen: Seen[] = [], original = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = original(sql), entry: Seen = { sql, rows: 0 };
    seen.push(entry);
    return new Proxy(statement, { get(target, key) {
      const value = (target as never)[key] as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (key === "all") entry.rows += (out as unknown[]).length;
        else if (key === "get") entry.rows += out ? 1 : 0;
        else if (key === "run") entry.rows += Number((out as { changes: number }).changes);
        return out;
      };
    } });
  };
  try { action(); } finally { (db as unknown as { prepare: unknown }).prepare = original; }
  return seen;
}
const touches = (sql: string) => /memory_evidence|memory_disclosures/.test(sql) && !/^\s*(CREATE|INSERT INTO memory_evidence)/i.test(sql);

it("a new and a changed notebook import read the same statements and rows at 10 and at 200,000 other evidence rows", () => {
  const runs: Seen[][] = [];
  for (const others of [10, 200_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
    fill(others);
    const root = ensureWorkspace("a");
    const seen: Seen[] = [];
    writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
    seen.push(...record(() => expect(walk()).toBe(1)));
    writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed, and edited.");
    seen.push(...record(() => expect(walk()).toBe(1)));
    const db = database();
    for (const entry of seen.filter(item => touches(item.sql))) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all() as Array<{ detail: string }>).map(row => row.detail);
      expect(plan.some(line => /^SCAN memory_evidence$/.test(line) || /^SCAN memory_disclosures$/.test(line)), `${entry.sql} :: ${plan.join(" | ")}`).toBe(false);
    }
    runs.push(seen.filter(item => touches(item.sql)));
  }
  expect(runs[0].length).toBeGreaterThan(0);
  expect(runs[1].map(item => [item.sql, item.rows])).toEqual(runs[0].map(item => [item.sql, item.rows]));
  // the first import reads no evidence for a source that has no row; the change reads it by source
  const first = runs[1].filter(item => /memory_evidence/.test(item.sql));
  expect(first.every(item => /memory_evidence_by_source/.test(item.sql))).toBe(true);
});

it("revoking the live disclosures seeks the live receipts by state, with or without the late live-receipts index", async () => {
  expect(database().prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosures_live'").get()).toBeUndefined(); // not made at open
  const plan = () => (database().prepare("EXPLAIN QUERY PLAN UPDATE memory_disclosures SET state='revoked' WHERE state IN ('prepared','delivered')").all() as Array<{ detail: string }>).map(row => row.detail).join(" | ");
  expect(plan()).toMatch(/SEARCH memory_disclosures/);
  await ensureDisclosuresLiveIndex(database(), { inline: true });
  expect(database().prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosures_live'").get()).toBeDefined();
  expect(plan()).not.toMatch(/SCAN memory_disclosures/);
});

/** What an install made before the id change holds: the source, its versions and evidence filed under a hash of the absolute path. */
function relabel(path: string): string {
  const db = database(), source = db.prepare("SELECT id,scope_id FROM memory_sources WHERE id LIKE 'legacy:%'").get()!;
  const old = `legacy:${createHash("sha256").update(JSON.stringify([String(source.scope_id), path])).digest("hex")}`;
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("UPDATE memory_sources SET id=? WHERE id=?").run(old, source.id);
  db.prepare("UPDATE memory_source_versions SET source_id=?, payload=json_set(payload,'$.path',?) WHERE source_id=?").run(old, path, source.id);
  db.prepare("UPDATE memory_evidence SET source_id=? WHERE source_id=?").run(old, source.id);
  db.prepare("DELETE FROM memory_scope_bindings WHERE id LIKE 'notebook-link:%' OR id='notebook-migration-done'").run();
  db.exec("PRAGMA foreign_keys=ON");
  return old;
}

it("a data dir moved after the import imports nothing for an unchanged notebook and one source for a changed one", () => {
  const root = ensureWorkspace("a");
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
  expect(walk()).toBe(1);
  const old = relabel("/old/home/.murage/workspaces/a/MEMORY.md");
  expect(walk()).toBe(0);
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed, and edited.");
  expect(walk()).toBe(1);
  const ids = database().prepare("SELECT id FROM memory_sources WHERE id LIKE 'legacy:%'").all().map(row => row.id);
  expect(ids).toEqual([old]);
});

it("an install whose source id hashes the absolute path in this data dir keeps that id", () => {
  const root = ensureWorkspace("a");
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
  expect(walk()).toBe(1);
  const old = relabel(join(root, "MEMORY.md"));
  expect(walk()).toBe(0);
  expect(database().prepare("SELECT id FROM memory_sources WHERE id LIKE 'legacy:%'").all().map(row => row.id)).toEqual([old]);
});

/** A changed notebook with a derived record resting on its first revision, the evidence index built or not. */
function changedImport(indexReady: boolean) {
  const root = ensureWorkspace("a");
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
  expect(walk()).toBe(1);
  const db = database(), source = db.prepare("SELECT id,scope_id FROM memory_sources WHERE id LIKE 'legacy:%'").get()!;
  db.prepare("INSERT INTO memory_records VALUES('derived-1',1,?,'fact','a fact','unverified-import','active',0,1,NULL,NULL,1)").run(source.scope_id);
  db.prepare("INSERT INTO memory_evidence VALUES('derived-1',1,?,1,0,5)").run(source.id);
  db.prepare("INSERT INTO memory_projection_receipts VALUES('derived-1',1,0,'pending','pending',NULL)").run();
  db.prepare("UPDATE memory_late_build SET ready=?,cursor=NULL WHERE name='evidence'").run(indexReady ? 1 : 0);
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed, and edited.");
  const snapshot = () => db.prepare("SELECT id,version,state FROM memory_records ORDER BY id,version").all().map(row => `${row.id}:${row.version}:${row.state}`);
  const link = () => String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'notebook-link:%'").get()?.intent);
  return { db, snapshot, link, source };
}

it("a changed notebook before the evidence index is ready is deferred whole, reads no evidence, and the retry once ready supersedes chunk and derived records", () => {
  const w = changedImport(false);
  const before = w.snapshot(), linkBefore = w.link();
  const seen = record(() => expect(walk()).toBe(0));
  expect(seen.filter(item => /memory_evidence/.test(item.sql) && !/^\s*INSERT INTO memory_evidence/i.test(item.sql)).map(item => item.sql)).toEqual([]);
  record(() => expect(syncTrackedMemoryImports(roster)).toBe(0));
  expect(w.snapshot()).toEqual(before); // nothing half-applied: no new chunk, no superseded record
  expect(w.link()).toBe(linkBefore); // the link still holds the old hash, so the sync tries again
  expect(w.db.prepare("SELECT count(*) AS n FROM memory_sources WHERE revision>1").get()!.n).toBe(0);

  w.db.prepare("UPDATE memory_late_build SET ready=1 WHERE name='evidence'").run();
  expect(syncTrackedMemoryImports(roster)).toBe(1);
  const after = w.snapshot().map(line => line.replace(/^legacy:[0-9a-f]+/, "S"));
  expect(after.find(line => line.startsWith("derived-1:"))).toBe("derived-1:1:superseded");
  expect(after.filter(line => line.includes(":chunk:")).map(line => line.split(":").pop())).toEqual(["superseded", "active"]);
  // no active record cites the old revision
  expect(w.db.prepare("SELECT count(*) AS n FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE e.source_id=? AND e.source_revision=1 AND r.state='active'").get(w.source.id)!.n).toBe(0);
});
