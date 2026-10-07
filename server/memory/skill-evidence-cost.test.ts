// The procedure-evidence check walks provenance (up to 256 nodes) and was the
// hot statement of an idle server: the review host re-asks it for every
// deferred review on every idle visit. Work is counted by the statements run,
// which do not depend on the machine.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { assertSkillProcedureEvidence, type SkillProcedureContext } from "../skills.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

function source(threadId: string, text: string) {
  const id = `source:${threadId}`;
  transaction(db => captureSource(db, { id, threadId, kind: "tool-outcome", speaker: "tool", outcome: "completed", text, action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
  const scopeId = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id)!.scope_id);
  return { kind: "source" as const, id, revision: 1, scopeId };
}
function statementsDuring(run: () => void): string[] {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return seen;
}
const identityChecks = (sql: string[]) => sql.filter(text => text.includes("memory_evidence")).length;

it("an unchanged database answers a repeated evidence check without a single evidence query", () => {
  const items = [source("a", "first"), source("b", "second")];
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [...new Set(items.map(item => item.scopeId))] };
  assertSkillProcedureEvidence(context, items);
  const idle = statementsDuring(() => { for (let i = 0; i < 300; i++) assertSkillProcedureEvidence(context, items); });
  expect(identityChecks(idle)).toBe(0);
  expect(idle.filter(text => text.includes("memory_tombstones") || text.includes("memory_sources"))).toEqual([]);
});

it("a refusal is remembered too, and still refuses", () => {
  const item = source("c", "third");
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [item.scopeId] };
  const wrong = { ...item, scopeId: "other-scope" };
  expect(() => assertSkillProcedureEvidence(context, [wrong])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  const idle = statementsDuring(() => { for (let i = 0; i < 50; i++) expect(() => assertSkillProcedureEvidence(context, [wrong])).toThrow("PROCEDURE_EVIDENCE_REVOKED"); });
  expect(idle.filter(text => text.includes("memory_tombstones"))).toEqual([]);
});

it("any write to the database invalidates the memo: a tombstone revokes remembered evidence", () => {
  const item = source("d", "fourth");
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [item.scopeId] };
  assertSkillProcedureEvidence(context, [item]);
  assertSkillProcedureEvidence(context, [item]);
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t1','source',?,NULL,NULL,1,'test',1)").run(item.id);
  expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});

it("a source cited by an identity record is refused, and its check uses no scan of memory_evidence", () => {
  const item = source("e", "fifth");
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES('canon',1,?,'character-canon','Canon','owner-statement','active',0,1,NULL,NULL,1)").run(item.scopeId);
  db.prepare("INSERT INTO memory_evidence VALUES('canon',1,?,1,0,1)").run(item.id);
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [item.scopeId] };
  const seen = statementsDuring(() => expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED"));
  const plans: string[] = [];
  for (const sql of new Set(seen.filter(text => text.includes("memory_evidence")))) {
    const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, (_, i) => (i % 2 ? 1 : "x"));
    for (const row of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)) plans.push(String(row.detail));
  }
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.filter(detail => /SCAN (e|memory_evidence)\b/.test(detail))).toEqual([]);
});
