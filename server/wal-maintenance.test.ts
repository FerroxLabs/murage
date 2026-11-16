import { Worker } from "node:worker_threads";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The write-ahead log of messages.db is copied and shrunk without any connection but the server's ever holding the writer
// lock (wal-maintenance.ts). Invariants I1 to I5 of the 1.0.2 design are each pinned here.
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { ioBudget, setAdmissionClockOffsetForFixture } from "./io-budget.ts";
import { JOURNAL_SIZE_LIMIT_BYTES, closeDatabase, database } from "./database.ts";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, resumeEngineHistory, runEngineHistoryOffThread, stopEngineHistory } from "./engine-history-offthread.ts";
import { stopDataWriters } from "./data-writers.ts";
import { appendMessage, closeMessageDb } from "./message-db.ts";
import { maintainLineageStorage } from "./memory/root-set-compaction.ts";
import type { Message } from "./store.ts";
import { checkpointPassive, readWalHeader, scrubWalAfterDelete, settleWal, startWalMaintenance, stopWalMaintenance, walMark, walMaintenanceReady, walMaintenanceTestHooks, walScrubPending, walScrubbed, type WalPass } from "./wal-maintenance.ts";
import { installWalBarrier } from "./testing/wal-barrier.ts";
import { searchCleanupPending, stopSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// Every checkpointer this file starts carries the test barrier (parked only when armed; bounded by its own deadline). Production workers get none.
const barrier = installWalBarrier();
const messagesFile = () => join(DATA_DIR, "messages.db");
const walFile = () => `${messagesFile()}-wal`;
const fileHas = (file: string, text: string) => existsSync(file) && readFileSync(file).includes(text);
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
const message = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: Date.now() });
const MB = 1024 * 1024;

// The admission ledger works in wall-clock minutes (admission-shared.ts), so a run is only repeatable if the second of the
// minute it starts at is chosen. WAL_TEST_START_SECOND=S starts the whole file at second S of the ledger's minute (a minute
// rollover then falls at a known point of the run); without it every test starts at second 10, 45 s clear of a rollover.
const START_SECOND = process.env.WAL_TEST_START_SECOND;
function pinAdmissionClock(second: number) { setAdmissionClockOffsetForFixture(((second * 1000 - (Date.now() % 60_000)) % 60_000 + 60_000) % 60_000); }
if (START_SECOND !== undefined) pinAdmissionClock(Number(START_SECOND));
afterAll(() => setAdmissionClockOffsetForFixture(0));
beforeEach(async () => {
  if (START_SECOND === undefined) pinAdmissionClock(10);
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  barrier.setHoldMs(0); walMaintenanceTestHooks.retryMs = 30_000; walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; walMaintenanceTestHooks.unreadableReads = 0;
  unhandled.length = 0; process.on("unhandledRejection", onUnhandled);
  // The search reset has its own genesis commit. Finish it before measuring
  // messages-WAL nudges so the two independent workers do not alter the oracle.
  const db = database();
  await vi.waitFor(() => expect(searchCleanupPending(db)).toBe(false), { timeout: 10000, interval: 10 });
  await stopSearchIndex();
  await settleWal({ nudge: true });
});
afterEach(async () => {
  ioBudget.stop(); vi.useRealTimers();
  process.off("unhandledRejection", onUnhandled);
  walMaintenanceTestHooks.paceTrace = null; walMaintenanceTestHooks.paceGen = null;
  barrier.setHoldMs(0); walMaintenanceTestHooks.retryMs = 30_000; walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; walMaintenanceTestHooks.unreadableReads = 0;
  for (const key of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[key];
  resumeEngineHistory();
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
});

/** The app's connection, with the checkpointer thread up (the autocheckpoint is handed over once it is ready). */
async function ready() {
  const db = database();
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  await vi.waitFor(() => expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(0), { timeout: 10_000 });
  return db;
}
/** A table of fillers and one text; one transaction, so the log grows by that much. */
function fill(db: DatabaseSync, megabytes: number, text?: string, thread = "t1") {
  db.exec("CREATE TABLE IF NOT EXISTS canary(thread_id TEXT, body BLOB)");
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO canary VALUES(?, randomblob(?))");
  for (let index = 0; index < megabytes; index++) insert.run("filler", MB);
  if (text) db.prepare("INSERT INTO canary VALUES(?, ?)").run(thread, text);
  db.exec("COMMIT");
}
/** Longest gap between two ticks of the event loop while `work` runs, and the largest single stall of a synchronous step. */
async function loopDelayDuring(work: () => Promise<void>) {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  try { await work(); } finally { histogram.disable(); }
  return histogram.max / 1e6;
}

it("deleted text leaves messages.db and its log within 5 s (canary)", async () => {
  const db = await ready();
  const canary = `CANARY-${crypto.randomUUID()}`;
  db.exec("PRAGMA wal_autocheckpoint=0");
  fill(db, 2, canary, "gone");
  expect(fileHas(walFile(), canary)).toBe(true);
  const before = walMark(walFile());
  const deletions = new ConversationDeletions({ dataDir: DATA_DIR, database });
  const started = performance.now();
  await runConversationDeletion(deletions, { threadIds: ["gone"] }, () => { db.prepare("DELETE FROM canary WHERE thread_id='gone'").run(); return true; });
  expect(performance.now() - started).toBeLessThan(5000);
  expect(fileHas(messagesFile(), canary)).toBe(false);
  expect(fileHas(walFile(), canary)).toBe(false);
  expect(walScrubbed(walFile(), before)).toBe(true);
  expect(walScrubPending()).toBe(false);
  expect(db.prepare("SELECT count(*) AS n FROM canary WHERE thread_id='filler'").get()?.n).toBe(2); // nothing else was lost
});

it("the nudge is one page-1 frame, and it restarts a fully copied log", async () => {
  const db = await ready();
  fill(db, 3);
  const before = walMark(walFile());
  expect(readWalHeader(walFile()).frames).toBeGreaterThan(100);
  expect(await settleWal()).toBe(true);
  expect(walScrubbed(walFile(), before)).toBe(false); // copied but not restarted: the old frames are still in the file
  expect(await settleWal({ nudge: true })).toBe(true);
  const state = readWalHeader(walFile());
  expect(state.frames).toBe(1);
  expect(walScrubbed(walFile(), before)).toBe(true);
});

it("a reader that pins the log holds the scrub back without stalling the app, and the timer finishes it once the reader is gone", async () => {
  const db = await ready();
  fill(db, 1, "pinned-before");
  const reader = new DatabaseSync(messagesFile());
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM canary").get();
  const canary = `CANARY-${crypto.randomUUID()}`;
  fill(db, 1, canary, "gone");
  db.prepare("DELETE FROM canary WHERE thread_id='gone'").run();
  const before = walMark(walFile());
  walMaintenanceTestHooks.retryMs = 100;
  let longest = 0;
  const tick = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  let last = performance.now();
  const outcome = await scrubWalAfterDelete(600);
  clearInterval(tick);
  expect(outcome).toBe(false);
  expect(walScrubbed(walFile(), before)).toBe(false);
  expect(walScrubPending()).toBe(true);
  expect(longest).toBeLessThan(50 + 25); // the loop never waited on the lock (timer slack included)
  reader.exec("COMMIT"); reader.close();
  await vi.waitFor(() => { expect(walScrubPending()).toBe(false); expect(walScrubbed(walFile(), before)).toBe(true); }, { timeout: 15_000 });
  expect(fileHas(walFile(), canary)).toBe(false);
});

it("main-thread writes all commit with no BUSY while the worker copies a log of 200 MB (REPORTED, Sean 11-08)", { tags: ["perf-budget"] }, async () => {
  const db = await ready();
  fill(db, 200);
  expect(statSync(walFile()).size).toBeGreaterThan(200 * MB);
  barrier.setHoldMs(1500); // the worker also sits on its answer afterwards
  const copying = checkpointPassive();
  const slowest: number[] = [];
  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    appendMessage("busy-thread", message(`m${index}`, `hello ${index}`));
    slowest.push(performance.now() - started);
  }
  const sorted = [...slowest].sort((a, b) => a - b);
  console.log(`[c2-commit200 reported, Sean 11-08] maxMs=${sorted[sorted.length - 1]!.toFixed(2)} p99Ms=${sorted[Math.floor(sorted.length * 0.99)]!.toFixed(2)} p50Ms=${sorted[100]!.toFixed(2)} commits=${sorted.length} slowIndexes=${slowest.map((ms, i) => [ms, i] as const).filter(([ms]) => ms > 50).map(([ms, i]) => `${i}:${ms.toFixed(0)}`).join(",")} backlogKiB=${walMaintenanceCounters()?.backlogKiB} passDone=${walMaintenanceCounters()?.passDone}`);
  // REPORTED, not enforced (Sean 11-08, C2-FSYNC-DEBT-RULING part 3, Option 1 extended): this log is ONE 200 MB transaction, so the worker's single
  // db flush of that copy cannot be split, and main's next commits can wait behind it. The 50 ms bound is enforced by T-DEBT-STALL (4 MB commits).
  // Was: expect(Math.max(...slowest)).toBeLessThan(50);
  expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id='busy-thread'").get()?.n).toBe(200);
  const result = await copying;
  expect(result.log).toBeGreaterThan(0);
  expect(unhandled).toEqual([]);
});

it("a checkpointer that dies mid-job leaves no rejection: the job answers busy, the scrub says not done, the app's own checkpoints return", async () => {
  const db = await ready();
  fill(db, 2, "x", "gone");
  barrier.setHoldMs(3000);
  const job = checkpointPassive();
  const scrub = scrubWalAfterDelete(400);
  await new Promise(resolve => setTimeout(resolve, 100));
  walMaintenanceTestHooks.terminate();
  expect((await job).busy).toBe(1);
  // With the checkpointer gone the scrub says not done and stays owed; the restarted checkpointer finishes it later.
  const scrubbed = await scrub;
  expect(walScrubPending()).toBe(!scrubbed);
  expect(await settleWal({ nudge: true })).toBe(false);
  await vi.waitFor(() => expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(0), { timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(unhandled).toEqual([]);
});

it("a checkpointer that cannot start leaves the connection on its own autocheckpoint", async () => {
  const calls: number[] = [];
  startWalMaintenance(join(DATA_DIR, "no-such-folder", "messages.db"), { setAutocheckpoint: pages => { calls.push(pages); }, nudge: async () => false });
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 10_000 });
  expect(calls.every(n => n === 0)).toBe(true);
  expect(walMaintenanceReady()).toBe(false);
  expect(await settleWal({ nudge: true })).toBe(false);
  expect(await scrubWalAfterDelete(100)).toBe(false);
  expect(unhandled).toEqual([]);
});

it("closing the database leaves a large log in place at once; the checkpointer's own close is the last one and removes it", async () => {
  const db = await ready();
  fill(db, 100);
  expect(statSync(walFile()).size).toBeGreaterThan(50 * MB);
  const started = performance.now();
  closeMessageDb();
  expect(performance.now() - started).toBeLessThan(50);
  expect(existsSync(walFile())).toBe(true);
  expect(await stopWalMaintenance()).toBe(true);
  expect(existsSync(walFile())).toBe(false);
  expect(await stopWalMaintenance()).toBe(true); // idempotent
  const reopened = new DatabaseSync(messagesFile());
  expect(reopened.prepare("SELECT count(*) AS n FROM canary").get()?.n).toBe(100);
  reopened.close();
});

it("a checkpointer that does not exit in time is reported as still alive, so the lease stays", async () => {
  await ready();
  barrier.setHoldMs(5000);
  void checkpointPassive();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await stopWalMaintenance(0, 0)).toBe(false); // no time to exit: the answer is "still alive", not a guess
  expect(await stopWalMaintenance(3000, 3000)).toBe(true); // given time, the stuck thread is ended and its real exit awaited
});

/** Who takes the admission ledger lock, and why a settle can be refused (read from the product, not guessed):
 * the checkpointer thread holds it for each copy (beginCopy and endCopy, wal-maintenance.ts worker, admission-shared.ts beginCopy/endCopy), a few microseconds each;
 * the main thread reads the ledger with ONE non-blocking compare-exchange (admission-shared.ts lock(): the main thread never waits), and every copied pass the
 * main thread receives triggers such a read (wal-maintenance.ts handler -> ioBudget.backfilled -> io-budget.ts readingOrNull -> admissionReading). That read
 * overlaps the worker's NEXT beginCopy exactly when a second pass was queued behind the first (a requested pass behind a timed one, or a deferred timed pass).
 * A missed read fails closed (io-budget.ts admissionReading: noteLockTimeout, slot 7 = 1) and the strict idle rule then refuses the checkpointer's copy
 * (admission-shared.ts beginCopy: idle && total + reserved + ceiling > 1 MiB - 64 KiB returns null), so that pass answers busy 1, log -1 and settleWal answers false.
 * The product retries by itself: the next successful main-thread read (io-budget.ts admissionReading, the line that republishes the idle verdict into slot 7;
 * it runs on every copied pass and on every admission call) clears the strict rule, and the checkpointer's own retry rule (worker poll: due ||= retrying &&
 * now - lastAt >= dueMs) offers the copy again. */
async function quietWorker(ticks: PaceTick[], delivered: { id: number; at: number }) {
  // The two fixture steps that make a first-try settle deterministic: (1) the worker is idle and nothing is owed, judged on the worker's own tick records after the
  // last delivered pass; (2) one requested pass is drained and the main thread reads the ledger in the same continuation, while the worker provably holds no lock.
  // After that the only pass in flight is the settle's own, and the main thread reads again only when that pass has finished.
  {
    await vi.waitFor(() => {
      const counters = stepCounters();
      expect(counters.running).toBe(0);
      expect(counters.passSeq).toBe(delivered.id); // every pass the worker started has been delivered (and its main-thread read done)
      expect(ticks.length).toBeGreaterThan(delivered.at); // a tick the worker made after the last delivered pass ...
      const last = ticks[ticks.length - 1]!;
      expect(last.work || last.changed || last.timed || last.started).toBe(false); // ... saw nothing owed
    }, { timeout: 30_000, interval: 5 });
    await checkpointPassive();
    expect(ioBudget.copyRoom(), "the main thread's read of the ledger succeeded (not a miss)").toBeGreaterThan(0);
  }
}
it("50 cycles of a 5 MB transaction and a settle keep the log under twice the largest transaction (no injected miss: every settle answers true on its first try)", { timeout: 300_000 }, async () => {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const db = await stepReady();
  const delivered = { id: 0, at: 0 };
  const stop = onWalPass(pass => { delivered.id = Math.max(delivered.id, pass.id); delivered.at = ticks.length; });
  const missesBefore = ioBudget.admissionHealth().lockTimeouts;
  let largest = 0;
  try {
    for (let cycle = 0; cycle < 50; cycle++) {
      fill(db, 5);
      largest = Math.max(largest, statSync(walFile()).size);
      await quietWorker(ticks, delivered);
      expect(await settleWal({ nudge: true }), `cycle ${cycle}: the settle answers true on its first try`).toBe(true);
      expect(statSync(walFile()).size).toBeLessThan(2 * largest);
    }
  } finally { stop(); }
  console.log(`[settle] 50 cycles, first-try settles, admission lock misses seen by the main thread: ${ioBudget.admissionHealth().lockTimeouts - missesBefore}`);
  expect(largest).toBeLessThan(2 * 5 * MB * 1.1);
  const final = statSync(walFile()).size;
  expect(final).toBeLessThan(64 * 1024);
});

