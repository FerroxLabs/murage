// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Premortem S1 (Astra #3 #4, Fable #2 #7): first-start work on a used data dir. A heavy user's history is read by the open-card
// index, memory validation and the output-lineage repair; each must (a) be announced in the start-up note BEFORE it starts, on
// the first start and on every later start while work remains, (b) be bounded by the rows it scans and keep its progress, and
// (c) keep its working memory linear in the history.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { legacyFile, restartLegacy } from "./testing/legacy-file-model.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
beforeEach(() => thawRootSetWritesForTest(true));
afterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR } from "../config.ts";
import { ancestryUnrepaired, closeDatabase, database, finishBackgroundUpgradeWorkNow, setRepairRunnerForTest, setUpgradeReporterForTest } from "../database.ts";
import { openRequestCards } from "../message-db.ts";
import { indexOpenCardsChunk, readIndexState } from "../transcript-backfill.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { memoryUpgradeReporter } from "./upgrade-status.ts";
import { ancestryThreadRepaired, legacyReplyRoots, lineageRepairPending, repairOutputRootBackfill, rootSetMembers, validateMemorySchema } from "./schema.ts";
import { windowsNightly } from "../testing/windows-hosted.ts";

// every method the database's reporter is asked to run, in order, with the open-card cursor an independent reader saw at that moment
const calls: Array<{ method: string; arg: unknown; cursor: number | null; indexed: number }> = [];
const wrapReporter: typeof memoryUpgradeReporter = (...args) => {
  const reporter = memoryUpgradeReporter(...args);
  return new Proxy(reporter, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      return (...a: unknown[]) => {
        let cursor: number | null = null, indexed = 0;
        const peek = new DatabaseSync(join(DATA_DIR, "messages.db"));
        try {
          const row = peek.prepare("SELECT cursor FROM transcript_index_state WHERE name='open_card'").get() as { cursor: number } | undefined;
          cursor = row ? row.cursor : null;
          indexed = Number((peek.prepare("SELECT count(*) AS n FROM open_card").get() as { n: number }).n);
        } catch { /* tables not there yet */ } finally { peek.close(); }
        calls.push({ method: String(key), arg: a[0], cursor, indexed });
        return (value as (...x: unknown[]) => unknown).apply(target, a);
      };
    },
  });
};

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [] }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster); calls.length = 0;
  setUpgradeReporterForTest(wrapReporter);
});
afterEach(() => setUpgradeReporterForTest(null));

