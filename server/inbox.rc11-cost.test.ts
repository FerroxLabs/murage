// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { inboxRequest } from "./inbox.ts";
import { inboxSuggestionRows, withLearningSuggestions } from "./inbox-learning-suggestions.ts";
import { memoryWaitingRows, withMemoryWaiting } from "./inbox-memory-waiting.ts";
import { withBackupNotices } from "./inbox-backup-notices.ts";
import { deriveGroupedDecisions } from "./project-goals.ts";
import { waitingSummary } from "./memory/review.ts";
import { WAITING_REVIEW, WAITING_REVIEW_INDEX, validateMemorySchema } from "./memory/schema.ts";
import { buildOptionalIndexOffThread, dropOptionalIndexes } from "./memory/optional-index.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roster = { bots: [{ id: "bot", name: "Ember", threadId: "chat", tasks: [] }], groups: [] } as unknown as MemoryRoster;
beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});

function seed(history: number) {
  const db = database();
  db.exec(`INSERT INTO memory_scopes VALUES('s','bot','bot','[]',0);
    INSERT INTO memory_sources VALUES('source','s','chat','message',NULL,1,'hash','text','owner','settled',NULL,'active');
    INSERT INTO memory_source_versions VALUES('source',1,'hash','{"text":"Reports go out Monday"}',1);`);
  db.exec("BEGIN");
  try {
    for (let i = 0; i < 9; i++) {
      db.prepare("INSERT INTO memory_records VALUES(?,1,'s','fact','Reports go out Monday','assistant-inference','candidate',0,1,NULL,NULL,1)").run(`candidate-${i}`);
      db.prepare("INSERT INTO memory_evidence VALUES(?,1,'source',1,0,5)").run(`candidate-${i}`);
    }
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO memory_scopes SELECT 'old-s-'||i,'conversation','old-chat-'||i,'[]',0 FROM n`).run(history);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO memory_records SELECT 'old-r-'||i,1,'old-s-'||i,'fact','Old note','assistant-inference','archived',0,1,NULL,NULL,1 FROM n`).run(history);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO memory_scope_bindings SELECT 'procedure-review:old:'||i,'s','system','procedure-review',1,'granted','{}' FROM n`).run(history);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at)
      SELECT 'old-l-'||i,1,'bot','bot','note','Old lesson','typed','retired',1 FROM n`).run(history);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return db;
}

function countReads(db: DatabaseSync) {
  const counts = { statements: 0, rows: 0, candidateVisits: 0 };
  db.function("rc11_visit", (_id: unknown) => { counts.candidateVisits++; return 1; });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (sql.includes(`SELECT scope_id FROM memory_records INDEXED BY ${WAITING_REVIEW_INDEX}`))
      sql = sql.replace("WHERE state='candidate'", "WHERE rc11_visit(id) AND state='candidate'");
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, method) {
      const value = Reflect.get(target, method) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = value.apply(target, args);
        if (method === "all" || method === "get") {
          counts.statements++;
          counts.rows += method === "all" ? (out as unknown[]).length : out ? 1 : 0;
        }
        return out;
      };
    } });
  }) as typeof db.prepare);
  return { counts, stop: () => spy.mockRestore() };
}

// The database-bearing card sources gathered by GET /api/inbox, including a forced waiting-summary refill.
function cards(db: DatabaseSync, now: number) {
  const base = inboxRequest(db, { method: "GET", path: "/api/inbox", query: { view: "decisions" } },
    { owner: true, threads: [{ threadId: "chat", botId: "bot", label: "Ember" }], routineRuns: [] }, { cache: true });
  expect(base.status).toBe(200);
  const learning = inboxSuggestionRows(db, id => id === "bot" ? "Ember" : undefined, ["bot"]);
  const waiting = memoryWaitingRows(waitingSummary(roster, now));
  const projects = deriveGroupedDecisions(db, { groupId: "room", openApprovals: [], now });
  return { body: withMemoryWaiting(withLearningSuggestions(withBackupNotices(base.body as { decisions: number },
    { backupWaiting: null, backupFailed: { sentence: "Backup stopped", at: 1 } }), learning), waiting), projects };
}

