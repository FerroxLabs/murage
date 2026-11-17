import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { initializeReplySchema } from "./tts/reply-schema.ts";
import { ReplyState, speechTransaction } from "./tts/reply-state.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeBotCalls } from "./bot-calls-schema.ts";
import { drainOwed, markTurnCall, settleTurnOwed } from "./bot-calls-machine.ts";
import { createBotCallsRuntime } from "./bot-calls-runtime.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { deleteContinuationRecord, readContinuationRecord } from "./decision/records.ts";
import { BACKGROUND_BUSY_MS, setBusy } from "./db-busy.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "room-cleanup-"));
  cleanups.push(() => removeTempDirSync(dir));
  const file = join(dir, "state.sqlite"), db = new DatabaseSync(file), lock = new DatabaseSync(file);
  cleanups.push(() => db.close(), () => { if (lock.isTransaction) lock.exec("ROLLBACK"); lock.close(); });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000");
  initializeReplySchema(db); initializeMessageTables(db); initializeBotCalls(db);
  const state = new ReplyState({ db: () => db, transaction: speechTransaction(db) }); state.boot();
  return { db, lock, state };
}

it.each([1, 16, 256])("already retired speech and unmarked calls need no writer after %s completed turns", history => {
  const { db, lock, state } = fixture();
  for (let i = 0; i < history; i++) {
    state.begin("thread", "bot", `generation-${i}`, "prompt");
    state.invalidateGeneration("thread", `generation-${i}`);
  }
  lock.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  expect(() => state.invalidateGeneration("thread", "generation-0")).not.toThrow();
  expect(settleTurnOwed(db, "unmarked", 1)).toBe(false);
  expect(performance.now() - started).toBeLessThan(500);
  expect(db.isTransaction).toBe(false);
});

it("a blocked speech retirement quarantines immediately and recovers durably before speech reopens", () => {
  const { db, lock, state } = fixture();
  state.begin("thread", "bot", "running", "prompt"); state.bind("running", "provider");
  lock.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  expect(() => state.invalidateGeneration("thread", "running")).toThrow("durable_stop_failed");
  expect(performance.now() - started).toBeLessThan(500);
  expect(() => state.generation("thread", "provider")).toThrow("speech_unavailable");
  expect(db.prepare("SELECT state FROM speech_generations WHERE generation_id='running'").get()?.state).toBe("running");
  lock.exec("ROLLBACK"); state.recoverPending();
  expect(db.prepare("SELECT state FROM speech_generations WHERE generation_id='running'").get()?.state).toBe("invalid");
  expect(state.generation("thread", "provider")?.state).toBe("invalid");
});

it("a settled call mark is idempotent even while another writer is held", () => {
  const { db, lock } = fixture();
  markTurnCall(db, { botId: "bot", threadId: "thread", turnId: "marked", how: "ring" }, 1);
  expect(settleTurnOwed(db, "marked", 2)).toBe(true);
  lock.exec("BEGIN IMMEDIATE");
  expect(settleTurnOwed(db, "marked", 3)).toBe(false);
  expect(db.prepare("SELECT at FROM bot_call_owed WHERE fact_key='turn:marked'").get()?.at).toBe(2);
});


it("speech recovery attempts two held threads per tick and rotates failures without forgetting them", () => {
  const { db, lock, state } = fixture();
  for (const thread of ["first", "second", "third"]) state.begin(thread, "bot", thread, "prompt");
  lock.exec("BEGIN IMMEDIATE");
  for (const thread of ["first", "second", "third"]) expect(() => state.invalidateGeneration(thread, thread)).toThrow("durable_stop_failed");
  const recover = vi.spyOn(state, "recover");
  state.recoverPending();
  expect(recover.mock.calls.map(([thread]) => thread)).toEqual(["first", "second"]);
  state.recoverPending();
  expect(recover.mock.calls.map(([thread]) => thread)).toEqual(["first", "second", "third", "first"]);
  expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1000);
  lock.exec("ROLLBACK");
  state.recoverPending(); state.recoverPending();
  expect(db.prepare("SELECT state FROM speech_generations").all().map(row => row.state)).toEqual(["invalid", "invalid", "invalid"]);
  for (const thread of ["first", "second", "third"]) expect(() => state.generation(thread, "unknown")).not.toThrow();
});


it("a failed retirement lookup still quarantines speech until durable recovery", () => {
  const { db, state } = fixture();
  state.begin("thread", "bot", "running", "prompt"); state.bind("running", "provider");
  db.exec("ALTER TABLE speech_generations RENAME TO held_generations");
  expect(() => state.invalidateGeneration("thread", "running")).toThrow("durable_stop_failed");
  db.exec("ALTER TABLE held_generations RENAME TO speech_generations");
  expect(() => state.generation("thread", "provider")).toThrow("speech_unavailable");
  state.recoverPending();
  expect(state.generation("thread", "provider")?.state).toBe("invalid");
});