it("T-SETTLE-MISS-RETRY: exactly one admission-lock miss refuses the copy once, and the product's own next 25 ms timer invocation (io-budget.ts readingOrNull timer path republishing the idle verdict) lets the next settle through", { timeout: 60_000 }, async () => {
  const db = await stepReady();
  const buffer = ioBudget.checkpointAdmissionBuffer(), slots = new BigInt64Array(buffer); // this call is itself a ledger read
  const flag = new Int32Array(new SharedArrayBuffer(4));
  // Frames owed and every pass parked before its copy: the worker holds no lock while the miss is injected.
  barrier.holdGate(true);
  fill(db, 5);
  const holder = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    const flag = new Int32Array(workerData.flag);
    ledger.lock(); parentPort.postMessage("held"); Atomics.wait(flag, 0, 0, 20000); ledger.unlock(); parentPort.postMessage("released");`,
  { eval: true, workerData: { buf: slots.buffer, src: checkpointLedger.toString(), flag: flag.buffer } });
  try {
    await new Promise<void>((resolve, reject) => { holder.once("message", () => resolve()); holder.once("error", reject); });
    // The product timer path only (design D3: no copyRoom call): fake intervals are installed BEFORE the budget starts, so the 25 ms admission read runs only when this test advances time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ioBudget.start();
    const before = ioBudget.admissionHealth();
    expect(slots[7], "idle verdict before the miss").toBe(0n);
    vi.advanceTimersByTime(25); // exactly one scheduled invocation: ONE compare-exchange, and it misses
    const after = ioBudget.admissionHealth();
    expect(after.lockTimeouts - before.lockTimeouts, "exactly one miss").toBe(1);
    expect(after.lastTimeoutSite).toBe("timer");
    expect(slots[7], "a miss fails closed: the strict idle rule is on").toBe(1n);
  } finally {
    Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
    await new Promise<void>(resolve => { holder.once("message", () => resolve()); holder.once("exit", () => resolve()); });
    await holder.terminate();
  }
  const misses = ioBudget.admissionHealth().lockTimeouts;
  // The strict rule refuses the checkpointer's copy: the settle that lands in that window is refused (this is the failure the 50-cycle test used to meet by chance).
  // Exclude the foreground buffer-read publisher during the window: only the product timer may clear the missed verdict.
  const bufferRead = vi.spyOn(ioBudget, "checkpointAdmissionBuffer").mockReturnValue(buffer);
  try {
    const refused = settleWal({ nudge: true });
    barrier.holdGate(false);
    expect(await refused, "refused while the miss stands").toBe(false);
    expect(walMaintenanceTestHooks.lastResult()?.log, "the pass was refused before copying (no ticket)").toBe(-1);
    expect(ioBudget.admissionHealth().lockTimeouts, "no second miss").toBe(misses);
  } finally { bufferRead.mockRestore(); }
  // The next read, through the product's own call (the same admissionReading the 25 ms timer and every copied pass run): the verdict is republished and the next settle copies.
  vi.advanceTimersByTime(25); // the next scheduled invocation of the product timer republishes the verdict
  expect(slots[7], "the idle verdict is republished").toBe(0n);
  expect(ioBudget.admissionHealth().lockTimeouts, "the republishing invocation did not miss").toBe(misses);
  ioBudget.stop(); vi.useRealTimers();
  expect(await settleWal({ nudge: true }), "settled on the next read").toBe(true);
  expect(ioBudget.admissionHealth().lockTimeouts, "still exactly the one injected miss").toBe(misses);
  expect(statSync(walFile()).size).toBeLessThan(64 * 1024);
});

it("no connection of the server process runs TRUNCATE or RESTART on messages.db after it listens, and nothing sleeps the main thread", () => {
  // Files that may name a TRUNCATE checkpoint, and why each is not a post-listen writer-lock hold on messages.db:
  const allowed = new Set([
    "database.ts",                      // before listen (start-up)
    "sqlite-checkpoint.ts",             // the helper itself; engine databases only
    "engine-exec.ts",                   // engine databases, run in a worker thread
    "installation-memory-downgrade.ts", // offline downgrade
    "memory/age-index.ts",              // 1.0.3 lane 2: downgradeMemoryIndexFile, the offline downgrade step's memory-index.db (never messages.db)
    "memory/root-set-compaction.ts",    // start-up conversion and reclaim, before listen
    "memory/schema.ts",                 // migration, before listen
    "memory/index.ts",                  // the memory child process's own file
    "memory/root-set-reclaim.ts",       // 1.0.2: idle-gated (10 min), sliced batches in a worker on its own connection; the one VACUUM holds owner writes asynchronously
    "memory/revoke-budget.ts",         // server/memory/revoke-budget.ts:379 (resetCopiedLogFenced): ruling-1 exception, wal-maintenance.ts header :14-17. Only that one own-copy reset; it runs only after walResetFence().enter() is true.
    "search-index-worker.ts",         // search.db only: dedicated off-thread writer
    "message-search-index.ts",         // 1.0.18 option A (451cce9e5): settleInheritedSearchMerge, called only from database() (database.ts:350), runs on every open; only its optimize and TRUNCATE wait on a pre-release search_merge marker and on the first open (before listen). A reopen after listen (a restore or data-dir switch) restores the merge config only and keeps the marker for the next start. busy_timeout=0 bounds only the lock wait (the checkpoint I/O itself is synchronous, as database.ts:211-213 notes for the open path)
    "memory/revoke-budget.ts",         // 1.0.18 IO-IDLE-DRAIN r3.6c (MurageMain ruling 1, named in wal-maintenance.ts): the revoke drain's own reset, resetCopiedLog, the one server-thread TRUNCATE. It runs only on a log it has re-read as completely copied (nBackfill >= mxFrame, same salt, same mxFrame), outside a transaction, under busy_timeout=0 restored in a finally, so there is nothing to copy and it never waits on a reader or a writer; the writer lock is held only for the reset. The two expects below pin that shape
  ]);
  const root = fileURLToPath(new URL(".", import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!["node_modules", "testing"].includes(entry.name)) walk(path); continue; }
      if (!/\.(ts|mjs)$/.test(entry.name) || /\.(test|bench)\./.test(entry.name)) continue;
      const text = readFileSync(path, "utf8");
      if (/wal_checkpoint\(\s*(TRUNCATE|RESTART)|checkpointTruncate\(|truncateWal\b/.test(text)) found.push(path.slice(root.length).replace(/\\/g, "/")); // '/' on every platform, as the allow list is written
    }
  };
  walk(root);
  expect(found.filter(file => !allowed.has(file))).toEqual([]);
  expect(found.some(file => file === "memory/root-set-compaction.ts")).toBe(true);
  expect(readFileSync(join(root, "memory/root-set-compaction.ts"), "utf8")).not.toMatch(/truncateWal/);
  // The revoke drain's reset is the only TRUNCATE in that file, runs only after the log was proven copied, and waits on nothing.
  const revoke = readFileSync(join(root, "memory/revoke-budget.ts"), "utf8");
  expect(revoke.match(/wal_checkpoint\(\s*(TRUNCATE|RESTART)/g)).toHaveLength(1);
  expect(revoke).toMatch(/PRAGMA busy_timeout=0[\s\S]*nBackfill < again\.mxFrame[\s\S]*wal_checkpoint\(TRUNCATE\)/);
  for (const file of ["wal-maintenance.ts", "engine-history-offthread.ts", "engine-history-worker.ts"]) expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/Atomics\.wait|execSync|spawnSync/);
});

it("every promise the module hands out resolves, even with no checkpointer running", async () => {
  await stopWalMaintenance();
  expect(await checkpointPassive()).toMatchObject({ busy: 1 });
  expect(await settleWal({ nudge: true })).toBe(false);
  expect(await scrubWalAfterDelete(50)).toBe(false);
  expect(await stopWalMaintenance()).toBe(true);
  expect(walScrubbed(join(DATA_DIR, "absent-wal"), null)).toBe(true);
  expect(unhandled).toEqual([]);
});

const SCALE_MB = Number(process.env.WAL_SCALE_MB ?? 256);
it(`a ${SCALE_MB} MB log with a writer every 10 ms: deletion scrub and idle sweep leave the loop free and lose no write`, { tags: ["perf-budget"], timeout: 600_000 }, async () => {
  const db = await ready();
  db.exec("CREATE TABLE IF NOT EXISTS beat(n INTEGER)");
  const canary = `CANARY-${crypto.randomUUID()}`;
  // One transaction, so the checkpointer has nothing to copy until it commits; the copy for the baseline is taken before the
  // event loop turns again.
  fill(db, SCALE_MB, canary, "gone");
  const walBytes = statSync(walFile()).size;
  expect(walBytes).toBeGreaterThan(SCALE_MB * MB * 0.9);
  const copyDir = mkdtempSync(join(tmpdir(), "murage-wal-scale-"));
  const copyFile = join(copyDir, "messages.db");
  copyFileSync(messagesFile(), copyFile); copyFileSync(walFile(), `${copyFile}-wal`);
  db.prepare("DELETE FROM canary WHERE thread_id='gone'").run();
  let baselineMs = 0;
  try {
    // the 1.0.1 way on a copy of the same fixture: TRUNCATE on the server connection holds the writer for the whole copy
    const old = new DatabaseSync(copyFile);
    old.exec("PRAGMA busy_timeout=1000");
    const started = performance.now();
    old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    baselineMs = performance.now() - started;
    old.close();
  } finally { removeTempDirSync(copyDir); }
  const before = walMark(walFile());
  let attempted = 0, failed = 0;
  const writer = setInterval(() => {
    attempted++;
    try { db.prepare("INSERT INTO beat VALUES(?)").run(attempted); } catch { failed++; }
  }, 10);
  let scrubbed = false;
  const delay = await loopDelayDuring(async () => {
    scrubbed = await scrubWalAfterDelete(15_000);
    await maintainLineageStorage({ database, idle: () => true, pauseMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  clearInterval(writer);
  const stored = Number(db.prepare("SELECT count(*) AS n FROM beat").get()?.n);
  console.log(`[wal-scale] wal=${Math.round(walBytes / MB)}MB loopMaxDelayMs=${delay.toFixed(1)} writes=${attempted} lost=${attempted - stored} failed=${failed} truncateBaselineMs=${Math.round(baselineMs)} scrubbed=${scrubbed}`);
  expect(failed).toBe(0);
  expect(stored).toBe(attempted);
  expect(delay).toBeLessThan(100);
  expect(scrubbed).toBe(true);
  expect(walScrubbed(walFile(), before)).toBe(true);
  expect(fileHas(walFile(), canary)).toBe(false);
  expect(fileHas(messagesFile(), canary)).toBe(false);
});


// ── r9 ─────────────────────────────────────────────────────────────────────

/** A second connection that holds the current end of the log (a read transaction), so the log cannot restart. */
function pinReader() {
  const reader = new DatabaseSync(messagesFile());
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM canary").get();
  return { release() { try { reader.exec("COMMIT"); } catch { /* done */ } reader.close(); } };
}

it("r9 finding 5: a log that cannot be read is unknown, never absent: no scrub is certified from it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "murage-wal-unreadable-"));
  try {
    // a directory where the log should be: opening works, reading fails with EISDIR (not ENOENT)
    mkdirSync(join(folder, "log"));
    const state = readWalHeader(join(folder, "log"));
    expect(state.unknown).toBe(true);
    expect(walMark(join(folder, "log"))).toBe("unknown");
    expect(walScrubbed(join(folder, "log"), null)).toBe(false);
    // a log that is really not there is still confirmed empty
    expect(readWalHeader(join(folder, "absent")).unknown).toBeUndefined();
    expect(walMark(join(folder, "absent"))).toBeNull();
    expect(walScrubbed(join(folder, "absent"), "unknown")).toBe(true);
  } finally { removeTempDirSync(folder); }

  // The report's scenario: a reader holds the latest log, PASSIVE copies everything, the nudge merely appends, and the very
  // first read of the log header fails (EMFILE). That used to certify the scrub; the text is still in the log.
  const db = await ready();
  fill(db, 1, "pinned-before");
  const reader = pinReader();
  const canary = `CANARY-${crypto.randomUUID()}`;
  fill(db, 1, canary, "gone");
  db.prepare("DELETE FROM canary WHERE thread_id='gone'").run();
  walMaintenanceTestHooks.unreadableReads = 1;
  walMaintenanceTestHooks.retryMs = 3_600_000;
  expect(await scrubWalAfterDelete(500)).toBe(false);
  expect(walScrubPending()).toBe(true);
  expect(fileHas(walFile(), canary)).toBe(true);
  expect(walScrubbed(walFile(), "unknown")).toBe(false);
  reader.release();
});

it("r9 finding 6: a scrub owed when the checkpointer dies is not forgotten; a restarted checkpointer finishes it", async () => {
  const db = await ready();
  fill(db, 1, "pinned-before");
  const reader = pinReader();
  const canary = `CANARY-${crypto.randomUUID()}`;
  fill(db, 1, canary, "gone");
  db.prepare("DELETE FROM canary WHERE thread_id='gone'").run();
  walMaintenanceTestHooks.restartDelaysMs = [50, 50, 50];
  walMaintenanceTestHooks.retryMs = 100;
  expect(await scrubWalAfterDelete(300)).toBe(false);
  expect(walScrubPending()).toBe(true);
  walMaintenanceTestHooks.terminate();
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(false), { timeout: 5000 });
  expect(walScrubPending()).toBe(true); // the worker's death took nothing with it
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 }); // a replacement came up
  expect(walScrubPending()).toBe(true);
  reader.release();
  await vi.waitFor(() => { expect(walScrubPending()).toBe(false); expect(fileHas(walFile(), canary)).toBe(false); }, { timeout: 15_000 });
  expect(unhandled).toEqual([]);
});

it("r10 finding 2: with the checkpointer dead the server thread never checkpoints; the scrub stays pending until the restarted checkpointer does it", async () => {
  const db = await ready();
  fill(db, 1, "pinned-before");
  const reader = pinReader();
  const canary = `CANARY-${crypto.randomUUID()}`;
  fill(db, 1, canary, "gone");
  db.prepare("DELETE FROM canary WHERE thread_id='gone'").run();
  const seen: string[] = [];
  const watch = (name: "prepare" | "exec") => { const original = db[name].bind(db) as (sql: string) => unknown; vi.spyOn(db, name).mockImplementation(((sql: string) => { seen.push(String(sql)); return original(sql); }) as never); };
  watch("prepare"); watch("exec");
  walMaintenanceTestHooks.restartDelaysMs = [1500]; // the checkpointer is down for a while
  walMaintenanceTestHooks.retryMs = 100;
  walMaintenanceTestHooks.terminate();
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(false), { timeout: 5000 });
  reader.release(); // nothing pins the log any more, so only the missing checkpointer is in the way
  let drift = 0, last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - last - 10); last = now; }, 10);
  const started = performance.now();
  expect(await scrubWalAfterDelete(300)).toBe(false);
  clearInterval(ticker);
  expect(performance.now() - started).toBeLessThan(900);
  expect(drift).toBeLessThan(200); // the event loop was never held by a checkpoint
  expect(seen.filter(sql => /wal_checkpoint/i.test(sql))).toEqual([]); // and no checkpoint call ran on the server connection
  expect(walScrubPending()).toBe(true);
  expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(0);
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  await vi.waitFor(() => { expect(walScrubPending()).toBe(false); expect(fileHas(walFile(), canary)).toBe(false); }, { timeout: 15_000 });
  vi.restoreAllMocks();
});

it("r10 finding 2: a checkpointer that keeps dying is restarted without an attempt limit", async () => {
  await ready();
  // The pause before each restart is longer than the polling step, so the gone checkpointer is always seen before its
  // replacement is ready (with a 30 ms pause and the 50 ms default step, a quick restart could be missed: CI 40172017933).
  walMaintenanceTestHooks.restartDelaysMs = [300];
  for (let round = 0; round < 5; round++) {
    walMaintenanceTestHooks.terminate();
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(false), { timeout: 5000, interval: 10 });
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  }
});

it("r9 finding 7: the deadline bounds a checkpointer that does not answer, and a nudge stuck behind the writer gate", async () => {
  const db = await ready();
  fill(db, 2, "x", "gone");
  barrier.setHoldMs(3000); // the worker sits on its answer
  let started = performance.now();
  expect(await scrubWalAfterDelete(150)).toBe(false);
  expect(performance.now() - started).toBeLessThan(900);
  expect(walScrubPending()).toBe(true);
  barrier.setHoldMs(0);
  await stopWalMaintenance(0, 3000);

  // a nudge that never returns (the writer gate never opens)
  let nudges = 0;
  startWalMaintenance(messagesFile(), { setAutocheckpoint: () => {}, nudge: () => { nudges++; return new Promise<boolean>(() => {}); } });
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  started = performance.now();
  expect(await scrubWalAfterDelete(200)).toBe(false);
  expect(performance.now() - started).toBeLessThan(900);
  expect(nudges).toBeGreaterThan(0);
  expect(walScrubPending()).toBe(true); // kept, not dropped, on expiry
});

it("r9 finding 7: the messages log scrub starts without waiting for the engine-history job", async () => {
  const db = await ready();
  const canary = `CANARY-${crypto.randomUUID()}`;
  db.exec("PRAGMA wal_autocheckpoint=0");
  fill(db, 2, canary, "gone");
  const data = mkdtempSync(join(tmpdir(), "murage-wal-concurrent-"));
  const desk = join(data, "workspaces", "f25024c1-a18e-4251-acf1-0c1713d9b6d9", "threads", "gone");
  mkdirSync(desk, { recursive: true });
  const silent = join(data, "silent-worker.mjs");
  writeFileSync(silent, 'import { parentPort } from "node:worker_threads"; parentPort.once("message", () => { setInterval(() => {}, 1000); });\n');
  engineHistoryTestHooks.createWorker = () => new Worker(silent); engineHistoryTestHooks.timeoutMs = 2500; // the engine job hangs until its timeout
  const home = join(data, "claude");
  mkdirSync(home);
  const deletions = new ConversationDeletions({ dataDir: data, database });
  let settled = false;
  const run = runConversationDeletion(deletions, { threadIds: ["gone"], engineHomes: [{ engine: "claude", home }] }, () => { db.prepare("DELETE FROM canary WHERE thread_id='gone'").run(); return true; }).then(result => { settled = true; return result; });
  try {
    await vi.waitFor(() => expect(fileHas(walFile(), canary)).toBe(false), { timeout: 2000 });
    expect(settled).toBe(false); // the engine job was still hanging when the log was already clean
    const { report } = await run;
    expect(report.failed).toEqual([home]);
  } finally { await run.catch(() => {}); deletions.dispose(); removeTempDirSync(data); }
});

it("r9 finding 4: shutdown refuses new engine jobs, ends the running one, and frees the lease only after the real exit of every writer", async () => {
  await ready();
  const data = mkdtempSync(join(tmpdir(), "murage-shutdown-"));
  const silent = join(data, "silent-worker.mjs");
  writeFileSync(silent, 'import { parentPort } from "node:worker_threads"; parentPort.once("message", () => { setInterval(() => {}, 1000); });\n');
  const events: string[] = [];
  let created = 0;
  const job = { homes: [{ engine: "claude" as const, home: join(data, "claude") }], folders: [], memoryFolders: [], sessions: {} };
  const running = runEngineHistoryOffThread(job, {
    createWorker: () => new Worker(silent),
    onWorker: worker => { created++; worker.on("exit", () => events.push("engine-worker-exit")); },
  });
  await vi.waitFor(() => expect(created).toBe(1), { timeout: 5000 });
  const stopped = await stopDataWriters({
    closeDatabase: () => { events.push("db-closed"); closeMessageDb(); },
    stopEngineHistory: () => { events.push("engine-stop-called"); return stopEngineHistory(100, 5000).then(done => { events.push(`engine-stopped:${done}`); return done; }); },
    stopWalMaintenance: () => { events.push("wal-stop-called"); return stopWalMaintenance().then(done => { events.push(`wal-stopped:${done}`); return done; }); },
  });
  events.push("lease-may-be-released");
  expect(stopped).toBe(true);
  expect(events[0]).toBe("engine-stop-called"); // admission closes first
  expect(events.indexOf("db-closed")).toBeLessThan(events.indexOf("wal-stop-called")); // server connection before the checkpointer's
  expect(events.indexOf("engine-worker-exit")).toBeLessThan(events.indexOf("lease-may-be-released"));
  expect(events.indexOf("engine-stopped:true")).toBeLessThan(events.indexOf("lease-may-be-released"));
  expect(events.indexOf("wal-stopped:true")).toBeLessThan(events.indexOf("lease-may-be-released"));
  expect((await running).failed).toEqual([job.homes[0]!.home]); // the interrupted job reports its home failed: the record stays
  expect(existsSync(walFile())).toBe(false); // the checkpointer really closed and removed the log
  // after shutdown began, no new worker starts
  const late = await runEngineHistoryOffThread(job, { createWorker: () => new Worker(silent), onWorker: () => { created++; } });
  expect(late.failed).toEqual([job.homes[0]!.home]);
  expect(created).toBe(1);
  removeTempDirSync(data);
});

it("r9 finding 4: a writer that is still alive keeps the lease", async () => {
  await ready();
  barrier.setHoldMs(5000);
  void checkpointPassive();
  await new Promise(resolve => setTimeout(resolve, 50));
  const kept = await stopDataWriters({ closeDatabase: closeMessageDb, stopEngineHistory: () => Promise.resolve(true), stopWalMaintenance: () => stopWalMaintenance(0, 0) });
  expect(kept).toBe(false);
  const engineAlive = await stopDataWriters({ closeDatabase: () => {}, stopEngineHistory: () => Promise.resolve(false), stopWalMaintenance: () => Promise.resolve(true) });
  expect(engineAlive).toBe(false);
});

// ── C2 r1 design A: worker-clock steps and generation-safe delivery ──────────
import { resetFenceTestHooks, resetRevokeWriteBudget, revokePaceRows, revokeWriteMeter } from "./memory/revoke-budget.ts";
import { DEBT_SYNC_BYTES, DUE_MS, STEP_BYTES, STEP_POLL_MS, lastRequestedPass, onWalPass, walMaintenanceCounters, walResetFence, type PaceTick } from "./wal-maintenance.ts";

type StepPass = Parameters<Parameters<typeof onWalPass>[0]>[0];
const stepSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function stepCounters() {
  const counters = walMaintenanceCounters();
  expect(counters).not.toBeNull();
  return counters!;
}
function stepPorts(db: DatabaseSync) {
  return {
    setAutocheckpoint(pages: number) { db.exec(`PRAGMA wal_autocheckpoint=${pages}`); },
    async nudge() {
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      db.exec(`PRAGMA user_version=${version}`);
      return true;
    },
    journalSizeLimit: () => Number(db.prepare("PRAGMA journal_size_limit").get()!.journal_size_limit),
    pinJournalSizeLimit: () => { db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}`); },
  };
}
/** Finish schema writes before starting a fresh clock: setup must not count as timed work. */
async function stepReady() {
  const db = await ready();
  db.exec("CREATE TABLE IF NOT EXISTS canary(thread_id TEXT, body BLOB); CREATE TABLE beat(n INTEGER PRIMARY KEY)");
  expect(await settleWal({ nudge: true })).toBe(true);
  startWalMaintenance(messagesFile(), stepPorts(db));
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  expect(STEP_BYTES).toBe(4 * MB);
  expect(STEP_POLL_MS).toBe(25);
  expect(DUE_MS).toBe(250);
  expect(stepCounters().timedPasses).toBe(0);
  return db;
}
/** Rules (b) and (c) fire DUE_MS after the last pass, on the next poll, and then the pass itself runs: the window is derived from the product's own
 * constants (two due periods and a poll), so it never races the rule it checks. The rule is unchanged; a missing rule still never fires inside it. */
