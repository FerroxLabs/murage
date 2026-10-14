// SPDX-License-Identifier: AGPL-3.0-or-later
// Changing the projection's layout does no work proportional to the history
// before the server listens. The old layout's triggers are dropped (cheap) and
// its tables are set aside under other names, still full; the new layout is
// created empty and filled by the normal background fill; the old tables are
// freed afterwards, in slices, by the same background loop.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { fillInboxProjection, initializeInbox, inboxProjectionReady, isInboxProjectionObject, listInbox, startInboxProjectionFill } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });
const ROUTINE_RESULTS = 200_000;
const access = { owner: true, threads: Array.from({ length: 50 }, (_, i) => ({ threadId: `t${i}`, label: `Bot ${i}` })) };

/** An installation whose projection is of an older layout: 200k projected routine results with 1 KiB summaries. */
function olderLayout() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA secure_delete=ON");
  initializeMessageTables(db);
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't' || (i % 50), 'r' || i, 1700000000000 + i, 'bot', 'routine.run', NULL,
      json_object('id','r' || i,'at',1700000000000 + i,'role','bot','kind','routine.run','routineRun',json_object('runId','run' || i,'routineId','rt' || (i % 7),'routineName','Routine ' || (i % 7),'status','completed','summary',replace(hex(zeroblob(512)),'0','y')))
    FROM n`).run(ROUTINE_RESULTS);
  initializeInbox(db);
  fillInboxProjection(db);
  const expected = (db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n;
  // Make it look like the previous layout's database: other marker, and index names the new layout does not use.
  const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL AND tbl_name IN ('inbox_raw','inbox_items','inbox_keys','inbox_counts','setup_marks')").all() as Array<{ name: string; sql: string }>;
  for (const index of indexes) { db.exec(`DROP INDEX ${index.name}`); db.exec(index.sql.replace(index.name, `${index.name}_old`)); }
  db.prepare("UPDATE inbox_projection_state SET cursor=2 WHERE name='layout'").run();
  return { db, expected };
}
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("a layout bump holds the start for the cost of the schema, not of the history", () => {
  it("initializes in under 20 ms over 200k projected routine results and frees no old page before the server listens", async () => {
    const { db, expected } = olderLayout();
    expect(expected).toBeGreaterThan(0);
    const freelistBefore = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    const times: number[] = [];
    const started = performance.now();
    initializeInbox(db);
    times.push(performance.now() - started);
    console.log(`[layout-bump] init over ${ROUTINE_RESULTS} projected results: ${times[0]!.toFixed(1)} ms`);
    expect(times[0]!).toBeLessThan(20);
    // nothing of the old layout has been freed: its rows are all still there under their new names
    const retired = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'retired%'").all() as Array<{ name: string }>;
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.map(row => row.name)).toContain("retired2_inbox_raw");
    expect(count(db, "retired2_inbox_raw")).toBe(ROUTINE_RESULTS);
    expect((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count, "no old page was freed").toBeLessThanOrEqual(freelistBefore);
    // the retired objects are the projection's: restore and the snapshot inspector treat them as derived data
    for (const row of retired) expect(isInboxProjectionObject({ type: "table", name: row.name, tbl_name: row.name })).toBe(true);
    // the new layout is empty and not ready; the old messages triggers are gone, the new ones are in
    expect(count(db, "inbox_raw")).toBe(0);
    expect(inboxProjectionReady(db)).toBe(false);
    const triggers = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='messages'").get() as { n: number }).n;
    expect(triggers).toBeGreaterThan(0);

    // the background loop fills the new layout, then frees the old tables in slices
    const fill = startInboxProjectionFill(db);
    expect(await fill.done).toEqual({ filled: true });
    expect(inboxProjectionReady(db)).toBe(true);
    expect(count(db, "inbox_items")).toBe(expected);
    expect(listInbox(db, { view: "all", pageSize: 20 }, access).items.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','index') AND name LIKE '%retired%'").all()).toEqual([]);
    expect(fill.stats.maxSliceMs, "no slice held the loop").toBeLessThan(50);
  }, 280_000);

  it("a start that finds the new layout ready and old tables left over frees them in slices without refilling", async () => {
    const { db } = olderLayout();
    initializeInbox(db);
    fillInboxProjection(db);
    expect(inboxProjectionReady(db)).toBe(true);
    expect(count(db, "retired2_inbox_raw")).toBe(ROUTINE_RESULTS);
    const reclaim = startInboxProjectionFill(db);
    expect(await reclaim.done).toEqual({ filled: false });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','index') AND name LIKE '%retired%'").all()).toEqual([]);
    expect(reclaim.stats.maxSliceMs).toBeLessThan(50);
  }, 280_000);
});
