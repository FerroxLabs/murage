// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/setup reads the Chief's task conversations by index, never whole,
// and a poll that finds nothing changed reads nothing at all. The cost is the
// same with 10 task conversations as with 2,000.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { emptySetupState, nextSetupStep, setupIsFirstRun, setupStepDone, setupStepStatus, type SetupLiveState } from "../shared/setup.ts";
import { fillInboxProjection, initializeInbox, inboxProjectionReady, inboxProjectionSlice } from "./inbox.ts";
import { SetupChecklist, readWorkspace, setupThreadFacts, type SetupBotReading, type SetupMessageReading } from "./setup.ts";
import { SETUP_FACT_STATEMENTS, SetupThreadFactsCache, readSetupThreadFacts } from "./setup-thread-facts.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });
const HISTORY = 200;

function seed(tasks: number) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  // Every task conversation: a long history, then a settled reply; the last
  // one also holds a provider refusal newer than its reply.
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'task' || (i / ${HISTORY}), 'm' || i, i % ${HISTORY}, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, 'text', 'line ' || i,
      json_object('id','m' || i,'at',i % ${HISTORY},'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i,
        'turnTerminal',CASE WHEN i % ${HISTORY} = ${HISTORY - 1} THEN json('true') ELSE json('false') END)
    FROM n`).run(tasks * HISTORY - 1);
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(`task${tasks - 1}`, "refused", HISTORY + 5, "bot", "activity", null, JSON.stringify({ id: "refused", at: HISTORY + 5, role: "bot", kind: "activity", tool: { name: "error: 402", ok: false, providerError: { httpStatus: 402, provider: "anthropic" } } }));
  const chief: SetupBotReading = { id: "chief", threadId: "task0", modelSelection: { instanceId: "claude", model: "claude-opus" },
    tasks: Array.from({ length: tasks }, (_, i) => ({ threadId: `task${i}`, lastInstanceId: "claude" })) };
  return { db, chief };
}

/** Counts statement executions on a handle. */
function counting(db: DatabaseSync) {
  const counter = { statements: 0 };
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...a: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { counter.statements++; return original(...args); };
    }
    return statement;
  };
  return counter;
}

describe("setup reads the Chief's tasks by index", () => {
  it("agrees with the whole-conversation reading", () => {
    const { db } = seed(3);
    const whole = (threadId: string) => (db.prepare("SELECT json FROM messages WHERE thread_id=? ORDER BY rowid").all(threadId) as Array<{ json: string }>).map(row => JSON.parse(row.json) as SetupMessageReading);
    for (const thread of ["task0", "task2", "missing"]) expect(readSetupThreadFacts(db, thread)).toEqual(setupThreadFacts(whole(thread)));
    expect(readSetupThreadFacts(db, "task2").refusal).toEqual({ at: HISTORY + 5, refusal: { httpStatus: 402, provider: "anthropic" } });
  });

  it("costs the same at 10 and 2,000 task conversations, and nothing on a repeat poll", () => {
    const results: Array<{ cold: number; warm: number; reading: unknown }> = [];
    for (const tasks of [10, 2_000]) {
      const { db, chief } = seed(tasks);
      expect(inboxProjectionReady(db)).toBe(true);
      const cache = new SetupThreadFactsCache(db), counter = counting(db);
      let loads = 0;
      const workspace = { bots: [chief], threadFacts: (id: string) => cache.facts(id), messagesFor: () => { loads++; return []; }, routesThroughFlux: () => false };
      const reading = readWorkspace(workspace, "chief");
      const cold = counter.statements;
      for (let poll = 0; poll < 10; poll++) readWorkspace(workspace, "chief");
      results.push({ cold: cold / tasks, warm: counter.statements - cold, reading: { ...reading } });
      expect(loads, "no whole conversation is loaded").toBe(0);
      expect(reading.chiefRefusal).toEqual({ httpStatus: 402, provider: "anthropic" });
      expect(reading.chiefAnsweredBy).toEqual(["claude"]);
      // a write to one conversation re-reads that one only
      cache.touch("task0");
      const before = counter.statements;
      readWorkspace(workspace, "chief");
      expect(counter.statements - before).toBe(2);
    }
    // per task: the same two bounded lookups, whatever the count; repeat polls: none
    expect(results[1]!.cold).toBe(results[0]!.cold);
    expect(results[0]!.cold).toBe(2);
    expect(results[0]!.warm).toBe(0);
    expect(results[1]!.warm).toBe(0);
    expect(results[1]!.reading).toEqual(results[0]!.reading);
  });

  it("answers both facts with index seeks, never a scan of the conversation", () => {
    const { db } = seed(1);
    const plans: string[] = [];
    for (const [sql, args] of [[SETUP_FACT_STATEMENTS.answer, ["task0"]], [SETUP_FACT_STATEMENTS.refusal, ["task0", 5]]] as const) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(row => row.detail).join("\n");
      plans.push(plan);
      expect(plan).toMatch(/SEARCH setup_marks USING (COVERING )?INDEX/);
      expect(plan).not.toMatch(/SCAN (?!CONSTANT)/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
      expect(plan).not.toMatch(/USING INDEX messages_/);
      expect(plan).not.toMatch(/\bmessages\b/);
    }
    // the two settled-reply probes and the refusal probe each lead with the conversation
    expect(plans.join("\n")).toMatch(/thread_id=\? AND kind=\?/);
  });

  it("keeps the facts equal to the transcript through replacement, edit and deletion", () => {
    const { db } = seed(2);
    const whole = (threadId: string) => (db.prepare("SELECT json FROM messages WHERE thread_id=? ORDER BY rowid").all(threadId) as Array<{ json: string }>).map(row => JSON.parse(row.json) as SetupMessageReading);
    const agree = () => { for (const thread of ["task0", "task1"]) expect(readSetupThreadFacts(db, thread), thread).toEqual(setupThreadFacts(whole(thread))); };
    agree();
    // the settled reply replaced by a blank one (INSERT OR REPLACE, as the store writes)
    db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) SELECT thread_id,id,at,role,kind,'  ',json_set(json,'$.text','  ') FROM messages WHERE thread_id='task0' AND id='m199'").run();
    agree();
    expect(readSetupThreadFacts(db, "task0").answered).toBe(false);
    db.prepare("UPDATE messages SET text='back', json=json_set(json,'$.text','back') WHERE thread_id='task0' AND id='m199'").run();
    agree();
    expect(readSetupThreadFacts(db, "task0").answered).toBe(true);
    db.prepare("DELETE FROM messages WHERE thread_id='task1' AND id='refused'").run();
    agree();
    db.prepare("DELETE FROM messages WHERE thread_id='task1' AND id='m399'").run();
    agree();
  });

  it("costs the same for a conversation of 50,000 messages as of 100, found or not", () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
    initializeInbox(db);
    db.exec("BEGIN");
    for (const [thread, count, reply] of [["short", 100, "none"], ["longNone", 50_000, "none"], ["longFirst", 50_000, "first"], ["longLast", 50_000, "last"], ["shortLast", 100, "last"]] as const) {
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?2)
        INSERT INTO messages(thread_id,id,at,role,kind,text,json)
        SELECT ?1, 'm' || i, i, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, 'text', 'line ' || i,
          json_object('id','m' || i,'at',i,'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i,
            'turnTerminal',CASE WHEN (?3='first' AND i=1) OR (?3='last' AND i=?2-1) THEN json('true') ELSE json('false') END)
        FROM n`).run(thread, count, reply);
    }
    db.exec("COMMIT");
    const time = (thread: string) => { const started = performance.now(); for (let i = 0; i < 200; i++) readSetupThreadFacts(db, thread); return (performance.now() - started) / 200; };
    const flat = time("short"), none = time("longNone"), first = time("longFirst"), last = time("longLast");
    console.log(`[setup-facts] per read: 100 msgs=${flat.toFixed(4)} ms, 50k none=${none.toFixed(4)}, 50k first=${first.toFixed(4)}, 50k last=${last.toFixed(4)}`);
    for (const long of [none, first, last]) expect(long).toBeLessThan(flat * 5 + 0.05);
    expect(readSetupThreadFacts(db, "longNone")).toMatchObject({ answered: false, answeredAt: -1 });
    expect(readSetupThreadFacts(db, "longFirst")).toMatchObject({ answered: true, answeredAt: 1 });
    expect(readSetupThreadFacts(db, "longLast")).toMatchObject({ answered: true, answeredAt: 49_999 });
  }, 60_000);

  it("reads 2,000 conversations of 1,500 messages in the time of 10", () => {
    const cold: number[] = [];
    for (const tasks of [10, 2_000]) {
      const db = new DatabaseSync(":memory:"); databases.push(db);
      db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
      initializeInbox(db);
      db.exec("BEGIN");
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i <= ?)
        INSERT INTO messages(thread_id,id,at,role,kind,text,json)
        SELECT 'task' || (i / 1500), 'm' || i, i % 1500, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, 'text', 'line ' || i,
          json_object('id','m' || i,'at',i % 1500,'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i,
            'turnTerminal',CASE WHEN i % 1500 = 1499 THEN json('true') ELSE json('false') END)
        FROM n`).run(tasks * 1500 - 1);
      db.exec("COMMIT");
      const chief: SetupBotReading = { id: "chief", threadId: "task0", modelSelection: { instanceId: "claude", model: "claude-opus" },
        tasks: Array.from({ length: tasks }, (_, i) => ({ threadId: `task${i}`, lastInstanceId: "claude" })) };
      const cache = new SetupThreadFactsCache(db);
      const started = performance.now();
      const reading = readWorkspace({ bots: [chief], threadFacts: id => cache.facts(id), routesThroughFlux: () => false }, "chief");
      cold.push((performance.now() - started) / tasks);
      expect(reading.chiefAnsweredBy).toEqual(["claude"]);
    }
    console.log(`[setup-facts] cold readWorkspace per task: 10 tasks=${cold[0]!.toFixed(4)} ms, 2,000 tasks=${cold[1]!.toFixed(4)} ms`);
    expect(cold[1]!).toBeLessThan(cold[0]! * 3 + 0.05);
  }, 120_000);
});


// A PARTIAL FILL IS NEVER TREATED AS THE TRUTH. While the first fill is still
// reading an old history, a conversation's marks are only the ones the fill
// has reached and the ones written since. A refusal the fill has reached whose
// recovery it has not is an obsolete fact: reporting it re-opened a settled
// key card. A fact is KNOWN when the fill is done or a write after the upgrade
// (above the high-water rowid) decided it; otherwise it is UNKNOWN, and setup
// keeps the persisted step exactly as it was.
describe("setup facts while the first fill is partial", () => {
  const FLUX_SAVED = { configured: true, conflict: false, looksValid: true };
  const baseLive = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
    ownerName: "Sean", agents: [{ id: "fuigo", name: "Fuigo", installed: false } as never], signedOutAgents: [], flux: FLUX_SAVED, bundledEngine: { ready: true } as never,
    chiefInstanceId: "", chiefAnsweredBy: [], chiefRefusal: null, chiefUsesFlux: false, crewSize: 1, connectedApps: 0, connectedAppIds: [], botReplyExists: false,
    routines: { total: 0, briefId: null, briefRan: false }, ...patch,
  });

  /** A big history; the Chief's thread holds an old Flux 402, then (much later in storage order) a successful reply. */
  function astra(filler: number) {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
    const lines = (from: number, to: number) => db.prepare(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i < ?)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT 'other' || (i / 100), 'f' || i, i, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, 'text', 'line ' || i,
        json_object('id','f' || i,'at',i,'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i) FROM n`).run(from, to - 1);
    const put = (id: string, at: number, kind: string, text: string | null, body: Record<string, unknown>) =>
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chief',?,?,'bot',?,?,?)").run(id, at, kind, text, JSON.stringify({ id, at, role: "bot", kind, ...(text ? { text } : {}), ...body }));
    lines(0, filler);
    put("refused", 1_000, "activity", null, { tool: { name: "error: 402", ok: false, providerError: { httpStatus: 402, provider: "flux-router" } } });
    const refusedRow = (db.prepare("SELECT rowid AS r FROM messages WHERE id='refused'").get() as { r: number }).r;
    lines(filler, filler * 2);
    put("recovered", 2_000, "text", "All set", { turnTerminal: true });
    const recoveredRow = (db.prepare("SELECT rowid AS r FROM messages WHERE id='recovered'").get() as { r: number }).r;
    lines(filler * 2, filler * 3);
    initializeInbox(db); // the upgrade: messages exist, the fill has not run
    const chief: SetupBotReading = { id: "chief", threadId: "chief", modelSelection: { instanceId: "fuigo", model: "flux/x" }, tasks: [{ threadId: "chief", lastInstanceId: "fuigo" }] };
    return { db, chief, put, refusedRow, recoveredRow };
  }
  const reading = (cache: SetupThreadFactsCache, chief: SetupBotReading) => readWorkspace({ bots: [chief], threadFacts: id => cache.facts(id), routesThroughFlux: () => true }, "chief");

  it("keeps a settled Flux step settled when the fill has reached the old 402 and not the recovery, writes nothing, and reports a new 402 at once", () => {
    const { db, chief, put, refusedRow, recoveredRow } = astra(20_000);
    const directory = mkdtempSync(join(tmpdir(), "murage-setup-partial-"));
    try {
      const file = join(directory, "setup.json");
      // The settled state, as the complete history left it: the key is saved and nothing is refusing.
      const checklist = new SetupChecklist(file);
      checklist.read(baseLive());
      expect(checklist.read(baseLive()).steps.flux.done).toBe(true);
      const persisted = checklist.read(baseLive());
      const written = { text: readFileSync(file, "utf8"), ino: statSync(file).ino, mtime: statSync(file).mtimeMs };

      // The fill stops between the refusal and the recovery.
      while ((db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='inbox'").get() as { cursor: number }).cursor < refusedRow) inboxProjectionSlice(db, { rows: 1_000 });
      expect((db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='inbox'").get() as { cursor: number }).cursor).toBeLessThan(recoveredRow);
      expect(inboxProjectionReady(db)).toBe(false);
      expect((db.prepare("SELECT COUNT(*) AS n FROM setup_marks WHERE kind='refusal' AND thread_id='chief'").get() as { n: number }).n, "the fill reached the refusal").toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM setup_marks WHERE kind='reply' AND thread_id='chief'").get() as { n: number }).n, "and not the recovery").toBe(0);

      const cache = new SetupThreadFactsCache(db);
      const partial = reading(cache, chief);
      const live = baseLive({ ...partial });
      expect(partial.chiefRefusal, "an obsolete refusal is not reported").toBeNull();
      expect(setupStepDone("flux", persisted.steps.flux, live)).toBe(true);
      const state = new SetupChecklist(file).read(live);
      expect(state.steps.flux.done).toBe(true);
      expect(setupStepStatus("flux", state.steps.flux, live)).toBe("done");
      expect(nextSetupStep(state)).not.toBe("flux");
      expect({ text: readFileSync(file, "utf8"), ino: statSync(file).ino, mtime: statSync(file).mtimeMs }, "no state was written").toEqual(written);
      // and it does not look like a first run to a workspace whose answers are not all read yet
      expect(setupIsFirstRun(emptySetupState(0), baseLive({ ...partial, ownerName: "", flux: { configured: false, conflict: false, looksValid: false }, crewSize: 0 }))).toBe(false);
      expect(setupIsFirstRun(emptySetupState(0), baseLive({ ownerName: "", flux: { configured: false, conflict: false, looksValid: false }, crewSize: 0 }))).toBe(true);
      // nothing unknown is cached: asking again is still unknown
      expect(cache.facts("chief")).toMatchObject({ known: false });

      // A NEW 402 on a conversation with nothing waiting unprojected is KNOWN at once, and blocks even
      // while another task is still unknown. The same 402 on the unfinished conversation is not certain
      // (its recovery is unprojected), so setup keeps the persisted state.
      put("refused-now", 3_000, "activity", null, { tool: { name: "error: 402", ok: false, providerError: { httpStatus: 402, provider: "flux-router" } } });
      cache.touch("chief");
      expect(reading(cache, chief).chiefRefusal, "unfinished conversation: not certain").toBeNull();
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('fresh','refused-fresh',3000,'bot','activity',NULL,?)")
        .run(JSON.stringify({ id: "refused-fresh", at: 3_000, role: "bot", kind: "activity", tool: { name: "error: 402", ok: false, providerError: { httpStatus: 402, provider: "flux-router" } } }));
      const withFresh: SetupBotReading = { ...chief, tasks: [...(chief.tasks ?? []), { threadId: "fresh", lastInstanceId: "fuigo" }] };
      cache.touch("chief"); cache.touch("fresh");
      const nowReading = reading(cache, withFresh);
      expect(nowReading.chiefRefusal).toEqual({ httpStatus: 402, provider: "flux-router" });
      expect(nowReading).toHaveProperty("threadFactsUnknown", true);
      expect(setupStepDone("flux", persisted.steps.flux, baseLive({ ...nowReading, chiefUsesFlux: true }))).toBe(false);

      // Once the fill is done every fact is complete, and the recovery is projected: the later 402 still wins (newest), the old one does not.
      fillInboxProjection(db);
      cache.touch("chief");
      expect(cache.facts("chief")).toMatchObject({ answered: true, answeredAt: 2_000, refusal: { at: 3_000 } });
      expect(cache.facts("chief")).not.toHaveProperty("known");
    } finally { removeTempDirSync(directory); }
  }, 120_000);

  it("is complete again, and unchanged from the complete reading, once the fill is done", () => {
    const { db, chief, refusedRow } = astra(5_000);
    while ((db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='inbox'").get() as { cursor: number }).cursor < refusedRow) inboxProjectionSlice(db, { rows: 1_000 });
    const cache = new SetupThreadFactsCache(db);
    expect(reading(cache, chief).chiefRefusal).toBeNull();
    fillInboxProjection(db);
    const done = reading(cache, chief);
    expect(done.chiefRefusal, "the recovery is newer than the 402").toBeNull();
    expect(done.chiefAnsweredBy).toEqual(["fuigo"]);
    expect(done).not.toHaveProperty("threadFactsUnknown", true);
  });
});
