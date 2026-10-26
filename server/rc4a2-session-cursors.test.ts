// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc4: after the root-set reclaim ran (complete or partial), "Prepare to reinstall Murage 1.0.1" cannot leave a retained provider session resumable.
// The case: a legacy native session with no receipts and an unprovable nonempty root-set id has no row after the reclaim; 1.0.1 reads "no row, no
// receipts" as valid and would resume it with context 1.0.2 withheld. Every retained cursor is cleared, so 1.0.1 starts a fresh session.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { settleTestHandles } from "./test-handle-registry.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

/** Murage 1.0.1 (d950cbf67 server/memory/dispatch.ts retainedSessionInvalid): a session with a session-roots row on the unprovable set (or none provable) is
 * invalid; with NO row and no receipts it is valid and resumes. Reproduced over the file's own tables. */
function v101Resumes(dir: string, thread: string, instance: string, session: string): boolean {
  const bots = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) as Array<{ tasks: Array<{ threadId: string; resumeCursors: Record<string, string> }> }>;
  const cursor = bots.flatMap(bot => bot.tasks).find(task => task.threadId === thread)?.resumeCursors?.[instance];
  if (cursor !== session) return false; // no retained cursor: 1.0.1 starts a fresh session
  const db = new DatabaseSync(join(dir, "messages.db"));
  try {
    const root = db.prepare("SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, instance, session) as { set_id?: string } | undefined;
    if (root && root.set_id === "") return false;
    const receipts = Number((db.prepare("SELECT COUNT(*) AS n FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, instance, session) as { n: number }).n);
    return receipts === 0 ? true : false;
  } finally { db.close(); }
}
async function fixture(reclaimMarker: 0 | 1) {
  const dir = DATA_DIR;
  setMemoryMode("capture"); // the real current-version file: every application and memory table
  database().prepare("INSERT OR REPLACE INTO memory_lineage_lsn_meta(key,value) VALUES('root_sets_dropped',?)").run(reclaimMarker);
  // The server's own connection and its checkpointer thread both leave before the step back runs, as in the app (the server
  // process has exited before the recovery worker starts). closeDatabase() only asks the checkpointer to leave; its last
  // close copies the log back and removes it under the file's write lock, so the test waits for the thread's real exit.
  await settleTestHandles(dir);
  writeFileSync(join(dir, "bots.json"), JSON.stringify([{ id: "b1", threadId: "th", resumeCursors: { drv: "sess-1" }, tasks: [{ threadId: "th", resumeCursors: { drv: "sess-1" } }, { threadId: "th2", resumeCursors: {} }] }]));
  return dir;
}

it("after a completed reclaim the downgrade leaves no retained provider session that 1.0.1 would resume", async () => {
  const dir = await fixture(1);
  // the session row was deleted by the reclaim, and nothing else names the session: 1.0.1 would resume it
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(true);
  downgradeInstallationMemorySchema(dir, 6);
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(false);
  const bots = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8"));
  expect(bots[0].resumeCursors).toEqual({});
  expect(bots[0].tasks.every((task: { resumeCursors: object }) => Object.keys(task.resumeCursors).length === 0)).toBe(true);
});

it("a file the reclaim never touched keeps its retained sessions", async () => {
  const dir = await fixture(0);
  downgradeInstallationMemorySchema(dir, 6);
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(true);
});

/** A connection that holds the whole file until it closes, as the checkpointer's last close does while it copies the log back.
 * Resolves once it holds the lock; `left` resolves on the thread's real exit. */
function holdFileUntilClose(file: string, holdMs: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.file);
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN IMMEDIATE; COMMIT;");
    Atomics.store(workerData.signal, 0, 1); Atomics.notify(workerData.signal, 0);
    const end = Date.now() + workerData.holdMs; while (Date.now() < end);
    db.close();
  `, { eval: true, workerData: { file, signal, holdMs } });
  const left = new Promise<void>(resolve => worker.once("exit", () => resolve()));
  Atomics.wait(signal, 0, 0, 10_000);
  expect(Atomics.load(signal, 0)).toBe(1);
  return left;
}

it("the step back waits for a connection still leaving the file instead of failing at once", async () => {
  const dir = await fixture(1);
  const file = join(dir, "messages.db");
  const left = holdFileUntilClose(file, 400);
  const started = Date.now();
  downgradeInstallationMemorySchema(dir, 6); // the first statement meets the held file: it waits, then goes ahead
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  await left;
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(false);
});
