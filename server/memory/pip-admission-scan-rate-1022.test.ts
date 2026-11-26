// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1022, witness W-SOURCES-SCAN-RATE. Field log, one idle minute under a 1 MB/min background budget: the thread page statement of
// pip-admission.ts threadSourcePageSql ran 3,907 times. A reflection pass (pip-reflect.ts runPipReflect) reads the candidate threads whole,
// then the chosen thread's snapshot, and only then asks for its first write; the background write gate refused that write (BG_DEFERRED),
// nothing was recorded, the pending check kept answering "pending" from its memory, and every sweep read the whole history again.
// These rows drive the real idle-lane entry (index.ts onContinuity: the sliced pending check, then the run) on a real store and count the
// page statements really executed on the connection. The write gate is stood in for at the connection, where the real one refuses
// (database.ts transaction: BEGIN IMMEDIATE throws BgDeferred); nothing of the code under test is replaced.
import { mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BgDeferred, isBgDeferred } from "../bg-admission.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { pipReflectPendingSliced, pipRefusedPassStats, readReflectState, resetPipPendingScans, runPipReflect, type ReflectDeps, type ReflectOutcome } from "./pip-reflect.ts";
import { captureStoredMessage } from "./testing/captured-message.ts";

const T0 = 1_760_000_000_000, MIN = 60_000, HOUR = 60 * MIN, THREAD = "private";
let clock = T0;
const restore: Array<() => void> = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetPipPendingScans(); clock = T0 + 24 * HOUR; });
afterEach(() => { for (const undo of restore.splice(0)) undo(); setMemoryCaptureRoster(null); });

const owner = (id: string, at: number) => ({ id, at, role: "user", kind: "text", text: `Please keep it short (${id}).`, origin: "desktop" }) as never;
const reply = (id: string, at: number) => ({ id, at, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } }) as never;
const completeJobs = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100 WHERE status<>'complete'");

/** One Continuity bot whose own thread holds `pairs` owner turns, each answered: 2 x pairs text sources, the newest a settled reply, every
 *  owner turn admissible and none reflected yet (no cursor). Its route cannot reflect, so an admitted pass ends at its first writes. */