function callRuntime(db: DatabaseSync, checked: string[]) {
  const runtime = createBotCallsRuntime({
    db: () => db, outbox: { ringCall: () => 0, noteCall: () => 0, resolveCall: () => 0, dropCallNotes: () => 0, sendNow: async () => ({ attempted: 0 }) },
    card() {}, hint() {}, startOutbox() {}, senderOf: () => null, turnEndedAt: () => null,
    world: { quietHours: () => false, voiceReady: () => false, ringingDevice: () => false, factValid: () => true, calendar: async () => "free" },
    threadRunning: thread => { checked.push(thread); return thread === "running"; }, now: () => 10,
  });
  runtime.boot(); cleanups.push(() => runtime.stop());
  return runtime;
}

it("a pending call mark returns within the cleanup budget and the live sweep recovers it once", () => {
  const { db, lock } = fixture();
  const checked: string[] = [];
  const runtime = callRuntime(db, checked);
  for (const thread of ["running", "first", "second", "third"]) markTurnCall(db, { botId: "bot", threadId: thread, turnId: thread, how: "ring" }, 1);
  lock.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  runtime.turnCompleted("first");
  expect(performance.now() - started).toBeLessThan(500);
  expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1000);
  expect(db.prepare("SELECT at FROM bot_call_owed WHERE fact_key='turn:first'").get()?.at).toBeNull();
  runtime.sweep();
  expect(checked).toEqual(["running", "first"]);
  lock.exec("ROLLBACK");
  runtime.sweep();
  expect(checked).toEqual(["running", "first", "second", "third"]);
  runtime.sweep(); runtime.sweep(); runtime.sweep();
  expect(db.prepare("SELECT fact_key FROM bot_call_owed").all()).toEqual([{ fact_key: "turn:running" }]);
  expect(db.prepare("SELECT fact_key, fact_at FROM bot_calls ORDER BY fact_key").all()).toEqual([
    { fact_key: "turn:first", fact_at: 10 }, { fact_key: "turn:second", fact_at: 10 }, { fact_key: "turn:third", fact_at: 10 },
  ]);
  runtime.turnCompleted("first"); runtime.sweep();
  expect(db.prepare("SELECT count(*) AS n FROM bot_calls").get()?.n).toBe(3);
});

it.each([1, 16, 256])("one owed drain processes at most one indexed page with %s queued rows", history => {
  const { db } = fixture();
  const put = db.prepare("INSERT INTO bot_call_owed(fact_key,bot_id,kind,thread_id,at) VALUES(?,'bot','channel','thread',1)");
  for (let i = 0; i < history; i++) put.run(`queued-${i}`);
  let matched = 0;
  drainOwed(db, () => { matched++; return []; }, 10);
  expect(matched).toBe(Math.min(history, 100));
  expect(db.prepare("SELECT count(*) AS n FROM bot_call_owed").get()?.n).toBe(Math.max(0, history - 100));
  while (Number(db.prepare("SELECT count(*) AS n FROM bot_call_owed").get()?.n)) drainOwed(db, () => [], 10);
  expect(db.prepare("SELECT count(*) AS n FROM bot_call_owed").get()?.n).toBe(0);
});


it("pending call recovery attempts two rows and rotates past failed and still-running marks", () => {
  const { db, lock } = fixture(), checked: string[] = [];
  const runtime = callRuntime(db, checked);
  for (const thread of ["running", "first", "second", "third"]) markTurnCall(db, { botId: "bot", threadId: thread, turnId: thread, how: "ring" }, 1);
  lock.exec("BEGIN IMMEDIATE");
  runtime.turnCompleted("first"); runtime.sweep();
  expect(checked).toEqual(["running", "first"]);
  lock.exec("ROLLBACK"); runtime.sweep();
  expect(checked).toEqual(["running", "first", "second", "third"]);
  runtime.sweep(); runtime.sweep(); runtime.sweep();
  expect(db.prepare("SELECT fact_key FROM bot_call_owed").all()).toEqual([{ fact_key: "turn:running" }]);
  expect(db.prepare("SELECT count(*) AS n FROM bot_calls").get()?.n).toBe(3);
});


