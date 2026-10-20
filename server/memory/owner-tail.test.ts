// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane msearch2 (1.0.2): owner search says "Showing the newest matches" only when a limit was really reached. On 77cb5d307 every search
// of a memory over 20,000 records carried the notice, because the never-indexed kinds were read among the newest 20,000 records only and
// any older record at all counted as "might have missed one".
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader, memoryIndexReaderOpens } from "./index-reader.ts";
import { OWNER_INDEX_MATCHES, OWNER_MANY_NOTICE, OWNER_NEWEST_NOTICE, OWNER_TAIL_WINDOW, ownerMemoryList, ownerSearchTrace, ownerSearchWork } from "./owner-list.ts";
import { dropLegacyOwnerTailIndex, fillOwnerTailNow, fillOwnerTailSlice, startOwnerTailIndexBuild } from "./owner-tail-index.ts";
import { PIP_ALL_KINDS } from "./pip-kinds.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { downgradeMemorySchema, dropOwnerTail, LEGACY_OWNER_TAIL_INDEX, LEGACY_OWNER_TAIL_INDEX_SQL, OWNER_TAIL_KINDS_SQL, OWNER_TAIL_TABLE, ownerTailPresent, ownerTailReady, validateMemorySchema } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { windowsPerfBudget } from "../testing/windows-hosted.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const roster = { bots: [{ id: "a", threadId: "ta" }], groups: [] };

beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

/** `count` indexed records that all say "weekly" (three of them, the oldest among them, also "zephyrine"), plus, older than all of them,
 * a continuity brief and a rolled checkpoint version that say "zephyrine" and are never in the search index. */
function seed(count: number, extra: (db: DatabaseSync, scope: string) => void = () => {}) {
  reconcileMemoryRoster(roster);
  const scope = ensureScope("bot", "a");
  const rare = new Set([0, Math.floor(count / 2), count - 1]);
  const text = (n: number) => `weekly note ${n}${rare.has(n) ? " zephyrine" : ""}`;
  transaction(db => {
    const record = db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement',?,0,?,NULL,NULL,?)");
    record.run("brief-old", 1, scope, "continuity-brief", "the zephyrine thread so far", "active", 1, 1);
    record.run("cp-old", 1, scope, "checkpoint", "zephyrine checkpoint, first draft", "superseded", 2, 2);
    record.run("cp-old", 2, scope, "checkpoint", "the current checkpoint", "active", 3, 3);
    extra(db, scope);
    const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'indexed','unavailable',NULL)");
    for (let n = 0; n < count; n++) {
      const id = `rec-${String(n).padStart(7, "0")}`;
      record.run(id, 1, scope, "fact", text(n), "active", 1000 + n, 1000 + n);
      receipt.run(id);
    }
  });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const made = new MemoryIndex(INDEX_PATH()); made.prepareModel("model"); made.close();
  const index = new DatabaseSync(INDEX_PATH());
  index.exec("BEGIN");
  const entry = index.prepare("INSERT INTO entries VALUES(?,1,?,?)"), word = index.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (let n = 0; n < count; n++) { const id = `rec-${String(n).padStart(7, "0")}`; entry.run(id, scope, text(n)); word.run(id, text(n)); }
  index.exec("COMMIT");
  index.close();
}
const ids = (rows: Array<Record<string, unknown>>) => rows.map(row => `${row.id}:${row.version}`).sort();