it("all database card sources keep the same statement and row cost with 10x history and scopes, including expiry and other-connection commits", async () => {
  const samples: Array<{ statements: number; rows: number; candidateVisits: number }> = [];
  for (const history of [1_000, 10_000]) {
    closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const db = seed(history);
    await buildOptionalIndexOffThread(db, WAITING_REVIEW, { inline: true });
    cards(db, 0);
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    const reads = countReads(db);
    try {
      for (let i = 1; i <= 10; i++) {
        other.prepare("UPDATE memory_records SET valid_from=? WHERE id='old-r-1'").run(i);
        const answer = cards(db, i * 31_000);
        expect(answer.body).toMatchObject({ decisions: 10, memoryWaiting: [{ id: "bot", waiting: 9, everyday: 9 }] });
        expect(answer.projects.count).toBe(0);
      }
      samples.push({ ...reads.counts });
    } finally { reads.stop(); other.close(); }
  }
  expect(samples[1]).toEqual(samples[0]);
  expect(samples[0]!.candidateVisits).toBe(90);
  expect(samples[0]!.statements).toBeLessThan(850);
  expect(samples[0]!.rows).toBeLessThan(850);
  console.info("RC11 inbox source costs", samples);
});

it("uses the partial candidate index, retains the fallback answer, and registers the exact schema and downgrade behavior", async () => {
  const db = seed(1_000), before = waitingSummary(roster, 0);
  await buildOptionalIndexOffThread(db, WAITING_REVIEW, { inline: true });
  const after = waitingSummary(roster, 31_000);
  expect(after).toEqual(before);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM memory_records INDEXED BY ${WAITING_REVIEW_INDEX}
    WHERE scope_id=? AND state='candidate' AND kind NOT IN ('continuity-brief','commitment','self-trait','relation','pip-proposal','pip-counter','concern','episode') ORDER BY created_at,id LIMIT 500`).all("s");
  expect(plan.map(row => row.detail).join(" ")).toContain(`USING INDEX ${WAITING_REVIEW_INDEX}`);
  expect(plan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
  dropOptionalIndexes(db);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(WAITING_REVIEW_INDEX)).toBeUndefined();
  expect(waitingSummary(roster, 62_000)).toEqual(before);
});

it("refreshes counts and eligibility immediately after same-connection and external writes, Later deletion, rollback and roster reassignment", async () => {
  const db = seed(10);
  await buildOptionalIndexOffThread(db, WAITING_REVIEW, { inline: true });
  expect(waitingSummary(roster, 0).subjects[0]).toMatchObject({ waiting: 9, everyday: 9 });
  db.exec("UPDATE memory_records SET text='My password' WHERE id='candidate-0'");
  expect(waitingSummary(roster, 1).subjects[0]!.everyday).toBe(8);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    other.exec("UPDATE memory_records SET state='active' WHERE id='candidate-1'");
    expect(waitingSummary(roster, 2).total).toBe(8);
    other.exec("UPDATE memory_sources SET state='retired' WHERE id='source'");
    expect(waitingSummary(roster, 3).subjects[0]!.everyday).toBe(0);
  } finally { other.close(); }
  db.exec(`INSERT INTO memory_scope_bindings VALUES('memory-review-later','s','system','memory-review-later',0,'granted','{"items":{"candidate-2":{"version":1}}}')`);
  expect(waitingSummary(roster, 4).total).toBe(7);
  db.exec("DELETE FROM memory_scope_bindings WHERE id='memory-review-later'");
  expect(waitingSummary(roster, 5).total).toBe(8);
  db.exec("BEGIN; UPDATE memory_records SET state='active' WHERE id='candidate-2';");
  expect(waitingSummary(roster, 6).total).toBe(7);
  db.exec("ROLLBACK;");
  expect(waitingSummary(roster, 6).total).toBe(8);
  db.exec("UPDATE memory_scopes SET kind='conversation',owner_key='task' WHERE id='s'");
  expect(waitingSummary(roster, 7).total).toBe(0);
  const assigned = { ...roster, bots: [{ ...roster.bots[0]!, tasks: [{ threadId: "task" }] }] } as MemoryRoster;
  expect(waitingSummary(assigned, 8).total).toBe(8);
});