const RULE_WINDOW_MS = 2 * DUE_MS + STEP_POLL_MS;
/** Poll shared memory without yielding to a main-thread timer or a worker message callback. */
function stepSyncUntil(predicate: () => boolean, ms: number) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const until = performance.now() + ms;
  while (!predicate() && performance.now() < until) Atomics.wait(sleeper, 0, 0, 2);
  expect(predicate()).toBe(true);
}
function stepBound() {
  const counters = stepCounters();
  expect(counters.timedPasses).toBeGreaterThan(1);
  expect(counters.maxBacklogKiB).toBeGreaterThan(0); // a disabled sampler cannot pass the bound
  expect(counters.maxBacklogKiB, `backlog sample that set the maximum: ${JSON.stringify(counters.maxSample)} walFileMaxKiB=${counters.maxWalFileKiB}`).toBeLessThan((4 * STEP_BYTES + 4 * MB) / 1024);
  console.log(`[c2-step] maxBacklogKiB=${counters.maxBacklogKiB} maxWalFileKiB=${counters.maxWalFileKiB}`); // file size is reported only
}
/** MAINBUSY only (ruling B, design doc "Mac MAINBUSY ruling"): a no-gap main-thread writer is outside the fixed bound's precondition on a host whose
 * commits are cheaper than the checkpoint copy (macOS fsync). The allowance is the fixed bound plus what the writer adds while one pass runs and one poll
 * passes: idle gaps between passes are not allowed for, so starvation or slow pacing still fails. EXPECTATION CHANGE for this test only. */
function stepBoundMainBusy(loopMs: number) {
  const counters = stepCounters();
  const writeKiBPerMs = (64 * 4 * 1024) / loopMs;
  const allowance = (4 * STEP_BYTES + 4 * MB) / 1024 + writeKiBPerMs * (counters.maxPassMs + 2 * STEP_POLL_MS);
  console.log(`[c2-step] mainbusy loopMs=${loopMs.toFixed(0)} maxPassMs=${counters.maxPassMs} timedPasses=${counters.timedPasses} maxBacklogKiB=${counters.maxBacklogKiB} allowanceKiB=${Math.round(allowance)}`);
  expect(counters.timedPasses).toBeGreaterThan(1);
  expect(counters.maxBacklogKiB).toBeGreaterThan(0); // a disabled sampler cannot pass
  expect(counters.maxBacklogKiB).toBeLessThan(allowance);
}
/** Same 10 ms committed beat and loop-delay probe as the scale scrub above.
 * `turn` (T-STEP-OFFTHREAD only) is the barrier on the writer lock between the beat and the fixture's own big-commit writer: 0 free, 1 the beat is inside its
 * insert, 2 the writer is inside its transaction. The beat takes the turn with one compare-exchange and never waits: when the writer holds it this tick is
 * not a beat (counted in `skipped`, not attempted), so the beat provably never holds the writer lock while the fixture's commit does and the busy timeouts
 * stay as they are. Beats keep running between the writer's commits, which is where the checkpoint copies. */
