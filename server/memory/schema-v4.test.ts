// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it,vi } from "vitest";
import { MEMORY_SCHEMA_V1,MEMORY_SCHEMA_V2,MEMORY_SCHEMA_V3,MEMORY_PRE_V4_SNAPSHOT,migrateMemorySchema, downgradeMemorySchema, validateMemorySchema } from "./schema.ts";

it("installs v4, validates ledger references, and round trips every supported downgrade", () => {
 const db=new DatabaseSync(":memory:");
 try {
  migrateMemorySchema(db);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(7);
  const settings=JSON.parse(String(db.prepare("SELECT settings FROM memory_learning_config").get()?.settings));
  expect(settings).toMatchObject({version:2,dailyInputTokens:400000,dailyOutputTokens:60000});
  db.exec("INSERT INTO memory_scopes VALUES('s','conversation','t','[]',0)");
  db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,record_id,record_version,created_at) VALUES(?,'s','activated','missing',1,0)").run(randomUUID());
  expect(()=>validateMemorySchema(db)).toThrow("INVALID_MEMORY_LEARNING_EVENT");
  db.exec("DELETE FROM memory_learning_events");
  for(const to of [3,2,1] as const){downgradeMemorySchema(db,to);validateMemorySchema(db);migrateMemorySchema(db);validateMemorySchema(db);}
 } finally {db.close();}
});

// Frozen validator from 7301fe0d; only the function/schema import names are adapted.
type SchemaRow = {type: string; name: string; tbl_name: string; sql: string | null};
const expected = new Map<number, Map<string, SchemaRow>>();
function expectedSchema(version: number) {
  const cached = expected.get(version);
  if (cached) return cached;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(({1:MEMORY_SCHEMA_V1,2:MEMORY_SCHEMA_V2,3:MEMORY_SCHEMA_V3} as Record<number,string>)[version]!);
    const schema = new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[]).map(row => [row.name,row]));
    expected.set(version, schema);
    return schema;
  } finally { db.close(); }
}

