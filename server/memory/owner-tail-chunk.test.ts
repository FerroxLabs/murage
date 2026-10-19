// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc13 round 3 (1): the owner-tail backfill bounds the rows of each statement, not only the time of each slice. A fixed 64-record chunk read
// cold beside the upgrade's writes held the loop 714 ms in one statement (rc13 real-data run, server3.log:94). Each statement now follows what
// the last one took by integrity-pass.ts nextWindowSize: halved past 20 ms, doubled under 5 ms, between 1 and OWNER_TAIL_CHUNK.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { fillOwnerTailNow, fillOwnerTailSlice, OWNER_TAIL_CHUNK, OWNER_TAIL_FIRST_CHUNK, OWNER_TAIL_SOURCE, ownerTailChunk, startOwnerTailIndexBuild } from "./owner-tail-index.ts";
import { ioBudget } from "../io-budget.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { dropOwnerTail, OWNER_TAIL_KINDS_SQL, OWNER_TAIL_TABLE, ownerTailReady } from "./schema.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function seed(count: number): void {
  reconcileMemoryRoster({ bots: [{ id: "a", threadId: "ta" }], groups: [] });
  const scope = ensureScope("bot", "a");
  transaction(db => {
    const record = db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement',?,0,?,NULL,NULL,?)");
    for (let n = 0; n < count; n++) {
      const kind = n % 10 === 0 ? "continuity-brief" : n % 10 === 5 ? "checkpoint" : "fact";
      record.run(`t-${String(n).padStart(7, "0")}`, 1, scope, kind, `row ${n}`, kind === "checkpoint" ? "superseded" : "active", n, n);
    }
  });
  dropOwnerTail(database());
}
/** A clock on which every statement of the slice takes `ms`: the slice reads it once at its start and once on each side of a statement. */
const clock = (ms: number) => { let t = 0; return () => (t += ms); };

it("a slow statement halves the next one down to a single record; quick ones double it back up to the cap", () => {
  seed(5_000);
  const db = database();
  expect(ownerTailChunk(db)).toBe(OWNER_TAIL_FIRST_CHUNK);
  // a budget of 0 ends each slice after its first statement, so `read` is the rows that statement covered
  const slow: number[] = [];
  for (let i = 0; i < 7; i++) slow.push(fillOwnerTailSlice(db, 4096, { budgetMs: 0, now: clock(100) }).read);
  expect(slow).toEqual([16, 8, 4, 2, 1, 1, 1]);
  const quick: number[] = [];
  for (let i = 0; i < 8; i++) quick.push(fillOwnerTailSlice(db, 4096, { budgetMs: 0, now: clock(1) }).read);
  expect(quick).toEqual([1, 2, 4, 8, 16, 32, 64, 64]);
  expect(ownerTailChunk(db)).toBe(OWNER_TAIL_CHUNK);
  // a statement between a quarter of the target and the target keeps the size
  expect(fillOwnerTailSlice(db, 4096, { budgetMs: 0, now: clock(10) }).read).toBe(64);
  expect(ownerTailChunk(db)).toBe(64);
  // whatever the sizes were, the table ends exact
  fillOwnerTailNow(db);
  expect(ownerTailReady(db)).toBe(true);
  const want = Number(db.prepare(`SELECT count(*) AS n FROM memory_records WHERE ${OWNER_TAIL_KINDS_SQL}`).get()!.n);
  expect(want).toBe(1_000);
  expect(Number(db.prepare(`SELECT count(*) AS n FROM ${OWNER_TAIL_TABLE}`).get()!.n)).toBe(want);
});

it("one slice of many statements never lets one statement cover more records than the adaptive size", () => {
  seed(3_000);
  const db = database();
  // every statement slow: the whole slice runs (no time budget) and the size falls to one record a statement within it
  const step = fillOwnerTailSlice(db, 40, { budgetMs: Number.POSITIVE_INFINITY, now: clock(100) });
  // 16 + 8 + 4 + 2 + 1 + 1 + ... = 40 rows in 5 + 9 statements
  expect(step.read).toBe(40);
  expect(ownerTailChunk(db)).toBe(1);
});

it("the statement after the cursor steps the primary key, never a scan and sort of the records table", () => {
  seed(10);
  const db = database();
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id,version,created_at,${OWNER_TAIL_KINDS_SQL} AS tail FROM memory_records WHERE (id,version)>(?,?) ORDER BY id,version LIMIT ?`)
    .all("t", 1, 16).map(row => String(row.detail));
  expect(plan.join(" | ")).toMatch(/USING INDEX sqlite_autoindex_memory_records_1/);
  expect(plan.join(" | ")).not.toMatch(/TEMP B-TREE/);
});

// 1.0.3 lane 3 (stall r1): every statement of the background backfill runs under OWNER_TAIL_SOURCE, so a slow one is named. Untested before.
it("the background build runs every one of its statements under OWNER_TAIL_SOURCE", async () => {
  seed(500);
  const db = database(), original = db.prepare.bind(db);
  const sources = new Set<string | undefined>();
  let statements = 0;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql.includes("FROM memory_records") || sql.includes(OWNER_TAIL_TABLE)) { statements++; sources.add(ioBudget.currentSource()); }
    return original(sql);
  };
  try {
    const build = startOwnerTailIndexBuild(db, { gate: null, admit: async () => {}, pauseMs: 1 });
    expect(await build.done).toBe(true);
  } finally { (db as unknown as { prepare: unknown }).prepare = original; }
  expect(statements).toBeGreaterThan(0);
  expect([...sources]).toEqual([OWNER_TAIL_SOURCE]);
  expect(ownerTailReady(db)).toBe(true);
});