async function stepBeats(db: DatabaseSync, work: () => Promise<void>, turn?: Int32Array) {
  let attempted = 0, failed = 0, skipped = 0;
  const insert = db.prepare("INSERT INTO beat VALUES(?)");
  const writer = setInterval(() => {
    if (turn && Atomics.compareExchange(turn, 0, 0, 1) !== 0) { skipped++; return; }
    attempted++;
    try { insert.run(attempted); }
    catch { failed++; }
    finally { if (turn) { Atomics.store(turn, 0, 0); Atomics.notify(turn, 0); } }
  }, 10);
  let loopMaxMs: number;
  try {
    loopMaxMs = await loopDelayDuring(async () => {
      await stepSleep(30); // arm the histogram and prove beats are live before releasing work
      await work();
      await stepSleep(30);
    });
  } finally { clearInterval(writer); }
  const stored = Number(db.prepare("SELECT count(*) AS n FROM beat").get()!.n);
  return { loopMaxMs, attempted, failed, lost: attempted - stored, skipped };
}
function stepAssertBeats(result: Awaited<ReturnType<typeof stepBeats>>) {
  expect(result.attempted).toBeGreaterThan(0);
  expect(result.failed).toBe(0);
  expect(result.lost).toBe(0);
}
async function stepOffthread() {
  const db = await stepReady();
  const turnBuffer = new SharedArrayBuffer(4);
  const writer = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.file);
    db.exec("PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=0; PRAGMA busy_timeout=1000");
    parentPort.once("message", () => {
      const insert = db.prepare("INSERT INTO canary VALUES('filler', randomblob(?))");
      const turn = new Int32Array(workerData.turn);
      // The writer goes only when the beat is provably not inside its insert: one compare-exchange from 0 (free) to 2, waiting on the word while it is 1 (the
      // beat's insert is synchronous and short). The beat never takes the turn while it is 2. BEGIN IMMEDIATE therefore never meets the beat's lock, and
      // busy_timeout stays at 1000: nothing here waits for SQLite.
      const enter = () => { while (Atomics.compareExchange(turn, 0, 0, 2) !== 0) Atomics.wait(turn, 0, 1, 1); };
      const leave = () => { Atomics.store(turn, 0, 0); Atomics.notify(turn, 0); };
      for (let i = 0; i < 64; i++) {
        enter();
        try {
          db.exec("BEGIN IMMEDIATE");
          for (let j = 0; j < 4; j++) insert.run(1024 * 1024);
          db.exec("COMMIT");
        } finally { leave(); }
        // A real background writer yields between big commits: root-set-compaction's idle sweep pauses pauseMs 60 (memory/root-set-compaction.ts).
        // A loop with no gap tests lock contention with the 10 ms beat, not the checkpoint.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      }
      db.close();
      parentPort.close();
    });
  `, { eval: true, workerData: { file: messagesFile(), turn: turnBuffer } });
  const exited = new Promise<void>((resolve, reject) => {
    writer.once("error", reject);
    writer.once("exit", code => code === 0 ? resolve() : reject(new Error(`step writer exit ${code}`)));
  });
  // Attach rejection handling even if fixture setup fails before the measured await.
  void exited.catch(() => {});
  try {
    const result = await stepBeats(db, async () => { writer.postMessage("go"); await exited; }, new Int32Array(turnBuffer));
    stepAssertBeats(result);
    expect(result.skipped, "the writer really took turns (beats were held off during its commits)").toBeGreaterThan(0);
    stepBound();
    // One step is one bounded pass: the largest single pass copy is the step that tripped it plus the commits that land before the worker snapshots the log
    // (the fixture writer commits 4 x 1 MiB = STEP_BYTES at a time, and at most two land in that window). A step threshold that lets a pass grow far past
    // STEP_BYTES copies many steps at once on the worker and fails here by size, whatever the clock does.
    const passCopyKiB = stepCounters().maxPassCopyKiB;
    expect(passCopyKiB, "passes really copied (a disabled pass-size counter cannot pass)").toBeGreaterThan(0);
    expect(passCopyKiB, "largest single pass copy (KiB) must stay within 3 x STEP_BYTES: one step copies a bounded amount, not many steps at once").toBeLessThan(3 * STEP_BYTES / 1024);
    expect(Number(db.prepare("SELECT sum(length(body)) AS n FROM canary").get()!.n)).toBe(256 * MB);
    return result;
  } finally { await writer.terminate(); }
}

it("T-STEP-OFFTHREAD", { tags: ["perf-budget"], timeout: 120_000 }, async () => {
  const result = await stepOffthread();
  if (process.env.MURAGE_TEST_PERF_QUIET_HOST === "1") expect(result.loopMaxMs).toBeLessThan(100);
});

it("T-STEP-OFFTHREAD work", { timeout: 120_000 }, async () => {
  await stepOffthread();
});

it("T-STEP-MAINBUSY work", { timeout: 120_000 }, async () => {
  const db = await stepReady();
  // No await, timer, or message dispatch between the first commit and the shared-memory assertions.
  const loopStart = performance.now();
  for (let index = 0; index < 64; index++) fill(db, 4);
  const loopMs = performance.now() - loopStart;
  stepBoundMainBusy(loopMs);
  const mark = walMark(walFile());
  await vi.waitFor(() => expect(stepCounters().backlogKiB).toBe(0), { timeout: 1000, interval: 5 });
  expect(await settleWal({ nudge: true })).toBe(true);
  expect(existsSync(walFile()) ? statSync(walFile()).size : 0).toBeLessThan(MB);
  expect(walScrubbed(walFile(), mark)).toBe(true);
  expect(Number(db.prepare("SELECT count(*) AS n FROM canary").get()!.n)).toBe(256);
});

it("T-STEP-PACE work", { timeout: 60_000 }, async () => {
  // Pacing is a rule about poll ticks, not about wall clock (ruling, MAINBUSY follow-up 2). The worker reports every tick with the eligibility its OWN scheduler
  // computed, so spill and reader-held bytes are excluded by construction, and no time bound is asserted: the only clock is the product's DUE_MS read as a predicate.
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  let reader: DatabaseSync | null = null;
  try {
    const db = await stepReady();
    ticks.length = 0; // only ticks of this test's own workload count
    // (i) committed work due: the pass starts on the first tick that sees it, never later. Each step commits one more step of work and WAITS until a tick has
    // reported it, so a worker that was descheduled for a while only delays the test; the number of observed opportunities never depends on load.
    for (let round = 1; round <= 3; round++) {
      fill(db, 4);
      await vi.waitFor(() => expect(ticks.filter(tick => tick.work).length).toBeGreaterThanOrEqual(round), { timeout: 30_000, interval: 10 }); // a silent hook cannot pass
    }
    await vi.waitFor(() => expect(stepCounters().backlogKiB).toBe(0), { timeout: 30_000, interval: 10 });
    expect(ticks.filter(tick => tick.work && !tick.started).map(tick => tick.tick)).toEqual([]);
    // (ii) reader-blocked retry: nothing new is committed, the copy cannot finish; the retry starts on the first tick where DUE_MS has passed, not earlier, not later.
    const from = ticks.length;
    reader = new DatabaseSync(messagesFile());
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM beat").get();
    db.exec("INSERT INTO beat VALUES(1)");
    const quiet = () => ticks.slice(from).filter(tick => tick.retry && !tick.changed && !tick.timed);
    // The reader stays pinned, so retries go on until three have started. No tick of any other kind is required: the check below is an equality on EVERY quiet
    // retry tick, so a start before DUE_MS (too early) and a missing start after it (too late) both fail on whatever ticks were observed.
    await vi.waitFor(() => expect(quiet().filter(tick => tick.started).length).toBeGreaterThanOrEqual(3), { timeout: 30_000, interval: 25 });
    reader.exec("COMMIT");
    const seen = quiet();
    for (const tick of seen) expect(tick.started, `tick ${tick.tick} age ${tick.now - tick.lastAt}`).toBe(tick.now - tick.lastAt >= DUE_MS);
  } finally {
    walMaintenanceTestHooks.paceTrace = null;
    try { reader?.close(); } catch { /* already closed */ }
  }
});

/** One generation cell per test: the same fresh SharedArrayBuffer(4) is given to the worker (workerData) and used by the test, never reset or wrapped. The worker
 * loads it at the top of every poll tick, before it reads data_version, and echoes it in the pace record (`gen`). Read when the worker starts: set before stepReady(). */
function paceGenCell(): Int32Array {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  walMaintenanceTestHooks.paceGen = cell;
  return cell;
}
/** The one proof that a record was sampled after the writer lock: the worker's load saw the test's bump, which follows BEGIN IMMEDIATE in program order, and the
 * worker's data_version read follows its load (atomics are sequentially consistent). No clock is involved, so a wall-clock step cannot forge it. */
const sampledAfterLock = (tick: PaceTick, lockGen: number) => tick.gen >= lockGen;
const IDLE = { work: false, changed: false, timed: false, retry: false, started: false } as const;

/** The open-transaction test body. A foreign writer (a background index build, the search worker) can commit between the checkpointer's baseline and this test:
 * that commit is committed work, so the product's rule (b), changed && DUE_MS since the last pass, rightly runs ONE pass, whatever the open transaction does.
 * The fixture therefore takes the writer lock FIRST (no foreign commit can land after it; the lock is held until the end of the body, through the drain), bumps
 * the generation cell, lets the pass that earlier commits owe finish, and only then counts: the open transaction itself must start no timed pass. The drain
 * is judged on the worker's own tick records, never on a sleep, and ONLY on a record whose `gen` shows it was sampled after the bump. `afterLock` runs right after the
 * bump (test only: delivers a stale record); `afterDrain` runs when the drain is over. */
async function openTxnBody(ticks: PaceTick[], db: DatabaseSync, gen: Int32Array, drain: boolean, afterLock?: (g: { staleGen: number; lockGen: number }) => void, afterDrain?: () => void) {
  db.exec("PRAGMA cache_size=-1024; PRAGMA cache_spill=ON; BEGIN IMMEDIATE");
  try {
    const staleGen = Atomics.load(gen, 0); // captured BEFORE the bump: the generation of every record sampled before the lock
    const lockGen = Atomics.add(gen, 0, 1) + 1;
    let owed = 0;
    afterLock?.({ staleGen, lockGen });
    if (drain) {
      await vi.waitFor(() => {
        const counters = stepCounters();
        expect(counters.running).toBe(0);
        expect(counters.passSeq).toBe(counters.passDone);
        const last = ticks.filter(tick => sampledAfterLock(tick, lockGen)).at(-1);
        expect(last !== undefined && !last.work && !last.changed && !last.retry && !last.timed && !last.started, "a tick sampled after the lock was taken saw nothing owed").toBe(true);
      }, { timeout: 30_000, interval: 5 });
      owed = stepCounters().timedPasses;
    }
    afterDrain?.();
    const insert = db.prepare("INSERT INTO canary VALUES('spill', zeroblob(?))");
    for (let index = 0; index < 64; index++) insert.run(MB);
    expect(statSync(walFile()).size).toBeGreaterThan(60 * MB); // spilled, not merely cached
    await stepSleep(500);
    expect(stepCounters().timedPasses).toBe(owed);
    db.exec("COMMIT");
    stepSyncUntil(() => stepCounters().timedPasses > owed, 300);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
}
it("T-STEP-OPEN-TXN work", { timeout: 30_000 }, async () => {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); }; // the flag is read when the worker starts: set before stepReady()
  const gen = paceGenCell();
  const db = await stepReady();
  await openTxnBody(ticks, db, gen, true);
});

/** Witness: a foreign commit lands after the checkpointer's baseline (what a background index build does under load). The pass it owes is not the open
 * transaction's: the test must still hold. Without the drain this fails by assertion (timedPasses 1, expected 0), on every run. */
it("T-STEP-OPEN-TXN-FOREIGN work", { timeout: 30_000 }, async () => {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const gen = paceGenCell();
  const db = await stepReady();
  const foreign = new DatabaseSync(messagesFile());
  try { foreign.exec("INSERT INTO beat VALUES(-1)"); } finally { foreign.close(); }
  await openTxnBody(ticks, db, gen, true);
});

/** A stale idle record (sampled before the lock: it saw nothing owed) is delivered after the lock was taken, while the foreign commit is STILL OWED. The start
 * hold keeps the worker from starting the owed pass (bounded 2 s), and the assertion in afterLock fails loudly if the commit is no longer owed, so a worker that
 * drained first cannot make the witness pass. A drain that takes this record for proof counts from a pass still ahead (timedPasses 1, expected 0). */
async function staleRecordWhileOwed(staleNow: () => number) {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const gen = paceGenCell();
  const db = await stepReady();
  const foreign = new DatabaseSync(messagesFile());
  barrier.holdStart(true);
  try {
    try { foreign.exec("INSERT INTO beat VALUES(-1)"); } finally { foreign.close(); }
    await openTxnBody(ticks, db, gen, true,
      ({ staleGen }) => {
        expect(stepCounters().timedPasses, "the foreign commit is still owed when the stale record arrives").toBe(0);
        ticks.push({ tick: -1, now: staleNow(), lastAt: 1, ...IDLE, gen: staleGen });
      },
      () => { barrier.holdStart(false); });
  } finally { barrier.holdStart(false); }
}
/** Witness LATE-TICK: the stale record's clock is epoch ms 1, long before any lock; only its generation (the one before the bump) marks it stale. */
it("T-STEP-OPEN-TXN-LATE-TICK work", { timeout: 30_000 }, async () => { await staleRecordWhileOwed(() => 1); });
/** Witness ROLLBACK: the stale record was sampled before the lock but the wall clock then stepped BACK, so its `now` is later than the lock's. No clock comparison
 * can reject it; its generation does. */
it("T-STEP-OPEN-TXN-ROLLBACK work", { timeout: 30_000 }, async () => { await staleRecordWhileOwed(() => Date.now() + 60_000); });

/** Witness GEN-EQ: a record carrying exactly the bumped generation was sampled after the bump (equality accepts), the generation before it was not. A drain
 * that wants more than the bump (>) or ignores the generation fails here by assertion, not by a timeout. */
it("T-STEP-GEN-EQ work", () => {
  const record = (gen: number): PaceTick => ({ tick: 1, now: 1, lastAt: 1, ...IDLE, gen });
  expect(sampledAfterLock(record(5), 5), "equality accepts").toBe(true);
  expect(sampledAfterLock(record(6), 5)).toBe(true);
  expect(sampledAfterLock(record(4), 5), "the generation before the bump is stale").toBe(false);
  expect(sampledAfterLock(record(-1), 0), "no seam (-1) is never after a bump").toBe(false);
});

/** GEN-ECHO waits for poll progress independently of the echoed value, then asserts that the first full tick after the bump echoes it. */
it("T-STEP-GEN-ECHO work", { timeout: 30_000 }, async () => {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const gen = paceGenCell();
  await stepReady();
  await vi.waitFor(() => expect(ticks.length).toBeGreaterThan(0), { timeout: 10_000, interval: 5 });
  expect(ticks.every(tick => Number.isInteger(tick.gen) && tick.gen >= 0 && tick.gen <= Atomics.load(gen, 0))).toBe(true);
  const expired = barrier.expired();
  barrier.arm(3);
  try {
    await vi.waitFor(() => expect(barrier.parkedAt()).toBe(3), { timeout: 10_000, interval: 5 });
    const parkedTick = barrier.parkInfo();
    const bumped = Atomics.add(gen, 0, 1) + 1;
    barrier.release();
    await vi.waitFor(() => expect(ticks.some(tick => tick.tick > parkedTick)).toBe(true), { timeout: 10_000, interval: 5 });
    expect(ticks.find(tick => tick.tick > parkedTick)!.gen, "the first full tick after the bump echoes the generation").toBe(bumped);
    let previous = -1;
    for (const tick of ticks) { expect(tick.gen, "generations never go back").toBeGreaterThanOrEqual(previous); previous = tick.gen; }
  } finally { barrier.release(); barrier.disarm(); }
  expect(barrier.expired() - expired, "no barrier deadline expired").toBe(0);
});

/** Witness GEN-LOAD-ORDER: the worker loads the generation BEFORE it reads data_version. The worker is parked right after data_version was read (barrier site 3,
 * released in finally, no deadline expiry), the test takes the lock and bumps while it is parked, and the record of that exact tick must keep the generation
 * from before the bump: its data_version read preceded the lock. A load placed after the read would see the bump here. */
it("T-STEP-GEN-LOAD-ORDER work", { timeout: 30_000 }, async () => {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const gen = paceGenCell();
  const db = await stepReady();
  await vi.waitFor(() => expect(ticks.length > 0 && Number.isInteger(ticks.at(-1)!.gen), "the seam echoes a generation").toBe(true), { timeout: 10_000, interval: 5 });
  const expired = barrier.expired();
  barrier.arm(3);
  try {
    await vi.waitFor(() => expect(barrier.parkedAt(), "the worker is parked after data_version").toBe(3), { timeout: 10_000, interval: 5 });
    const parkedTick = barrier.parkInfo();
    db.exec("BEGIN IMMEDIATE");
    const staleGen = Atomics.load(gen, 0);
    const lockGen = Atomics.add(gen, 0, 1) + 1;
    barrier.release();
    await vi.waitFor(() => expect(ticks.some(tick => tick.tick === parkedTick), `the record of parked tick ${parkedTick}`).toBe(true), { timeout: 10_000, interval: 5 });
    expect(ticks.find(tick => tick.tick === parkedTick)!.gen, "the parked tick keeps the generation from before the bump").toBe(staleGen);
    expect(lockGen).toBe(staleGen + 1);
    await vi.waitFor(() => expect(ticks.some(tick => tick.tick > parkedTick && sampledAfterLock(tick, lockGen)), "a later tick sees the bump").toBe(true), { timeout: 10_000, interval: 5 });
  } finally {
    barrier.release(); barrier.disarm();
    if (db.isTransaction) db.exec("ROLLBACK");
  }
  expect(barrier.expired() - expired, "no barrier deadline expired").toBe(0);
});

it("T-STEP-REUSE work", { timeout: 30_000 }, async () => {
  // The trace flag is read when the worker starts, so the recorder is set BEFORE stepReady(); afterEach clears it.
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const db = await stepReady();
  // Retain the allocation specifically to exercise reuse, rather than growth or a salt change.
  db.exec("PRAGMA journal_size_limit=-1");
  fill(db, 8);
  expect(await settleWal()).toBe(true);
  const oldSalt = walMark(walFile());
  db.exec("PRAGMA user_version=7"); // restart the fully copied log, keeping its allocation
  expect(walMark(walFile())).not.toEqual(oldSalt);
  expect(await settleWal()).toBe(true); // establish the new salt/size baseline
  // A timed pass owed from before the insert below carries a sample taken before it. Let it drain first: one poll tick must report no timed pass owed, no
  // work and no start, and no pass may be running, before the start hold is taken, so every pass counted after this point was sampled after the insert.
  ticks.length = 0;
  await vi.waitFor(() => {
    // One tick after settleWal that saw no timed pass owed, no work and no start: the queued pass (if any) has been taken and finished before this tick.
    expect(ticks.some(tick => !tick.timed && !tick.work && !tick.started), "a queued timed pass is still draining").toBe(true);
    expect(stepCounters().running).toBe(0);
  }, { timeout: 10_000, interval: 10 });
  // The log was fully copied, so a reader opened now would sit on read-mark 0 and could not hold the restart. Write one frame first (the
  // restart it does is allowed), then pin the reader above mark 0, then take the baseline: the next write really cannot restart the log.
  // The worker must not copy this frame before the reader sits above it: a reader opened on a fully copied log takes read-mark 0 and cannot hold the restart
  // (a slow connection open, as on Windows, loses that race against a 25 ms poll). The start hold keeps the pass from running until the reader is pinned.
  // The hold is bounded (2 s), so the pin is VERIFIED: if a pass had started by the time the reader was pinned, the frame may already be copied; release and try again.
  let reader: ReturnType<typeof pinReader> | null = null;
  let passesBefore = 0;
  for (let attempt = 0; reader === null; attempt++) {
    expect(attempt, "no attempt pinned the reader above a copied frame").toBeLessThan(10);
    barrier.holdStart(true);
    try {
      passesBefore = stepCounters().timedPasses; // read BEFORE the insert: a pass that copies the frame at any point after it is seen as a change
      db.prepare("INSERT INTO canary VALUES('reuse-pin', 'small')").run();
      const pinned = pinReader(); // prevent another restart from satisfying rule (a)
      if (stepCounters().timedPasses === passesBefore && stepCounters().running === 0) reader = pinned;
      else pinned.release();
    } finally { barrier.holdStart(false); }
    if (reader === null) await vi.waitFor(() => expect(stepCounters().running).toBe(0), { timeout: 10_000, interval: 5 });
  }
  try {
    // The restart write is a changed log under a new salt, so it earns its own pass. Let that pass finish (it copies up to the reader's mark, so
    // it is complete and leaves no retry owed): the write below is then the only thing that can start the next pass, which is rule (b) alone.
    stepSyncUntil(() => stepCounters().timedPasses > passesBefore && stepCounters().running === 0, RULE_WINDOW_MS);
    const bytes = statSync(walFile()).size, salt = walMark(walFile());
    const before = stepCounters().timedPasses;
    db.prepare("INSERT INTO canary VALUES('reuse', 'small')").run();
    expect(statSync(walFile()).size).toBe(bytes);
    expect(walMark(walFile())).toEqual(salt);
    stepSyncUntil(() => stepCounters().timedPasses > before, RULE_WINDOW_MS);
  } finally { reader.release(); }
});

it("T-STEP-REUSE-LATE work", { timeout: 30_000 }, async () => {
  // Product-level proof for the REUSE reasoning: a reader that opens late, on a log the worker has already fully copied, takes read-mark 0, reads the restarted log
  // correctly and keeps a stable snapshot while the writer restarts the log and commits; nothing is lost and nothing is torn. The start hold below only fixes the pass-id floor for the proof; correctness does not need it.
  const db = await stepReady();
  db.exec("PRAGMA journal_size_limit=-1");
  fill(db, 8);
  expect(await settleWal()).toBe(true);
  db.exec("PRAGMA user_version=7");
  expect(await settleWal()).toBe(true);
  const count = (conn: DatabaseSync) => Number(conn.prepare("SELECT count(*) AS n FROM canary").get()!.n);
  const before = count(db);
  const reader = new DatabaseSync(messagesFile());
  const done: StepPass[] = []; // completed (not cancelled) timed passes that started after the late write
  let seqFloor = Number.MAX_SAFE_INTEGER;
  const unsubscribe = onWalPass(pass => { if (pass.kind === "timed" && !pass.cancelled && pass.id > seqFloor && pass.log !== undefined && pass.checkpointed !== undefined && pass.log > pass.checkpointed) done.push(pass); });
  try {
    reader.exec("BEGIN");
    expect(count(reader)).toBe(before);
    const oldSalt = walMark(walFile());
    // No pass may start between the id read and the insert (start hold), so a COMPLETED timed pass with a newer id ran its checkpoint after this write; log > checkpointed is the read-lock-0 reader holding that checkpoint (a pass that sampled before the write finds log === checkpointed).
    barrier.holdStart(true);
    try {
      await vi.waitFor(() => expect(stepCounters().running).toBe(0), { timeout: 10_000, interval: 5 }); // a pass already in flight is not this write's pass
      seqFloor = stepCounters().passSeq;
      db.prepare("INSERT INTO canary VALUES('late', 'small')").run(); // the restart this write does is allowed: the reader sits on read-mark 0
    } finally { barrier.holdStart(false); }
    expect(walMark(walFile())).not.toEqual(oldSalt); // the log really restarted under the open reader
    expect(count(reader)).toBe(before); // the snapshot stays whole across the restart
    // Hold the reader until the worker's timed pass for this write has run: that pass checkpoints while the reader is still open (READ_LOCK(0)), so this test
    // alone proves the checkpoint is held by the read-mark-0 reader and torn by nothing. Only then commit.
    await vi.waitFor(() => expect(done.length).toBeGreaterThan(0), { timeout: 10_000, interval: 5 }); // presence timeout, not a pacing bound; a silent worker cannot pass
    expect(count(reader)).toBe(before); // still whole after the pass
    reader.exec("COMMIT");
    expect(count(reader)).toBe(before + 1); // and the next read sees the new row from the restarted log
    expect(count(db)).toBe(before + 1);
    expect(await settleWal()).toBe(true);
    expect(count(db)).toBe(before + 1);
  } finally { unsubscribe(); try { reader.exec("COMMIT"); } catch { /* done */ } reader.close(); }
});

/** Rule (c) after the reader lets go: the retry starts on the first poll tick at least DUE_MS after the last pass ended, and then finishes the log. The
 * start is judged on the worker's own tick records (each tick carries the `now` and `lastAt` its decision used), as in T-STEP-PACE; the old wall-clock
 * window of 2 x DUE_MS + one poll on this thread also counted the retry's own copy and sync of 8 MB, which takes longer than that on a loaded disk
 * ("expected 261 to be 2318" at the window's end: the retry had not reported yet). Finishing is then waited for without a wall bound. `stall` holds the
 * worker just before it marks the retry running, the forced form of that delay. */
async function stepRelease(stall: boolean) {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); }; // read when the worker starts, so before stepReady
  const db = await stepReady();
  fill(db, 1);
  const reader = pinReader();
  let released = false;
  try {
    fill(db, 8);
    // Establish an incomplete result without relying on a race with the timed poll.
    const held = await checkpointPassive();
    expect(held.log).toBeGreaterThan(held.checkpointed);
    const from = ticks.length; // tick records are delivered in order with the pass answer: later ones belong to the time after the held pass ended
    const bytes = statSync(walFile()).size;
    if (stall) barrier.holdStart(true);
    reader.release(); released = true;
    expect(statSync(walFile()).size).toBe(bytes);
    // No writes or requested passes after release; only rule (c) can finish this log.
    await vi.waitFor(() => {
      const result = walMaintenanceTestHooks.lastResult();
      expect(result).not.toBeNull();
      expect(result!.log).toBeGreaterThan(0);
      expect(result!.checkpointed).toBe(result!.log);
    }, { timeout: 20_000, interval: 5 }); // a retry that never starts or never finishes cannot pass
    expect(statSync(walFile()).size).toBe(bytes);
    const after = ticks.slice(from);
    const first = after.findIndex(tick => tick.started);
    expect(first).toBeGreaterThanOrEqual(0);
    // Up to and including the tick that started the retry: a retrying tick starts a pass exactly when DUE_MS has passed on the worker's clock.
    for (const tick of after.slice(0, first + 1)) {
      if (tick.retry) expect(tick.started, `tick ${tick.tick}: now - lastAt = ${tick.now - tick.lastAt} ms`).toBe(tick.now - tick.lastAt >= DUE_MS);
    }
  } finally { barrier.holdStart(false); if (!released) reader.release(); }
}
it("T-STEP-RELEASE work", { timeout: 30_000 }, async () => { await stepRelease(false); });
it("T-STEP-RELEASE-STALL work", { timeout: 30_000 }, async () => { await stepRelease(true); });

it("T-STEP-IDLE work", { timeout: 15_000 }, async () => {
  await stepReady();
  await stepSleep(2000);
  expect(stepCounters().timedPasses).toBe(0);
});

it("T-STEP-SERIAL work", { timeout: 30_000 }, async () => {
  const db = await stepReady();
  const passes: StepPass[] = [];
  const unsubscribe = onWalPass(pass => passes.push(pass));
  barrier.holdGate(true);
  let requested: Promise<unknown> | undefined;
  try {
    fill(db, 4);
    // running is published before the sequence and timed counter. Wait for the
    // identified timed pass while holdGate keeps it from completing.
    await vi.waitFor(() => {
      const counters = stepCounters();
      expect(counters.running).toBe(1);
      expect(counters.passSeq).toBe(1);
      expect(counters.timedPasses).toBe(1);
      expect(counters.passDone).toBe(0);
    }, { timeout: 5000, interval: 5 });
    const timed = stepCounters();
    expect(timed.timedPasses).toBe(1);
    let resolved = false;
    requested = checkpointPassive().then(result => { resolved = true; return result; });
    await stepSleep(100);
    expect(resolved).toBe(false);
    expect(stepCounters().passSeq).toBe(timed.passSeq);
    expect(stepCounters().passDone).toBeLessThan(timed.passSeq);
    expect(passes).toEqual([]);
    barrier.holdGate(false);
    const result = await requested;
    const last = lastRequestedPass();
    expect(last).not.toBeNull();
    expect(typeof last!.reqId).toBe("number");
    expect(last!.id).toBeGreaterThan(timed.passSeq);
    const timedMessages = passes.filter(pass => pass.gen === timed.gen && pass.id === timed.passSeq);
    expect(timedMessages).toHaveLength(1);
    expect(timedMessages[0]).toMatchObject({ kind: "timed", reqId: null });
    const own = passes.filter(pass => pass.gen === timed.gen && pass.id === last!.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ kind: "requested", reqId: last!.reqId });
    expect(own[0]!.cancelled).toBeUndefined();
    expect(result).toEqual({ busy: own[0]!.busy, log: own[0]!.log, checkpointed: own[0]!.checkpointed });
    expect(passes.indexOf(timedMessages[0]!)).toBeLessThan(passes.indexOf(own[0]!));
  } finally { barrier.holdGate(false); await requested; unsubscribe(); }
});

it("T-STEP-CLOSE work", { timeout: 30_000 }, async () => {
  const db = await stepReady();
  // Keep this connection open so worker close itself cannot be a last-close checkpoint.
  const copiedBefore = readFileSync(messagesFile());
  const passes: StepPass[] = [];
  const unsubscribe = onWalPass(pass => passes.push(pass));
  const seqBefore = stepCounters().passSeq;
  barrier.holdGate(true);
  try {
    fill(db, 4);
    // The worker stores running=1 BEFORE it takes the pass id, and a timed pass can still be deferred after that store. A counters read between the two sees
    // running=1 with the previous id. A new id (passSeq above the value read before the work) together with running=1 is the held pass itself.
    await vi.waitFor(() => { const now = stepCounters(); expect(now.running === 1 && now.passSeq > seqBefore).toBe(true); }, { timeout: 5000, interval: 5 });
    const running = stepCounters();
    expect(await stopWalMaintenance(5000, 5000)).toBe(true);
    const cancelled = passes.filter(pass => pass.gen === running.gen && pass.id === running.passSeq);
    expect(cancelled, `held pass ${running.gen}/${running.passSeq}, passes seen: ${JSON.stringify(passes)}`).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ kind: "timed", cancelled: true });
    expect(passes.filter(pass => !pass.cancelled)).toEqual([]);
    // No checkpointed pages changed, including a silent PASSIVE followed by a fake cancellation.
    expect(readFileSync(messagesFile()).equals(copiedBefore)).toBe(true);
    expect(walMaintenanceReady()).toBe(false);
  } finally { barrier.holdGate(false); unsubscribe(); }
});

it("T-STEP-LATE work", { timeout: 30_000 }, async () => {
  const db = await stepReady();
  const a = stepCounters();
  const handler = walMaintenanceTestHooks.captureHandler();
  const passes: StepPass[] = [];
  const unsubscribe = onWalPass(pass => passes.push(pass));
  try {
    startWalMaintenance(messagesFile(), stepPorts(db));
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
    expect(stepCounters().gen).not.toBe(a.gen);
    await checkpointPassive();
    const before = walMaintenanceTestHooks.lastResult();
    const late = { type: "pass", gen: a.gen, id: a.passSeq + 1000, kind: "timed", reqId: null, busy: 0, log: 12345, checkpointed: 12345 };
    handler(late);
    handler(late); // duplicate delivery is not a second ledger entry
    expect(passes.filter(pass => pass.gen === a.gen && pass.id === late.id)).toHaveLength(1);
    expect(walMaintenanceTestHooks.lastResult()).toEqual(before);
    unsubscribe();
    handler({ ...late, id: late.id + 1 });
    expect(passes.filter(pass => pass.gen === a.gen)).toHaveLength(1);
  } finally { unsubscribe(); }
});

it("T-STEP-FENCE-NOBLOCK work", { timeout: 30_000 }, async () => {
  const db = await stepReady();
  const fence = walResetFence();
  barrier.holdGate(true);
  try {
    fill(db, 4);
    stepSyncUntil(() => stepCounters().running === 1, 1000);
    const pass = stepCounters().passSeq;
    const started = performance.now();
    const clear = fence.enter();
    const elapsed = performance.now() - started;
    expect(clear).toBe(false); // caller must take its busy path
    expect(elapsed).toBeLessThan(5);
    expect(stepCounters().resetWant).toBe(1);
    // IO-IDLE's resetCopiedLog in memory/revoke-budget.ts does not consume this boolean yet.
    barrier.holdGate(false);
    fence.leave(); fence.leave();
    expect(stepCounters().resetWant).toBe(0);
    stepSyncUntil(() => stepCounters().passDone >= pass && stepCounters().running === 0, 1000);
    expect(fence.enter()).toBe(true);
  } finally { barrier.holdGate(false); fence.leave(); }
});

it("T-STEP-FENCE-RESET work", { timeout: 30_000 }, async () => {
  // r3.8 ruling 1: IO-IDLE's reset (memory/revoke-budget.ts resetCopiedLog) enters the fence; while a pass is in flight it defers.
  const db = await stepReady();
  resetRevokeWriteBudget();
  fill(db, 1);
  expect(await settleWal()).toBe(true); // the log is now fully copied, with frames in it
  const mark = walMark(walFile());
  barrier.holdGate(true);
  try {
    const pass = checkpointPassive();
    void pass.catch(() => {});
    await vi.waitFor(() => expect(stepCounters().running).toBe(1), { timeout: 5000, interval: 5 });
    const skipped = revokeWriteMeter.logResetsSkipped, resets = revokeWriteMeter.logResets, busy = revokeWriteMeter.logResetsBusy;
    const size = statSync(walFile()).size;
    const started = performance.now();
    revokePaceRows(db);
    expect(performance.now() - started).toBeLessThan(250); // the server thread never waits
    expect(revokeWriteMeter.logResetsSkipped).toBe(skipped + 1); // deferred, not run
    expect(revokeWriteMeter.logResets).toBe(resets);
    expect(revokeWriteMeter.logResetsBusy).toBe(busy);
    expect(statSync(walFile()).size).toBe(size);
    expect(walMark(walFile())).toEqual(mark);
    expect(stepCounters().resetWant).toBe(1); // a deferred reset keeps its intent up, so the worker yields to it
    barrier.holdGate(false);
    await pass;
    stepSyncUntil(() => stepCounters().running === 0, 1000);
    // Never starved: once the pass is over the very next step lands the reset (skips stay bounded at the one above).
    revokePaceRows(db);
    expect(revokeWriteMeter.logResets).toBe(resets + 1);
    expect(revokeWriteMeter.logResetsSkipped).toBe(skipped + 1);
    expect(walMark(walFile())).not.toEqual(mark);
    expect(stepCounters().resetWant).toBe(0);
  } finally { barrier.holdGate(false); }
});

it("T-STEP-FENCE-NOSTARVE work", { timeout: 30_000 }, async () => {
  // A deferred reset with no retry does not hold the worker for ever: the intent drops by itself within ~250 ms.
  const db = await stepReady();
  resetRevokeWriteBudget();
  fill(db, 1);
  expect(await settleWal()).toBe(true);
  barrier.holdGate(true);
  try {
    const pass = checkpointPassive();
    void pass.catch(() => {});
    await vi.waitFor(() => expect(stepCounters().running).toBe(1), { timeout: 5000, interval: 5 });
    const skipped = revokeWriteMeter.logResetsSkipped;
    revokePaceRows(db);
    expect(revokeWriteMeter.logResetsSkipped).toBe(skipped + 1);
    expect(stepCounters().resetWant).toBe(1);
    // back-to-back steps while the pass is still in flight: skips stay bounded by the steps taken, and nothing runs the reset
    for (let step = 0; step < 5; step++) revokePaceRows(db);
    expect(revokeWriteMeter.logResetsSkipped).toBe(skipped + 6);
    barrier.holdGate(false);
    await pass;
    await vi.waitFor(() => expect(stepCounters().resetWant).toBe(0), { timeout: 1000, interval: 5 });
    const resets = revokeWriteMeter.logResets;
    revokePaceRows(db);
    expect(revokeWriteMeter.logResets).toBe(resets + 1);
  } finally { barrier.holdGate(false); }
});

it("T-STEP-FENCE-RACE work", { timeout: 30_000 }, async () => {
  // The worker has passed its poll and is about to mark a pass running; the fence is granted in that window (running still 0).
  // The worker must see the intent after its running store and stand down: a granted reset and a timed pass never overlap.
  const db = await stepReady();
  const fence = walResetFence();
  barrier.holdStart(true);
  try {
    const before = stepCounters().timedPasses;
    fill(db, 4); // due by size
    await stepSleep(200); // several polls: the worker is now waiting just before the running store
    expect(stepCounters().running).toBe(0);
    expect(fence.enter()).toBe(true);
    barrier.holdStart(false);
    const until = performance.now() + 150;
    while (performance.now() < until) {
      expect(stepCounters().timedPasses).toBe(before);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    fence.leave();
    stepSyncUntil(() => stepCounters().timedPasses > before, 1000); // and the pass is not lost
  } finally { barrier.holdStart(false); fence.leave(); }
});

it("T-STEP-FENCE-RESTART work", { timeout: 30_000 }, async () => {
  // The hold timer of a deferred reset leaves through the CURRENT worker's fence: a restart inside the hold must not strand the new intent.
  // No wall clock: the pending timer callback is fired by the hook after the restart.
  const db = await stepReady();
  resetRevokeWriteBudget();
  fill(db, 1);
  expect(await settleWal()).toBe(true);
  barrier.holdGate(true);
  const pass = checkpointPassive();
  void pass.catch(() => {});
  await vi.waitFor(() => expect(stepCounters().running).toBe(1), { timeout: 5000, interval: 5 });
  const skipped = revokeWriteMeter.logResetsSkipped;
  resetFenceTestHooks.holdMs = 600_000; // never fires by itself
  try {
    revokePaceRows(db); // deferred: the hold timer is armed on this worker
    expect(revokeWriteMeter.logResetsSkipped).toBe(skipped + 1);
    barrier.holdGate(false);
    await pass;
    expect(await stopWalMaintenance()).toBe(true);
    startWalMaintenance(messagesFile(), stepPorts(db));
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
    expect(walResetFence().enter()).toBe(true);
    expect(stepCounters().resetWant).toBe(1);
    resetFenceTestHooks.fireNow(); // the old timer fires now, on the new worker's world
    expect(stepCounters().resetWant).toBe(0);
  } finally { resetFenceTestHooks.fireNow(); resetFenceTestHooks.holdMs = 250; }
});

it("T-STEP-PIN work", { timeout: 60_000 }, async () => {
  // r3.9: the tracked connection never keeps a negative journal_size_limit (r3.7 accounting assumes a copied log is cut back). The check runs
  // BEFORE any worker exists: pinned and read back, else no worker, no extra connection, and the connection keeps its own autocheckpoint.
  const db = await stepReady();
  const limit = () => Number(db.prepare("PRAGMA journal_size_limit").get()!.journal_size_limit);
  const autocheckpoint = () => Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint);
  expect(JOURNAL_SIZE_LIMIT_BYTES).toBe(0); // prod value, server/database.ts:429, applied at open (database.ts:295)
  expect(limit()).toBe(JOURNAL_SIZE_LIMIT_BYTES);
  db.exec("PRAGMA journal_size_limit=-1");
  expect(await stopWalMaintenance()).toBe(true);
  startWalMaintenance(messagesFile(), stepPorts(db));
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  expect(limit()).toBe(JOURNAL_SIZE_LIMIT_BYTES);
  // A pin that never succeeds, and a port that throws: zero workers over several restart cycles.
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = [20, 20, 20];
  try {
    for (const bad of [
      { pinJournalSizeLimit: () => {} },
      { journalSizeLimit: () => { throw new Error("port failed"); } },
    ]) {
      db.exec("PRAGMA journal_size_limit=-1");
      expect(await stopWalMaintenance()).toBe(true);
      const spawned = walMaintenanceTestHooks.spawned(), refused = walMaintenanceTestHooks.pinRefusals();
      startWalMaintenance(messagesFile(), { ...stepPorts(db), ...bad });
      await vi.waitFor(() => expect(walMaintenanceTestHooks.pinRefusals()).toBeGreaterThanOrEqual(refused + 4), { timeout: 10_000, interval: 5 });
      expect(walMaintenanceTestHooks.spawned()).toBe(spawned); // no worker was ever created
      expect(walMaintenanceTestHooks.liveWorkers()).toBe(0);
      expect(walMaintenanceReady()).toBe(false);
      expect(autocheckpoint()).toBe(0); // retry gaps never checkpoint on main
    }
  } finally { walMaintenanceTestHooks.restartDelaysMs = delays; }
});

it("T-STEP-LOG-HONEST work", { timeout: 60_000 }, async () => {
  // r3.9 Low: a refused start has its own line and never uses up the one-shot "stopped" line; after a worker that really ran, its failure
  // logs once, and logs again after a later successful ready.
  const db = await stepReady();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const count = (re: RegExp) => warn.mock.calls.filter(call => re.test(String(call[0]))).length;
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = [20, 20, 20];
  walMaintenanceTestHooks.failureLogGapMs = 0; // this test is about the one-shots; T-STEP-LOG-THROTTLE owns the gap
  const backToReady = async () => vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  try {
    walMaintenanceTestHooks.resetLogOnce();
    db.exec("PRAGMA journal_size_limit=-1");
    expect(await stopWalMaintenance()).toBe(true);
    const refused = walMaintenanceTestHooks.pinRefusals();
    startWalMaintenance(messagesFile(), { ...stepPorts(db), pinJournalSizeLimit: () => {} });
    await vi.waitFor(() => expect(walMaintenanceTestHooks.pinRefusals()).toBeGreaterThanOrEqual(refused + 3), { timeout: 10_000, interval: 5 });
    expect(count(/did not start/)).toBe(1); // its own line, once
    expect(count(/checkpointer stopped/)).toBe(0); // the real-failure line is untouched
    // A new start session reports its own refusal once more.
    expect(await stopWalMaintenance()).toBe(true);
    const refused2 = walMaintenanceTestHooks.pinRefusals();
    startWalMaintenance(messagesFile(), { ...stepPorts(db), pinJournalSizeLimit: () => {} });
    await vi.waitFor(() => expect(walMaintenanceTestHooks.pinRefusals()).toBeGreaterThanOrEqual(refused2 + 3), { timeout: 10_000, interval: 5 });
    expect(count(/did not start/)).toBe(2);
    expect(await stopWalMaintenance()).toBe(true);
    startWalMaintenance(messagesFile(), stepPorts(db));
    await backToReady();
    expect(walMaintenanceTestHooks.failActive()).toBe(true);
    await vi.waitFor(() => expect(count(/checkpointer stopped/)).toBe(1), { timeout: 5000, interval: 5 });
    await backToReady();
    expect(walMaintenanceTestHooks.failActive()).toBe(true);
    await vi.waitFor(() => expect(count(/checkpointer stopped/)).toBe(2), { timeout: 5000, interval: 5 }); // reset by the ready in between
  } finally { walMaintenanceTestHooks.restartDelaysMs = delays; walMaintenanceTestHooks.failureLogGapMs = 600_000; warn.mockRestore(); }
});

it("T-STEP-LOG-THROTTLE work", { timeout: 60_000 }, async () => {
  // r3.9 Low: a checkpointer that reaches ready and fails again and again is reported once per gap, not once per cycle.
  const db = await stepReady();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const count = () => warn.mock.calls.filter(call => /checkpointer stopped/.test(String(call[0]))).length;
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = [20, 20, 20];
  walMaintenanceTestHooks.failureLogGapMs = 600_000;
  const backToReady = async () => vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  try {
    walMaintenanceTestHooks.resetLogOnce();
    expect(await stopWalMaintenance()).toBe(true);
    startWalMaintenance(messagesFile(), stepPorts(db));
    await backToReady();
    const realNow = Date.now.bind(Date);
    for (let cycle = 1; cycle <= 3; cycle++) {
      // The wall clock jumps an hour ahead for the instant of the failure (a clock adjustment): the gap is on a monotonic clock, so it still holds.
      const skew = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3_600_000);
      try { expect(walMaintenanceTestHooks.failActive()).toBe(true); } finally { skew.mockRestore(); }
      await vi.waitFor(() => expect(walMaintenanceTestHooks.liveWorkers()).toBe(0), { timeout: 5000, interval: 5 });
      await backToReady(); // a fresh worker reached ready between failures
    }
    expect(count()).toBe(1); // three failures, one line
    // The gap over, the next failure is reported again.
    walMaintenanceTestHooks.failureLogGapMs = 0;
    expect(walMaintenanceTestHooks.failActive()).toBe(true);
    await vi.waitFor(() => expect(count()).toBe(2), { timeout: 5000, interval: 5 });
  } finally { walMaintenanceTestHooks.restartDelaysMs = delays; walMaintenanceTestHooks.failureLogGapMs = 600_000; warn.mockRestore(); }
});

it("T-STEP-LOG-CRASHLOOP work", { timeout: 60_000 }, async () => {
  // r3.9: replacements that fail again and again WITHOUT ever reaching ready (nothing re-arms the one-shot) are still reported, once
  // per gap: a failure the gap swallowed must not silence the loop for good.
  const db = await stepReady();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const count = () => warn.mock.calls.filter(call => /checkpointer stopped/.test(String(call[0]))).length;
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  try {
    expect(await stopWalMaintenance()).toBe(true);
    walMaintenanceTestHooks.resetLogOnce();
    walMaintenanceTestHooks.restartDelaysMs = [20];
    walMaintenanceTestHooks.failureLogGapMs = 600_000; // far longer than this test
    const spawned = walMaintenanceTestHooks.spawned();
    // The thread cannot open this file: every worker fails before ready (a crash loop).
    startWalMaintenance(join(DATA_DIR, "no-such-dir", "messages.db"), stepPorts(db));
    await vi.waitFor(() => expect(walMaintenanceTestHooks.spawned()).toBeGreaterThanOrEqual(spawned + 6), { timeout: 20_000, interval: 5 });
    expect(walMaintenanceReady()).toBe(false);
    expect(count()).toBe(1); // six failed starts inside one gap, one line
    // A short gap: after each gap the loop is reported again, with no ready in between.
    walMaintenanceTestHooks.failureLogGapMs = 150;
    await vi.waitFor(() => expect(count()).toBeGreaterThanOrEqual(3), { timeout: 20_000, interval: 5 });
    expect(walMaintenanceReady()).toBe(false);
    expect(walMaintenanceTestHooks.spawned()).toBeGreaterThan(spawned + count()); // more failures than lines: still throttled
  } finally {
    walMaintenanceTestHooks.restartDelaysMs = delays; walMaintenanceTestHooks.failureLogGapMs = 600_000; warn.mockRestore();
    await stopWalMaintenance();
  }
});

it("T-STEP-FAILHOOK-CLEARED work", { timeout: 30_000 }, async () => {
  // r3.9 Low: the test hook that fails the current worker does not outlive the worker (stop and retire clear it).
  const db = await stepReady(); // a live worker is stopped: its hook goes with it
  expect(await stopWalMaintenance()).toBe(true);
  expect(walMaintenanceTestHooks.failActive()).toBe(false); // stopped
  // A worker that failed on its own: the hook is gone as soon as it is, before any replacement and without a stop.
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = [];
  try {
    startWalMaintenance(messagesFile(), stepPorts(db));
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
    expect(walMaintenanceTestHooks.failActive()).toBe(true);
    await vi.waitFor(() => expect(walMaintenanceTestHooks.liveWorkers()).toBe(0), { timeout: 5000, interval: 5 });
    expect(walMaintenanceTestHooks.failActive()).toBe(false);
  } finally { walMaintenanceTestHooks.restartDelaysMs = delays; }
});

it("T-STEP-FAILCLOSE work", { timeout: 30_000 }, async () => {
  // A worker that fails is closed like a stopped one, not left polling and copying outside the fence.
  await stepReady();
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = []; // no replacement: only the failed worker is in question
  try {
    expect(walMaintenanceTestHooks.liveWorkers()).toBe(1);
    walMaintenanceTestHooks.failActive();
    await vi.waitFor(() => expect(walMaintenanceTestHooks.liveWorkers()).toBe(0), { timeout: 5000, interval: 5 });
  } finally { walMaintenanceTestHooks.restartDelaysMs = delays; }
});

/** The deferral cap is a rule about the WORKER's clock: the pass that the held reset intent defers starts on the first poll tick at least DUE_MS after the
 * first tick that saw the work, never earlier and never later. Both ends are read from the worker's own tick records (the product's DUE_MS and poll as
 * predicates), as in T-STEP-PACE: a wall-clock bound measured by this thread (the old "300 ms after the commit returned") also counts every
 * millisecond that the host keeps this thread or the worker off the CPU, and the rule's own worst case (one poll of phase + DUE_MS + one poll of lag)
 * is that same 300 ms, so any scheduling delay failed it. `stall` holds the worker for 2 s just before it marks each pass running (the test hook), the
 * forced form of that delay: the rule must hold on the worker's clock whatever the host does. */
function stepDeferral(ticks: PaceTick[], gate = false) {
  const first = ticks.find(tick => tick.work);
  const started = ticks.find(tick => tick.started);
  expect(first).toBeDefined();
  expect(started).toBeDefined();
  expect(first!.started).toBe(false); // the held intent defers the pass: a fence-ignoring worker starts on the first tick
  // Not earlier: the pass starts no sooner than DUE_MS after the deferral began. Both ends are the worker's Date.now() readings (the deferral began
  // inside the first tick, after its clock read; the pass starts inside the starting tick, after its own): one poll of slack covers the work between a
  // tick's clock read and its decision. startedAt (a performance-clock epoch) is not mixed in: against Date.now it read 226 ms where
  // 250 is the floor ("expected 226 to be greater than or equal to 245"), two clocks that are not the same one.
  expect(started!.now - first!.now).toBeGreaterThanOrEqual(DUE_MS - STEP_POLL_MS);
  // Not later: no tick that read its clock DUE_MS or more after the deferral began (the worker's own reading of when it began, deferredAt: the first tick's
  // clock read can precede it by the time that tick spends reading the log, which a loaded disk stretches past a poll) is still deferred.
  expect(ticks.filter(tick => tick.deferredAt != null && !tick.started && tick.now - tick.deferredAt >= DUE_MS).map(tick => tick.tick)).toEqual([]);
  expect(ticks.some(tick => tick.deferredAt != null)).toBe(true); // a silent field cannot pass
  // The 300 ms start gate, with the STARTING tick counted (the check above leaves started ticks out, so a start that came late with no deferred tick after the cap
  // would pass it): the pass starts within one poll of phase + DUE_MS + one poll of lag of the worker's own deferredAt. Both ends are the worker's Date.now()
  // readings, so a host that keeps this thread off the CPU cannot fail it; only the worker itself starting late can. The gate is asserted where the intent is held
  // for the whole deferral and the worker is not held (T-STEP-DEFER-CAP): the STALL form holds the worker for 2 s before every pass check by construction, and
  // T-STEP-RESETFAIR toggles the intent, so its deferredAt can predate the scenario; their worker-clock rules above are asserted.
  const began = ticks.find(tick => tick.deferredAt != null)!.deferredAt!;
  if (gate) expect(started!.now - began, "the pass starts within 300 ms of the deferral beginning, on the worker's clock").toBeLessThanOrEqual(DUE_MS + 2 * STEP_POLL_MS);
  expect(DUE_MS + 2 * STEP_POLL_MS).toBe(300);
}
async function stepDeferCap(stall: boolean) {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); };
  const db = await stepReady();
  const fence = walResetFence();
  expect(fence.enter()).toBe(true);
  try {
    ticks.length = 0; // only ticks of this test's own work count (queued older ones carry no work)
    if (stall) barrier.holdStart(true);
    fill(db, 4); // due by size, with no more commits or requests during deferral
    await vi.waitFor(() => expect(ticks.some(tick => tick.started)).toBe(true), { timeout: 20_000, interval: 5 }); // a fence that never lets the pass start cannot pass
    if (stall) barrier.holdStart(false);
    expect(stepCounters().resetWant).toBe(1); // starts despite the still-held intent
    stepDeferral(ticks, !stall);
  } finally { barrier.holdStart(false); fence.leave(); }
}
it("T-STEP-DEFER-CAP work", { timeout: 30_000 }, async () => { await stepDeferCap(false); });
it("T-STEP-DEFER-CAP-STALL work", { timeout: 30_000 }, async () => { await stepDeferCap(true); });

/** Reset fairness on the worker's clock (see stepDeferCap). While the intent is held, commits keep arriving and the deferred pass does not start before DUE_MS
 * has passed since the deferral began (the old loop asserted "no pass yet" after each of 8 commits, each an fsync: on a loaded disk they took over 250 ms and
 * the cap had legitimately expired, "expected 1 to be 0"); once the intent is released the pass starts on the first tick that sees it; and a forgotten
 * leave cannot starve the worker beyond the cap. `slow` makes every guard commit take 40 ms, a loaded disk's fsync: the old failure, forced. */
async function stepResetFair(slow: boolean) {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); }; // read when the worker starts, so before stepReady
  const db = await stepReady();
  const fence = walResetFence();
  expect(fence.enter()).toBe(true);
  try {
    expect(stepCounters().resetWant).toBe(1);
    ticks.length = 0;
    // Make a pass due by size, then keep committing while the intent is held.
    // A fence-ignoring mutant must fail even if the small commits alone take less than 250 ms.
    fill(db, 4);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let index = 0; index < 8; index++) {
      db.prepare("INSERT INTO canary VALUES('guard', zeroblob(16384))").run();
      if (slow) Atomics.wait(sleeper, 0, 0, 40);
    }
    for (const until = performance.now() + 100; performance.now() < until;) Atomics.wait(sleeper, 0, 0, 2);
    fence.leave(); fence.leave(); // idempotent
    const leftAt = Date.now(); // after the release: a tick that reads its clock after this sees no intent
    expect(stepCounters().resetWant).toBe(0);
    await vi.waitFor(() => expect(ticks.some(tick => tick.started)).toBe(true), { timeout: 20_000, interval: 5 }); // a pass that is never released or never starts cannot pass
    const first = ticks.find(tick => tick.work);
    const started = ticks.find(tick => tick.started)!;
    expect(first).toBeDefined();
    expect(first!.started).toBe(false); // deferred while held: a fence-ignoring worker starts on the first tick
    // Held: it starts only once DUE_MS has passed on the worker's clock, or after the release.
    expect(started.now >= leftAt - STEP_POLL_MS || started.now - first!.now >= DUE_MS - STEP_POLL_MS, `started ${started.now - first!.now} ms after the first tick, released ${leftAt - first!.now} ms after it`).toBe(true);
    // Released: the pass starts on the first tick that reads its clock after the release (or earlier, if the cap had passed).
    const firstAfter = ticks.findIndex(tick => tick.now > leftAt);
    expect(firstAfter === -1 || ticks.indexOf(started) <= firstAfter, `started at tick index ${ticks.indexOf(started)}, first tick after the release is ${firstAfter}`).toBe(true);
    await checkpointPassive(); // every earlier tick record is delivered before this answer
    // The pass that follows a pass (a crossed one, a retry) is due DUE_MS later and starts on its own: let the worker go quiet first (its latest tick has no
    // deferral pending, no retry owed and no change unseen), or that pass's start is read as the start of this scenario's.
    ticks.length = 0;
    await vi.waitFor(() => { const last = ticks[ticks.length - 1]; expect(last).toBeDefined(); expect(last!.timed || last!.retry || last!.changed).toBe(false); }, { timeout: 20_000, interval: 5 });

    // A forgotten leave cannot starve the worker beyond the cap. A pass still running (the retry or the debt pass that follows a pass) refuses the fence and the
    // caller asks again: a refused enter leaves its intent stored, so it is withdrawn before the next ask.
    await vi.waitFor(() => { const granted = fence.enter(); if (!granted) fence.leave(); expect(granted).toBe(true); }, { timeout: 20_000, interval: 5 });
    ticks.length = 0;
    fill(db, 4);
    await vi.waitFor(() => expect(ticks.some(tick => tick.started)).toBe(true), { timeout: 20_000, interval: 5 });
    stepDeferral(ticks);
  } finally { fence.leave(); }
}
it("T-STEP-RESETFAIR work", { timeout: 30_000 }, async () => { await stepResetFair(false); });
it("T-STEP-RESETFAIR-SLOW work", { timeout: 30_000 }, async () => { await stepResetFair(true); });

it("T-NUDGE-DV work", { timeout: 30_000 }, async () => {
  // Use database.ts's real nudge port, rather than the restart fixture's equivalent port.
  const db = await ready();
  const observer = new DatabaseSync(messagesFile());
  const version = () => Number(observer.prepare("PRAGMA data_version").get()!.data_version);
  try {
    fill(db, 1);
    const before = version();
    expect(await settleWal()).toBe(true);
    expect(version()).toBe(before);
    const userVersion = db.prepare("PRAGMA user_version").get()!.user_version;
    expect(await settleWal({ nudge: true })).toBe(true);
    expect(version()).not.toBe(before);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(userVersion);
  } finally { observer.close(); }
});

async function stepBurst(which: "a" | "b") {
  const db = await stepReady();
  const canary = `C2-BURST-${crypto.randomUUID()}`;
  const passes: StepPass[] = [];
  const unsubscribe = onWalPass(pass => passes.push(pass));
  let reader: ReturnType<typeof pinReader> | undefined;
  const seqBefore = stepCounters().passSeq;
  barrier.holdGate(true);
  try {
    if (which === "a") fill(db, 256, canary, "gone");
    else {
      reader = pinReader();
      for (let index = 0; index < 64; index++) fill(db, 4, index === 63 ? canary : undefined, "gone");
    }
    db.prepare("DELETE FROM canary WHERE thread_id='gone'").run();
    const mark = walMark(walFile());
    expect(statSync(walFile()).size).toBeGreaterThan(256 * MB);
    // running is published before the new pass id; join the held pass, not its predecessor.
    await vi.waitFor(() => { const now = stepCounters(); expect(now.running === 1 && now.passSeq > seqBefore).toBe(true); }, { timeout: 5000, interval: 5 });
    const gated = stepCounters();
    let scrubbed = false;
    const result = await stepBeats(db, async () => {
      expect(Number(db.prepare("SELECT count(*) AS n FROM beat").get()!.n)).toBeGreaterThan(0);
      reader?.release(); reader = undefined;
      barrier.holdGate(false);
      scrubbed = await scrubWalAfterDelete(30_000);
    });
    console.log(`[c2-burst] case=${which} loopMaxMs=${result.loopMaxMs.toFixed(1)} lost=${result.lost} failed=${result.failed}`);
    // REPORTED only: the 100 ms wall-clock budget is NOT asserted for either one-burst case.
    stepAssertBeats(result);
    expect(scrubbed).toBe(true);
    expect(walScrubbed(walFile(), mark)).toBe(true);
    expect(fileHas(walFile(), canary)).toBe(false);
    expect(fileHas(messagesFile(), canary)).toBe(false);
    expect(passes.some(pass => pass.gen === gated.gen && pass.id === gated.passSeq && !pass.cancelled)).toBe(true);
  } finally { reader?.release(); barrier.holdGate(false); unsubscribe(); }
}

it("T-BURST-OVERLAP case=a work (REPORTED)", { timeout: 120_000 }, async () => {
  await stepBurst("a");
});

it("T-BURST-OVERLAP case=b work (REPORTED)", { timeout: 120_000 }, async () => {
  await stepBurst("b");
});

// ── C2 sync-debt cap (C2-FSYNC-DEBT-RULING part 1) ───────────────────────────
// A pass that a commit or a reader mark keeps from the end of the log leaves its copied pages unsynced; once 8 MiB of them have built up the worker flushes
// the db file itself, on one descriptor the main thread owns. The existing 200 MB single-transaction test above is a separate question and is not touched.
const DEBT_WRITER = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=0; PRAGMA busy_timeout=1000");
  parentPort.once("message", () => {
    const insert = db.prepare("INSERT INTO canary VALUES(?, randomblob(?))");
    for (let i = 0; i < workerData.commits; i++) {
      db.exec("BEGIN IMMEDIATE");
      for (let j = 0; j < workerData.perCommit; j++) insert.run("filler", workerData.commitBytes / workerData.perCommit);
      db.exec("COMMIT");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.gapMs);
    }
    db.close();
    parentPort.close();
  });
`;
/** An off-thread writer: `commits` transactions of `commitBytes` each, `gapMs` apart. */
function debtWriter(commits: number, commitBytes: number, gapMs: number) {
  const writer = new Worker(DEBT_WRITER, { eval: true, workerData: { file: messagesFile(), commits, commitBytes, perCommit: Math.max(1, commitBytes / MB), gapMs } });
  const exited = new Promise<void>((resolve, reject) => {
    writer.once("error", reject);
    writer.once("exit", code => code === 0 ? resolve() : reject(new Error(`debt writer exit ${code}`)));
  });
  void exited.catch(() => {});
  return { go() { writer.postMessage("go"); return exited; }, stop() { return writer.terminate(); } };
}
const canaryBytes = (db: DatabaseSync) => Number(db.prepare("SELECT sum(length(body)) AS n FROM canary").get()!.n);

it("T-DEBT-CAP work", { timeout: 120_000 }, async () => {
  const ticks: PaceTick[] = [];
  walMaintenanceTestHooks.paceTrace = tick => { ticks.push(tick); }; // read when the worker starts, so before stepReady
  const db = await stepReady();
  ticks.length = 0;
  const COMMITS = 200;
  const writer = debtWriter(COMMITS, MB, 5);
  // A reader that re-pins every 40 ms, so its mark is always several commits behind the log end: passes copy up to it and cannot reach the end, SQLite does not
  // sync, and only the cap bounds the unsynced bytes.
  const churn = new DatabaseSync(messagesFile());
  let open = false;
  const timer = setInterval(() => {
    try {
      if (open) churn.exec("COMMIT");
      churn.exec("BEGIN"); churn.prepare("SELECT count(*) FROM beat").get(); open = true;
    } catch { open = false; }
  }, 40);
  try {
    await writer.go();
  } finally {
    clearInterval(timer);
    try { if (open) churn.exec("COMMIT"); } catch { /* done */ }
    churn.close();
    await writer.stop();
  }
  const counters = stepCounters();
  console.log(`[c2-debt] cap: debtSyncs=${counters.debtSyncs} maxUnsyncedKiB=${counters.maxUnsyncedKiB} maxPassCopyKiB=${counters.maxPassCopyKiB} timedPasses=${counters.timedPasses} failures=${counters.debtSyncFailures}`);
  expect(counters.debtSyncs).toBeGreaterThan(0);
  expect(counters.debtSyncFailures).toBe(0);
  // PACE rule (i) still holds under debt: the cap flushes inside the pass, it never holds the next one back. A silent hook cannot pass.
  expect(ticks.filter(tick => tick.work).length).toBeGreaterThan(0);
  expect(ticks.filter(tick => tick.work && !tick.started).map(tick => tick.tick)).toEqual([]);
  expect(counters.maxUnsyncedKiB).toBeGreaterThan(0); // a disabled counter cannot pass
  expect(counters.maxUnsyncedKiB).toBeLessThanOrEqual(DEBT_SYNC_BYTES / 1024 + counters.maxPassCopyKiB);
  expect(canaryBytes(db)).toBe(COMMITS * MB); // no lost commit
});

/** Each 4 MB commit is followed by silence until ITS pass is done and nothing is owed. "Its pass" is identified by what the pass reports, not by a counter
 * that any pass moves: the old wait (passDone moved, running 0, backlog 0) was satisfied by a pass that ran DURING the commit (a log restart makes the
 * tick start an empty pass) and by a backlog sample that no tick had refreshed yet, so the next commit landed before this one was copied; one pass then
 * copied two commits, was crossed by a third, and the flush at 8 MB (correct for what it saw) failed the "no debt" assertion. A pass counts for commit N
 * only if it started after N began (id above the number of passes started so far), reports a log of at least this commit's frames and copied all of them.
 * A pass that a commit crossed leaves its bytes owed until the next pass syncs them (due DUE_MS later), so the wait also needs nothing owed before the
 * next commit may land. `stall` forces the old failure: a pass that is not the commit's is already done and the worker is held just before its next
 * pass, so the shared counters are stale at the moment the commit returns. */
async function stepDebtReset(stall: boolean) {
  const db = await stepReady();
  const COMMITS = 6;
  const FRAMES = (4 * MB) / 4096; // a 4 MB commit is at least this many log frames (default page size)
  const passes: StepPass[] = [];
  const stop = onWalPass(pass => { passes.push(pass); });
  try {
    for (let index = 0; index < COMMITS; index++) {
      const started = stepCounters().passSeq;
      if (stall) { await checkpointPassive(); barrier.holdStart(true); void checkpointPassive(); await stepSleep(50); }
      fill(db, 4);
      if (stall) barrier.holdStart(false);
      await vi.waitFor(() => {
        expect(passes.some(pass => pass.id > started && Number(pass.log ?? -1) >= FRAMES && pass.checkpointed === pass.log)).toBe(true); // a pass copied this commit
        const counters = stepCounters();
        expect(counters.running).toBe(0); expect(counters.backlogKiB).toBe(0); expect(counters.unsyncedKiB).toBe(0); // and nothing is owed
      }, { timeout: 15_000, interval: 10 });
    }
  } finally { stop(); barrier.holdStart(false); }
  // Drain: one more pass on a quiet log (a pass still in flight from the last commit may have been crossed by it), which must leave nothing owed.
  await checkpointPassive();
  await vi.waitFor(() => expect(stepCounters().running).toBe(0), { timeout: 5000, interval: 5 });
  const counters = stepCounters();
  console.log(`[c2-debt] reset: debtSyncs=${counters.debtSyncs} unsyncedKiB=${counters.unsyncedKiB} maxUnsyncedKiB=${counters.maxUnsyncedKiB} maxPassCopyKiB=${counters.maxPassCopyKiB} timedPasses=${counters.timedPasses}`);
  if (!stall) expect(counters.timedPasses).toBeGreaterThanOrEqual(COMMITS); // (the held passes of the stall form are requested passes)
  expect(counters.maxPassCopyKiB).toBeGreaterThan(0); // passes really copied
  expect(counters.debtSyncs).toBe(0);
  expect(counters.unsyncedKiB).toBe(0);
  expect(canaryBytes(db)).toBe(COMMITS * 4 * MB);
}
it("T-DEBT-RESET work", { timeout: 120_000 }, async () => { await stepDebtReset(false); });
it("T-DEBT-RESET-STALL work", { timeout: 120_000 }, async () => { await stepDebtReset(true); });

/** The debt counter goes back to 0 after a pass that copied everything. A clean run never owes anything (no commit crosses a pass), so T-DEBT-RESET cannot see
 * the reset itself. Here the debt is made to exist first: with every pass parked, commit A, pin a reader at the end of A, commit B; the first pass copies A and cannot
 * reach the end of the log (the reader holds it), so A's bytes are owed (unsyncedKiB > 0, health surface slot 13). When the reader lets go the retry copies B and
 * reaches the end of the log with no commit crossing: SQLite syncs the db file and the debt must read 0. Mutants: debt not reset on a synced pass, synced passes counted as debt. */
it("T-DEBT-RESET-OBSERVED work", { timeout: 60_000 }, async () => {
  const db = await stepReady();
  const passes: StepPass[] = [];
  const stop = onWalPass(pass => { passes.push(pass); });
  let reader: DatabaseSync | null = null;
  try {
    barrier.holdGate(true);
    fill(db, 2); // A
    reader = new DatabaseSync(messagesFile());
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM canary").get(); // pins the log at the end of A
    fill(db, 2); // B, committed after the pin
    barrier.holdGate(false);
    await vi.waitFor(() => expect(passes.some(pass => Number(pass.checkpointed ?? -1) > 0 && Number(pass.log ?? -1) > Number(pass.checkpointed))).toBe(true), { timeout: 30_000, interval: 10 }); // copied A, could not reach the end
    expect(stepCounters().unsyncedKiB, "A's bytes are owed: a disabled debt counter cannot pass").toBeGreaterThanOrEqual(2 * 1024);
    expect(stepCounters().debtSyncs).toBe(0);
    const from = passes.length;
    reader.exec("COMMIT");
    await vi.waitFor(() => expect(passes.slice(from).some(pass => Number(pass.log ?? -1) > 0 && pass.checkpointed === pass.log)).toBe(true), { timeout: 30_000, interval: 10 }); // copied everything
    expect(stepCounters().unsyncedKiB, "a synced pass returns the debt to 0").toBe(0);
    expect(stepCounters().debtSyncs, "by the reset, not by a flush").toBe(0);
    expect(stepCounters().maxUnsyncedKiB).toBeGreaterThanOrEqual(2 * 1024);
  } finally { stop(); barrier.holdGate(false); try { reader?.close(); } catch { /* already closed */ } }
});

const debtFdsOn = (file: string) => {
  const real = realpathSync(file);
  return readdirSync("/proc/self/fd").filter(name => { try { return readlinkSync(`/proc/self/fd/${name}`) === real; } catch { return false; } }).length;
};

it("T-DEBT-FD work", { timeout: 60_000 }, async () => {
  const db = await stepReady();
  const proc = existsSync("/proc/self/fd");
  const fd = walMaintenanceTestHooks.debtFd();
  expect(fd).toBeGreaterThanOrEqual(0);
  const inode = () => statSync(messagesFile(), { bigint: true }).ino;
  const same = () => { expect(fstatSync(fd, { bigint: true }).ino).toBe(inode()); }; // throws EBADF if anything closed it
  same();
  // The server connection holds a read transaction on a log that is not fully copied: it must keep holding it through every worker change.
  fill(db, 1);
  db.exec("BEGIN"); db.prepare("SELECT count(*) FROM canary").get();
  let baseline = -1;
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = [20];
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      const spawned = walMaintenanceTestHooks.spawned();
      // Two cycles retire the worker (it closes its own connection), two fail it (the thread is ended): neither may touch the descriptor.
      if (cycle % 2 === 0) startWalMaintenance(messagesFile(), stepPorts(db)); else expect(walMaintenanceTestHooks.failActive()).toBe(true);
      await vi.waitFor(() => {
        expect(walMaintenanceTestHooks.spawned()).toBeGreaterThan(spawned);
        expect(walMaintenanceTestHooks.liveWorkers()).toBe(1);
        expect(walMaintenanceReady()).toBe(true);
      }, { timeout: 10_000, interval: 5 });
      expect(walMaintenanceTestHooks.debtFd()).toBe(fd);
      expect(walMaintenanceTestHooks.debtOrphans()).toBe(0);
      same();
      if (proc) {
        expect(readlinkSync(`/proc/self/fd/${fd}`)).toBe(realpathSync(messagesFile()));
        if (baseline < 0) baseline = debtFdsOn(messagesFile());
        await vi.waitFor(() => expect(debtFdsOn(messagesFile())).toBe(baseline), { timeout: 5000, interval: 10 }); // no leak, nothing closed
      }
    }
    // The server connection locks survived: a second process cannot reset the log under the open read transaction.
    const child = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout=0");
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all()[0];
      console.log(JSON.stringify({ busy: Number(row.busy) }));
    `, messagesFile()], { encoding: "utf8", timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").pop()!).busy).toBe(1);
    same();
  } finally {
    walMaintenanceTestHooks.restartDelaysMs = delays;
    if (db.isTransaction) db.exec("COMMIT");
  }
});

it("T-DEBT-STALL", { tags: ["perf-budget"], timeout: 180_000 }, async () => {
  const db = await stepReady();
  // 200 MB built from 4 MB main-thread commits, back to back, while passes run: a pass is overtaken by the next commit before it reaches the end, so SQLite does not
  // sync it and the dirty pages build up. Four timed message appends follow each commit; the cap must keep the flush they can meet under the budget.
  const COMMITS = 50;
  const slowest: number[] = [];
  let appended = 0;
  for (let index = 0; index < COMMITS; index++) {
    fill(db, 4);
    for (let each = 0; each < 4; each++) {
      const started = performance.now();
      appendMessage("debt-thread", message(`d${appended}`, `hello ${appended}`));
      slowest.push(performance.now() - started);
      appended++;
    }
  }
  const counters = stepCounters();
  const max = Math.max(...slowest);
  console.log(`[c2-debt] stall: maxAppendMs=${max.toFixed(1)} appended=${appended} debtSyncs=${counters.debtSyncs} maxUnsyncedKiB=${counters.maxUnsyncedKiB} maxPassCopyKiB=${counters.maxPassCopyKiB} timedPasses=${counters.timedPasses}`);
  // Sanity rows: the debt really accrued past the cap and was flushed, so this test exercises the cap and not an idle disk.
  expect(counters.maxUnsyncedKiB).toBeGreaterThanOrEqual(DEBT_SYNC_BYTES / 1024);
  expect(counters.debtSyncs).toBeGreaterThan(0);
  expect(counters.debtSyncFailures).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?").get("debt-thread")?.n).toBe(appended); // no lost commit
  expect(canaryBytes(db)).toBe(COMMITS * 4 * MB);
  // ENFORCED (Sean 11-08) in the serial release timing run: MURAGE_TEST_TIMING=1, a TEST word the env scrub keeps, set by the timing box runner under its lock.
  // The nightly runner leaves this flag unset. Loaded runs report timing and enforce the sanity rows above.
  if (process.env.MURAGE_TEST_TIMING === "1") expect(max).toBeLessThan(50);
});

it("T-LOCK-WIRING a checkpointer ended while it holds the ledger lock is recovered only after its exit event; poisoned until the next checkpointer starts, then rebuilt", { timeout: 60_000 }, async () => {
  await ready();
  walMaintenanceTestHooks.restartDelaysMs = [1500]; // a window in which the ledger stays poisoned
  const slots = new BigInt64Array(ioBudget.checkpointAdmissionBuffer());
  const id = walMaintenanceTestHooks.workerThreadId();
  expect(id).toBeGreaterThan(0);
  const before = ioBudget.admissionHealth();
  // The thread holds the lock when it is ended (its token is in the word; it only takes the lock inside a copy, so wait for a released word).
  await vi.waitFor(() => expect(Atomics.compareExchange(slots, 0, 0n, (BigInt(id) << 32n) | 7n)).toBe(0n), { timeout: 5000 });
  walMaintenanceTestHooks.terminate(); // same tick: no timer runs between the plant and the terminate
  await vi.waitFor(() => expect(ioBudget.admissionHealth().recoveries, "recovered after the exit event").toBe(before.recoveries + 1), { timeout: 15_000 });
  expect(Atomics.load(slots, 0), "lock word cleared by the recovery").toBe(0n);
  expect(ioBudget.admissionHealth().poisoned, "poisoned until the next checkpointer starts").toBe(true);
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 20_000 });
  expect(ioBudget.admissionHealth().poisoned, "rebuilt when the next checkpointer started").toBe(false);
});

it("T-LOCK-CONTENDED the lock is held when the timer starts: the main thread fails closed at once, a worker waits for it inside the deadline", { timeout: 30_000 }, async () => {
  await ready();
  const buf = ioBudget.checkpointAdmissionBuffer();
  const holder = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    ledger.lock(); parentPort.postMessage("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); ledger.unlock(); parentPort.postMessage("released");`,
  { eval: true, workerData: { buf, src: checkpointLedger.toString() } });
  const waiter = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    parentPort.once("message", () => { const t0 = performance.now(); ledger.lock(); ledger.unlock(); parentPort.postMessage(performance.now() - t0); });`,
  { eval: true, workerData: { buf, src: checkpointLedger.toString() } });
  try {
    await new Promise<void>((resolve, reject) => { holder.once("message", () => resolve()); holder.once("error", reject); });
    // The lock is held now. The timers start here: both acquires below are contended.
    const answer = new Promise<number>((resolve, reject) => { waiter.once("message", resolve); waiter.once("error", reject); });
    waiter.postMessage("go");
    const ledger = checkpointLedger(buf), t0 = performance.now();
    let name = "acquired";
    try { ledger.lock(); ledger.unlock(); } catch (error) { name = (error as Error).name; }
    expect(name, "main thread: busy word is an immediate named error").toBe("AdmissionLockTimeout");
    expect(performance.now() - t0, "and it did not wait").toBeLessThan(50);
    const waited = await answer;
    expect(waited, "worker: really waited for the holder").toBeGreaterThan(150);
    expect(waited, "inside the total deadline").toBeLessThan(2000);
  } finally { await holder.terminate(); await waiter.terminate(); }
});

// WAL-ADMISSION-HANG r3 (D6-R3, T6b-real): the real checkpointer, a real temp database, and a test worker that holds the ledger lock.
const d6Owners = (s: BigInt64Array) => [18, 21, 24, 27].map(i => s[i]!).filter(o => o !== 0n);
const d6Holder = (buf: SharedArrayBuffer, holdMs: number) => new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const l = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    l.lock(); parentPort.postMessage("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs); l.unlock(); parentPort.postMessage("released");`,
{ eval: true, workerData: { buf, src: checkpointLedger.toString(), holdMs } });
const d6Msg = (w: Worker, text: string) => new Promise<void>((resolve, reject) => { const on = (m: string) => { if (m === text) { w.off("message", on); resolve(); } }; w.on("message", on); w.once("error", reject); });
const d6Sites = () => { const sites = (ioBudget as any).admissionHealth?.().timeoutSites ?? {}; return { begin: Number(sites["wal-beginCopy"] ?? 0), end: Number(sites["wal-endCopy"] ?? 0) }; };
/** Deterministic placement: the checkpointer's next pass is parked exactly before one admission call (1 = beginCopy, 2 = endCopy) by the
 *  test barrier (server/testing/wal-barrier.ts), and the test only goes on once the pass is there. There is no timing to win: whichever pass
 *  reaches the call first stops at it, with its owner-table entry in the state that call leaves behind (none before beginCopy, one charged
 *  before endCopy). */
