// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The exact counts the upgrade screen shows (conversations, messages, memory records, receipts, the date of the first message). They are counted
// by a worker thread on its own read-only connection, started at the beginning of the wait, so the server thread (which may be inside one long
// statement of the migration) never counts anything. The worker writes the figures into a shared block; whoever builds a progress answer (the
// server thread, the heartbeat thread, the pre-listen health responder) reads the block and puts the figures in only once they are exact.
// Until then `counts` carries nulls and `exact: false`, and the screen shows no number. The figures are cached in a small file beside the data
// (never in messages.db: writing it there would be a write that invalidates it), keyed on the write revision of messages.db (app-write-revision.ts: an epoch and a counter
// that every counted write moves), so a launch with no counted write since shows them at once; any write since means a recount.
import { Worker } from "node:worker_threads";

export interface ExactCounts { messages: number; conversations: number; memoryRecords: number; receipts: number; firstMessageAt: number | null }
export const UPGRADE_COUNTS_FILE = "memory-upgrade-counts.json";
const SLOTS = 6; // ready flag + five figures
const BLOCK_BYTES = 16 + SLOTS * 8;

export function createCountsBlock(): SharedArrayBuffer { return new SharedArrayBuffer(BLOCK_BYTES); }
/** The figures once the worker has published them (exact), or null. */
export function readCountsBlock(shared: SharedArrayBuffer | undefined): ExactCounts | null {
  if (!shared) return null;
  const ctl = new Int32Array(shared, 0, 2), values = new Float64Array(shared, 16, SLOTS);
  if (Atomics.load(ctl, 0) !== 1) return null;
  return { messages: values[1]!, conversations: values[2]!, memoryRecords: values[3]!, receipts: values[4]!, firstMessageAt: values[5]! < 0 ? null : values[5]! };
}
/** The same reader as plain source, and the merge of figures into a progress answer, for the worker threads that speak for a blocked server. */
export const COUNTS_OVERLAY_SOURCE = `
const readCounts = (shared) => {
  if (!shared) return null;
  const ctl = new Int32Array(shared, 0, 2), values = new Float64Array(shared, 16, ${SLOTS});
  if (Atomics.load(ctl, 0) !== 1) return null;
  return { messages: values[1], conversations: values[2], memoryRecords: values[3], receipts: values[4], firstMessageAt: values[5] < 0 ? null : values[5] };
};
const overlayCounts = (progress, counts) => {
  if (!progress || !counts) return progress;
  return { ...progress, counts: { ...(progress.counts || {}), ...counts, exact: true } };
};`;
/** The merge, for the server thread. */
export function overlayCounts<T extends { counts: object }>(progress: T, counts: ExactCounts | null): T {
  if (!counts) return progress;
  return { ...progress, counts: { ...progress.counts, ...counts, exact: true } };
}

/** The counting itself, as plain source so the worker thread and the tests run the very same text. ONE read transaction: the revision and every
 * count come from the same snapshot of the file, so the figures describe one state of it and `key` names that state. Every query must succeed: a count
 * that failed is not zero, and nothing is returned from a partial set of figures (the caller publishes nothing). `between(sql)` is a test hook called
 * before each query. `cached` ({key, counts}) is used when its key equals the snapshot's. */
export const COUNT_AT_REVISION_SOURCE = `
function countAtRevision(db, between, cached) {
  db.exec("BEGIN");
  try {
    const revision = db.prepare("SELECT epoch, n FROM app_write_revision WHERE id=1").get();
    if (!revision) throw new Error("no revision");
    const key = String(revision.epoch) + ":" + String(revision.n);
    if (cached && cached.key === key && cached.counts) { db.exec("COMMIT"); return { key, counts: cached.counts, fresh: false }; }
    const run = (sql) => { if (between) between(sql); return db.prepare(sql).get(); };
    const one = (sql) => { const row = run(sql); const v = row ? Number(Object.values(row)[0]) : NaN; if (!Number.isFinite(v)) throw new Error("count"); return v; };
    const conversations = one("SELECT count(*) FROM thread_state");
    const messages = one("SELECT count(*) FROM messages");
    const memoryRecords = one("SELECT count(*) FROM memory_records");
    const receipts = one("SELECT count(*) FROM memory_disclosures");
    const first = run("SELECT min(at) AS at FROM messages");
    const counts = { conversations, messages, memoryRecords, receipts, firstMessageAt: first && first.at !== null && first.at !== undefined ? Number(first.at) : null };
    db.exec("COMMIT");
    return { key, counts, fresh: true };
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}`;

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
${COUNT_AT_REVISION_SOURCE}
const ctl = new Int32Array(workerData.shared, 0, 2), values = new Float64Array(workerData.shared, 16, ${SLOTS});
const publish = (c) => {
  values[1] = c.messages; values[2] = c.conversations; values[3] = c.memoryRecords; values[4] = c.receipts; values[5] = c.firstMessageAt === null ? -1 : c.firstMessageAt;
  Atomics.store(ctl, 0, 1);
};
let db;
try {
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  let cached = null;
  try { const text = JSON.parse(fs.readFileSync(workerData.cacheFile, "utf8")); if (text && text.v === 2) cached = text; } catch {}
  const result = countAtRevision(db, null, cached);
  publish(result.counts);
  if (result.fresh) {
    const temp = workerData.cacheFile + "." + process.pid + ".tmp";
    try { fs.writeFileSync(temp, JSON.stringify({ v: 2, key: result.key, counts: result.counts }), { mode: 0o600 }); fs.renameSync(temp, workerData.cacheFile); } catch { try { fs.rmSync(temp, { force: true }); } catch {} }
  }
} catch {
  // nothing is published: the screen shows no number rather than a wrong one
}
try { db && db.close(); } catch {}
`;

/** Starts the counting thread. Never throws; without it the screen simply shows no numbers. `cacheFile` is where the figures are kept between launches. */
export function startExactCounts(file: string, cacheFile: string, shared: SharedArrayBuffer): { stop(): void } {
  let worker: Worker | null = null;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file, cacheFile, shared } });
    worker.on("error", () => { /* counting failed: no numbers are shown */ });
    worker.unref();
  } catch { worker = null; }
  return { stop() { try { void worker?.terminate(); } catch { /* already gone */ } worker = null; } };
}
