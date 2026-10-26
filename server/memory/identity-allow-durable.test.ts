// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lane 2, item 2.3 (LANE2-MEMORY-DESIGN r2.7): procedural skills are not withheld at startup while the identity indexes are deferred.
// The identity set a consumer ALLOWS on is kept in the file under a durable counter that every identity write of any connection moves
// (schema.ts IDENTITY_STAMP_SCHEMA); a fresh process serves it at once, an unrelated commit does not throw it away, an identity write does
// (withheld until the recompute lands), a set computed under a counter that moved is discarded, and the downgrade step drops the mirror.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { durableIdentityStamp, identityForAllow, identityIndexesReady, identityRecomputeStats, recomputeIdentityOffThread, SMALL_STORE_ROWS, storeIdentityAllow } from "./provenance-stamp.ts";
import { downgradeMemorySchema, migrateMemorySchema, IDENTITY_ALLOW_TABLE, IDENTITY_STAMP_NAMES, IDENTITY_STAMP_TABLE, validateMemorySchema } from "./schema.ts";
import { assertSkillProcedureEvidence, type SkillProcedureContext } from "../skills.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

function source(threadId: string) {
  const id = `source:${threadId}`;
  transaction(db => captureSource(db, { id, threadId, kind: "tool-outcome", speaker: "tool", outcome: "completed", text: `o ${threadId}`, action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
  const scopeId = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id)!.scope_id);
  return { kind: "source" as const, id, revision: 1, scopeId };
}
function record(id: string, scope: string, source: string, kind = "fact") {
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,'plain','owner-statement','active',0,1,NULL,NULL,1)").run(id, scope, kind);
  db.prepare("INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status) VALUES(?,1,'semantic','current','current') ON CONFLICT(record_id,record_version) DO UPDATE SET partition=excluded.partition").run(id);
  db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(id, source);
}
function bulk(n: number, scope: string) {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_records SELECT 'h-'||n,1,?,'fact','x','owner-statement','active',0,1,NULL,NULL,n FROM c`).run(n, scope);
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status) SELECT 'h-'||n,1,'semantic','current','current' FROM c`).run(n);
  db.exec("COMMIT");
}
const elsewhere = (sql: string) => { const other = new DatabaseSync(join(DATA_DIR, "messages.db")); try { other.exec("PRAGMA foreign_keys=OFF"); other.exec(sql); } finally { other.close(); } };
const objects = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?))").all(JSON.stringify(IDENTITY_STAMP_NAMES)) as Array<{ name: string }>).map(row => row.name).sort();