async function parkNextPass(db: DatabaseSync, slots: BigInt64Array, site: 1 | 2) {
  await vi.waitFor(() => expect(d6Owners(slots), "a quiet table before the pass is armed").toEqual([]), { timeout: 15_000, interval: 10 });
  barrier.arm(site);
  fill(db, 8); // a pass is due
  await vi.waitFor(() => expect(barrier.parkedAt(), "the pass is parked before the admission call").toBe(site), { timeout: 15_000, interval: 10 });
}
/** Resolves with the next pass the worker reports. The worker posts its admission-timeout message BEFORE its pass message on the one port, so
 *  once this resolves the main thread has already counted the timeout: the caller then asserts the counter directly (no waiting predicate). */
const nextPass = () => new Promise<WalPass>(resolve => { const off = onWalPass(pass => { off(); resolve(pass); }); });
/** Lets the parked pass go on and returns once that pass is over. */
async function releaseAndFinish() { const done = nextPass(); barrier.release(); return done; }
/** Runs one more pass (a commit makes it due) and returns once it is over. */
async function onePassAfter(db: DatabaseSync) { const done = nextPass(); fill(db, 1); return done; }

it("D6-R3e the holder meets the pass at endCopy: the endCopy timeout is kept and retried, the owner-table entry clears and the reservation is released", { timeout: 120_000 }, async () => {
  const db = await ready();
  const buf = ioBudget.checkpointAdmissionBuffer(), slots = new BigInt64Array(buf);
  const before = d6Sites();
  await parkNextPass(db, slots, 2);
  expect(d6Owners(slots).length, "parked at endCopy: the pass holds its entry").toBe(1);
  const holder = d6Holder(buf, 3000);
  const held = d6Msg(holder, "held"), released = d6Msg(holder, "released");
  try {
    await held; // the lock is held before the pass makes its endCopy call
    await releaseAndFinish();
    expect(d6Sites().end, "the worker's endCopy lock timeout was counted").toBe(before.end + 1);
    expect(d6Sites().begin, "it met the holder at endCopy, not at beginCopy").toBe(before.begin);
    expect(d6Owners(slots).length, "the entry stays charged meanwhile").toBe(1);
    await released;
  } finally { barrier.release(); try { await released; } finally { await holder.terminate(); } }
  await onePassAfter(db); // the retry runs at the start of that pass, the lock is released now
  expect(d6Owners(slots), "the retry released the entry").toEqual([]);
  expect(Number(slots[6]), "and its reservation").toBe(0);
  expect(Number(slots[16]), "no table refusal happened").toBe(0);
  expect(barrier.expired(), "the park ended by the test's release, not by its deadline").toBe(0);
});

