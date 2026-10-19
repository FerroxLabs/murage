// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 rc3f P3 notes on the turn path, each read flat: the same statements and rows at 10 and at 100,000 unrelated rows.
//  - the card sweep reads one newest slice before the open-card index exists (not the whole history);
//  - the starting turn's capture is claimed by its job id (no scope search, no claim index);
//  - the owner's pins are read through the partial index once it exists;
//  - the Inbox's waiting lessons are read by bot, through memory_lessons_bot_state;
//  - a notebook's legacy source id scans the scope's legacy sources once per (scope, path) until the memory data changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { walkStaleToolCards } from "../card-sweep-walk.ts";
import { inboxSuggestionRows } from "../inbox-learning-suggestions.ts";
import { claimMemoryJob, resetMemoryClaimCursor } from "./jobs.ts";
import { setMemoryMode } from "./repository.ts";
import { ensureWorkspace } from "../workspace.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { migrateDetectedMemoryNotebooks } from "./import.ts";
import { ensureOwnerPinIndex, ownerPinIndexPresent, validateMemorySchema } from "./schema.ts";
import { forgetTurnCaptureJob, turnCaptureJobId } from "./turn-capture-jobs.ts";
import { resetParkSweep } from "./park.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

type Seen = { sql: string; rows: number };
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
const shape = (seen: Seen[], only: RegExp) => seen.filter(item => only.test(item.sql)).map(item => `${item.sql.replace(/\s+/g, " ")} => ${item.rows}`).sort();
const plans = (sql: string) => (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail);

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); resetParkSweep(); resetMemoryClaimCursor(); resetWorkerLog();
});
afterEach(() => { vi.restoreAllMocks(); });

it("the card sweep reads one newest slice of an unwalked file, the same at 1,000 and at 100,000 rows, and keeps its mark", async () => {
  const reads: number[] = [];
  for (const high of [1_000, 100_000]) {
    const read: Array<[number, number]> = [], kept: Array<[number, number]> = [];
    await walkStaleToolCards({ high, range: { floor: high, top: high }, indexDone: () => false, sliceRows: () => 400,
      walk: async (after, upTo) => { read.push([after, upTo]); }, keep: (floor, top) => { kept.push([floor, top]); } });
    expect(read).toEqual([[high - 400, high]]);
    expect(kept).toEqual([[high - 400, high]]);
    reads.push(read.reduce((n, [a, b]) => n + b - a, 0));
  }
  expect(reads[0]).toBe(reads[1]);
});

it("the card sweep reads the rows since the last walk, then stops; and nothing at all once the index is complete", async () => {
  const read: Array<[number, number]> = [];
  await walkStaleToolCards({ high: 100_000, range: { floor: 99_000, top: 99_500 }, indexDone: () => false, sliceRows: () => 200,
    walk: async (after, upTo) => { read.push([after, upTo]); }, keep: () => {} });
  expect(read).toEqual([[99_800, 100_000], [99_600, 99_800], [99_500, 99_600]]);
  const none: Array<[number, number]> = [];
  await walkStaleToolCards({ high: 100_000, range: { floor: 100_000, top: 100_000 }, indexDone: () => true, sliceRows: () => 200, walk: async (a, b) => { none.push([a, b]); }, keep: () => {} });
  expect(none).toEqual([]);
});

function seedOtherJobs(others: number): void {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?)
    INSERT INTO memory_sources SELECT 'other-s'||n,'other-scope-'||(n%50),'other-t'||n,'m'||n,NULL,1,'h'||n,'message','user','ok',NULL,'active' FROM c`).run(others);
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?)
    INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) SELECT 'other-j'||n,'other-s'||n,1,'capture','1','pending',1,0 FROM c`).run(others);
  db.exec("COMMIT");
}

it("the starting turn's capture is claimed by its job id: the same statements and rows with 10 and with 100,000 other pending jobs", () => {
  const shapes: string[][] = [];
  for (const others of [10, 100_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); resetMemoryClaimCursor();
    appendMessage("turn-thread", { id: "p1", at: Date.now(), role: "user", kind: "text", text: "The owner's prompt that this turn sends" });
    const jobId = turnCaptureJobId("turn-thread");
    expect(jobId).toBeTruthy();
    seedOtherJobs(others);
    const out: { work: ReturnType<typeof claimMemoryJob> } = { work: null };
    const seen = record(() => { out.work = claimMemoryJob("w", Date.now(), undefined, { busyMs: 0, jobId: jobId! }); });
    expect(out.work?.id).toBe(jobId);
    // a primary-key lease, and every statement of the claim plans without scanning the job table or the sources
    for (const item of seen.filter(entry => /memory_jobs|memory_sources/.test(entry.sql) && /^\s*(SELECT|UPDATE)/i.test(entry.sql))) {
      const plan = plans(item.sql.replace(/\?\d*/g, "'x'"));
      expect(plan.some(line => /^SCAN (j|memory_jobs|s|memory_sources)\b/.test(line)), `${item.sql} :: ${plan.join(" | ")}`).toBe(false);
    }
    expect(seen.some(item => /UPDATE memory_jobs SET status='leased'[^]*WHERE id=\?/.test(item.sql))).toBe(true);
    shapes.push(shape(seen, /memory_jobs|memory_sources|memory_claim/));
    forgetTurnCaptureJob("turn-thread", jobId!);
    expect(turnCaptureJobId("turn-thread")).toBeUndefined();
  }
  expect(shapes[1]).toEqual(shapes[0]);
});

