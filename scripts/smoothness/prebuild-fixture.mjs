// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic data only. The product creates/downgrades the schema; no migration SQL.
import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function seedPrebuildFixture(product, file, version, rows = 10_000) {
  const root = resolve(product);
  const schema = await import(pathToFileURL(join(root, "server/memory/schema.ts")).href);
  const { MESSAGES_SQL } = await import(pathToFileURL(join(root, "server/memory/testing/writetime-fixture.ts")).href);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    db.exec(MESSAGES_SQL);
    schema.migrateMemorySchema(db, "active");
    if (version !== schema.MEMORY_SCHEMA_VERSION) schema.downgradeMemorySchema(db, version);
    db.exec("BEGIN");
    db.exec("INSERT INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES('fixture','room','fixture','[]',0)");
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,'fixture','fact','fixture','owner-statement','active',?,0,NULL,NULL,0)");
    const source = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,'fixture',NULL,NULL,NULL,1,'fixture','message','user','ok',NULL,'active')");
    const sourceVersion = db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,'fixture','{\"text\":\"fixture\"}',0)");
    for (let i = 0; i < rows; i++) {
      record.run(`r${i}`, i % 10 === 0 ? 1 : 0);
      source.run(`s${i}`);
      sourceVersion.run(`s${i}`);
    }
    db.exec("COMMIT");
    // Leave absent indexes as an earlier install would, including a current-v13
    // install predating these preListen indexes.
    const { OPTIONAL_INDEXES, REQUIRED_INDEXES = [] } = await import(pathToFileURL(join(root, "server/memory/optional-index.ts")).href);
    for (const index of [...REQUIRED_INDEXES, ...OPTIONAL_INDEXES].filter(index => index.preListen)) db.exec(`DROP INDEX IF EXISTS "${index.name}"`);
    return { schemaVersion: Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get().schema_version), records: rows, sourceVersions: rows,
      sourceStamps: version < 13 ? 0 : Number(db.prepare("SELECT count(*) n FROM memory_source_lsn").get().n) };
  } finally { db.close(); }
}