it("D6-R3b the holder meets the pass at beginCopy: the copy is refused and nothing is charged, the timeout reaches the counter", { timeout: 120_000 }, async () => {
  const db = await ready();
  const buf = ioBudget.checkpointAdmissionBuffer(), slots = new BigInt64Array(buf);
  const before = d6Sites();
  await parkNextPass(db, slots, 1);
  expect(d6Owners(slots), "parked at beginCopy: the pass holds no entry yet").toEqual([]);
  const holder = d6Holder(buf, 3000);
  const held = d6Msg(holder, "held"), released = d6Msg(holder, "released");
  try {
    await held; // the lock is held before the pass makes its beginCopy call
    await releaseAndFinish();
    expect(d6Sites().begin, "the worker's beginCopy lock timeout was counted").toBe(before.begin + 1);
    expect(d6Sites().end, "it met the holder at beginCopy, not at endCopy").toBe(before.end);
    expect(d6Owners(slots), "a refused copy holds no entry").toEqual([]);
    expect(Number(slots[6]), "and no reservation").toBe(0);
    await released;
  } finally { barrier.release(); try { await released; } finally { await holder.terminate(); } }
  expect(Number(slots[16]), "no table refusal happened").toBe(0);
  expect(barrier.expired(), "the park ended by the test's release, not by its deadline").toBe(0);
});