function validateAs0161(db: DatabaseSync, options: { references?: boolean | (() => boolean) } = {}): Set<string> {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
  const memoryRows = rows.filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (!memoryRows.length) return new Set(); // private.7 legacy archive
  // Recognize only an exact known meta table before reading its version field.
  const metaSchema = memoryRows.find(row => row.name === "memory_meta");
  const version = [1, 2, 3].find(value => metaSchema?.sql === expectedSchema(value).get("memory_meta")?.sql);
  if (!version) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  const schema = expectedSchema(version);
  if (memoryRows.length !== schema.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of memoryRows) {
    const wanted = schema.get(row.name);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== version || !/^[a-f0-9-]{36}$/.test(String(meta[0].installation_id))) throw new Error("INVALID_MEMORY_META");
  const sweep = options.references ?? true;
  const full = typeof sweep === "function" ? sweep() : sweep;
  if (full && db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("INVALID_MEMORY_REFERENCE");
  // The output index is derived: a file from outside this installation (an
  // archive, a merge) whose index lost a row would hide a receipt from the
  // per-message replay check, so the full sweep proves it matches the JSON.
  if (full && version === 3 && (db.prepare(`SELECT 1 FROM memory_disclosures d, json_each(d.output_message_ids) j WHERE j.type='text'
    AND NOT EXISTS (SELECT 1 FROM memory_disclosure_outputs o WHERE o.bundle_id=d.bundle_id AND o.thread_id=d.thread_id AND o.message_id=j.value) LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM memory_disclosure_outputs o WHERE NOT EXISTS (SELECT 1 FROM memory_disclosures d, json_each(d.output_message_ids) j
    WHERE d.bundle_id=o.bundle_id AND d.thread_id=o.thread_id AND j.type='text' AND j.value=o.message_id) LIMIT 1`).get())) throw new Error("INVALID_MEMORY_OUTPUT_INDEX");
  for (const [table,column,kind] of [
    ["memory_scopes","audience","array"], ["memory_scope_bindings","intent","object"],
    ["memory_source_versions","payload","object"], ["memory_disclosures","record_versions","array"],
    ["memory_disclosures","source_versions","array"], ["memory_disclosures","output_message_ids","array"],
  ]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE json_type(${column})!=? LIMIT 1`).get(kind)) throw new Error("INVALID_MEMORY_JSON_SHAPE");
  }
  if (db.prepare("SELECT 1 FROM memory_records WHERE assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import') LIMIT 1").get()) throw new Error("INVALID_MEMORY_ASSERTION");
  if (version >= 2) {
    const settings = db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get();
    if (!settings || !memoryLearningV1Schema.safeParse(JSON.parse(String(settings.settings))).success) throw new Error("INVALID_MEMORY_LEARNING_CONFIG");
    if (db.prepare("SELECT 1 FROM memory_records r LEFT JOIN memory_record_details d ON r.id=d.record_id AND r.version=d.record_version WHERE d.record_id IS NULL LIMIT 1").get()) throw new Error("INVALID_MEMORY_RECORD_DETAILS");
  }
  return new Set(memoryRows.map(row => row.name));
}

import {DEFAULT_MEMORY_LEARNING_V1,memoryLearningV1Schema,readMemoryLearning} from "./learning-policy.ts";
import {mkdtempSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
function oldDatabase(db:DatabaseSync,version:1|2|3){
 db.exec([MEMORY_SCHEMA_V1,MEMORY_SCHEMA_V2,MEMORY_SCHEMA_V3][version-1]);
 db.prepare("INSERT INTO memory_meta VALUES(1,?,?,0,0,0,'active')").run(version,randomUUID());
 if(version>1)db.prepare("INSERT INTO memory_learning_config VALUES(1,2,?)").run(JSON.stringify({...DEFAULT_MEMORY_LEARNING_V1,dailyCostUsd:5}));
 db.exec(`INSERT INTO memory_scopes VALUES('scope','conversation','thread','[]',0);
 INSERT INTO memory_sources VALUES('source','scope','thread','message',NULL,1,'hash','text','owner','recorded',NULL,'active');
 INSERT INTO memory_source_versions VALUES('source',1,'hash','{"text":"tea"}',1);
 INSERT INTO memory_records VALUES('record',1,'scope','fact','tea','owner-statement','active',0,1,NULL,NULL,1);
 INSERT INTO memory_evidence VALUES('record',1,'source',1,0,3);
 INSERT INTO memory_disclosures VALUES('bundle','thread','driver',NULL,'[]','[]','["reply"]',0,0,1,'delivered',1);`);
}
it.each([1,2,3] as const)("upgrades v%s, refuses the previous validator, and preserves evidence through inverse migrations",version=>{
 const db=new DatabaseSync(":memory:");try{
 oldDatabase(db,version);validateAs0161(db);migrateMemorySchema(db);
 expect(()=>validateAs0161(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
 expect(readMemoryLearning(db)).toMatchObject({version:2,automaticFacts:true});
 expect(db.prepare("SELECT count(*) n FROM memory_learning_events WHERE kind='settings-migrated'").get()?.n).toBe(version===1?0:1);
 for(const to of [3,2,1] as const){downgradeMemorySchema(db,to);validateAs0161(db);validateMemorySchema(db);migrateMemorySchema(db);for(const table of ["memory_records","memory_sources","memory_disclosures"])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(1);}
 }finally{db.close();}
});
it("preserves a v3 snapshot and does not snapshot or rewrite a reopened v4 file",()=>{
 const root=mkdtempSync(join(tmpdir(),"memory-v4-")),file=join(root,"messages.db"),snapshot=join(root,MEMORY_PRE_V4_SNAPSHOT);
 let db=new DatabaseSync(file);try{oldDatabase(db,3);migrateMemorySchema(db,"off",{snapshotV3Path:snapshot});expect(existsSync(snapshot)).toBe(true);
 const copy=new DatabaseSync(snapshot);try{validateAs0161(copy);expect(copy.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(3);}finally{copy.close();}
 db.close();db=new DatabaseSync(file);migrateMemorySchema(db,"off",{snapshotV3Path:join(root,"second.db")});expect(existsSync(join(root,"second.db"))).toBe(false);expect(db.prepare("SELECT count(*) n FROM memory_learning_events").get()?.n).toBe(1);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
it("rolls an interrupted rewrite back to valid v3 and retries once",()=>{
 const root=mkdtempSync(join(tmpdir(),"memory-v4-interrupt-")),db=new DatabaseSync(join(root,"messages.db"));try{oldDatabase(db,3);const original=db.exec.bind(db);const spy=vi.spyOn(db,"exec").mockImplementation(sql=>{if(sql.includes("DROP TABLE memory_meta_previous"))throw Error("fixture interruption");original(sql);});
 expect(()=>migrateMemorySchema(db)).toThrow("fixture interruption");spy.mockRestore();validateMemorySchema(db);validateAs0161(db);migrateMemorySchema(db);validateMemorySchema(db);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

it("preserves pauses and source switches through a previous-release-valid v3 binding",()=>{
 const db=new DatabaseSync(":memory:");try{
 migrateMemorySchema(db);
 db.exec(`UPDATE memory_learning_config SET revision=2,settings=json_set(settings,'$.botsPaused',json('["paused-bot"]'),'$.learnFrom',json('{"chats":false,"channels":true}'))`);
 downgradeMemorySchema(db,3);validateAs0161(db);validateMemorySchema(db);
 // An old release may edit its own settings while retaining the opaque binding.
 db.exec("UPDATE memory_learning_config SET revision=3,settings=json_set(settings,'$.callsPerMinute',2)");
 migrateMemorySchema(db);expect(readMemoryLearning(db)).toMatchObject({botsPaused:["paused-bot"],learnFrom:{chats:false,channels:true},callsPerMinute:2});
 expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-learning-v4-preserved'").get()).toBeUndefined();
 }finally{db.close();}
});