describe("owner search: the notice only when a limit was reached", () => {
  it("100k records, a rare word: every match, the old continuity brief and checkpoint version included, and no notice", { timeout: 300_000 }, async () => {
    seed(100_000);
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(ids(found.rows)).toEqual(["brief-old:1", "cp-old:1", "rec-0000000:1", "rec-0050000:1", "rec-0099999:1"]);
    expect(found.coverageComplete).toBe(true);
    expect(found.searchNotice).toBeUndefined();
  });

  it("100k records, a common word: one bounded page, the count stops at 1,000+, the owner is told, and the next page carries on", { timeout: 300_000 }, async () => {
    seed(100_000);
    const before = { ...ownerSearchWork };
    const found = await ownerMemoryList({ botId: "a", query: "weekly" }, roster);
    const visited = ownerSearchWork.visited - before.visited;
    expect(found.rows).toHaveLength(50);
    expect(found.rows[0]!.id).toBe("rec-0099999");
    expect(found.nextCursor).toBeDefined();
    // every match is still reachable page by page: nothing was cut short, the count is capped and said
    expect(found).toMatchObject({ coverageComplete: true, matchCountLabel: "1,000+", searchNotice: OWNER_MANY_NOTICE });
    // the count steps 1,000 matches and stops (one slice past it at most), never the 100k
    expect(visited).toBeLessThan(1000 + 2 * 256 + 10);
    const next = await ownerMemoryList({ botId: "a", query: "weekly", cursor: found.nextCursor }, roster);
    expect(next.rows).toHaveLength(50);
    expect(next.rows[0]!.id).toBe("rec-0099949");
    expect(next.matchCountLabel).toBeUndefined();
    expect(new Set([...found.rows, ...next.rows].map(row => row.id)).size).toBe(100);
  });

  it("a match behind more ineligible matches than one page steps: the page says so, and the next page reaches it", { timeout: 300_000 }, async () => {
    seed(10, (db) => {
      // OWNER_INDEX_MATCHES + 1000 newer records in a scope this bot cannot see, all saying the word
      const other = ensureScope("bot", "b");
      const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)");
      for (let n = 0; n < OWNER_INDEX_MATCHES + 1000; n++) record.run(`other-${String(n).padStart(6, "0")}`, other, "zephyrine elsewhere", 500_000 + n, 500_000 + n);
    });
    const index = new DatabaseSync(INDEX_PATH());
    index.exec("BEGIN");
    const entry = index.prepare("INSERT INTO entries VALUES(?,1,'s',?)"), word = index.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
    for (let n = 0; n < OWNER_INDEX_MATCHES + 1000; n++) { const id = `other-${String(n).padStart(6, "0")}`; entry.run(id, "zephyrine elsewhere"); word.run(id, "zephyrine elsewhere"); }
    index.exec("COMMIT"); index.close();
    const first = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(first).toMatchObject({ coverageComplete: false, searchNotice: expect.stringContaining(OWNER_NEWEST_NOTICE) });
    expect(first.nextCursor).toBeDefined();
    const second = await ownerMemoryList({ botId: "a", query: "zephyrine", cursor: first.nextCursor }, roster);
    expect(ids([...first.rows, ...second.rows])).toEqual(expect.arrayContaining(["rec-0000000:1", "rec-0000005:1", "rec-0000009:1"]));
  });

  it("a common word over 300k records never holds the loop past 50 ms, and reuses the one reader handle", { timeout: 600_000 }, async () => {
    seed(300_000);
    await ownerMemoryList({ botId: "a", query: "weekly" }, roster);
    const opens = memoryIndexReaderOpens();
    let last = performance.now(), longest = 0;
    const probe = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 1);
    try {
      for (let n = 0; n < 3; n++) { last = performance.now(); await ownerMemoryList({ botId: "a", query: n === 1 ? "zephyrine" : "weekly" }, roster); }
    } finally { clearInterval(probe); }
    console.log(`[owner-search 300k] longest loop hold ${longest.toFixed(1)} ms`);
    expect(longest).toBeLessThan(50);
    expect(memoryIndexReaderOpens()).toBe(opens);
  });

  it("continuity and checkpoint rows are never hidden: found past any window, with or without the owner-tail table (1.0.3: the key table's kind index answers)", { timeout: 300_000 }, async () => {
    seed(30_000);
    const db = database();
    dropOwnerTail(db);
    const before = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    // the old brief and checkpoint lie past the newest 20,000 records: the kind scans of the key table reach them whatever the table holds
    expect(ids(before.rows)).toEqual(expect.arrayContaining(["brief-old:1", "cp-old:1"]));
    expect(before.coverageComplete).toBe(true);
    fillOwnerTailNow(db);
    const after = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(ids(after.rows)).toEqual(expect.arrayContaining(["brief-old:1", "cp-old:1"]));
    expect(after.coverageComplete).toBe(true);
    // the live checkpoint version is answered by the search index, never twice
    expect(ids(after.rows)).not.toContain("cp-old:2");
  });

  it("more never-indexed rows than the bound: the newest are read and the owner is told", { timeout: 300_000 }, async () => {
    seed(10, (db, scope) => {
      const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'episode',?,'owner-statement','active',0,?,NULL,NULL,?)");
      // a slice past the bound: the search reads whole slices, so the bound is reached only when more remain after them
      for (let n = 0; n <= OWNER_TAIL_WINDOW + 1000; n++) record.run(`ep-${String(n).padStart(6, "0")}`, scope, `episode ${n}${n === OWNER_TAIL_WINDOW + 1000 ? " zephyrine" : ""}`, 10 + n, 10 + n);
    });
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(ids(found.rows)).toContain(`ep-${String(OWNER_TAIL_WINDOW + 1000).padStart(6, "0")}:1`);
    expect(found).toMatchObject({ coverageComplete: false, searchNotice: OWNER_NEWEST_NOTICE });
  });

  it("the statements, and the rows they step, are the same at 20k and 500k records, and none reads the records table whole", { tags: ["nightly"], timeout: 900_000 }, async () => {
    const run = async (count: number) => {
      closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      seed(count);
      const before = { ...ownerSearchWork };
      ownerSearchTrace.statements = []; ownerSearchTrace.on = true;
      try {
        const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
        expect(found.coverageComplete).toBe(true);
        expect(ids(found.rows)).toContain("brief-old:1");
      } finally { ownerSearchTrace.on = false; }
      const visited = ownerSearchWork.visited - before.visited, ran = ownerSearchWork.statements - before.statements;
      const statements = ownerSearchTrace.statements.map(statement => ({ ...statement }));
      const plans = statements.filter(statement => statement.db === "main").map(statement =>
        (database().prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all() as Array<{ detail: string }>).map(row => row.detail));
      return { statements, plans, visited, ran };
    };
    const small = await run(20_000), large = await run(500_000);
    // 1.0.3: the index walk reads one key range (4,096 keys) at a time, so a rare word costs one short range probe per 4,096 records
    // (LANE2-MEMORY-DESIGN r3.3); the SET of statements, their plans, and the rows the word table steps are the same at any size
    const ranges = (run: typeof small) => run.statements.filter(statement => statement.sql.includes("OFFSET 4095")).length;
    const distinct = (run: typeof small) => [...new Set(run.statements.map(statement => `${statement.db}\u0000${statement.sql}`))].sort();
    expect(distinct(large)).toEqual(distinct(small));
    expect(new Set(large.plans.map(plan => plan.join("|")))).toEqual(new Set(small.plans.map(plan => plan.join("|"))));
    expect(large.visited - ranges(large)).toBe(small.visited - ranges(small));
    // an empty range costs its probe and one empty step of the word table: at most two statements per extra range
    expect(large.ran - small.ran).toBeLessThanOrEqual(2 * (ranges(large) - ranges(small)));
    expect(ranges(large)).toBeLessThanOrEqual(Math.ceil(500_000 / 4096) + 2);
    // the records table is only ever searched by key, never scanned; the never-indexed kinds come from the key table's kind index (bounded by its LIMIT)
    for (const plan of large.plans) for (const step of plan) expect(step).not.toMatch(/^SCAN (r|memory_records|memory_record_keys)\b/);
    expect(large.plans.flat().some(step => step.includes("memory_record_keys_kind"))).toBe(true);
  });
});

