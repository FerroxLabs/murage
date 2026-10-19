// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc3f: an optional index is built off the main thread (a worker on its own connection), open makes none, readers see readiness as
// "the index exists", validation accepts the file with or without it, and the downgrade for 1.0.1 drops every registered one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { DISCLOSURES_LIVE_INDEX, downgradeMemorySchema, ensureDisclosuresLiveIndex, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { OPTIONAL_INDEXES, optionalIndexReady, registerOptionalIndex } from "./optional-index.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dirs: string[] = [], dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) try { db.close(); } catch { /* closed */ } for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

it("open makes no optional index; the worker builds it on its own connection; downgrade drops all of them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "optidx-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  expect(OPTIONAL_INDEXES.length).toBeGreaterThan(0);
  for (const index of OPTIONAL_INDEXES) expect(optionalIndexReady(db, index.name)).toBe(false);
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) SELECT 'b'||i,'t','d',NULL,'[]','[]',0,0,0,'delivered',0 FROM n`).run();
  expect(await ensureDisclosuresLiveIndex(db)).toBe(true); // a file database: the worker builds it
  expect(optionalIndexReady(db, DISCLOSURES_LIVE_INDEX)).toBe(true);
  expect(() => validateMemorySchema(db)).not.toThrow();
  downgradeMemorySchema(db, 8);
  for (const index of OPTIONAL_INDEXES) expect(optionalIndexReady(db, index.name)).toBe(false);
});

it("an optional index is built only while the reclaim gate allows it, and one per idle window", async () => {
  const { buildOptionalIndexesWhenIdle, resetOptionalIndexWindow } = await import("./optional-index.ts");
  const { setReadTimeJudgeRetired } = await import("./root-set-reclaim.ts");
  setReadTimeJudgeRetired(true);
  try {
    const dir = mkdtempSync(join(tmpdir(), "optidx-gate-")); dirs.push(dir);
    const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    migrateMemorySchema(db, "active");
    const idle = { ownerIdleMs: () => 3_600_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
    const indexes = OPTIONAL_INDEXES.filter(item => item.table.startsWith("memory_")); // this file holds only the memory tables
    const first = indexes[0].name; // registration order: the first not-yet-built index is the one an idle window builds
    const ready = () => optionalIndexReady(db, first);
    resetOptionalIndexWindow();
    for (const busy of [{ ownerIdleMs: () => 9 * 60_000 }, { ownerIdleMs: () => 1_000 }, { liveTurn: () => true }, { typingHeld: () => true }, { routineDueWithin: () => true }, { healthAnswered: () => false }, { integrityPending: () => true }, { revocationWaiting: () => true }]) {
      expect(await buildOptionalIndexesWhenIdle(db, { ...idle, ...busy })).toBeNull();
      expect(ready()).toBe(false); // no build while the owner is active or a turn is live
    }
    expect(await buildOptionalIndexesWhenIdle(db, idle)).toBe(first); // idle: it builds
    expect(ready()).toBe(true);
    // one per window: the next registered index waits for the next window
    const next = indexes[1].name;
    expect(optionalIndexReady(db, next)).toBe(false);
    expect(await buildOptionalIndexesWhenIdle(db, idle)).toBeNull();
    expect(await buildOptionalIndexesWhenIdle(db, { ...idle, liveTurn: () => true })).toBeNull(); // the window closes
    expect(await buildOptionalIndexesWhenIdle(db, idle)).toBe(next);
    for (let window = 0; window < indexes.length && !indexes.every(item => optionalIndexReady(db, item.name)); window++) {
      expect(await buildOptionalIndexesWhenIdle(db, { ...idle, liveTurn: () => true })).toBeNull(); // each window closes before the next
      expect(await buildOptionalIndexesWhenIdle(db, idle)).not.toBeNull();
    }
    expect(await buildOptionalIndexesWhenIdle(db, { ...idle, liveTurn: () => true })).toBeNull();
    expect(indexes.every(item => optionalIndexReady(db, item.name))).toBe(true);
    // and an index registered later waits for the window after that
    const second = registerOptionalIndex({ name: "optidx_test_second", table: "memory_disclosures", minSchemaVersion: 9, sql: "CREATE INDEX IF NOT EXISTS optidx_test_second ON memory_disclosures(thread_id)" });
    try {
      expect(optionalIndexReady(db, second.name)).toBe(false);
      expect(await buildOptionalIndexesWhenIdle(db, { ...idle, liveTurn: () => true })).toBeNull(); // the window closes
      // one index per window: every other registered index (the owner-pin one) goes first, each in a window of its own
      let built: string | null = null;
      for (let window = 0; window < OPTIONAL_INDEXES.length + 1 && built !== second.name; window++) {
        await buildOptionalIndexesWhenIdle(db, { ...idle, liveTurn: () => true });
        built = await buildOptionalIndexesWhenIdle(db, idle);
      }
      expect(built).toBe(second.name);
      expect(optionalIndexReady(db, second.name)).toBe(true);
    } finally { OPTIONAL_INDEXES.splice(OPTIONAL_INDEXES.findIndex(item => item.name === second.name), 1); }
  } finally { setReadTimeJudgeRetired(false); }
}, 60_000);

it("a retry of a failed optional index build passes the same idle gate as the first attempt", async () => {
  const { buildOptionalIndexesWhenIdle, resetOptionalIndexWindow, optionalIndexStats } = await import("./optional-index.ts");
  const { setReadTimeJudgeRetired } = await import("./root-set-reclaim.ts");
  setReadTimeJudgeRetired(true);
  const broken = registerOptionalIndex({ name: "optidx_test_broken", table: "memory_disclosures", minSchemaVersion: 9, sql: "CREATE INDEX IF NOT EXISTS optidx_test_broken ON memory_disclosures(no_such_column)" });
  const saved = OPTIONAL_INDEXES.splice(0, OPTIONAL_INDEXES.length, broken);
  try {
    const dir = mkdtempSync(join(tmpdir(), "optidx-retry-")); dirs.push(dir);
    const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    migrateMemorySchema(db, "active");
    const before = { ...optionalIndexStats };
    // the gate is open for the first attempt and closes the moment its worker has started (a turn begins)
    const gate = { ownerIdleMs: () => 3_600_000, liveTurn: () => optionalIndexStats.started > before.started, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
    resetOptionalIndexWindow();
    expect(await buildOptionalIndexesWhenIdle(db, gate, { retryMs: 10 })).toBeNull(); // the first attempt fails (bad column)
    expect(optionalIndexStats.started - before.started).toBe(1); // no retry started a worker while the gate was closed
    expect(optionalIndexStats.gated - before.gated).toBe(3);
  } finally { OPTIONAL_INDEXES.splice(0, OPTIONAL_INDEXES.length, ...saved); setReadTimeJudgeRetired(false); }
}, 60_000);