function store(pairs: number): ReflectDeps {
  const roster = { bots: [{ id: "moss", threadId: THREAD, tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
  reconcileMemoryRoster(roster as never); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  const db = database();
  db.exec("PRAGMA synchronous=OFF");
  db.exec("BEGIN");
  for (let n = 0; n < pairs; n++) {
    const name = String(n).padStart(4, "0");
    captureStoredMessage(db, THREAD, owner(`o-${name}`, T0 + n * MIN));
    captureStoredMessage(db, THREAD, reply(`b-${name}`, T0 + n * MIN + 1_000));
  }
  db.exec("COMMIT");
  completeJobs();
  return {
    now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: "/tmp", memoryMode: () => "active",
    bots: () => [{ id: "moss", name: "Moss", threadIds: [THREAD], continuity: true, options: { reflect: true } as never }],
    resolveRoute: async () => ({ fingerprint: "fp-stub", engine: "Stub", kind: "cli", model: "m", unsupported: { reason: "no-text-only-turn" } }),
  } as unknown as ReflectDeps;
}
/** The background write gate, at the place the real one refuses a memory pass: the BEGIN IMMEDIATE of its first transaction. */
function writeGate(db: DatabaseSync) {
  const gate = { shut: false, refusals: 0 }, real = db.exec;
  db.exec = function (this: DatabaseSync, sql: string) {
    if (gate.shut && /^\s*BEGIN IMMEDIATE\b/i.test(sql)) { gate.refusals++; throw new BgDeferred(60_000); }
    return real.call(this, sql);
  } as typeof db.exec;
  restore.push(() => { db.exec = real; });
  return gate;
}
/** The thread page statement (pip-admission.ts threadSourcePageSql `page`, the field log's top statement), by its text. */
const isPage = (sql: string) => sql.startsWith("SELECT s.rowid AS pos,s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,v.payload FROM memory_sources s");
/** Counts every execution of the page statement on the connection and keeps the message ids its rows carried. Each call goes to the real
 *  statement; a statement object handed out twice is wrapped once. */
function countPages(db: DatabaseSync) {
  const real = db.prepare, wrapped = new WeakSet<object>(), seen = new Set<string>();
  let runs = 0;
  db.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]): StatementSync {
    const statement = (real as (...args: unknown[]) => StatementSync).call(this, sql, ...rest);
    if (!isPage(sql) || wrapped.has(statement)) return statement;
    wrapped.add(statement);
    const all = statement.all as (...args: unknown[]) => Array<Record<string, unknown>>;
    (statement as unknown as Record<string, unknown>).all = (...args: unknown[]) => {
      runs++;
      const rows = all.apply(statement, args);
      for (const row of rows) seen.add(String(row.message_id));
      return rows;
    };
    return statement;
  } as typeof db.prepare;
  restore.push(() => { db.prepare = real; });
  return { runs: () => runs, seen };
}
/** One sweep of the idle lane, as index.ts onContinuity runs it: the sliced pending check, then the run for the bot it names. "deferred"
 *  when the pass ended on the write gate's refusal (worker-controller.ts logs it and comes back later). */
async function tick(deps: ReflectDeps): Promise<ReflectOutcome | "deferred" | "nothing-pending"> {
  const signal = new AbortController().signal;
  try {
    const botId = await pipReflectPendingSliced(deps, undefined, signal);
    if (!botId) return "nothing-pending";
    return await runPipReflect(deps, botId, signal);
  } catch (error) {
    if (isBgDeferred(error)) return "deferred";
    throw error;
  }
}

it("W-SOURCES-SCAN-RATE: 200 sweeps over 1,000 sources with the write gate shut read the thread once; a source captured later is read by the next admitted sweep", async () => {
  const deps = store(500), db = database();
  expect(Number(db.prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE thread_id=? AND kind='text'").get(THREAD)!.n)).toBe(1_000);
  const gate = writeGate(db), pages = countPages(db);
  gate.shut = true;
  // the first refused pass is the unfixed one: the whole thread, several times over, then the refusal
  expect(await tick(deps)).toBe("deferred");
  const first = pages.runs();
  expect(first).toBeGreaterThanOrEqual(Math.ceil(1_000 / 64));
  expect(gate.refusals).toBeGreaterThanOrEqual(1);
  // 199 more sweeps, one a second (more than three minutes: the floor passes several times, and the gate, asked first, still refuses)
  for (let n = 1; n < 200; n++) {
    clock += 1_000;
    expect(await tick(deps)).toBe("deferred");
  }
  // unfixed: 200 x `first` executions (every sweep walks the thread again); fixed: the one pass
  expect(pages.runs()).toBe(first);
  expect(pipRefusedPassStats.held + pipRefusedPassStats.refused).toBe(199);
  expect(pipRefusedPassStats.refused).toBeGreaterThanOrEqual(1);
  // long after every floor, the gate still shut: asked first, no thread read
  clock += 2 * HOUR;
  expect(await tick(deps)).toBe("deferred");
  expect(pages.runs()).toBe(first);
  expect(readReflectState(db, "moss").lastFingerprint).toBeUndefined();

  // the gate opens and one more owner turn (and its reply, settled) is captured: the very next sweep, a second later and well inside the
  // floor the last refusal left, starts the pass again because what it reads moved, and its pages carry the new source
  gate.shut = false;
  captureStoredMessage(db, THREAD, owner("o-new", clock - 30 * MIN));
  captureStoredMessage(db, THREAD, reply("b-new", clock - 29 * MIN));
  completeJobs();
  expect(pages.seen.has("o-new")).toBe(false);
  clock += 1_000;
  const outcome = await tick(deps);
  expect(outcome).toMatchObject({ status: "refused", reason: "unsupported" });
  expect(pages.seen.has("o-new")).toBe(true);
  expect(pages.runs()).toBeGreaterThan(first);
  // the pass wrote: the route is recorded, and the lane is held by its own record from here on
  expect(readReflectState(db, "moss").lastFingerprint).toBe("fp-stub");
}, 180_000);

it("W-SOURCES-SCAN-RATE: a refused pass is not lost: with nothing new, it runs once the floor has passed and the gate admits it", async () => {
  const deps = store(100), db = database();
  const gate = writeGate(db), pages = countPages(db);
  gate.shut = true;
  expect(await tick(deps)).toBe("deferred");
  const first = pages.runs();
  expect(first).toBeGreaterThan(0);
  // the gate opens, nothing else moved: inside the floor the pass is not started (the refusal named a minute)
  gate.shut = false;
  clock += 1_000;
  expect(await tick(deps)).toBe("deferred");
  expect(pages.runs()).toBe(first);
  // after it, the same pass from the start, admitted this time
  clock += 61_000;
  expect(await tick(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  expect(pages.runs()).toBeGreaterThan(first);
  expect(readReflectState(db, "moss").lastFingerprint).toBe("fp-stub");
}, 120_000);