const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function extract(name: string, until: string, deps: Record<string, unknown>) {
  const start = indexSource.indexOf(`async function ${name}(`), end = indexSource.indexOf(until, start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(indexSource.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js + `return ${name};`)(...Object.values(deps));
}
/** The turn's own rows, read the way index.ts reads them (the turn id inside the stored json), never through the runtime's handle. */
function ownTurnEnd(db: DatabaseSync) {
  return (threadId: string, turnId: string): number | null => {
    const row = db.prepare("SELECT MAX(at) AS at FROM messages WHERE thread_id=? AND json_extract(json,'$.turnId')=?").get(threadId, turnId);
    return row?.at == null ? null : Number(row.at);
  };
}
function addRows(db: DatabaseSync, threadId: string, turnId: string | null, count: number, at: (i: number) => number, prefix: string) {
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','text','x',?)");
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) put.run(threadId, `${prefix}-${i}`, at(i), JSON.stringify(turnId ? { turnId } : {}));
  db.exec("COMMIT");
}
function recoveryRuntime(db: DatabaseSync, turnEndedAt: (threadId: string, turnId: string) => number | null, dbOf: () => DatabaseSync = () => db) {
  const runtime = createBotCallsRuntime({
    db: dbOf, outbox: { ringCall: () => 0, noteCall: () => 0, resolveCall: () => 0, dropCallNotes: () => 0, sendNow: async () => ({ attempted: 0 }) },
    card() {}, hint() {}, startOutbox() {}, senderOf: () => null, turnEndedAt,
    world: { quietHours: () => false, voiceReady: () => false, ringingDevice: () => false, factValid: () => true, calendar: async () => "free" },
    threadRunning: () => false, now: () => 5_000_000,
  });
  runtime.boot(); cleanups.push(() => runtime.stop());
  return runtime;
}

it("W1a a recovered mark settles at its own turn's end, not the thread's newest message", () => {
  const { db, lock } = fixture();
  addRows(db, "thread", "turn-a", 1, () => 1000, "own"); addRows(db, "thread", "turn-b", 1, () => 9000, "later");
  const runtime = recoveryRuntime(db, ownTurnEnd(db));
  markTurnCall(db, { botId: "bot", threadId: "thread", turnId: "turn-a", how: "ring" }, 1);
  lock.exec("BEGIN IMMEDIATE");
  runtime.sweep();
  expect(db.prepare("SELECT at FROM bot_call_owed WHERE fact_key='turn:turn-a'").get()?.at).toBeNull();
  lock.exec("ROLLBACK");
  runtime.sweep();
  expect(db.prepare("SELECT at FROM bot_call_owed WHERE fact_key='turn:turn-a'").get()?.at ?? db.prepare("SELECT fact_at FROM bot_calls WHERE fact_key='turn:turn-a'").get()?.fact_at).toBe(1000);
});

it("W1b recovery reads the marked turn once and never touches the thread's history", () => {
  const { db } = fixture();
  addRows(db, "thread", null, 10_000, i => 100 + i, "history"); addRows(db, "thread", "turn-a", 2, i => 2000 + i, "own");
  const prepared: string[] = [], calls: Array<[string, string]> = [];
  const spy = new Proxy(db, { get: (target, key) => key === "prepare" ? (sql: string) => { prepared.push(sql); return target.prepare(sql); } : Reflect.get(target, key, target).bind?.(target) ?? Reflect.get(target, key, target) });
  const own = ownTurnEnd(db);
  const runtime = recoveryRuntime(db, (thread, turn) => { calls.push([thread, turn]); return own(thread, turn); }, () => spy);
  markTurnCall(db, { botId: "bot", threadId: "thread", turnId: "turn-a", how: "ring" }, 1);
  markTurnCall(db, { botId: "bot", threadId: "thread", turnId: "turn-empty", how: "ring" }, 1);
  prepared.length = 0;
  runtime.sweep();
  expect(calls).toEqual([["thread", "turn-a"], ["thread", "turn-empty"]]);
  expect(prepared.filter(sql => /\bmessages\b/i.test(sql))).toEqual([]);
  expect(db.prepare("SELECT fact_at FROM bot_calls WHERE fact_key='turn:turn-a'").get()?.fact_at).toBe(2001);
  // a turn that wrote nothing settles at the sweep's own time, never at a thread-wide read
  expect(db.prepare("SELECT fact_at FROM bot_calls WHERE fact_key='turn:turn-empty'").get()?.fact_at).toBe(5_000_000);
});

function quarantine(state: ReplyState, lock: DatabaseSync, threadId: string) {
  state.begin(threadId, "bot", "generation", "prompt"); state.bind("generation", "provider");
  lock.exec("BEGIN IMMEDIATE");
  expect(() => state.invalidateGeneration(threadId, "generation")).toThrow("durable_stop_failed");
}