const keyOf = (thread: string, id: string) => `${thread}\u0000${id}`;
/** `n` bot text replies in a straight line, every one a receipt output of one bundle. */
function chainThread(thread: string, n: number, bundle: string) {
  const db = database();
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m${String(i).padStart(6, "0")}`; ids.push(id);
    insert.run(thread, id, i, "bot", "text", "t", JSON.stringify({ id, at: i, role: "bot", kind: "text", text: "t", parentId: i ? ids[i - 1] : null }));
  }
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'engine','S','[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1000)")
    .run(bundle, thread, JSON.stringify(ids));
  db.exec("COMMIT");
  return ids;
}
const openOptions = (id: string, requestId: string) => ({ id, at: 1, role: "bot", kind: "options", text: "x", parentId: null, card: { title: "May I?", options: [], requestId, tool: "Bash" } });

it("S1: the open-card index is bounded by rows scanned, not cards found: a sparse history takes many small chunks, each saved", () => {
  const live = database();
  live.exec("DELETE FROM transcript_index_state; DELETE FROM open_card");
  const insert = live.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t',?,?,'bot','text','x',?)");
  live.exec("BEGIN");
  for (let i = 0; i < 5000; i++) insert.run(`r${i}`, i, JSON.stringify({ id: `r${i}`, kind: "text", parentId: null }));
  live.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','card',9999,'bot','options','x',?)").run(JSON.stringify(openOptions("card", "req-1")));
  live.exec("COMMIT");
  let chunks = 0;
  const cursors: number[] = [];
  while (indexOpenCardsChunk(live, 1000)) { chunks++; cursors.push(readIndexState(live, "open_card").cursor); }
  expect(chunks, "one match must not end the scan: five thousand rows scanned a thousand at a time").toBeGreaterThanOrEqual(5);
  expect(cursors.every((cursor, at) => at === 0 || cursor > cursors[at - 1]!)).toBe(true);
  expect(readIndexState(live, "open_card").done).toBe(1);
  expect(live.prepare("SELECT id FROM open_card").all().map(r => r.id)).toEqual(["card"]);
});

it("S1 (fast upgrade): a used data dir opens without scanning its history for cards: the index is filled by the background walker, readers read the thread's rows meanwhile", () => {
  const live = database();
  live.exec("BEGIN");
  const insert = live.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t',?,?,'bot','text','x',?)");
  for (let i = 0; i < 3500; i++) insert.run(`r${i}`, i, JSON.stringify({ id: `r${i}`, kind: "text", parentId: null }));
  live.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','card',9999,'bot','options','x',?)").run(JSON.stringify(openOptions("card", "req-1")));
  live.exec("DELETE FROM open_card; DELETE FROM transcript_index_state");
  live.exec("COMMIT");
  closeDatabase(); calls.length = 0;
  database();
  expect(calls.filter(c => c.method === "indexing"), "no index note: the open reads no history").toEqual([]);
  expect(readIndexState(database(), "open_card").done, "not yet filled").toBe(0);
  expect(openRequestCards("t", 5).map(row => row.message.id), "but the approval is found").toEqual(["card"]);
  finishBackgroundUpgradeWorkNow();
  expect(readIndexState(database(), "open_card").done).toBe(1);
  expect(database().prepare("SELECT id FROM open_card").all().map(r => r.id)).toEqual(["card"]);
});

it("S1: a fresh or fully indexed file writes no index note at all", () => {
  database(); closeDatabase(); calls.length = 0;
  database();
  expect(calls.map(c => c.method)).toEqual(["done"]);
});

it("S1: lineage repair keeps its working memory linear: no set copy per output (N and 2N peaks differ by about 2x, not 4x)", windowsNightly(), () => {
  const peakFor = (n: number) => {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    setMemoryMode("active"); reconcileMemoryRoster(roster);
    chainThread("chat", n, "B1");
    const stats = { peakRetained: 0 };
    const roots = legacyReplyRoots(database(), "chat", { stats });
    return { stats, roots, n };
  };
  const small = peakFor(1500), big = peakFor(3000);
  expect(small.stats.peakRetained).toBeLessThanOrEqual(3 * 1500 + 16);
  expect(big.stats.peakRetained).toBeLessThanOrEqual(3 * 3000 + 16);
  expect(big.stats.peakRetained / small.stats.peakRetained).toBeLessThan(2.6);
  expect(big.roots.size).toBe(2999);
});

it("S1: the sets the repair stores are exactly what they were: each reply rests on every output above it", () => {
  const ids = chainThread("chat", 40, "B1");
  const roots = legacyReplyRoots(database(), "chat");
  for (let i = 1; i < ids.length; i++) {
    // the id is an opaque key (a chain derived from the parent set and the added output); what a reply rests on is its members
    const members = rootSetMembers(database(), roots.get(ids[i]!)!);
    expect([...(members ?? [])].sort(), `reply ${i}`).toEqual(ids.slice(0, i).map(id => keyOf("chat", id)).sort());
  }
  expect(roots.has(ids[0]!)).toBe(false);
});

it("S1: the repair reports per-thread progress, records each finished thread, and resumes after an interruption", () => {
  chainThread("a", 6, "BA"); chainThread("b", 6, "BB"); chainThread("c", 6, "BC");
  const db = legacyFile(database()); // a 1.0.1-shaped file: v10 never has this repair pending
  db.exec("DELETE FROM memory_output_roots; DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  expect(lineageRepairPending(db)).toBe(true);
  // thread "b" fails its write: "a" is finished and recorded, nothing after it ran
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON memory_output_roots WHEN NEW.thread_id='b' BEGIN SELECT RAISE(ABORT,'boom'); END");
  const firstRun: Array<{ done: number; total: number }> = [];
  expect(() => repairOutputRootBackfill(db, { onProgress: p => firstRun.push(p) })).toThrow("boom");
  expect(firstRun[0]).toEqual({ done: 0, total: 3 });
  expect(db.prepare("SELECT name FROM transcript_index_state WHERE name LIKE 'lineage_repair:%' AND done=1").all().map(r => r.name)).toEqual(["lineage_repair:a"]);
  expect(db.prepare("SELECT count(*) AS n FROM memory_output_roots WHERE thread_id='a'").get()?.n).toBe(5);
  expect(lineageRepairPending(db)).toBe(true);
  db.exec("DROP TRIGGER boom");
  // a restart (a new connection, nothing in memory) trusts the finished thread at once and nobody else
  setRepairRunnerForTest(() => undefined); // the open would heal everything on its own; hold it back to look at the interrupted state
  const reopened = restartLegacy();
  setRepairRunnerForTest(null);
  expect(ancestryThreadRepaired(reopened, "a")).toBe(true);
  expect(ancestryThreadRepaired(reopened, "b")).toBe(false);
  const secondRun: Array<{ done: number; total: number }> = [];
  const result = repairOutputRootBackfill(reopened, { onProgress: p => secondRun.push(p) });
  expect(secondRun[0], "resumed after thread a").toEqual({ done: 1, total: 3 });
  expect(secondRun.at(-1)).toEqual({ done: 3, total: 3 });
  expect(result.threads, "a was not repaired again").toBe(2);
  expect(lineageRepairPending(reopened)).toBe(false);
  expect(reopened.prepare("SELECT count(*) AS n FROM transcript_index_state WHERE name LIKE 'lineage_repair:%'").get()?.n).toBe(0);
  for (const thread of ["a", "b", "c"]) expect(reopened.prepare("SELECT count(*) AS n FROM memory_output_roots WHERE thread_id=?").get(thread)?.n).toBe(5);
});

it("S1 (fast upgrade): a restart finds no output-root repair to run on a v10 file: nothing is withheld by it, nothing is announced, and no root set is written", () => {
  // v10: the repair that this test drove (withheld from the first moment, finished in the background) is retired. An upgraded file's replay is held by
  // the write-time certificate instead (memory_lineage_cert, lineage-backfill.ts); the 1.0.1-shaped repair is exercised above on a legacyFile.
  chainThread("a", 6, "BA"); chainThread("b", 6, "BB");
  const db = database();
  db.exec("DELETE FROM memory_output_roots; DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  expect(lineageRepairPending(db)).toBe(false);
  closeDatabase(); calls.length = 0;
  const reopened = database();
  expect(ancestryUnrepaired(reopened), "no repair to wait for").toBe(false);
  expect(calls.map(c => c.method)).not.toContain("repairing");
  expect(lineageRepairPending(reopened)).toBe(false);
  finishBackgroundUpgradeWorkNow();
  expect(reopened.prepare("SELECT count(*) AS n FROM memory_output_roots").get()?.n).toBe(0);
  expect(lineageRepairPending(reopened)).toBe(false);
  expect(ancestryUnrepaired(reopened)).toBe(false);
});

/** Puts the file back to "repair not yet done" so repairOutputRootBackfill runs on what a test just inserted. */
function resetRepair(db: DatabaseSync) {
  db.exec("DELETE FROM memory_output_roots; DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
}
const sortedKeys = (thread: string, ids: string[]) => ids.map(id => keyOf(thread, id)).sort();

it("P1 r1: repairing one long thread is linear (10k vs 20k outputs), every reply rests on exactly the outputs above it, and no set is a copy", async () => {
  // Work is counted, not timed: statement executions and rows read while the repair runs. Wall time on a shared machine swings by more than the bound.
  const runFor = async (n: number) => {
    closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    setMemoryMode("active"); reconcileMemoryRoster(roster);
    const ids = chainThread("chat", n, "B1");
    const db = database();
    resetRepair(db);
    const work = { statements: 0, rows: 0 };
    const original = db.prepare.bind(db), originalExec = db.exec.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const statement = original(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        return (...a: unknown[]) => {
          if (key === "run" || key === "get" || key === "all") work.statements++;
          const out = (value as (...x: unknown[]) => unknown).apply(target, a);
          if (key === "all" && Array.isArray(out)) work.rows += out.length; else if (key === "get" && out) work.rows++;
          return out;
        };
      } });
    };
    (db as unknown as { exec: unknown }).exec = (sql: string) => { work.statements++; return originalExec(sql); };
    let result: ReturnType<typeof repairOutputRootBackfill>;
    try { result = repairOutputRootBackfill(db); } finally { (db as unknown as { prepare: unknown }).prepare = original; (db as unknown as { exec: unknown }).exec = originalExec; }
    return { work, ids, db, result };
  };
  const small = await runFor(10_000);
  const big = await runFor(20_000);
  expect(big.work.statements / small.work.statements, `10k ${JSON.stringify(small.work)}, 20k ${JSON.stringify(big.work)}`).toBeLessThan(2.5);
  expect(big.work.rows / Math.max(1, small.work.rows), `10k ${JSON.stringify(small.work)}, 20k ${JSON.stringify(big.work)}`).toBeLessThan(2.5);
  const { db, ids } = big;
  // storage is one row per output: a copy per set would be N^2/2 member rows
  expect(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()?.n).toBe(ids.length - 1);
  expect(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n).toBe(ids.length - 1);
  expect(big.result.widened).toBe(ids.length - 1);
  // identical to the reference for random queries (and the two ends)
  const picks = [1, ids.length - 1, ...Array.from({ length: 12 }, (_, at) => 1 + ((at * 7919 + 13) % (ids.length - 1)))];
  for (const at of picks) {
    const set = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[at]!)?.set_id as string;
    expect([...(rootSetMembers(db, set) ?? [])].sort(), `reply ${at}`).toEqual(sortedKeys("chat", ids.slice(0, at)));
  }
}, 240_000);

it("P1 r1: a repair killed in the middle of one long thread resumes with the batches already committed", () => {
  const ids = chainThread("chat", 2_600, "B1");
  const db = database();
  resetRepair(db);
  db.exec("CREATE TABLE zz_inserted(size INTEGER)");
  db.exec("CREATE TRIGGER zz_count AFTER INSERT ON memory_root_sets BEGIN INSERT INTO zz_inserted VALUES(NEW.size); END");
  db.exec("CREATE TRIGGER zz_kill BEFORE INSERT ON memory_root_sets WHEN NEW.size=1700 BEGIN SELECT RAISE(ABORT,'killed'); END");
  expect(() => repairOutputRootBackfill(db, { checkpointMs: 0 })).toThrow("killed");
  const kept = Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n);
  expect(kept, "the batches before the kill are committed").toBeGreaterThanOrEqual(1_000);
  expect(kept).toBeLessThan(1_700);
  expect(db.prepare("SELECT 1 FROM transcript_index_state WHERE name='lineage_repair:chat'").get(), "the thread is not recorded finished").toBeUndefined();
  db.exec("DROP TRIGGER zz_kill; DELETE FROM zz_inserted");
  expect(repairOutputRootBackfill(db).threads).toBe(1);
  expect(Number(db.prepare("SELECT count(*) AS n FROM zz_inserted").get()?.n), "the committed sets are found in place, not written again").toBe(ids.length - 1 - kept);
  db.exec("DROP TRIGGER zz_count; DROP TABLE zz_inserted");
  for (const at of [1, 700, 1_699, 1_700, 2_599]) {
    const set = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[at]!)?.set_id as string;
    expect([...(rootSetMembers(db, set) ?? [])].sort(), `reply ${at}`).toEqual(sortedKeys("chat", ids.slice(0, at)));
  }
  expect(lineageRepairPending(db)).toBe(false);
});

it("P1 r1: merging widens a reply's older set without reading either set whole, keeps the progress note moving, and joins a stray member", () => {
  const ids = chainThread("chat", 1_800, "B1");
  const db = database();
  resetRepair(db);
  repairOutputRootBackfill(db);
  // each reply is given a different older set (one early output only, as a set stored by an earlier build): the repair must union it
  const early = storeRootSetFor(db, [keyOf("chat", ids[0]!)]);
  const stray = storeRootSetFor(db, [keyOf("chat", ids[0]!), keyOf("chat", "elsewhere")]);
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("UPDATE memory_output_roots SET set_id=? WHERE thread_id='chat'").run(early);
  db.prepare("UPDATE memory_output_roots SET set_id=? WHERE thread_id='chat' AND message_id=?").run(stray, ids[900]!);
  resetRepairMarkers(db);
  const reports: Array<{ done: number; total: number }> = [];
  repairOutputRootBackfill(db, { onProgress: progress => reports.push(progress) });
  expect(reports.some(report => report.done > 0 && report.done < 1), "the note moves inside the thread, during merges too").toBe(true);
  expect(reports.filter(report => report.done > 0 && report.done < 1).length).toBeGreaterThanOrEqual(6);
  for (const at of [1, 450, 899, 900, 901, 1_799]) {
    const set = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[at]!)?.set_id as string;
    const expected = sortedKeys("chat", ids.slice(0, at));
    if (at === 900) expected.push(keyOf("chat", "elsewhere"));
    expect([...(rootSetMembers(db, set) ?? [])].sort(), `reply ${at}`).toEqual(expected.sort());
  }
});
function storeRootSetFor(db: DatabaseSync, keys: string[]): string {
  const id = rootSetIdOf(keys);
  db.prepare("INSERT OR IGNORE INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, keys.length);
  for (const key of keys) { const at = key.indexOf("\u0000"); db.prepare("INSERT OR IGNORE INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES(?,?,?)").run(id, key.slice(0, at), key.slice(at + 1)); }
  return id;
}
const rootSetIdOf = (keys: string[]) => `rs-test:${[...keys].sort().join("|")}`;
function resetRepairMarkers(db: DatabaseSync) {
  db.exec("DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
}

it("P2 r1: a file with no scope records the repair as finished: the next start lists no receipts and announces no repair", () => {
  chainThread("a", 6, "BA");
  const db = legacyFile(database()); // a 1.0.1-shaped file (v10 never has a repair pending)
  resetRepair(db);
  db.exec("PRAGMA foreign_keys=OFF; DELETE FROM memory_scope_bindings; DELETE FROM memory_scopes; PRAGMA foreign_keys=ON");
  expect(db.prepare("SELECT count(*) AS n FROM memory_scopes").get()?.n).toBe(0);
  expect(lineageRepairPending(db)).toBe(true);
  repairOutputRootBackfill(db);
  expect(lineageRepairPending(db), "finished without a marker").toBe(false);
  expect(ancestryThreadRepaired(db, "a")).toBe(true);
  // second run: the receipts are not even enumerated
  const sql: string[] = [];
  const spy = new Proxy(db, { get(target, key) { const value = Reflect.get(target, key) as unknown; if (typeof value !== "function") return value;
    return (...args: unknown[]) => { if (key === "prepare") sql.push(String(args[0])); return (value as (...x: unknown[]) => unknown).apply(target, args); }; } });
  expect(repairOutputRootBackfill(spy).threads).toBe(0);
  expect(sql.filter(text => text.includes("memory_disclosure_outputs"))).toEqual([]);
  // and a start announces nothing
  calls.length = 0;
  restartLegacy();
  expect(calls.map(c => c.method)).not.toContain("repairing");
});

it("P2 r1: a heavy tail of rows since the last launch is announced, and validation keeps the note moving while it reads", () => {
  const db = database();
  const grow = (rows: number) => db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${rows})
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'G'||hex(randomblob(8)),'t','engine','S','[]','[]','[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1 FROM n`);
  grow(6_000);
  const seen = { full: 0, progress: 0 };
  const run = () => { seen.full = 0; seen.progress = 0; validateMemorySchema(db, { incrementalShapes: true, references: false, onFullRead: () => { seen.full++; }, onProgress: () => { seen.progress++; } }); };
  run(); // takes the marks
  run();
  expect(seen.full, "nothing new since the last launch: no note").toBe(0);
  grow(2_000);
  run();
  expect(seen.full, "a small tail is not announced").toBe(0);
  grow(120_000);
  run();
  expect(seen.full, "a tail of over a hundred thousand rows is announced once").toBe(1);
  expect(seen.progress, "and refreshed between slices").toBeGreaterThanOrEqual(2);
  // the full sweep (an outside file) is sliced too
  seen.full = 0; seen.progress = 0;
  validateMemorySchema(db, { onFullRead: () => { seen.full++; }, onProgress: () => { seen.progress++; } });
  expect(seen.full).toBe(1);
  expect(seen.progress).toBeGreaterThanOrEqual(3);
}, 240_000);

it("r3: the repair stops at its deadline: no thread is begun past it, it says so, the threads not reached stay unrepaired (withheld), and a later run finishes", () => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  chainThread("chat", 200, "B1");
  const db = legacyFile(database()); // a 1.0.1-shaped file (v10 never has a repair pending)
  resetRepair(db);
  const cut = repairOutputRootBackfill(db, { deadline: 0 });
  expect(cut.unfinished, "a run past its deadline reports what is left").toBe(true);
  expect(cut.threads).toBe(0);
  expect(lineageRepairPending(db)).toBe(true);
  expect(ancestryThreadRepaired(db, "chat")).toBe(false);
  const rest = repairOutputRootBackfill(db);
  expect(rest.unfinished).toBeUndefined();
  expect(rest.threads).toBe(1);
  expect(lineageRepairPending(db)).toBe(false);
});
