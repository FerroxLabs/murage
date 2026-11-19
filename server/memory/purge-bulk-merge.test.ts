// SPDX-License-Identifier: AGPL-3.0-or-later
// A bulk rolled-checkpoint removal is merged in short steps; a trickle (one rollover) settles in place with no merge at all.
// The 500,000-version witness is msearch-review.test.ts (perf-budget); this is the same contract at a size every run can afford.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryIndex } from "./index.ts";
import { openTestIndex } from "./testing/open-index.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purge-merge-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function seeded(versions: number): Promise<{ index: MemoryIndex; path: string }> {
  const path = join(dir, "memory-index.db");
  (await openTestIndex(path)).close();
  const raw = new DatabaseSync(path);
  raw.exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',4)");
  raw.exec("BEGIN");
  raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${versions})
    INSERT INTO entries SELECT 'checkpoint:long',i,'s','Working evidence: the launch review status, version '||i FROM n`);
  raw.exec("INSERT INTO lexical(id,version,text) SELECT id,version,text FROM entries ORDER BY id,version");
  raw.exec("INSERT INTO lexical_keys SELECT id,CAST(version AS INTEGER),rowid FROM lexical");
  raw.exec("COMMIT");
  raw.exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1999)");
  raw.close();
  return { index: await openTestIndex(path), path };
}
async function purgeAll(index: MemoryIndex) {
  let walk = 0, merge = 0, removed = 0, lastMergeAt = 0;
  for (;;) {
    const step = await index.purgeRolledCheckpoints();
    if(index.writerStopped()!==false)throw new Error("purge writer stopped");
    if (step.merged) { merge++; lastMergeAt = removed; } else walk++;
    removed += step.removed;
    if (step.done) return { walk, merge, removed, lastMergeAt };
  }
}

it("a bulk removal of rolled versions is merged in short steps", { timeout: 300_000 }, async () => {
  const { index, path } = await seeded(30000);
  const run = await purgeAll(index);
  index.close();
  expect(run.removed).toBe(29999);
  expect(run.merge).toBeGreaterThan(0);
  expect(run.lastMergeAt).toBeGreaterThan(25000);
  const after = new DatabaseSync(path);
  expect(after.prepare("SELECT id,version FROM entries").all().map(row => `${row.id}:${row.version}`)).toEqual(["checkpoint:long:30000"]);
  after.close();
});

it("one rolled version is erased in place: no merge step runs", async () => {
  const { index } = await seeded(2);
  const run = await purgeAll(index);
  index.close();
  expect(run.removed).toBe(1);
  expect(run.merge).toBe(0);
});

it("the walk reads rows in small chunks, so a step pays for the rows it consumes, not for the whole examine cap", async () => {
  const { index } = await seeded(5000);
  const proto = DatabaseSync.prototype as unknown as { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
  const original = proto.prepare, reads: number[] = [];
  proto.prepare = function (this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (!/FROM entries e LEFT JOIN lexical_keys/.test(sql)) return statement;
    const all = statement.all.bind(statement);
    statement.all = (...args: unknown[]) => { const rows = all(...args); reads.push(rows.length); return rows; };
    return statement;
  };
  let run: Awaited<ReturnType<typeof purgeAll>>;
  try { run = await purgeAll(index); } finally { proto.prepare = original; index.close(); }
  expect(run.removed).toBe(4999);
  expect(reads.length).toBeGreaterThan(0);
  expect(Math.max(...reads)).toBeLessThanOrEqual(65);
});

it("the bulk-merge threshold doubles with each merge of a pass, so a stale live count costs a handful of merges", { timeout: 300_000 }, async () => {
  const { index } = await seeded(7000);
  const owed = index as unknown as { setMergeOwed(owed: boolean, directlyErased?: boolean): void };
  const original = owed.setMergeOwed.bind(index), bulkMerges: number[] = [];
  owed.setMergeOwed = (flag: boolean, directlyErased = false) => { if (flag && !directlyErased) bulkMerges.push(bulkMerges.length); original(flag, directlyErased); };
  let removed = 0;
  for (;;) {
    // mergeFraction 0 leaves `mergeAt` as the only threshold; each pass removes about 1,100 rows.
    const step = await index.purgeRolledCheckpoints({ maxExamined: 1100, maxMs: 60_000, mergeFraction: 0 });
    removed += step.removed;
    if (step.done) break;
  }
  index.close();
  expect(removed).toBe(6999);
  // 1,000 then 2,000 then 4,000: three bulk merges at most, not one per 1,100-row pass (about six).
  expect(bulkMerges.length).toBeGreaterThan(0);
  expect(bulkMerges.length).toBeLessThanOrEqual(3);
});

// Structural row bounds use a fixed clock; the unchanged P2 test measures real wall time.
async function chunkStep(index: MemoryIndex) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now());
  try { return await index.purgeRolledCheckpoints({ maxExamined: 64, maxMs: 50 }); }
  finally { clock.mockRestore(); }
}

it("keeps the first posting until the checkpoint walk ends, including across bounded steps", async () => {
  const { index, path } = await seeded(130);
  try {
    const step = await chunkStep(index);
    expect(step.examined).toBe(64);
    expect(step.removed).toBe(63);
    expect(step.done).toBe(false);
    const raw = new DatabaseSync(path);
    try { expect(raw.prepare("SELECT version FROM entries ORDER BY version").all().map(row => row.version)).toEqual([1, ...Array.from({ length: 66 }, (_, n) => n + 65)]); }
    finally { raw.close(); }
    const rest = await purgeAll(index);
    expect(rest.removed).toBe(66);
    const after = new DatabaseSync(path);
    try { expect(after.prepare("SELECT version FROM entries").all().map(row => row.version)).toEqual([130]); }
    finally { after.close(); }
  } finally { index.close(); }
});


it("an interrupted full-chunk walk removes its deferred version after reopening", async () => {
  const { index, path } = await seeded(130);
  try { expect((await chunkStep(index)).removed).toBe(63); }
  finally { index.close(); }
  const reopened = await openTestIndex(path);
  try { expect((await purgeAll(reopened)).removed).toBe(66); }
  finally { reopened.close(); }
  const raw = new DatabaseSync(path);
  try { expect(raw.prepare("SELECT version FROM entries").all().map(row => row.version)).toEqual([130]); }
  finally { raw.close(); }
});

it("never deletes a deferred version that became the sole surviving checkpoint", async () => {
  const { index, path } = await seeded(130);
  try {
    expect((await chunkStep(index)).removed).toBe(63);
    const raw = new DatabaseSync(path);
    try {
      raw.exec("BEGIN; DELETE FROM lexical WHERE rowid IN (SELECT fts_rowid FROM lexical_keys WHERE version>1); DELETE FROM lexical_keys WHERE version>1; DELETE FROM entries WHERE version>1; COMMIT");
    } finally { raw.close(); }
    expect((await purgeAll(index)).removed).toBe(0);
    const after = new DatabaseSync(path);
    try { expect(after.prepare("SELECT version FROM entries").all().map(row => row.version)).toEqual([1]); }
    finally { after.close(); }
  } finally { index.close(); }
});

it("a rolled-back final deletion keeps the deferred version queued for the next step", async () => {
  const { index, path } = await seeded(130);
  const proto = DatabaseSync.prototype as unknown as { prepare(sql: string): { run(...args: unknown[]): unknown } };
  const original = proto.prepare;
  let injected = false;
  try {
    expect((await chunkStep(index)).removed).toBe(63);
    proto.prepare = function (this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql !== "DELETE FROM lexical WHERE rowid=?") return statement;
      const run = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        if (args[0] === 1 && !injected) { injected = true; throw new Error("fixture delete fault"); }
        return run(...args);
      };
      return statement;
    };
    await expect(purgeAll(index)).rejects.toThrow("fixture delete fault");
    expect(injected).toBe(true);
    await purgeAll(index);
    const raw = new DatabaseSync(path);
    try { expect(raw.prepare("SELECT version FROM entries ORDER BY version").all().map(row => row.version)).toEqual([130]); }
    finally { raw.close(); }
  } finally { proto.prepare = original; index.close(); }
});


it.each([{ cursor: null, live: 130, after: 67 }, { cursor: 20, live: 20, after: 1 }])("a delete step batches metadata without crossing its recount frontier ($cursor)", async ({ cursor, live, after }) => {
  const proto = DatabaseSync.prototype as unknown as { prepare(sql: string): { run(...args: unknown[]): unknown } };
  const original = proto.prepare;
  const writes: Record<string, number> = { entries_live: 0, "text_bytes:lexical": 0, "debt_bytes:lexical": 0 };
  proto.prepare = function (this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (sql !== "INSERT OR REPLACE INTO index_meta VALUES(?,?)") return statement;
    const run = statement.run.bind(statement);
    statement.run = (...args: unknown[]) => { const key = String(args[0]); if (key in writes) writes[key]++; return run(...args); };
    return statement;
  };
  let index: MemoryIndex | undefined, totalBytes = 0;
  try {
    const seededIndex = await seeded(130); index = seededIndex.index;
    const raw = new DatabaseSync(seededIndex.path);
    try {
      totalBytes = Number(raw.prepare("SELECT sum(length(CAST(text AS BLOB))) AS n FROM entries").get()!.n);
      raw.prepare("INSERT OR REPLACE INTO index_meta VALUES('text_bytes:lexical',?)").run(String(totalBytes));
      raw.exec("INSERT OR REPLACE INTO index_meta VALUES('debt_bytes:lexical','0')");
      raw.prepare("INSERT OR REPLACE INTO index_meta VALUES('entries_live',?)").run(String(live));
      if (cursor !== null) raw.prepare("INSERT OR REPLACE INTO index_meta VALUES('entries_live_recount',?)").run(String(cursor));
    } finally { raw.close(); }
    for (const key of Object.keys(writes)) writes[key] = 0;
    expect((await chunkStep(index)).removed).toBe(63);
    expect(writes).toEqual({ entries_live: 1, "text_bytes:lexical": 1, "debt_bytes:lexical": 1 });
    expect(index.entriesLive()).toBe(after);
    const check = new DatabaseSync(seededIndex.path);
    try {
      const remaining = Number(check.prepare("SELECT sum(length(CAST(text AS BLOB))) AS n FROM entries").get()!.n);
      expect(Number(check.prepare("SELECT value FROM index_meta WHERE key='text_bytes:lexical'").get()!.value)).toBe(remaining);
      expect(Number(check.prepare("SELECT value FROM index_meta WHERE key='debt_bytes:lexical'").get()!.value)).toBe(totalBytes - remaining);
    } finally { check.close(); }
    await purgeAll(index);
    while (index.entriesRecounting()) await index.recountStep();
    expect(index.entriesLive()).toBe(1);
  } finally { proto.prepare = original; index?.close(); }
});