it("T6b-real a real checkpointer meets a held lock at beginCopy: its lock timeout reaches the counter and the health field", { timeout: 60_000 }, async () => {
  const db = await ready();
  const buf = ioBudget.checkpointAdmissionBuffer(), slots = new BigInt64Array(buf);
  const before = d6Sites();
  await parkNextPass(db, slots, 1);
  const holder = d6Holder(buf, 3000);
  const held = d6Msg(holder, "held"), released = d6Msg(holder, "released");
  try {
    await held;
    await releaseAndFinish();
    const h = (ioBudget as any).admissionHealth?.() ?? {};
    expect(d6Sites().begin, "a worker's beginCopy lock timeout reached the counter").toBe(before.begin + 1);
    expect(h.lockTimeouts, "and the health field").toBeGreaterThan(0);
    await released;
  } finally { barrier.release(); try { await released; } finally { await holder.terminate(); } }
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(index, "GET /api/health carries the admission field").toContain("admissionLock: ioBudget.admissionHealth()");
  expect(barrier.expired(), "the park ended by the test's release, not by its deadline").toBe(0);
});

// D6-R6w (DESIGN-D6.2-DELTA.md): the real checkpointer copies the log back with a real PRAGMA wal_checkpoint, is killed before its endCopy
// and the main thread reconciles the dead owner. The ledger must end in exactly one accounted state, never neither: nothing may be released
// without a covered reading, and a charge is taken in full. The pass and the kill are in the same admission minute (the clock is pinned), so
// the covered release is not available and the ceiling must be CHARGED in slot 8, the entry cleared and its reservation (slot 6) released.
// Windows-only requirement: it is listed in ci/WINDOWS-REQUIRED.txt, which scripts/run-windows-required.mjs consumes (a skipped row fails there).
// D6_R6W_ON_HOST=1 runs the same assertions on another OS to check the test itself and its mutants; it never satisfies the Windows requirement.
const r6wRuns = process.platform === "win32" || process.env.D6_R6W_ON_HOST === "1";
it.skipIf(!r6wRuns)("D6-R6w [WINDOWS-REQUIRED] real copy-back killed before endCopy: the ceiling is charged once, the entry and reservation are released, never neither", { timeout: 120_000 }, async () => {
  const db = await ready();
  const slots = new BigInt64Array(ioBudget.checkpointAdmissionBuffer());
  const delays = [...walMaintenanceTestHooks.restartDelaysMs];
  walMaintenanceTestHooks.restartDelaysMs = []; // no restart: the exit is the only event
  try {
    await parkNextPass(db, slots, 2); // PRAGMA wal_checkpoint has copied the log back; the pass holds one charged entry and has not settled
    expect(d6Owners(slots).length, "one entry held by the pass").toBe(1);
    const ceiling = Number(slots[19]), charged0 = Number(slots[8]), visible0 = Number(slots[11]);
    expect(ceiling, "the entry carries the reserved ceiling").toBeGreaterThan(0);
    expect(Number(slots[6]), "and the reservation includes it").toBeGreaterThanOrEqual(ceiling);
    walMaintenanceTestHooks.terminate(); // killed inside the pass: endCopy never runs
    await vi.waitFor(() => expect(walMaintenanceTestHooks.liveWorkers(), "the thread is gone").toBe(0), { timeout: 15_000, interval: 10 });
    const charged = Number(slots[8]) - charged0, visible = Number(slots[11]) - visible0;
    const outcome = d6Owners(slots).length === 0 && Number(slots[6]) === 0 ? (charged === ceiling ? "charge" : charged === 0 && visible > 0 ? "covered" : "neither") : "unsettled";
    console.info(`D6-R6w platform=${process.platform} outcome=${outcome} ceiling=${ceiling} charged=${charged} slot11Delta=${visible} health=${JSON.stringify((ioBudget as any).admissionHealth?.() ?? {})}`);
    expect(d6Owners(slots), "the dead worker's entry is reconciled").toEqual([]);
    expect(Number(slots[6]), "its reservation is released").toBe(0);
    expect(charged, "released without a covered reading would charge nothing: the whole ceiling is charged once").toBe(ceiling);
    expect(outcome, "exactly one accounted outcome, same minute so the charge").toBe("charge");
  } finally { walMaintenanceTestHooks.restartDelaysMs = delays; barrier.release(); }
});
