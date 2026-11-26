// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: pip (the idle lane's reflection pending check, pip-reflect.ts anyThreadPendingSliced, and its change feed,
// pip-admission.ts pendingChanges); consumer owner: cause18c-pip (1.0.21 owner copy, TRIAGE-1122 1c).
// The installed 1.0.21 read about 1,000 source pages a minute all night: each time a Continuity bot's memo key moved (once a minute, and at
// every memory write anywhere) the check walked every thread of the bot whole. These witnesses run the real check on a real store and count
// the statements it really runs: a scan reads the threads a write changed, never every thread, whoever wrote and on whichever connection,
// and the answer stays what the walk gives.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { PENDING_CHANGED_SQL, pendingFeedStats } from "./pip-admission.ts";
import { movedReflectThreads, mutateReflect, pipPendingScanStats, pipReflectPendingSliced, REFLECTABLE_AGE_MS, resetPipPendingScans, type ReflectDeps } from "./pip-reflect.ts";
import { captureStoredMessage } from "./testing/captured-message.ts";

const T0 = 1_760_000_000_000, HOUR = 3_600_000;
let clock = T0;
let other: DatabaseSync | undefined;
const fresh = () => { other?.close(); other = undefined; closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetPipPendingScans(); clock = T0 + 24 * HOUR; };
beforeEach(fresh);
afterEach(() => { other?.close(); other = undefined; setMemoryCaptureRoster(null); });

const threadName = (n: number) => `thread-${String(n).padStart(4, "0")}`;
const owner = (id: string, at: number) => ({ id, at, role: "user", kind: "text", text: `Please keep it short (${id}).`, origin: "desktop" }) as never;
const reply = (id: string, at: number) => ({ id, at, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } }) as never;
const completeJobs = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100 WHERE status<>'complete'");
/** One Continuity bot with `count` threads of its own, each with a little history and nothing to reflect: in the even threads the owner
 *  spoke last (no settled reply), in the odd ones there is only a settled reply (no owner turn to learn from). */
function bot(count: number, counted?: ReturnType<typeof countedRoster>): { deps: ReflectDeps; threads: string[] } {
  const threads = Array.from({ length: count }, (_, n) => threadName(n));
  const roster = { bots: [{ id: "moss", threadId: threads[0]!, tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] as never[] };
  reconcileMemoryRoster(roster as never); setMemoryMode("active"); setMemoryCaptureRoster(() => (counted ? counted.over(roster) : roster) as never);
  const db = database();
  db.exec("PRAGMA synchronous=OFF");
  db.exec("BEGIN");
  for (const [n, thread] of threads.entries()) {
    captureStoredMessage(db, thread, reply(`b-${n}`, T0 + n));
    if (n % 2 === 0) captureStoredMessage(db, thread, owner(`o-${n}`, T0 + 1_000 + n));
  }
  db.exec("COMMIT");
  completeJobs();
  const deps = {
    now: () => clock, bootEpoch: "boot" as never, tmpBase: "/tmp", memoryMode: () => "active", resolveRoute: async () => { throw new Error("not used"); },
    bots: () => [{ id: "moss", threadIds: threads, continuity: true, options: { reflect: true } as never }],
  } as unknown as ReflectDeps;
  return { deps, threads };
}
/** The roster as the Store gives it (store.ts): a revision that moves with every structural edit, and a lookup of a room by thread. It
 *  counts, outside the code under test, every time the roster is asked whose a thread is: each read of its bot and room lists, and
 *  the threads asked about. The lists themselves are the plain roster's. */
function countedRoster() {
  let reads = 0, plain: { bots: unknown[]; groups: unknown[] } = { bots: [], groups: [] };
  const asked: string[] = [];
  const roster = {
    memoryRosterRevision: 1,
    get bots() { reads++; return plain.bots; },
    get groups() { reads++; return plain.groups; },
    groupByThread(threadId: string) { asked.push(threadId); return undefined; },
  };
  return {
    over: (lists: { bots: unknown[]; groups: unknown[] }) => { plain = lists; return roster; },
    /** the threads the roster was asked about, each once, in order */
    threads: () => [...new Set(asked)],
    /** every read of the roster's lists */
    reads: () => reads,
    reset: () => { reads = 0; asked.length = 0; },
  };
}
/** Counts what the check really asks of SQLite on one connection: every execution of a prepared statement, by its SQL text. Nothing is
 *  stubbed: each call goes to the real statement. The check hands the loop back between reads, and a timer of the store's own may then run
 *  a statement on the same connection: an execution with no frame of the check's two files on its stack is not the check's, and is counted
 *  apart (`strays`, printed when there are any). */
function countStatements(db: DatabaseSync) {
  const executions = new Map<string, number>(), strays = new Map<string, number>(), original = db.prepare;
  const ofTheCheck = () => {
    // the whole stack: a statement deep under the check's own call is the check's
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    try { return /pip-(reflect|admission)\.ts/.test(String(new Error().stack)); } finally { Error.stackTraceLimit = limit; }
  };
  db.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]): StatementSync {
    const statement = (original as (...args: unknown[]) => StatementSync).call(this, sql, ...rest);
    for (const method of ["get", "all", "run", "iterate"] as const) {
      const real = statement[method] as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { const into = ofTheCheck() ? executions : strays; into.set(sql, (into.get(sql) ?? 0) + 1); return real.apply(statement, args); };
    }
    return statement;
  } as typeof db.prepare;
  return {
    runs: (match: (sql: string) => boolean = () => true) => { let n = 0; for (const [sql, count] of executions) if (match(sql)) n += count; return n; },
    /** the statements other code ran on this connection since the last reset */
    strays: () => [...strays],
    reset: () => { executions.clear(); strays.clear(); },
    dump: () => [...executions].map(([q, n]) => [n, q.slice(0, 70)]),
    stop: () => { db.prepare = original; },
  };
}
/** The statements that read a thread's history: the pages of its walk and the seeks into them. */
const sources = (sql: string) => /\bmemory_sources\b/.test(sql) && !/\bmain\.memory_sources\b/.test(sql);
/** A second connection to the same file, as a worker thread holds one. */
function elsewhere(): DatabaseSync {
  other ??= new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("PRAGMA busy_timeout=5000");
  return other;
}
/** Counts, outside the code under test, what is done with the cursors of every reflect state parsed from its text while this is on:
 *  the real JSON.parse runs, and the cursor map of a state it returns is handed on behind a counter. `listings` is every time a cursor
 *  map is listed (a loop over it, its keys or values, a spread, a stringify), `names` the cursor names read, `parses` the states parsed. */