it("W2a an owner Stop on a quarantined thread is not refused and quarantine stays until recovery commits", () => {
  const { db, lock, state } = fixture();
  quarantine(state, lock, "t");
  const aborted = vi.spyOn(state as unknown as { abortWhere: (match: (job: { threadId: string }) => boolean) => void }, "abortWhere");
  expect(() => state.invalidate("t")).not.toThrow();
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(() => state.session({ id: "c", principal: "owner", send: () => true, terminate() {} }, "t")).toThrow("speech_unavailable");
  expect(() => state.authorize({ sessionId: "s", principal: "owner", connectionId: "c", threadId: "t" })).toThrow("speech_unavailable");
  expect(() => state.reserve({ sessionId: "s", principal: "owner", connectionId: "c", threadId: "t", messageId: "m", commandSequence: 1 }, () => { throw new Error("quarantined reservation reached validation"); })).toThrow("speech_unavailable");
  expect(() => state.revision("t")).toThrow("speech_unavailable");
  lock.exec("ROLLBACK");
  state.recoverPending();
  expect(() => state.session({ id: "c", principal: "owner", send: () => true, terminate() {} }, "t")).not.toThrow();
  expect(db.prepare("SELECT state FROM speech_generations WHERE generation_id='generation'").get()?.state ?? "invalid").toBe("invalid");
});

it("W2b the owner Stop wiring on a quarantined thread resolves, interrupts once and stops playback", async () => {
  const { lock, state, db } = fixture();
  quarantine(state, lock, "t");
  const interrupt = vi.fn(async () => {}), playerStop = vi.fn(), cancel = vi.fn();
  const stop = extract("stopDirectThreadForOwner", "\n/**", {
    replyState: state, callSpeech: { invalidate: () => playerStop() }, interruptDirectThread: interrupt, dropAskerWakes: () => {}, recordStopForThread: () => {}, database: () => db,
    markSendsStopped: () => {}, botCalls: { cancel }, stopHeldVenuePosts: () => [], settleVenuePostCard: () => {}, routines: { activeBotRunForThread: () => undefined },
  });
  await expect(stop({ id: "bot" }, "t")).resolves.toBeUndefined();
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(playerStop).toHaveBeenCalled();
  expect(() => state.revision("t")).toThrow("speech_unavailable");
});

it.each([false, true])("W2c turn-end continuation cleanup returns within the cleanup budget, keeps the row and logs one failure; writer releases=%s", async writerReleases => {
  const { db, lock } = fixture();
  let writer: Worker | undefined;
  const proofKey = JSON.stringify({ kind: "background-job", id: "service:g", botId: "bot", threadId: "t" });
  db.prepare("INSERT INTO decision_continuations(key,value) VALUES(?,?)").run(proofKey, "{}");
  const release = extract("releaseDecisionProvenance", "\nfunction decisionLiveIdentity", {
    decisionSharedSaves: new Map(), completeDecisionGeneration: async () => {}, cancelRequests: async () => {}, decisionAuthorities: new Map(),
    decisionRequestTargets: new Map(), decisionProvenance: new Map([["g", { botId: "bot" }]]), decisionQueuePorts: new Map(),
    readContinuation: () => ({}), database: () => db, setBusy, BACKGROUND_BUSY_MS,
    deleteContinuation: async () => { writer?.postMessage("deleting"); deleteContinuationRecord(db, proofKey); },
  });
  const ast = ts.createSourceFile("index.ts", indexSource, ts.ScriptTarget.Latest, true);
  const revoke = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "revokeInternalGeneration") as ts.FunctionDeclaration;
  const cleanup = revoke.body!.statements.find(node => ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression) && node.expression.expression.getText(ast).startsWith("releaseDecisionProvenance(")) as ts.ExpressionStatement;
  // Await the shipped caller's catch, so the assertion covers its production failure log.
  const expression = (cleanup.expression as ts.VoidExpression).expression.getText(ast);
  const logged: unknown[][] = [];
  const retire = new Function("releaseDecisionProvenance", "console", "threadId", "generation", "completed", `return ${expression};`);
  let released = Promise.resolve();
  if (writerReleases) {
    const worker = writer = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const { DatabaseSync } = require('node:sqlite');
      const writer = new DatabaseSync(workerData); writer.exec('BEGIN IMMEDIATE'); parentPort.postMessage('held');
      parentPort.once('message', () => setTimeout(() => { writer.exec('ROLLBACK'); writer.close(); }, 200));`, { eval: true, workerData: db.prepare("PRAGMA database_list").get()!.file });
    cleanups.push(() => { void worker.terminate(); });
    released = new Promise<void>((resolve, reject) => { worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`))); worker.once("error", reject); });
    await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
  } else lock.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  await retire(release, { error: (...args: unknown[]) => logged.push(args) }, "t", "g", true);
  expect(performance.now() - started).toBeLessThan(500);
  expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1000);
  if (!writerReleases) lock.exec("ROLLBACK");
  await released;
  expect(readContinuationRecord(db, proofKey)).toBe("{}");
  expect(logged).toHaveLength(1);
  expect(logged[0]![0]).toBe("[decision] generation cleanup failed");
  expect(logged[0]![1]).toBeInstanceOf(Error);
});
