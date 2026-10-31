// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the backup worker tells the desktop while it runs (1.0.12): one-way,
// for the log line and the progress window only. Nothing here may change a
// backup: a note that cannot be sent, read or shown is dropped, and a desktop
// or worker of another version simply ignores it.

export const BACKUP_PROGRESS_MESSAGE = "murage:recovery-progress";

/** The worker's steps, in the order a run takes them. "source-recheck" shows up twice. */
export const BACKUP_WORKER_STEPS = Object.freeze([
  "records", "database-read", "source-recheck", "database-check", "database-copy", "database-clean", "database-verify", "database-digest", "ledger",
  "inventory", "encrypt", "readback", "readback-entries", "readback-hash", "flush", "publish", "done",
]);

const known = new Set(BACKUP_WORKER_STEPS);
const isCount = value => Number.isSafeInteger(value) && value >= 0;

/** A worker's note as the desktop may use it, or null. */
export function normalizeBackupProgress(raw) {
  if (!raw || typeof raw !== "object" || !known.has(raw.step) || !isCount(raw.elapsedMs)) return null;
  const note = { step: raw.step, elapsedMs: raw.elapsedMs };
  if (isCount(raw.done) && isCount(raw.total)) { note.done = Math.min(raw.done, raw.total); note.total = raw.total; }
  return note;
}

/** A report function that can never throw into the backup. */
export function safeBackupProgress(report) {
  if (typeof report !== "function") return () => {};
  return (...values) => { try { report(...values); } catch { /* A progress note never changes the backup. */ } };
}

/** The worker's side. Every new step goes out at once, because the time beside
 * it is what the log line is built from; repeats of a step at most every
 * `minIntervalMs`. Time comes from the worker, so a note held up on its way
 * to the desktop still measures the step correctly. */
export function createBackupProgressReporter(post, { now = () => performance.now(), minIntervalMs = 500 } = {}) {
  const started = now();
  let step = null, sentAt = 0;
  return safeBackupProgress((next, done, total) => {
    const at = now();
    if (next === step && at - sentAt < minIntervalMs) return;
    step = next; sentAt = at;
    post({ step: next, elapsedMs: Math.max(0, Math.round(at - started)), ...(isCount(done) && isCount(total) ? { done, total } : {}) });
  });
}

/** The desktop's side: one `backup step {...}` line as each step ends. */
export function createBackupStepLog({ job, log }) {
  let current = null;
  return raw => {
    const note = normalizeBackupProgress(raw);
    if (!note) return;
    if (current && current.step !== note.step) {
      log(`backup step ${JSON.stringify({ job, step: current.step, ms: Math.max(0, note.elapsedMs - current.startedAt), ...(current.bytes === undefined ? {} : { bytes: current.bytes }) })}`);
      current = null;
    }
    current ??= { step: note.step, startedAt: note.elapsedMs };
    if (note.done !== undefined) current.bytes = note.done;
  };
}
