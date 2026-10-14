// SPDX-License-Identifier: AGPL-3.0-or-later
// hotpath round r4 (closes Astra r3c): a row the slice budget cannot admit is
// never read on the main thread; a thread's setup facts are KNOWN exactly when
// no row of it waits unprojected; a KNOWN refusal blocks whatever other
// threads are still unknown.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { setupStepBlock, setupStepDone, type SetupLiveState } from "../shared/setup.ts";
import { inboxDeferredDrain } from "./inbox-fill-worker.ts";
import { INBOX_DEFERRED_SQL, drainInboxDeferredInline, initializeInbox, inboxProjectionReady, inboxProjectionSlice, startInboxProjectionFill } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { readWorkspace, type SetupBotReading } from "./setup.ts";
import { SETUP_FACT_STATEMENTS, SetupThreadFactsCache, readSetupThreadFacts } from "./setup-thread-facts.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
const memory = () => { const db = new DatabaseSync(":memory:"); databases.push(db); initializeMessageTables(db); return db; };
function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "murage-r4-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
  initializeMessageTables(db);
  return db;
}
const cursorOf = (db: DatabaseSync) => (db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='inbox'").get() as { cursor: number }).cursor;
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

/** Rows that are admitted are charged 60 ms/MiB by the fill's insert; a row the budget diverts is not read by it. */
function slowDisk(db: DatabaseSync, msPerMiB: number): DatabaseSync {
  const burn = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* a slow read */ } };
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("INSERT OR IGNORE INTO inbox_raw")) return statement;
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "run") {
              return (from: number, to: number, budget?: number) => {
                const { bytes } = target.prepare("SELECT COALESCE(SUM(octet_length(json)),0) AS bytes FROM messages WHERE rowid>? AND rowid<=? AND octet_length(json)+256<=?").get(from, to, budget ?? Number.MAX_SAFE_INTEGER) as { bytes: number };
                burn(bytes / 1048576 * msPerMiB);
                return (inner.run as (...a: unknown[]) => unknown)(...(budget === undefined ? [from, to] : [from, to, budget]));
              };
            }
            const member = Reflect.get(inner, name) as unknown;
            return typeof member === "function" ? member.bind(inner) : member;
          },
        });
      };
    },
  });
}

const refusal = (id: string, at: number, output = "") => JSON.stringify({ id, at, role: "bot", kind: "activity", tool: { name: "run", ok: false, providerError: { httpStatus: 402, provider: "flux-router" }, output } });
const insertRow = (db: DatabaseSync, thread: string, id: string, at: number, kind: string, text: string | null, json: string, verb = "INSERT") =>
  db.prepare(`${verb} INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot',?,?,?)`).run(thread, id, at, kind, text, json);