it("a large store with deferred indexes: the kept set serves a fresh process at once, survives unrelated commits, and an identity write withholds until the recompute lands", { timeout: 120_000 }, async () => {
  const a = source("a"), b = source("b");
  record("canon", a.scopeId, a.id, "character-canon");
  record("plain", a.scopeId, b.id);
  bulk(SMALL_STORE_ROWS + 5_000, a.scopeId);
  let db = database();
  expect(identityIndexesReady(db)).toBe(false);
  expect(objects(db)).toEqual([...IDENTITY_STAMP_NAMES].sort());
  // the seed's identity writes moved the durable counter; no set is kept yet, so the first check withholds and starts the recompute
  const n = durableIdentityStamp(db)!;
  expect(n).toBeGreaterThan(0);
  expect(identityForAllow(db)).toBeNull();
  expect(await recomputeIdentityOffThread(db)).toBe(true);
  expect([...identityForAllow(db)!]).toEqual([`${a.id}:1`]);
  expect(db.prepare(`SELECT stamp FROM ${IDENTITY_ALLOW_TABLE} WHERE id=1`).get()?.stamp).toBe(n);

  // a fresh process: no memo, indexes still deferred, and the check is served from the file with no recompute
  closeDatabase(); db = database();
  expect(identityIndexesReady(db)).toBe(false);
  const started = identityRecomputeStats.started;
  expect([...identityForAllow(db)!]).toEqual([`${a.id}:1`]);
  expect(identityRecomputeStats.started).toBe(started);
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [a.scopeId, b.scopeId] };
  expect(() => assertSkillProcedureEvidence(context, [b])).not.toThrow();
  expect(() => assertSkillProcedureEvidence(context, [a])).toThrow("PROCEDURE_EVIDENCE_REVOKED");

  // an unrelated commit by another connection (an ordinary record): the memo of this connection is stale, the durable counter is not
  elsewhere("INSERT INTO memory_records VALUES('other-plain',1,'" + a.scopeId + "','fact','plain','owner-statement','active',0,1,NULL,NULL,1)");
  expect(durableIdentityStamp(db)).toBe(n);
  expect([...identityForAllow(db)!]).toEqual([`${a.id}:1`]);
  expect(identityRecomputeStats.started).toBe(started);

  // an identity record citing an existing source, from another connection (Astra's case): withheld until the recompute lands, then exact
  elsewhere("INSERT INTO memory_records VALUES('canon-2',1,'" + a.scopeId + "','character-canon','plain','owner-statement','active',0,1,NULL,NULL,1); INSERT INTO memory_evidence VALUES('canon-2',1,'" + b.id + "',1,0,1)");
  expect(durableIdentityStamp(db)).toBeGreaterThan(n);
  expect(identityForAllow(db)).toBeNull();
  expect(() => assertSkillProcedureEvidence(context, [b])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  expect(await recomputeIdentityOffThread(db)).toBe(true);
  expect([...identityForAllow(db)!].sort()).toEqual([`${a.id}:1`, `${b.id}:1`]);
  expect(() => assertSkillProcedureEvidence(context, [b])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});

it("a set computed under a counter that moved is discarded, never written", () => {
  const a = source("a");
  record("plain", a.scopeId, a.id);
  const db = database();
  const n = durableIdentityStamp(db)!;
  expect(storeIdentityAllow(db, n - 1, new Set(["stale:1"]))).toBe(false);
  expect(db.prepare(`SELECT 1 FROM ${IDENTITY_ALLOW_TABLE} WHERE id=1`).get()).toBeUndefined();
  expect(storeIdentityAllow(db, n, new Set(["kept:1"]))).toBe(true);
  expect(db.prepare(`SELECT stamp,ids_json FROM ${IDENTITY_ALLOW_TABLE} WHERE id=1`).get()).toMatchObject({ stamp: n, ids_json: '["kept:1"]' });
  // inside a transaction nothing is written (a write may roll back)
  db.exec("BEGIN");
  try { expect(storeIdentityAllow(db, n, new Set(["in-tx:1"]))).toBe(false); } finally { db.exec("ROLLBACK"); }
  expect(db.prepare(`SELECT ids_json FROM ${IDENTITY_ALLOW_TABLE} WHERE id=1`).get()?.ids_json).toBe('["kept:1"]');
});

it("the small-store read keeps its set in the file, and the downgrade step drops the mirror while the validator accepts both shapes", () => {
  const a = source("a");
  record("canon", a.scopeId, a.id, "character-canon");
  const db = database();
  const n = durableIdentityStamp(db)!;
  expect([...identityForAllow(db)!]).toEqual([`${a.id}:1`]);
  expect(db.prepare(`SELECT stamp FROM ${IDENTITY_ALLOW_TABLE} WHERE id=1`).get()?.stamp).toBe(n);
  expect(() => validateMemorySchema(db)).not.toThrow();
  expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "downgraded", from: 13, to: 10 }); // 1.0.3: the file is v13, 1.0.2 reads v10
  expect(objects(db)).toEqual([]);
  expect(durableIdentityStamp(db)).toBeNull();
  expect(() => validateMemorySchema(db)).not.toThrow();
  // without the mirror the check still answers (a small store reads the rows), and the next open makes the mirror again from zero
  expect([...identityForAllow(db)!]).toEqual([`${a.id}:1`]);
  // the next open is the migration (1.0.3: v10 to settings' v11), which makes the lane's objects again
  migrateMemorySchema(db);
  expect(objects(db)).toEqual([...IDENTITY_STAMP_NAMES].sort());
  expect(durableIdentityStamp(db)).toBe(0);
  expect(db.prepare(`SELECT 1 FROM ${IDENTITY_ALLOW_TABLE} WHERE id=1`).get()).toBeUndefined();
  expect(db.prepare(`SELECT 1 FROM sqlite_schema WHERE name=?`).get(IDENTITY_STAMP_TABLE)).toBeDefined();
});