function countedStates() {
  let listings = 0, parses = 0;
  const names: string[] = [], parse = JSON.parse;
  const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value = parse(text, reviver) as { threads?: unknown } | null;
    if (value && typeof value === "object" && !Array.isArray(value) && "cooldownUntil" in value && value.threads && typeof value.threads === "object") {
      parses++;
      value.threads = new Proxy(value.threads, {
        get(target, key, receiver) { if (typeof key === "string") names.push(key); return Reflect.get(target, key, receiver); },
        ownKeys(target) { listings++; return Reflect.ownKeys(target); },
      });
    }
    return value;
  });
  return {
    listings: () => listings, parses: () => parses,
    /** the cursor names read, each once, in order */
    names: () => [...new Set(names)],
    reset: () => { listings = 0; parses = 0; names.length = 0; },
    stop: () => spy.mockRestore(),
  };
}
/** The bot's reflect state written by another connection, as another process would: the whole text, no word to this one. */
function stateWrittenElsewhere(edit: (state: { threads: Record<string, { cursorAt: number }> }) => void): void {
  const db = elsewhere(), id = "pip-reflect:moss";
  const state = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent)) as { threads: Record<string, { cursorAt: number }> };
  edit(state);
  db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(state), id);
}
const dataVersion = () => Number(database().prepare("PRAGMA data_version").get()?.data_version);

/** Ten idle passes of a night: between passes the minute moves on, a memory write lands elsewhere (the data revision), and one thread
 *  gets one more owner turn (still nothing to reflect). Returns what the ten passes ran: every statement, and those that read sources. */
async function night(count: number): Promise<{ all: number; sources: number; ranges: number; answers: Array<string | undefined> }> {
  const { deps, threads } = bot(count);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined(); // the first pass after start reads every thread once
  const counter = countStatements(db);
  let all = 0, read = 0, ranges = 0, first = 0;
  const answers: Array<string | undefined> = [];
  try {
    for (let pass = 0; pass < 10; pass++) {
      clock += 61_000;
      db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
      captureStoredMessage(db, threads[0]!, owner(`night-${pass}`, clock));
      completeJobs();
      counter.reset();
      answers.push(await pipReflectPendingSliced(deps, 0));
      const range = counter.runs(sql => sql === PENDING_CHANGED_SQL);
      if (counter.strays().length) console.log("statements of other code on this connection during a pass:", count, pass, JSON.stringify(counter.strays()));
      all += counter.runs() - range; read += counter.runs(sources); ranges += range;
      // every pass of a night does the same work: one that does not is printed, statement by statement
      if (pass === 0) first = counter.runs() - range;
      else if (counter.runs() - range !== first) console.log("a pass unlike the first", count, pass, JSON.stringify(counter.dump()));
    }
  } finally { counter.stop(); }
  return { all, sources: read, ranges, answers };
}