const reply = (id: string, at: number) => JSON.stringify({ id, at, role: "bot", kind: "text", text: "All set", turnTerminal: true });
const filler = (db: DatabaseSync, from: number, to: number, thread = "other") =>
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i < ?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ? || (i / 100), 'f' || i, i, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, 'text', 'line ' || i,
      json_object('id','f' || i,'at',i,'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i) FROM n`).run(from, to - 1, thread);

describe("r4 P1#1: rows the budget cannot admit never reach the main thread", () => {
  for (const [label, budget] of [["64 KiB", 64 * 1024], ["512 KiB", 512 * 1024]] as const) {
    it(`consecutive 8 MiB tool rows at the ${label} budget: every main-thread slice under 50 ms on the slow-disk model`, () => {
      const db = memory();
      for (let i = 0; i < 4; i++) insertRow(db, `t${i}`, `big${i}`, 1_800_000_000_000 + i, "activity", null, refusal(`big${i}`, 1_800_000_000_000 + i, "x".repeat(8 * 1024 * 1024)));
      initializeInbox(db);
      const proxy = slowDisk(db, 60);
      const times: number[] = [];
      for (let i = 0; i < 4; i++) { const started = performance.now(); inboxProjectionSlice(proxy, { rows: 10_000, weight: budget }); times.push(performance.now() - started); }
      console.log(`[r4-huge] ${label}: slices ${times.map(t => t.toFixed(1)).join(", ")} ms`);
      expect(Math.max(...times)).toBeLessThan(50);
      expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred"), "every huge row is deferred").toBe(4);
      expect(count(db, "SELECT COUNT(*) AS n FROM inbox_raw"), "and none was read here").toBe(0);
    }, 60_000);
  }

  it("the worker projects them, and the fill is done only after the deferred table is empty", async () => {
    const db = fileDb();
    for (let i = 0; i < 4; i++) insertRow(db, `t${i}`, `big${i}`, 1_800_000_000_000 + i, "activity", null, refusal(`big${i}`, 1_800_000_000_000 + i, "x".repeat(8 * 1024 * 1024)));
    filler(db, 0, 2_000);
    initializeInbox(db);
    const fill = startInboxProjectionFill(slowDisk(db, 60));
    expect(await fill.done).toEqual({ filled: true });
    console.log(`[r4-worker] slices=${fill.stats.slices} max=${fill.stats.maxSliceMs.toFixed(1)} ms`);
    expect(fill.stats.maxSliceMs).toBeLessThan(50);
    expect(inboxProjectionReady(db)).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks WHERE kind='refusal'")).toBe(4);
  }, 120_000);
});

describe("r4 P1#1: a deferred row is applied exactly", () => {
  const huge = (id: string, at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ id, at, role: "bot", kind: "activity", tool: { name: "run", ok: false, providerError: { httpStatus: 402, provider: "flux-router" }, output: "x".repeat(300 * 1024), ...extra } });
  function deferredOne() {
    const db = memory();
    insertRow(db, "t", "big", 1_000, "activity", null, huge("big", 1_000));
    initializeInbox(db);
    inboxProjectionSlice(db, { rows: 10_000, weight: 64 * 1024 });
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks")).toBe(0);
    const row = db.prepare("SELECT rowid AS r, json FROM messages WHERE id='big'").get() as { r: number; json: string };
    // the worker has read and projected the row (outside the lock) and not yet applied it
    const drain = inboxDeferredDrain(db, INBOX_DEFERRED_SQL);
    expect(drain.stage()).toBe(true);
    return { db, row, drain };
  }
  const staleApply = (drain: { step(): boolean }) => { drain.step(); };

  it("projects the row it read when nothing was written since", () => {
    const { db, row } = deferredOne();
    drainInboxDeferredInline(db);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks WHERE source_row=" + row.r)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_raw")).toBe(1);
  });

  it("an in-place rewrite between the read and the apply stands: the stale apply is a no-op", () => {
    const { db, drain } = deferredOne();
    // the row stops being a refusal; the triggers drop its mark, a stale apply must not bring it back
    db.prepare("UPDATE messages SET json=? WHERE id='big'").run(JSON.stringify({ id: "big", at: 1_000, role: "bot", kind: "activity", tool: { name: "run", ok: true } }));
    staleApply(drain);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_raw"), "the stale json would have projected one").toBe(0);
  });

  it("an INSERT OR REPLACE between the read and the apply stands: the old rowid is gone, nothing is added for it", () => {
    const { db, row, drain } = deferredOne();
    insertRow(db, "t", "big", 1_000, "activity", null, JSON.stringify({ id: "big", at: 1_000, role: "bot", kind: "activity", tool: { name: "run", ok: true } }), "INSERT OR REPLACE");
    staleApply(drain);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_raw WHERE source_row=" + row.r)).toBe(0);
    drainInboxDeferredInline(db);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks")).toBe(0);
  });

  it("a deleted row leaves no item, and deleting its conversation removes its deferred entry", () => {
    const { db } = deferredOne();
    db.prepare("DELETE FROM messages WHERE thread_id='t'").run();
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(0);
    drainInboxDeferredInline(db);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_raw")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks")).toBe(0);
  });

  it("a thread with a deferred row is UNKNOWN until the worker has projected it", () => {
    const db = memory();
    insertRow(db, "t", "refused", 1_000, "activity", null, refusal("refused", 1_000));
    insertRow(db, "t", "recovered", 2_000, "text", "All set", JSON.stringify({ id: "recovered", at: 2_000, role: "bot", kind: "text", text: "All set", turnTerminal: true, pad: "x".repeat(300 * 1024) }));
    initializeInbox(db);
    inboxProjectionSlice(db, { rows: 10_000, weight: 64 * 1024 }); // the refusal is admitted, the recovery deferred
    inboxProjectionSlice(db, { rows: 10_000, weight: 64 * 1024 }); // nothing follows: the fill waits for the deferred row
    expect(inboxProjectionReady(db)).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(1);
    expect(readSetupThreadFacts(db, "t")).toMatchObject({ known: false, refusal: null });
    drainInboxDeferredInline(db);
    inboxProjectionSlice(db, { rows: 10_000, weight: 64 * 1024 });
    expect(inboxProjectionReady(db)).toBe(true);
    expect(readSetupThreadFacts(db, "t")).toMatchObject({ answered: true, refusal: null });
  });
});