describe("the owner-tail index", () => {
  it("covers exactly the PIP kinds plus rolled checkpoints", () => {
    const kinds = /kind IN \(([^)]*)\)/.exec(OWNER_TAIL_KINDS_SQL)![1]!.split(",").map(kind => kind.trim().replace(/'/g, ""));
    expect(kinds).toEqual([...PIP_ALL_KINDS]);
  });

  it("a new file has it; the validator accepts a v8 file with all of it or none of it (and the earlier partial index), refuses part of it or a different one, and a downgrade drops it", () => {
    const db = database();
    expect(ownerTailReady(db)).toBe(true);
    expect(() => validateMemorySchema(db)).not.toThrow();
    dropOwnerTail(db);
    expect(ownerTailPresent(db)).toBe(false);
    expect(() => validateMemorySchema(db)).not.toThrow();
    db.exec(LEGACY_OWNER_TAIL_INDEX_SQL);
    expect(() => validateMemorySchema(db)).not.toThrow();
    fillOwnerTailNow(db);
    expect(ownerTailReady(db)).toBe(true);
    expect(() => validateMemorySchema(db)).not.toThrow();
    db.exec("DROP TRIGGER memory_owner_tail_update");
    expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    dropOwnerTail(db);
    db.exec(`CREATE TABLE ${OWNER_TAIL_TABLE}(created_at INTEGER, record_id TEXT, record_version INTEGER)`);
    expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    db.exec(`DROP TABLE ${OWNER_TAIL_TABLE}`);
    fillOwnerTailNow(db);
    expect(downgradeMemorySchema(db, 7).status).toBe("downgraded");
    expect(ownerTailPresent(db)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'memory_owner_tail%' OR name='memory_records_owner_tail'").get()!.n).toBe(0);
  });

  it("an existing file is filled after start in slices that never hold the writers, waiting while the owner is in a turn", async () => {
    seed(5_000);
    const db = database();
    dropOwnerTail(db);
    let busy = true;
    const build = startOwnerTailIndexBuild(db, { busyPollMs: 20, busy: () => busy });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(ownerTailPresent(db)).toBe(false); // waits while the owner is in a turn
    busy = false;
    expect(await build.done).toBe(true);
    expect(ownerTailReady(db)).toBe(true);
    expect(() => validateMemorySchema(db)).not.toThrow();
    const { writersHeldForIndexBuild } = await import("../database.ts");
    expect(writersHeldForIndexBuild()).toBe(false);
    expect((await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster)).coverageComplete).toBe(true);
  });
});

/** The rows the earlier partial index held, read through it: the reference the table must equal. */
function throughLegacyIndex(db: DatabaseSync) {
  return db.prepare(`SELECT created_at,id,version FROM memory_records INDEXED BY memory_records_owner_tail WHERE ${OWNER_TAIL_KINDS_SQL} ORDER BY created_at,id,version`).all()
    .map(row => `${row.created_at}|${row.id}|${row.version}`);
}
function tailRows(db: DatabaseSync) {
  return db.prepare(`SELECT created_at,record_id AS id,record_version AS version FROM ${OWNER_TAIL_TABLE} ORDER BY created_at,record_id,record_version`).all()
    .map(row => `${row.created_at}|${row.id}|${row.version}`);
}
/** `count` ordinary records plus every fifth one of an owner-tail kind (briefs and rolled checkpoints), all saying "zephyrine". */
function seedTail(count: number) {
  reconcileMemoryRoster(roster);
  const scope = ensureScope("bot", "a");
  transaction(db => {
    const record = db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement',?,0,?,NULL,NULL,?)");
    for (let n = 0; n < count; n++) {
      const kind = n % 10 === 0 ? "continuity-brief" : n % 10 === 5 ? "checkpoint" : "fact";
      record.run(`t-${String(n).padStart(7, "0")}`, 1, scope, kind, `zephyrine row ${n}`, kind === "checkpoint" ? "superseded" : "active", n, n);
    }
  });
  // an empty search index, so owner search takes its indexed path (and reads the never-indexed kinds through the owner-tail table)
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  new MemoryIndex(INDEX_PATH()).close();
  return scope;
}

describe("the owner-tail backfill", () => {
  it("a send's write during the backfill is never held more than 50 ms by it, and the writer gate is never taken", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
    seedTail(300_000);
    const db = database();
    dropOwnerTail(db);
    const { awaitWriterGateForeground, writersHeldForIndexBuild } = await import("../database.ts");
    const build = startOwnerTailIndexBuild(db, { pauseMs: 1 });
    let finished = false;
    void build.done.then(() => { finished = true; });
    const waits: number[] = [];
    let gateHeld = false, n = 0;
    // a send every few milliseconds for as long as the backfill runs: the time from when it was due to when its write committed
    while (!finished) {
      const due = performance.now() + 2;
      await new Promise(resolve => setTimeout(resolve, 2));
      gateHeld ||= writersHeldForIndexBuild();
      await awaitWriterGateForeground();
      transaction(tx => { tx.prepare("INSERT INTO memory_records VALUES(?,1,(SELECT id FROM memory_scopes LIMIT 1),'continuity-brief','sent during backfill','owner-statement','active',0,1,NULL,NULL,?)").run(`send-${n++}`, 400_000 + n); });
      waits.push(performance.now() - due);
    }
    expect(await build.done).toBe(true);
    console.log(`[owner-tail backfill 300k] ${build.stats.slices} slices, longest ${build.stats.maxSliceMs.toFixed(1)} ms; ${waits.length} sends, longest wait ${Math.max(...waits).toFixed(1)} ms`);
    expect(waits.length).toBeGreaterThan(10);
    expect(Math.max(...waits)).toBeLessThan(50);
    expect(build.stats.maxSliceMs).toBeLessThan(50);
    expect(gateHeld).toBe(false);
    // the records sent during the backfill are in the table (the triggers), and so is every old one (the backfill)
    db.exec(LEGACY_OWNER_TAIL_INDEX_SQL);
    expect(tailRows(db)).toEqual(throughLegacyIndex(db));
  });

  it("killed part way, it resumes after the last committed slice and ends with exactly the index's rows, changes made meanwhile included", { timeout: 300_000 }, async () => {
    seedTail(50_000);
    const db = database();
    dropOwnerTail(db);
    const first = startOwnerTailIndexBuild(db, { pauseMs: 1, targetMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 40));
    first.stop();
    expect(await first.done).toBe(false);
    expect(first.stats.slices).toBeGreaterThan(0);
    expect(ownerTailReady(db)).toBe(false);
    const build = db.prepare("SELECT ready,cursor_id FROM memory_owner_tail_build").get()!;
    expect(build.ready).toBe(0);
    expect(build.cursor_id).not.toBeNull();
    const partial = tailRows(db).length;
    // changes on both sides of the cursor while it is stopped: a new episode, a rolled checkpoint made live again, a brief turned fact, briefs deleted
    const scope = db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id;
    db.prepare("INSERT INTO memory_records VALUES('t-new',1,?,'episode','zephyrine new','owner-statement','active',0,1,NULL,NULL,999999)").run(scope);
    db.prepare("UPDATE memory_records SET state='active' WHERE id='t-0049995'").run();
    db.prepare("UPDATE memory_records SET kind='fact' WHERE id='t-0000010'").run();
    db.prepare("DELETE FROM memory_records WHERE id IN ('t-0000020','t-0049990')").run();
    const second = startOwnerTailIndexBuild(db, { pauseMs: 1 });
    expect(await second.done).toBe(true);
    expect(second.stats.slices).toBeGreaterThan(0);
    db.exec(LEGACY_OWNER_TAIL_INDEX_SQL);
    const rows = tailRows(db);
    expect(rows.length).toBeGreaterThan(partial);
    expect(rows).toEqual(throughLegacyIndex(db));
  });

  it("owner search with the backfill done answers exactly as the index version did", { timeout: 300_000 }, async () => {
    // reference: a file whose table was kept by its triggers from the first record (the index's own answer: same rows, same order)
    seedTail(30_000);
    const db = database();
    db.exec(LEGACY_OWNER_TAIL_INDEX_SQL);
    expect(tailRows(db)).toEqual(throughLegacyIndex(db));
    const pages = async () => {
      const out: string[][] = [];
      let cursor: string | undefined;
      for (let n = 0; n < 4; n++) {
        const page = await ownerMemoryList({ botId: "a", query: "zephyrine", ...cursor ? { cursor } : {} }, roster);
        out.push(page.rows.map(row => `${row.id}:${row.version}`));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return out;
    };
    const reference = await pages();
    dropOwnerTail(db);
    fillOwnerTailNow(db);
    expect(await pages()).toEqual(reference);
    expect(reference.flat().length).toBeGreaterThan(100);
  });

  it("a slice that meets a write lock held by another connection returns within 50 ms with no progress, restores the busy wait, and the build completes once the lock is gone", { timeout: 30_000, ...windowsPerfBudget() }, async () => {
    seedTail(2_000);
    const db = database();
    dropOwnerTail(db);
    const holder = new DatabaseSync(join(DATA_DIR, "messages.db"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const t0 = performance.now();
      const step = fillOwnerTailSlice(db, 256);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(50);
      expect(step).toMatchObject({ ready: false, read: 0, busy: true });
      expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(1000);
      expect(ownerTailReady(db)).toBe(false);
      const build = startOwnerTailIndexBuild(db, { pauseMs: 5, targetMs: 5 });
      setTimeout(() => holder.exec("COMMIT"), 650);
      expect(await build.done).toBe(true);
      expect(build.stats.lockedRetries).toBeGreaterThan(0);
      expect(build.stats.maxSliceMs).toBeLessThan(50);
    } finally { try { holder.exec("ROLLBACK"); } catch { /* committed */ } holder.close(); }
    expect(ownerTailReady(db)).toBe(true);
  });

  it("the final slice does not drop the legacy index; the separate step does, only when the lock is free, and the table answers without it", async () => {
    seedTail(500);
    const db = database();
    dropOwnerTail(db);
    db.exec(LEGACY_OWNER_TAIL_INDEX_SQL);
    const present = () => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(LEGACY_OWNER_TAIL_INDEX);
    while (!fillOwnerTailSlice(db, 4096, { budgetMs: Number.POSITIVE_INFINITY }).ready) { /* next slice */ }
    expect(ownerTailReady(db)).toBe(true);
    expect(present()).toBe(true);
    const holder = new DatabaseSync(join(DATA_DIR, "messages.db"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const t0 = performance.now();
      expect(dropLegacyOwnerTailIndex(db)).toBe("busy");
      expect(performance.now() - t0).toBeLessThan(50);
      expect(present()).toBe(true);
    } finally { holder.exec("ROLLBACK"); holder.close(); }
    expect(dropLegacyOwnerTailIndex(db)).toBe("dropped");
    expect(present()).toBe(false);
    expect(dropLegacyOwnerTailIndex(db)).toBe("none");
  });

  it("a started build on a file that is ready but still has the legacy index drops it in its own step", async () => {
    seedTail(300);
    const db = database();
    fillOwnerTailNow(db);
    db.exec(LEGACY_OWNER_TAIL_INDEX_SQL);
    const build = startOwnerTailIndexBuild(db, { pauseMs: 1 });
    expect(await build.done).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(LEGACY_OWNER_TAIL_INDEX)).toBeUndefined();
  });
});