it("W1 ten idle passes run the same statements for a bot with 10 threads and one with 1,000", async () => {
  const small = await night(10);
  fresh();
  const large = await night(1_000);
  expect(small.answers).toEqual(Array(10).fill(undefined));
  expect(large.answers).toEqual(small.answers);
  expect(small.sources).toBeGreaterThan(0); // the changed thread really is walked each pass
  // base: every pass walks every thread (1,000 threads cost 100 times what 10 do)
  expect(large.sources).toBe(small.sources);
  // every other statement too. The read of the change rows is counted apart (round 2): it runs once each time the feed's sequence number
  // moved, so a write that lands while the loop is handed back (a timer of the store's own, naming no thread of this bot) adds one read of
  // the index range, at 10 threads as at 1,000. It is bounded per pass instead: once for the pass, once more at most per hand-back.
  expect(large.all).toBe(small.all);
  expect(small.ranges).toBeGreaterThanOrEqual(10);
  expect(Math.max(small.ranges, large.ranges)).toBeLessThanOrEqual(10 * 3);
}, 240_000);

it("W2 a memo miss with 1,000 threads walks the threads that changed and no other", async () => {
  const { deps, threads } = bot(1_000);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined(); // the one read of every thread after start
  for (const n of [3, 400, 998]) captureStoredMessage(db, threads[n]!, owner(`late-${n}`, clock));
  completeJobs();
  clock += 61_000;
  const counter = countStatements(db), scans = pipPendingScanStats.scans;
  try {
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    expect(pipPendingScanStats.scans).toBe(scans + 1); // a memo miss
    // base: about 3,000 (three and more for each of 1,000 threads)
    expect(counter.runs(sources)).toBeLessThanOrEqual(3 * 12);
    expect(pipPendingScanStats.threadWalks).toBe(1_003);
  } finally { counter.stop(); }
}, 240_000);

it("W3 a commit by another connection that touches no memory row walks no thread", async () => {
  const { deps } = bot(300);
  const db = database();
  // a table of the worker's own, there before the check first runs
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const counter = countStatements(db);
  try {
    for (let pass = 0; pass < 5; pass++) {
      const before = dataVersion();
      elsewhere().prepare("INSERT INTO worker_scratch VALUES(?)").run(pass);
      expect(dataVersion()).not.toBe(before); // this connection does see a commit elsewhere
      clock += 61_000;
      expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    }
    // base: 5 passes x 300 threads
    expect(counter.runs(sources)).toBe(0);
  } finally { counter.stop(); }
}, 120_000);