describe("r4 P1#2/#3: facts are KNOWN exactly when no row of the thread waits unprojected", () => {
  const baseLive = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
    ownerName: "Sean", agents: [{ id: "fuigo", name: "Fuigo", installed: false } as never], signedOutAgents: [], flux: { configured: true, conflict: false, looksValid: true }, bundledEngine: { ready: true } as never,
    chiefInstanceId: "", chiefAnsweredBy: [], chiefRefusal: null, chiefUsesFlux: true, crewSize: 1, connectedApps: 0, connectedAppIds: [], botReplyExists: false,
    routines: { total: 0, briefId: null, briefRan: false }, ...patch,
  });
  const chiefOf = (...threads: string[]): SetupBotReading => ({ id: "chief", threadId: threads[0]!, modelSelection: { instanceId: "fuigo", model: "flux/x" }, tasks: threads.map(threadId => ({ threadId, lastInstanceId: "fuigo" })) });
  const read = (cache: SetupThreadFactsCache, chief: SetupBotReading) => readWorkspace({ bots: [chief], threadFacts: id => cache.facts(id), routesThroughFlux: () => true }, "chief");
  const settled = { done: true } as never;

  /** The Chief's big task: an old 402, then (later in storage) its recovery; filler around them. The fill stops between the two. */
  function upgraded(fill = 5_000) {
    const db = memory();
    filler(db, 0, fill);
    insertRow(db, "big", "refused", 1_000, "activity", null, refusal("refused", 1_000));
    const refusedRow = (db.prepare("SELECT rowid AS r FROM messages WHERE id='refused'").get() as { r: number }).r;
    filler(db, fill, fill * 2);
    insertRow(db, "big", "recovered", 2_000, "text", "All set", reply("recovered", 2_000));
    const recoveredRow = (db.prepare("SELECT rowid AS r FROM messages WHERE id='recovered'").get() as { r: number }).r;
    filler(db, fill * 2, fill * 3);
    initializeInbox(db);
    while (cursorOf(db) < refusedRow) inboxProjectionSlice(db, { rows: 1_000 });
    expect(cursorOf(db)).toBeLessThan(recoveredRow);
    return { db, refusedRow, recoveredRow };
  }

  it("a post-upgrade 402 on one Chief task blocks setup even while another task is UNKNOWN", () => {
    const { db } = upgraded();
    insertRow(db, "fresh", "refused-now", 3_000, "activity", null, refusal("refused-now", 3_000));
    const chief = chiefOf("big", "fresh");
    const cache = new SetupThreadFactsCache(db);
    const reading = read(cache, chief);
    expect(reading.threadFactsUnknown, "the big task is still unknown").toBe(true);
    expect(reading.chiefRefusal).toEqual({ httpStatus: 402, provider: "flux-router" });
    const live = baseLive({ ...reading });
    expect(setupStepDone("flux", settled, live)).toBe(false);
    expect(setupStepBlock("flux", settled, live)?.reason).toBe("payment-required");
  });

  it("INSERT OR REPLACE of a historical 402 with its recovery unfilled does not change settled Flux", () => {
    const { db, recoveredRow } = upgraded();
    // the store rewrites the old refusal: new rowid, the old `at`
    insertRow(db, "big", "refused", 1_000, "activity", null, refusal("refused", 1_000), "INSERT OR REPLACE");
    const chief = chiefOf("big");
    const cache = new SetupThreadFactsCache(db);
    const reading = read(cache, chief);
    expect(reading.chiefRefusal, "an obsolete refusal is not reported").toBeNull();
    expect(setupStepDone("flux", settled, baseLive({ ...reading }))).toBe(true);
    expect(readSetupThreadFacts(db, "big")).toMatchObject({ known: false });
    // the fill reaches the recovery: the thread is known, and the recovery wins
    while (cursorOf(db) < recoveredRow) inboxProjectionSlice(db, { rows: 1_000 });
    const known = readSetupThreadFacts(db, "big");
    expect(known).not.toHaveProperty("known");
    expect(known).toMatchObject({ answered: true, answeredAt: 2_000, refusal: null });
  });

  it("the KNOWN check reads O(1) index entries with 200k pre-upgrade marks", () => {
    const db = memory();
    db.exec("BEGIN");
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 200000)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT 'chief', 'm' || i, i, 'bot', 'text', 'line ' || i, json_object('id','m' || i,'at',i,'role','bot','kind','text','text','line ' || i,'turnTerminal',json('true')) FROM n`).run();
    db.exec("COMMIT");
    filler(db, 0, 20_000);
    initializeInbox(db);
    while (cursorOf(db) < 200_000) inboxProjectionSlice(db, { rows: 20_000 });
    expect(inboxProjectionReady(db)).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks WHERE thread_id='chief'")).toBe(200_000);
    expect(readSetupThreadFacts(db, "chief"), "no row of the thread waits: known").not.toHaveProperty("known");
    const started = performance.now();
    for (let i = 0; i < 100; i++) readSetupThreadFacts(db, "chief");
    const per = (performance.now() - started) / 100;
    console.log(`[r4-known] per read with 200k marks: ${per.toFixed(4)} ms`);
    expect(per).toBeLessThan(0.5);
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]) as Array<{ detail: string }>).map(row => row.detail).join("\n");
    const statements = SETUP_FACT_STATEMENTS as unknown as Record<string, string>;
    const detail = plan(statements.unprojected!, "chief", 0, 1);
    expect(detail).toMatch(/SEARCH messages USING (COVERING )?INDEX messages_thread \(thread_id=\? AND rowid>\? AND rowid<\?\)/);
    expect(plan(statements.deferred!, "chief")).toMatch(/SEARCH inbox_fill_deferred/);
  }, 120_000);
});
