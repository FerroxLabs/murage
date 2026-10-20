// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The write-ahead log of messages.db is copied and shrunk without any connection but the server's ever holding the writer
// lock (wal-maintenance.ts). Invariants I1 to I5 of the 1.0.2 design are each pinned here.
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, resumeEngineHistory, runEngineHistoryOffThread, stopEngineHistory } from "./engine-history-offthread.ts";
import { stopDataWriters } from "./data-writers.ts";
import { appendMessage, closeMessageDb } from "./message-db.ts";
import { maintainLineageStorage } from "./memory/root-set-compaction.ts";
import type { Message } from "./store.ts";
import { checkpointPassive, readWalHeader, scrubWalAfterDelete, settleWal, startWalMaintenance, stopWalMaintenance, walMark, walMaintenanceReady, walMaintenanceTestHooks, walScrubPending, walScrubbed } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const messagesFile = () => join(DATA_DIR, "messages.db");
const walFile = () => `${messagesFile()}-wal`;
const fileHas = (file: string, text: string) => existsSync(file) && readFileSync(file).includes(text);
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
const message = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: Date.now() });
const MB = 1024 * 1024;

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  walMaintenanceTestHooks.holdMs = 0; walMaintenanceTestHooks.retryMs = 30_000; walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; walMaintenanceTestHooks.unreadableReads = 0;
  unhandled.length = 0; process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  process.off("unhandledRejection", onUnhandled);
  walMaintenanceTestHooks.holdMs = 0; walMaintenanceTestHooks.retryMs = 30_000; walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; walMaintenanceTestHooks.unreadableReads = 0;
  for (const key of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[key];
  resumeEngineHistory();
  closeDatabase(); await stopWalMaintenance();
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

it("main-thread writes all commit quickly with no BUSY while the worker copies a log of 200 MB", { tags: ["perf-budget"] }, async () => {
  const db = await ready();
  fill(db, 200);
  expect(statSync(walFile()).size).toBeGreaterThan(200 * MB);
  walMaintenanceTestHooks.holdMs = 1500; // the worker also sits on its answer afterwards
  const copying = checkpointPassive();
  const slowest: number[] = [];
  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    appendMessage("busy-thread", message(`m${index}`, `hello ${index}`));
    slowest.push(performance.now() - started);
  }
  expect(Math.max(...slowest)).toBeLessThan(50);
  expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id='busy-thread'").get()?.n).toBe(200);
  const result = await copying;
  expect(result.log).toBeGreaterThan(0);
  expect(unhandled).toEqual([]);
});

it("a checkpointer that dies mid-job leaves no rejection: the job answers busy, the scrub says not done, the app's own checkpoints return", async () => {
  const db = await ready();
  fill(db, 2, "x", "gone");
  walMaintenanceTestHooks.holdMs = 3000;
  const job = checkpointPassive();
  const scrub = scrubWalAfterDelete(400);
  await new Promise(resolve => setTimeout(resolve, 100));
  walMaintenanceTestHooks.terminate();
  expect((await job).busy).toBe(1);
  // With the checkpointer gone the scrub says not done and stays owed; the restarted checkpointer finishes it later.
  const scrubbed = await scrub;
  expect(walScrubPending()).toBe(!scrubbed);
  expect(await settleWal({ nudge: true })).toBe(false);
  await vi.waitFor(() => expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(1000), { timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(unhandled).toEqual([]);
});

it("a checkpointer that cannot start leaves the connection on its own autocheckpoint", async () => {
  const calls: number[] = [];
  startWalMaintenance(join(DATA_DIR, "no-such-folder", "messages.db"), { setAutocheckpoint: pages => { calls.push(pages); }, nudge: async () => false });
  await vi.waitFor(() => expect(calls).toEqual([1000]), { timeout: 10_000 });
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
  walMaintenanceTestHooks.holdMs = 5000;
  void checkpointPassive();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await stopWalMaintenance(0, 0)).toBe(false); // no time to exit: the answer is "still alive", not a guess
  expect(await stopWalMaintenance(3000, 3000)).toBe(true); // given time, the stuck thread is ended and its real exit awaited
});

it("50 cycles of a 5 MB transaction and a settle keep the log under twice the largest transaction", async () => {
  const db = await ready();
  db.exec("CREATE TABLE IF NOT EXISTS canary(thread_id TEXT, body BLOB)");
  let largest = 0;
  for (let cycle = 0; cycle < 50; cycle++) {
    fill(db, 5);
    largest = Math.max(largest, statSync(walFile()).size);
    expect(await settleWal({ nudge: true })).toBe(true);
    expect(statSync(walFile()).size).toBeLessThan(2 * largest);
  }
  expect(largest).toBeLessThan(2 * 5 * MB * 1.1);
  const final = statSync(walFile()).size;
  expect(final).toBeLessThan(64 * 1024);
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
  for (const file of ["wal-maintenance.ts", "engine-history-offthread.ts", "engine-history-worker.ts"]) expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/Atomics\.wait|execSync|spawnSync/);
});

it("every promise the module hands out resolves, even with no checkpointer running", async () => {
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
  expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(1000);
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  await vi.waitFor(() => { expect(walScrubPending()).toBe(false); expect(fileHas(walFile(), canary)).toBe(false); }, { timeout: 15_000 });
  vi.restoreAllMocks();
});

it("r10 finding 2: a checkpointer that keeps dying is restarted without an attempt limit", async () => {
  await ready();
  walMaintenanceTestHooks.restartDelaysMs = [30];
  for (let round = 0; round < 5; round++) {
    walMaintenanceTestHooks.terminate();
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  }
});

it("r9 finding 7: the deadline bounds a checkpointer that does not answer, and a nudge stuck behind the writer gate", async () => {
  const db = await ready();
  fill(db, 2, "x", "gone");
  walMaintenanceTestHooks.holdMs = 3000; // the worker sits on its answer
  let started = performance.now();
  expect(await scrubWalAfterDelete(150)).toBe(false);
  expect(performance.now() - started).toBeLessThan(900);
  expect(walScrubPending()).toBe(true);
  walMaintenanceTestHooks.holdMs = 0;
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
  engineHistoryTestHooks.workerPath = silent; engineHistoryTestHooks.timeoutMs = 2500; // the engine job hangs until its timeout
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
    workerPath: silent,
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
  const late = await runEngineHistoryOffThread(job, { workerPath: silent, onWorker: () => { created++; } });
  expect(late.failed).toEqual([job.homes[0]!.home]);
  expect(created).toBe(1);
  removeTempDirSync(data);
});

it("r9 finding 4: a writer that is still alive keeps the lease", async () => {
  await ready();
  walMaintenanceTestHooks.holdMs = 5000;
  void checkpointPassive();
  await new Promise(resolve => setTimeout(resolve, 50));
  const kept = await stopDataWriters({ closeDatabase: closeMessageDb, stopEngineHistory: () => Promise.resolve(true), stopWalMaintenance: () => stopWalMaintenance(0, 0) });
  expect(kept).toBe(false);
  const engineAlive = await stopDataWriters({ closeDatabase: () => {}, stopEngineHistory: () => Promise.resolve(false), stopWalMaintenance: () => Promise.resolve(true) });
  expect(engineAlive).toBe(false);
});