it("a job that is not claimable (already leased) is not claimed by id", () => {
  appendMessage("turn-thread", { id: "p1", at: Date.now(), role: "user", kind: "text", text: "The owner's prompt" });
  const jobId = turnCaptureJobId("turn-thread")!;
  expect(claimMemoryJob("w1", Date.now(), undefined, { busyMs: 0, jobId })?.id).toBe(jobId);
  expect(claimMemoryJob("w2", Date.now(), undefined, { busyMs: 0, jobId })).toBeNull();
});

it("the owner's pins are read through the partial index once it exists, keyed by scope, flat at 10 and 100,000 other records", async () => {
  const sql = `SELECT id,version FROM memory_records r INDEXED BY memory_records_pinned WHERE state='active' AND owner_pinned=1 AND scope_id IN (SELECT value FROM json_each('["s-0"]'))`;
  const rowsRead: number[] = [];
  for (const others of [10, 100_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active");
    const db = database();
    expect(ownerPinIndexPresent(db)).toBe(false);
    db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
    db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?)
      INSERT INTO memory_records SELECT 'r'||n,1,'s-0','note','t','a','active',CASE WHEN n%50000=0 THEN 1 ELSE 0 END,0,NULL,NULL,0 FROM c`).run(others);
    db.exec("COMMIT");
    await ensureOwnerPinIndex(db, { inline: true });
    expect(ownerPinIndexPresent(db)).toBe(true);
    expect(plans(sql).join(" | ")).toMatch(/USING (COVERING )?INDEX memory_records_pinned/);
    expect(() => validateMemorySchema(db, { references: false, structuralOnly: true })).not.toThrow();
    rowsRead.push(db.prepare(sql).all().length);
  }
  expect(rowsRead).toEqual([0, 2]);
});

it("the Inbox's waiting lessons are read by bot through memory_lessons_bot_state, not by a scan of the table", () => {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?)
    INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,spec,created_at) SELECT 'l'||n,1,'other-bot-'||(n%40),'bot','note','x','typed','active',NULL,n FROM c`).run(100_000);
  db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('mine',1,'bot-a','bot','note','A waiting lesson','suggested','suggested',5)").run();
  db.exec("COMMIT");
  let rows: ReturnType<typeof inboxSuggestionRows> = [];
  const seen = record(() => { rows = inboxSuggestionRows(db, id => (id === "bot-a" ? "Ava" : undefined), ["bot-a"]); });
  expect(rows.map(row => row.lessonId)).toEqual(["mine"]);
  for (const item of seen.filter(entry => /FROM memory_lessons/.test(entry.sql))) {
    const plan = plans(item.sql.replace(/\?\d*/g, "'x'"));
    expect(plan.some(line => /^SCAN memory_lessons\b/.test(line)), `${item.sql} :: ${plan.join(" | ")}`).toBe(false);
    expect(item.rows).toBeLessThanOrEqual(1);
  }
});

it("a notebook moved from another data dir is found by its stored path once per (scope, path) until the memory data changes, flat in the other scopes' sources", () => {
  const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
  const walk = () => { let cursor: string | undefined; do { cursor = migrateDetectedMemoryNotebooks(roster, cursor).nextCursor; } while (cursor); };
  const scans: number[] = [];
  for (const others of [10, 20_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
    writeFileSync(join(ensureWorkspace("a"), "MEMORY.md"), "Durable notebook text, longer than the seed.");
    walk();
    const db = database();
    // the data dir "moved": the imported source carries the id and path of the old location
    const row = db.prepare("SELECT id FROM memory_sources WHERE id>='legacy:' AND id<'legacy;'").get()!;
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("UPDATE memory_source_versions SET source_id='legacy:moved',payload=json_set(payload,'$.path','/old/data/workspaces/a/MEMORY.md') WHERE source_id=?").run(row.id);
    db.prepare("UPDATE memory_sources SET id='legacy:moved' WHERE id=?").run(row.id);
    db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?)
      INSERT INTO memory_sources SELECT 'legacy:other'||n,'other-scope-'||(n%50),'t','m'||n,NULL,1,'h'||n,'notebook','user','ok',NULL,'active' FROM c`).run(others);
    walk(); walk(); // the first may move the data revision; the next ones must not scan again
    const third = record(() => walk());
    scans.push(third.filter(item => /json_extract\(v\.payload,'\$\.path'\)/.test(item.sql)).length);
    expect(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE id='legacy:moved'").get()!.n).toBe(1);
  }
  expect(scans).toEqual([0, 0]);
});
