// R1: the cleanup that ends parking (forgetParkedSource, forgetParkedThreads and
// the tombstone cleanup of a restore) seeks the jobs of the affected sources by
// source id. It never walks the cancelled range of the status index, so its
// cost does not grow with the number of unrelated cancelled jobs.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as park from "./park.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";

const fix = park as unknown as Record<string, any>;
const UNRELATED = 20_000;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [], groups: [] }); setMemoryMode("capture");
});
afterEach(() => { closeDatabase(); });

const plan = (sql: string, ...args: any[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => String(r.detail)).join("\n");
const MARKER = "parked:v1:{\"s\":\"pending\",\"e\":null}";

/** UNRELATED cancelled jobs (one source, no marker), plus three small threads of sources whose cancelled jobs carry a marker. */
function world() {
  const db = database();
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_scopes VALUES('s','conversation','o','[]',0)").run();
  const source = (id: string, thread: string, state: string) => {
    db.prepare("INSERT INTO memory_sources VALUES(?,'s',?,?,NULL,1,?,'text','owner','recorded',NULL,?)").run(id, thread, id, `h-${id}`, state);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(id, `h-${id}`, JSON.stringify({ text: "x" }));
  };
  const job = (id: string, src: string, stage: string, error: string | null) =>
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch,error) VALUES(?,?,1,'capture',?,'cancelled',0,0,?)").run(id, src, stage, error);
  source("big", "unrelated", "active");
  for (let i = 0; i < UNRELATED; i++) job(`c-${i}`, "big", `v${i}`, null);
  for (const t of ["ta", "tb", "tc"]) for (let i = 0; i < 3; i++) { source(`${t}-${i}`, t, i === 0 ? "deleted" : "active"); job(`j-${t}-${i}`, `${t}-${i}`, "1", MARKER); }
  db.exec("COMMIT");
  return db;
}
/** The statement with a counting function evaluated on every job row that reaches the marker test. */
function counted(sql: string) {
  const text = sql.replace(/substr\((j\.)?error,1,7\)='parked:'/g, "probe($1rowid) AND $&");
  expect(text).not.toBe(sql);
  let rows = 0;
  database().function("probe", { deterministic: false, varargs: true }, () => { rows++; return 1; });
  return { text, rows: () => rows };
}
const marked = () => Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE error LIKE 'parked:%'").get()!.n);

describe("R1: cleanup of parking seeks by source id", () => {
  it("forgetSource: source-id index seek, no status range", () => {
    world();
    const text = plan(fix.PARK_SQL.forgetSource, "ta-1");
    expect(text).toMatch(/SEARCH memory_jobs USING (COVERING )?INDEX sqlite_autoindex_memory_jobs_2 \(source_id=\?/);
    expect(text).not.toContain("memory_jobs_pending");
    expect(text).not.toMatch(/SCAN/);
  });
  it("forgetThreads: thread index on sources, then a source-id seek on jobs", () => {
    world();
    const text = plan(fix.PARK_SQL.forgetThreads, JSON.stringify(["ta", "tb"]));
    expect(text).toMatch(/SEARCH s USING (COVERING )?INDEX memory_sources_thread \(thread_id=\?/);
    expect(text).toMatch(/SEARCH j USING (COVERING )?INDEX sqlite_autoindex_memory_jobs_2 \(source_id=\?/);
    expect(text).not.toContain("memory_jobs_pending");
    expect(text).not.toMatch(/SCAN (j|s|memory_jobs|memory_sources)\b/);
  });
  it("tombstone cleanup: driven by the deleted sources and the tombstones, jobs sought by source id", () => {
    world();
    const text = plan(fix.PARK_SQL.forgetTombstoned);
    expect(text).toMatch(/SEARCH j USING (COVERING )?INDEX sqlite_autoindex_memory_jobs_2 \(source_id=\?/);
    expect(text).not.toContain("memory_jobs_pending");
    expect(text).not.toMatch(/SCAN (j|memory_jobs)\b/);
  });

  it(`with ${UNRELATED} unrelated cancelled jobs, forgetSource examines only that source's jobs`, () => {
    const db = world();
    const c = counted(fix.PARK_SQL.forgetSource);
    db.prepare(c.text).run("ta-1");
    expect(c.rows()).toBeLessThanOrEqual(1);
    expect(db.prepare("SELECT error FROM memory_jobs WHERE id='j-ta-1'").get()!.error).toBeNull();
    expect(marked()).toBe(8);
    const absent = counted(fix.PARK_SQL.forgetSource);
    const before = absent.rows();
    db.prepare(absent.text).run("no-such-source");
    expect(absent.rows() - before).toBe(0);
  });
  it(`with ${UNRELATED} unrelated cancelled jobs, forgetThreads examines only the selected threads' jobs`, () => {
    const db = world();
    const c = counted(fix.PARK_SQL.forgetThreads);
    db.prepare(c.text).run(JSON.stringify(["ta", "tb"]));
    expect(c.rows()).toBeLessThanOrEqual(6);
    expect(marked()).toBe(3);  // only thread tc keeps its markers
  });
  it(`with ${UNRELATED} unrelated cancelled jobs, the tombstone cleanup examines only deleted or tombstoned sources' jobs`, () => {
    const db = world();
    db.prepare("INSERT INTO memory_tombstones VALUES('tomb','source','tb-1',NULL,NULL,1,'x',0)").run();
    const c = counted(fix.PARK_SQL.forgetTombstoned);
    db.prepare(c.text).run();
    expect(c.rows()).toBeLessThanOrEqual(8);
    // deleted sources ta-0, tb-0, tc-0 and the tombstoned tb-1 lose their markers; the others keep theirs
    expect(marked()).toBe(5);
    expect(db.prepare("SELECT error FROM memory_jobs WHERE id='j-tb-1'").get()!.error).toBeNull();
  });
});
