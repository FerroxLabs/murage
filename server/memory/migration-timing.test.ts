// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in timing of the memory schema v2 -> v4 upgrade on a large synthetic
// messages.db (MEMMIGRATE_MB=645, or a .memmigrate-mb file in the cwd, then vitest run <this file>).
// Skipped in the normal suite. Temp data dir only.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MEMORY_PRE_V3_SNAPSHOT, MEMORY_SCHEMA_V2, migrateMemorySchema } from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./learning-policy.ts";

const SIZE_FILE = join(process.cwd(), ".memmigrate-mb");
const MB = Number(process.env.MEMMIGRATE_MB ?? (existsSync(SIZE_FILE) ? readFileSync(SIZE_FILE, "utf8") : 0));
const gate = MB > 0 ? it : it.skip;

gate("times the v2 -> v4 upgrade and its copy on a large messages.db", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-memmigrate-timing-"));
  try {
    const file = join(root, "messages.db");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=OFF");
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
    const rows = Math.ceil((MB * 1024 * 1024) / 4200);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${rows})
      INSERT INTO messages SELECT 'thread-'||(i%2000),'m'||i,i,CASE i%2 WHEN 0 THEN 'user' ELSE 'assistant' END,'text',
      substr(hex(randomblob(1000)),1,2000),'{"parts":"'||hex(randomblob(1000))||'"}' FROM n`);
    db.exec(MEMORY_SCHEMA_V2);
    db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
    db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
    db.exec("INSERT INTO memory_scopes VALUES('scope','conversation','thread','[]',0)");
    const memRows = Math.ceil(rows / 4);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${memRows})
      INSERT INTO memory_sources SELECT 's'||i,'scope','thread-'||(i%2000),'m'||i,NULL,1,hex(randomblob(16)),'text','user','ok',NULL,'active' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${memRows})
      INSERT INTO memory_source_versions SELECT 's'||i,1,hex(randomblob(16)),'{"t":"'||hex(randomblob(300))||'"}',i FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${memRows})
      INSERT INTO memory_records SELECT 'r'||i,1,'scope','fact',hex(randomblob(150)),'owner-statement','active',0,i,NULL,NULL,i FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${memRows})
      INSERT INTO memory_evidence SELECT 'r'||i,1,'s'||i,1,0,10 FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${Math.ceil(memRows / 2)})
      INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
      SELECT 'b'||i,'thread-'||(i%2000),'drv',NULL,'["r1"]','["s1"]','["m'||i||'","m'||(i+1)||'"]',0,0,5,'delivered',i FROM n`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA synchronous=FULL");
    const size = statSync(file).size;
    const time = <T>(label: string, run: () => T): T => { const t = performance.now(); const out = run(); console.log(`TIMING ${label}: ${((performance.now() - t) / 1000).toFixed(2)} s`); return out; };
    console.log(`TIMING file size: ${(size / 1048576).toFixed(0)} MB, messages ${rows}, memory rows ${memRows}`);
    time("copy VACUUM INTO", () => db.prepare("VACUUM INTO ?").run(join(root, "probe.db")));
    rmSync(join(root, "probe.db"));
    const marks: Array<[string, number]> = []; const t0 = performance.now();
    migrateMemorySchema(db, "off", { snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT), onPhase: event => marks.push([event.phase, performance.now() - t0]) });
    const total = performance.now() - t0;
    console.log(`TIMING full upgrade: ${(total / 1000).toFixed(2)} s; ` + marks.map(([phase, at], i) => `${phase} ${(((marks[i + 1]?.[1] ?? total) - at) / 1000).toFixed(2)} s`).join(", "));
    console.log(`TIMING copy file: ${(statSync(join(root, MEMORY_PRE_V3_SNAPSHOT)).size / 1048576).toFixed(0)} MB`);
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(5);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 3_600_000);
