// The identity check of a procedure source cost 2 s per uncached check on a
// 735 MB store (one scan of memory_records), and the memo that should have
// absorbed it was emptied by every database write. Sized like the real store:
// tens of thousands of records, a few hundred sources.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { identityScanCount } from "./provenance-stamp.ts";
import { assertSkillProcedureEvidence, type SkillProcedureContext } from "../skills.ts";

const SOURCES = 300, RECORDS = 30000;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
});
function seed() {
  const items = [];
  for (let i = 0; i < SOURCES; i++) {
    const id = `source:t${i}`;
    transaction(db => captureSource(db, { id, threadId: `t${i}`, kind: "tool-outcome", speaker: "tool", outcome: "completed", text: `outcome ${i}`, action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
    items.push({ kind: "source" as const, id, revision: 1, scopeId: String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id)!.scope_id) });
  }
  const db = database(), scope = items[0]!.scopeId;
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${RECORDS})
    INSERT INTO memory_records SELECT 'bulk'||i,1,'${scope}','fact','fact '||i,'model-inference','active',0,1,NULL,NULL,1 FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${RECORDS})
    INSERT INTO memory_evidence SELECT 'bulk'||i,1,'source:t'||(i%${SOURCES}),1,0,1 FROM n;`);
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [...new Set(items.map(item => item.scopeId))] };
  return { items, context };
}
function statementsDuring(run: () => void): string[] {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return seen;
}
function messageWrite(n: number) {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,'user','text','hi','{}')").run(`m${n}`, n);
}

it("100 procedure scans with unrelated writes between them run the identity scan at most once", () => {
  const { items, context } = seed();
  const before = identityScanCount();
  for (let i = 0; i < 100; i++) {
    messageWrite(i);
    // a different evidence item each time, so the verdict memo cannot answer
    assertSkillProcedureEvidence(context, [items[i % SOURCES]!]);
  }
  // runs of the scan, not compiles of its statement
  expect(identityScanCount() - before).toBeLessThanOrEqual(1);
});

it("a check of 50 sources inside a transaction runs the identity scan once, not once per source", () => {
  const { items, context } = seed();
  const before = identityScanCount();
  transaction(() => assertSkillProcedureEvidence(context, items.slice(0, 50)));
  expect(identityScanCount() - before).toBe(1);
});

it("a new source capture and a message write move nothing the identity set rests on", () => {
  const { items, context } = seed();
  assertSkillProcedureEvidence(context, [items[0]!]);
  messageWrite(1);
  transaction(db => captureSource(db, { id: "source:late", threadId: "late", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: "late", action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
  const sql = statementsDuring(() => assertSkillProcedureEvidence(context, [items[0]!]));
  expect(sql.filter(text => text.includes("memory_tombstones") || text.includes("memory_sources") || text.includes("memory_evidence"))).toEqual([]);
});

it("the per-call statements of a check use indexes on the realistic store", () => {
  const { items, context } = seed();
  const sql = statementsDuring(() => assertSkillProcedureEvidence(context, [items[0]!]));
  const db = database(), plans: string[] = [];
  for (const text of new Set(sql.filter(s => !s.startsWith("EXPLAIN") && !s.includes("CROSS JOIN memory_evidence e")))) {
    if (!/^\s*SELECT/i.test(text) || /pragma|total_changes|temp\./.test(text)) continue;
    const params = Array.from({ length: (text.match(/\?/g) ?? []).length }, (_, i) => (i % 2 ? 1 : "x"));
    for (const row of db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params)) plans.push(String(row.detail));
  }
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.filter(detail => /SCAN (r|memory_records|e|memory_evidence|s|memory_sources)\b/.test(detail))).toEqual([]);
});

// The remembered verdict must follow withholding immediately.
it("a tombstone revokes a remembered verdict at once", () => {
  const { items, context } = seed();
  assertSkillProcedureEvidence(context, [items[1]!]); assertSkillProcedureEvidence(context, [items[1]!]);
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t9','source',?,NULL,NULL,1,'test',1)").run(items[1]!.id);
  expect(() => assertSkillProcedureEvidence(context, [items[1]!])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});
it("a deleted source revokes a remembered verdict at once", () => {
  const { items, context } = seed();
  assertSkillProcedureEvidence(context, [items[2]!]); assertSkillProcedureEvidence(context, [items[2]!]);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(items[2]!.id);
  expect(() => assertSkillProcedureEvidence(context, [items[2]!])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});
it("an identity record written over a remembered source refuses it at once", () => {
  const { items, context } = seed();
  assertSkillProcedureEvidence(context, [items[3]!]); assertSkillProcedureEvidence(context, [items[3]!]);
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES('canon',1,?,'character-canon','Canon','owner-statement','active',0,1,NULL,NULL,1)").run(items[3]!.scopeId);
  db.prepare("INSERT INTO memory_evidence VALUES('canon',1,?,1,0,1)").run(items[3]!.id);
  expect(() => assertSkillProcedureEvidence(context, [items[3]!])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});
it("a deletion epoch or policy revision change moves the stamp, a message write does not", async () => {
  const { provenanceStamp } = await import("./provenance-stamp.ts");
  seed();
  const db = database();
  const base = provenanceStamp(db);
  messageWrite(77);
  expect(provenanceStamp(db)).toBe(base);
  db.prepare("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1").run();
  const afterPolicy = provenanceStamp(db);
  expect(afterPolicy).not.toBe(base);
  db.prepare("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1").run();
  expect(provenanceStamp(db)).not.toBe(afterPolicy);
});

it("a tombstone written on a second connection to the same file revokes a remembered verdict", () => {
  const { items, context } = seed();
  assertSkillProcedureEvidence(context, [items[4]!]); assertSkillProcedureEvidence(context, [items[4]!]);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    other.exec("PRAGMA busy_timeout=5000");
    other.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t-other','source',?,NULL,NULL,1,'test',1)").run(items[4]!.id);
  } finally { other.close(); }
  // only data_version moved on this connection: the temp trigger never fired here
  expect(() => assertSkillProcedureEvidence(context, [items[4]!])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});