it("W4 rows another connection adds to one thread make that thread pending, and only it is walked", async () => {
  const { deps, threads } = bot(300);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  // thread 7 has only a settled reply. On another connection the owner speaks there and the bot answers: copies of thread 6's owner turn
  // and thread 7's reply, as new rows (no trigger of this connection sees them)
  const w = elsewhere(), from = (thread: string, speaker: string) => String(db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND kind='text' AND speaker" + (speaker === "owner" ? "='owner'" : "<>'owner'")).get(thread)!.id);
  const copy = (source: string, id: string) => {
    w.prepare("INSERT INTO memory_sources SELECT ?1,scope_id,?2,?1,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state FROM memory_sources WHERE id=?3").run(id, threads[7]!, source);
    w.prepare("INSERT INTO memory_source_versions SELECT ?1,revision,content_hash,payload,created_at FROM memory_source_versions WHERE source_id=?2").run(id, source);
    const job = w.prepare("SELECT * FROM memory_jobs WHERE source_id=? AND stage='capture'").get(source) as Record<string, never>;
    const columns = Object.keys(job);
    w.prepare(`INSERT INTO memory_jobs(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(c => c === "id" ? `job-${id}` : c === "source_id" ? id : job[c]));
  };
  w.exec("BEGIN IMMEDIATE");
  copy(from(threads[6]!, "owner"), "copied-owner"); copy(from(threads[7]!, "bot"), "copied-reply");
  w.exec("COMMIT");
  clock += 61_000;
  const walks = pipPendingScanStats.threadWalks, counter = countStatements(db);
  try {
    expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
    // base: every thread before thread 7 is walked too
    expect(counter.runs(sources)).toBeLessThanOrEqual(16);
    expect(pipPendingScanStats.threadWalks).toBe(walks + 1);
  } finally { counter.stop(); }
}, 120_000);

it("W5 a row another connection changes in place, with the memory revision it moves, is read again: the thread becomes pending", async () => {
  const { deps, threads } = bot(40);
  const db = database();
  // thread 9: the owner spoke, the bot answered (settled), the owner spoke again: the owner has the last word, so nothing is pending
  captureStoredMessage(db, threads[9]!, owner("o-first", clock - 3 * HOUR));
  captureStoredMessage(db, threads[9]!, reply("b-answer", clock - 2 * HOUR));
  captureStoredMessage(db, threads[9]!, owner("o-last", clock - HOUR));
  completeJobs();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  // another connection retires the owner's last word (no row is added) and moves the memory revision, as every memory write does
  const last = String(db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND message_id='o-last' AND kind='text'").get(threads[9]!)!.id);
  const w = elsewhere();
  w.exec("BEGIN IMMEDIATE");
  w.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(last);
  w.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  w.exec("COMMIT");
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
}, 120_000);

it("W6 a tombstone on one source walks its thread alone; a tombstone on a record walks none", async () => {
  const { deps, threads } = bot(300);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const source = String(db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND kind='text'").get(threads[11]!)!.id);
  const counter = countStatements(db);
  try {
    db.prepare("INSERT INTO memory_tombstones VALUES('tomb-record','record','no-such-record',NULL,NULL,0,'test',?)").run(clock);
    clock += 61_000;
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    expect(counter.runs(sources)).toBe(0);
    db.prepare("INSERT INTO memory_tombstones VALUES('tomb-source','source',?,NULL,NULL,0,'test',?)").run(source, clock);
    clock += 61_000;
    const walks = pipPendingScanStats.threadWalks;
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    expect(pipPendingScanStats.threadWalks).toBe(walks + 1);
    // base: 2 passes x 300 threads
    expect(counter.runs(sources)).toBeLessThanOrEqual(12);
  } finally { counter.stop(); }
}, 120_000);

it("W7 a pending thread stops being pending when its owner turn is tombstoned, and is pending again when the tombstone goes", async () => {
  const { deps, threads } = bot(40);
  const db = database();
  captureStoredMessage(db, threads[7]!, owner("o-new", clock - 30 * 60_000));
  captureStoredMessage(db, threads[7]!, reply("b-new", clock - 29 * 60_000));
  completeJobs();
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
  const turn = String(db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND message_id='o-new' AND kind='text'").get(threads[7]!)!.id);
  db.prepare("INSERT INTO memory_tombstones VALUES('tomb-turn','source',?,NULL,NULL,0,'test',?)").run(turn, clock);
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  db.exec("DELETE FROM memory_tombstones WHERE id='tomb-turn'");
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
});

it("W8 a remembered thread is walked again when its own rows change: an owner turn and a settled reply make it pending", async () => {
  const { deps, threads } = bot(40);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  captureStoredMessage(db, threads[7]!, owner("o-new", clock - 30 * 60_000));
  captureStoredMessage(db, threads[7]!, reply("b-new", clock - 29 * 60_000));
  completeJobs();
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
});

it("W9 a pending thread whose reflection does not start is not walked again every minute", async () => {
  const { deps, threads } = bot(40);
  const db = database();
  captureStoredMessage(db, threads[7]!, owner("o-new", clock - 30 * 60_000));
  captureStoredMessage(db, threads[7]!, reply("b-new", clock - 29 * 60_000));
  completeJobs();
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
  const counter = countStatements(db);
  try {
    for (let pass = 0; pass < 5; pass++) {
      clock += 61_000;
      db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
      expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
    }
    // base: the threads before the pending one and the pending one itself, whole, every pass
    expect(counter.runs(sources)).toBe(0);
  } finally { counter.stop(); }
});

it("W10 a reply too young to be settled becomes pending when it settles, with no row changed in between", async () => {
  const { deps, threads } = bot(6);
  const db = database();
  captureStoredMessage(db, threads[1]!, owner("o-young", clock - 60_000));
  captureStoredMessage(db, threads[1]!, reply("b-young", clock - 30_000));
  completeJobs();
  const repliedAt = clock - 30_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  clock = repliedAt + REFLECTABLE_AGE_MS - 1_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  clock = repliedAt + REFLECTABLE_AGE_MS + 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
});

it("W11 a change that concerns every thread (the memory policy) reads every thread once more, then none", async () => {
  const { deps } = bot(60);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  clock += 61_000;
  let walks = pipPendingScanStats.threadWalks;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  expect(pipPendingScanStats.threadWalks).toBe(walks + 60);
  clock += 61_000;
  walks = pipPendingScanStats.threadWalks;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  expect(pipPendingScanStats.threadWalks).toBe(walks);
});

it("W12 a thread that stops being the bot's own (the roster, no write) is read again", async () => {
  const { deps, threads } = bot(12);
  const db = database();
  captureStoredMessage(db, threads[7]!, owner("o-new", clock - 30 * 60_000));
  captureStoredMessage(db, threads[7]!, reply("b-new", clock - 29 * 60_000));
  completeJobs();
  expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
  // the roster now gives thread 7 to another bot: nothing is written
  const roster = { bots: [{ id: "moss", threadId: threads[0]!, tasks: threads.slice(1).filter(t => t !== threads[7]).map(threadId => ({ threadId })) }, { id: "fern", threadId: threads[7]!, tasks: [] }], groups: [] as never[] };
  setMemoryCaptureRoster(() => roster as never);
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
});

// ---- round 2 (ASTRA 201cd2cb51 / 346f362534 / 1011fa2406, row 1c): the miss path itself. A pass with nothing changed does no work per
// thread at all (no read, no roster lookup, no key), and a pass after a change visits the changed thread and no other. "Visited" is
// measured from outside: the threads the roster is asked about (every visit of the earlier builds asked it whose the thread is).

it("W13 1,000 threads and nothing changed: passes in new minutes visit no thread, ask the roster nothing and read one mark", async () => {
  const roster = countedRoster();
  const { deps } = bot(1_000, roster);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined(); // the one read of every thread after start
  const counter = countStatements(db), walks = pipPendingScanStats.threadWalks, ranges = pendingFeedStats.ranges;
  roster.reset();
  try {
    for (let pass = 0; pass < 5; pass++) {
      clock += 61_000;
      expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    }
    // 201cd2cb51: every thread of the bot, five times
    expect(roster.threads()).toEqual([]);
    expect(roster.reads()).toBe(0);
    expect(pipPendingScanStats.threadWalks).toBe(walks);
    expect(counter.runs(sources)).toBe(0);
    // the mark alone: the change rows are not read while the sequence number stands
    expect(pendingFeedStats.ranges).toBe(ranges);
    // per pass: the feed's mark (its row, data_version, the two presence checks) and the bot's reflect binding
    expect(counter.runs()).toBeLessThanOrEqual(5 * 6);
  } finally { counter.stop(); }
}, 240_000);

it("W14 1,000 threads and one changed: exactly that thread is visited", async () => {
  const roster = countedRoster();
  const { deps, threads } = bot(1_000, roster);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  // thread 501 had only a settled reply: the owner speaks there and the bot answers
  captureStoredMessage(db, threads[501]!, owner("o-new", clock - 30 * 60_000));
  captureStoredMessage(db, threads[501]!, reply("b-new", clock - 29 * 60_000));
  completeJobs();
  clock += 61_000;
  const counter = countStatements(db), walks = pipPendingScanStats.threadWalks, ranges = pendingFeedStats.ranges;
  roster.reset();
  try {
    expect(await pipReflectPendingSliced(deps, 0)).toBe("moss");
    // 201cd2cb51: every thread up to the changed one
    expect(roster.threads()).toEqual([threads[501]]);
    expect(pipPendingScanStats.threadWalks).toBe(walks + 1);
    expect(pendingFeedStats.ranges).toBe(ranges + 1);
    expect(counter.runs(sources)).toBeLessThanOrEqual(16);
  } finally { counter.stop(); }
}, 240_000);

it("W15 1,000 threads and a commit by another connection that touches nothing the check reads: no thread is visited", async () => {
  const roster = countedRoster();
  const { deps } = bot(1_000, roster);
  const db = database();
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const counter = countStatements(db), walks = pipPendingScanStats.threadWalks, placed = pendingFeedStats.placed;
  roster.reset();
  try {
    for (let pass = 0; pass < 3; pass++) {
      const before = dataVersion();
      elsewhere().prepare("INSERT INTO worker_scratch VALUES(?)").run(pass);
      expect(dataVersion()).not.toBe(before); // this connection does see a commit elsewhere
      clock += 61_000;
      expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    }
    // 201cd2cb51: every thread of the bot, three times
    expect(roster.threads()).toEqual([]);
    expect(roster.reads()).toBe(0);
    expect(pipPendingScanStats.threadWalks).toBe(walks);
    expect(counter.runs(sources)).toBe(0);
    expect(pendingFeedStats.placed).toBe(placed + 3); // each commit was looked at, and named nothing
  } finally { counter.stop(); }
}, 240_000);

it("W16 the changed threads are read as one range of the index on the change rows' sequence number", async () => {
  const { deps, threads } = bot(6);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${PENDING_CHANGED_SQL}`).all(0).map(row => String(row.detail)).join("; ");
  expect(plan).toMatch(/^SEARCH (temp\.)?memory_pending_dirty USING (COVERING )?INDEX memory_pending_dirty_seq \(seq>\?\)$/);
  // a write to one thread leaves one change row after the last sequence number read, whatever was written before
  const last = Number(db.prepare("SELECT seq FROM temp.memory_pending_feed WHERE id=1").get()!.seq);
  captureStoredMessage(db, threads[3]!, owner("o-late", clock));
  expect(db.prepare(PENDING_CHANGED_SQL).all(last).map(row => String(row.thread_id))).toEqual([threads[3]]);
});

it("W17 a roster revision with no thread changing hands reads no thread; a reflect state that moved one cursor reads that thread alone", async () => {
  const roster = countedRoster();
  const { deps, threads } = bot(200, roster);
  const db = database();
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const counter = countStatements(db);
  try {
    // the Store saved its bots (a turn ended): the revision moves, no thread changed hands
    (roster.over({ bots: [{ id: "moss", threadId: threads[0]!, tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] }) as { memoryRosterRevision: number }).memoryRosterRevision++;
    clock += 61_000;
    let walks = pipPendingScanStats.threadWalks;
    roster.reset();
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    // the Store's revision moves at every save of its bots: no thread of the 200 has an answer a change of hands could change (each
    // is the bot's own with nothing admissible), so the roster is asked about none
    expect(roster.threads()).toEqual([]);
    expect(pipPendingScanStats.threadWalks).toBe(walks);
    expect(counter.runs(sources)).toBe(0);
    // the bot's reflect state moves the cursor of thread 5 (a settled reply, nothing admissible): that thread is asked again, alone
    mutateReflect("moss", state => { state.threads[threads[5]!] = { cursorMessageId: null, cursorAt: 1, lastRunAt: 0, surprise: 0, unreflected: [] }; });
    roster.reset(); walks = pipPendingScanStats.threadWalks;
    clock += 61_000;
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    expect(roster.threads()).toEqual([threads[5]]);
    expect(pipPendingScanStats.threadWalks).toBe(walks + 1);
  } finally { counter.stop(); }
});

// ---- round 3 (ASTRA 1977a62606, row 1c(d) and 1c(c)): what this connection wrote and the check has consumed is never asked about again
// by a later commit elsewhere, and a reflect state edit builds nothing from the cursors that did not move.

/** Three passes, each after a commit by another connection that touches nothing the check reads; then what they did, measured outside. */
async function unrelatedCommits(deps: ReflectDeps, roster: ReturnType<typeof countedRoster>): Promise<{ asked: string[]; walks: number; sources: number; placed: number }> {
  const db = database(), counter = countStatements(db), walks = pipPendingScanStats.threadWalks, placed = pendingFeedStats.placed;
  roster.reset();
  try {
    for (let pass = 0; pass < 3; pass++) {
      const before = dataVersion();
      elsewhere().prepare("INSERT INTO worker_scratch VALUES(?)").run(pass);
      expect(dataVersion()).not.toBe(before); // this connection does see a commit elsewhere
      clock += 61_000;
      expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    }
    return { asked: roster.threads(), walks: pipPendingScanStats.threadWalks - walks, sources: counter.runs(sources), placed: pendingFeedStats.placed - placed };
  } finally { counter.stop(); }
}

it("W18 1,000 threads this connection wrote to, read once: a commit elsewhere that touches nothing the check reads visits none of them again", async () => {
  const roster = countedRoster();
  const { deps, threads } = bot(1_000, roster);
  const db = database();
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  // after the warm pass, on this connection: the owner speaks in every thread (nothing to reflect: the owner's word is the newest)
  db.exec("BEGIN");
  for (const [n, thread] of threads.entries()) captureStoredMessage(db, thread, owner(`late-${n}`, clock + n));
  db.exec("COMMIT");
  completeJobs();
  clock += 61_000;
  const consumed = pipPendingScanStats.threadWalks;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  expect(pipPendingScanStats.threadWalks).toBe(consumed + 1_000); // the pass that consumes this connection's changes: each written thread, once
  const after = await unrelatedCommits(deps, roster);
  // 1977a62606: all 1,000 threads again at the first commit elsewhere (the rows this connection added lay after the rowid marks)
  expect(after.walks).toBe(0);
  expect(after.asked).toEqual([]);
  expect(after.sources).toBe(0);
  expect(after.placed).toBe(3); // each commit was looked at, and named nothing
}, 240_000);

it("W19 a setting this connection changed, every thread read once for it: a commit elsewhere does not read every thread again", async () => {
  const roster = countedRoster();
  const { deps } = bot(300, roster);
  const db = database();
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  // this connection changes the learning settings (a change that concerns every thread)
  db.exec("INSERT INTO memory_learning_config(id,revision,settings) VALUES(1,1,'{}') ON CONFLICT(id) DO UPDATE SET revision=revision+1");
  clock += 61_000;
  const consumed = pipPendingScanStats.threadWalks;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  expect(pipPendingScanStats.threadWalks).toBe(consumed + 300); // the pass that consumes the change: every thread, once
  const wide = pendingFeedStats.wide;
  const after = await unrelatedCommits(deps, roster);
  // 1977a62606: all 300 threads again (the fingerprint of the file still held the settings from before this connection's change)
  expect(after.walks).toBe(0);
  expect(after.asked).toEqual([]);
  expect(pendingFeedStats.wide).toBe(wide);
  expect(after.placed).toBe(3); // each commit was looked at
});

it("W20 a capture job this connection adds for a thread already read: a commit elsewhere does not name that thread", async () => {
  const roster = countedRoster();
  const { deps, threads } = bot(40, roster);
  const db = database();
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  // a second capture job (another stage version, not complete) for thread 7's reply: a new row no trigger of the feed names a thread for
  const job = db.prepare("SELECT j.* FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.stage='capture'").get(threads[7]!) as Record<string, never>;
  const columns = Object.keys(job);
  const seq = Number(db.prepare("SELECT seq FROM temp.memory_pending_feed WHERE id=1").get()!.seq);
  db.prepare(`INSERT INTO memory_jobs(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(c => c === "id" ? "job-again" : c === "stage_version" ? "again" : c === "status" ? "pending" : job[c]));
  expect(Number(db.prepare("SELECT seq FROM temp.memory_pending_feed WHERE id=1").get()!.seq)).toBe(seq); // the row named no thread
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const after = await unrelatedCommits(deps, roster);
  // 1977a62606: thread 7 (the job row lay after the rowid mark, and a commit elsewhere read it as a row of its own)
  expect(after.walks).toBe(0);
  expect(after.asked).toEqual([]);
  expect(after.placed).toBe(3); // each commit was looked at
});

it("W21 a row this connection removes: a commit elsewhere is not taken for a file whose rows were renumbered", async () => {
  const roster = countedRoster();
  const { deps } = bot(300, roster);
  const db = database();
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  // a tombstone on a record (it concerns no thread), there before the check first runs
  db.prepare("INSERT INTO memory_tombstones VALUES('tomb-record','record','no-record',NULL,NULL,0,'test',?)").run(clock);
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const seq = Number(db.prepare("SELECT seq FROM temp.memory_pending_feed WHERE id=1").get()!.seq);
  db.exec("DELETE FROM memory_tombstones WHERE id='tomb-record'");
  expect(Number(db.prepare("SELECT seq FROM temp.memory_pending_feed WHERE id=1").get()!.seq)).toBe(seq); // the removal named no thread
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const wide = pendingFeedStats.wide;
  const after = await unrelatedCommits(deps, roster);
  // 1977a62606: all 300 threads again (fewer tombstone rows than at the mark: taken for another connection's removal)
  expect(after.walks).toBe(0);
  expect(after.asked).toEqual([]);
  expect(pendingFeedStats.wide).toBe(wide);
  expect(after.placed).toBe(3); // each commit was looked at
});

it("W22 a reflect state with a cursor for each of 1,000 threads, one cursor moved: that thread alone is asked again, and nothing is built from the others", async () => {
  // (1) the comparison itself, probed from outside: every cursor's message id is an object that counts each time a string is made of it
  let strings = 0;
  const counted = (id: string) => ({ toString() { strings++; return id; } }) as never as string;
  const ids = Array.from({ length: 1_000 }, (_, n) => counted(`m-${n}`));
  const stateOf = (movedAt?: number) => ({
    threads: Object.fromEntries(ids.map((id, n) => [threadName(n), { cursorMessageId: id, cursorAt: n === movedAt ? 2 : 1, lastRunAt: 0, surprise: 0, unreflected: [] }])),
    excludedThreads: [threadName(1)],
  });
  expect(movedReflectThreads(stateOf(), stateOf(501))).toEqual([threadName(501)]);
  // 1977a62606: two key strings for each of the 1,000 cursors
  expect(strings).toBe(0);
  expect(movedReflectThreads(stateOf(), { ...stateOf(), excludedThreads: [threadName(2)] }).sort()).toEqual([threadName(1), threadName(2)]);
  const { [threadName(3)]: _gone, ...rest } = stateOf().threads;
  expect(movedReflectThreads(stateOf(), { threads: rest, excludedThreads: [threadName(1)] })).toEqual([threadName(3)]);
  // a thread with no cursor under its name (a state is parsed as it was written) is one that moved, never an error
  expect(movedReflectThreads(stateOf(), { threads: { ...stateOf().threads, [threadName(4)]: null as never }, excludedThreads: [threadName(1)] })).toEqual([threadName(4)]);
  expect(strings).toBe(0);
  // (2) the real check on a real store whose reflect state holds a cursor for every thread (W17 began with none)
  const roster = countedRoster();
  const { deps, threads } = bot(1_000, roster);
  mutateReflect("moss", state => { for (const thread of threads) state.threads[thread] = { cursorMessageId: null, cursorAt: 1, lastRunAt: 0, surprise: 0, unreflected: [] }; });
  // (3) the stored cursors themselves, counted from outside from here on: each listing of a parsed state's cursors, each cursor name read
  const seen = countedStates();
  try {
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    expect(seen.parses()).toBe(1); // the check holds the 1,000 stored cursors, behind the counter
    mutateReflect("moss", state => { state.threads[threads[501]!]!.cursorAt = 2; });
    clock += 61_000;
    roster.reset(); seen.reset();
    const walks = pipPendingScanStats.threadWalks;
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    // 6821ad0caa: 2 (the pass after a one-cursor edit went through every stored cursor of the new state, then of the one it held)
    expect(seen.listings()).toBe(0);
    // 6821ad0caa: 1 (the whole text parsed again to find the one cursor)
    expect(seen.parses()).toBe(0);
    // of the 1,000 stored cursors the pass read the moved one, and no other
    expect(seen.names()).toEqual([threads[501]]);
    expect(roster.threads()).toEqual([threads[501]]);
    expect(pipPendingScanStats.threadWalks).toBe(walks + 1);
  } finally { seen.stop(); }
}, 240_000);

it("W23 a table this connection makes (the schema moves, no memory row does): a commit elsewhere does not read every thread again", async () => {
  const roster = countedRoster();
  const { deps } = bot(300, roster);
  const db = database();
  db.exec("CREATE TABLE worker_scratch (n INTEGER NOT NULL)");
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const feedRow = () => JSON.stringify(db.prepare("SELECT * FROM temp.memory_pending_feed WHERE id=1").get());
  const row = feedRow();
  db.exec("CREATE TABLE made_late (n INTEGER NOT NULL)");
  expect(feedRow()).toBe(row); // no row of the feed moved
  clock += 61_000;
  expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
  const wide = pendingFeedStats.wide;
  const after = await unrelatedCommits(deps, roster);
  // 1977a62606: all 300 threads again (the schema version in the fingerprint was this connection's own change)
  expect(after.walks).toBe(0);
  expect(after.asked).toEqual([]);
  expect(pendingFeedStats.wide).toBe(wide);
  expect(after.placed).toBe(3); // each commit was looked at
});

it("W24 what the writer says of an edit is taken only when it is the whole account: joined edits, an exclusion, a row written elsewhere, a rollback", async () => {
  const roster = countedRoster();
  const { deps, threads } = bot(300, roster);
  const db = database();
  mutateReflect("moss", state => {
    for (const thread of threads) state.threads[thread] = { cursorMessageId: null, cursorAt: 1, lastRunAt: 0, surprise: 0, unreflected: [] };
    state.excludedThreads = [threads[3]!];
  });
  const seen = countedStates();
  /** the threads the next pass asks the roster about (each a settled reply: asked again when its cursor moved), in order of name */
  const asked = async () => {
    clock += 61_000;
    roster.reset(); seen.reset();
    expect(await pipReflectPendingSliced(deps, 0)).toBeUndefined();
    return roster.threads().sort();
  };
  try {
    expect((await asked()).length).toBe(149); // every thread with a settled reply and no owner turn, but the excluded one
    // two edits before one pass: both cursors, still with no stored cursor listed
    mutateReflect("moss", state => { state.threads[threads[5]!]!.cursorAt = 2; });
    mutateReflect("moss", state => { state.threads[threads[11]!]!.cursorAt = 2; });
    expect(await asked()).toEqual([threads[11], threads[5]].sort());
    expect(seen.listings()).toBe(0);
    // an exclusion lifted moves no cursor: the thread is read (it never was), with no stored cursor listed
    mutateReflect("moss", state => { state.excludedThreads = []; });
    expect(await asked()).toEqual([threads[3]]);
    expect(seen.listings()).toBe(0);
    // (the account of the edit before was taken: the one left now begins at the text the check holds, and ends at a text never committed)
    // an edit that was rolled back, then a cursor moved by another process: the rolled-back cursor is not believed, the other is found
    db.exec("BEGIN");
    mutateReflect("moss", state => { state.threads[threads[13]!]!.cursorAt = 2; });
    db.exec("ROLLBACK");
    stateWrittenElsewhere(state => { state.threads[threads[15]!]!.cursorAt = 2; });
    expect(await asked()).toEqual([threads[15]]);
    // another process moved a cursor, then this one moved another: the writer's account begins after the first, so the states are compared whole
    stateWrittenElsewhere(state => { state.threads[threads[7]!]!.cursorAt = 2; });
    mutateReflect("moss", state => { state.threads[threads[9]!]!.cursorAt = 2; });
    expect(await asked()).toEqual([threads[7], threads[9]]);
    // an edit that goes through every cursor is more than names can tell: compared whole, and right
    mutateReflect("moss", state => { for (const cursor of Object.values(state.threads)) if (cursor.cursorAt === 2) cursor.cursorAt = 3; });
    expect(await asked()).toEqual([threads[11], threads[15], threads[5], threads[7], threads[9]].sort());
    // and nothing is left over: a quiet pass asks nothing
    expect(await asked()).toEqual([]);
  } finally { seen.stop(); }
}, 240_000);
