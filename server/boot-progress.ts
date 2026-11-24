// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 startup-all: the start-up note for EVERY step before listen, not only the memory upgrade's (memory/upgrade-status.ts).
// The desktop shell stops a child that has not answered /api/health within 5 minutes (electron/main.mjs SERVER_BOOT_SLOW_LIMIT_MS). Every
// pre-listen step outside the memory-upgrade note (table setup, memory open on an equal version, the 1.0.19 pending-table drop, a large
// write-ahead log replayed at open, the boot steps of index.ts) was stopped there, and the next start began the same work again.
// This note says, from the first module the server loads until it listens, that this process is alive and which step it is in. A
// worker thread of THIS process rewrites it every two seconds, so it stops moving exactly when the server dies; the shell keeps waiting
// while the note is its own child's, moving, and its step (name or seq) advanced within 5 minutes, up to its absolute limit
// (electron/boot-progress-watch.mjs, server-boot-probe.mjs). The heartbeat proves alive, not progress: a step held 5 minutes is a stall.
// It names a fixed step name and numbers only: no path, no data, no secret. It is removed at listen. A note left behind (the process died
// before listen) is read by the next start, which logs the step the earlier start ended in.
import { Worker } from "node:worker_threads";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { windowsHidePrelude } from "../shared/win-hide-child-process.mjs";

export const BOOT_PROGRESS_FILE = "boot-progress.json";
export const BOOT_PROGRESS_INTERVAL_MS = 2_000;
const LABEL_BYTES = 48;
// shared block: Int32 [writing, stopped, labelLength, seq], then the label bytes
const WORKER_SOURCE = `
const { workerData, threadId } = require("node:worker_threads");
const fs = require("node:fs");
const ctl = new Int32Array(workerData.shared, 0, 4), label = new Uint8Array(workerData.shared, 16, ${LABEL_BYTES});
const temp = workerData.file + "." + (process.pid * 1000 + threadId) + ".tmp";
const beat = () => {
  if (Atomics.load(ctl, 1)) return;
  Atomics.store(ctl, 0, 1);
  try {
    if (Atomics.load(ctl, 1)) return;
    const step = Buffer.from(label.slice(0, Atomics.load(ctl, 2))).toString("utf8");
    fs.writeFileSync(temp, JSON.stringify({ v: 1, state: "starting", pid: workerData.pid, startedAt: workerData.startedAt, updatedAt: Date.now(), step, seq: Atomics.load(ctl, 3) }), { mode: 0o600 });
    fs.renameSync(temp, workerData.file);
  } catch { try { fs.rmSync(temp, { force: true }); } catch {} }
  finally { Atomics.store(ctl, 0, 0); Atomics.notify(ctl, 0); }
};
beat();
setInterval(beat, workerData.intervalMs);
`;

type Running = { file: string; ctl: Int32Array; label: Uint8Array; worker: Worker | null };
let running: Running | null = null;
let ended = false;

/** The step an earlier start of this data folder ended in (its note is still there and is not this process's), or null. */
export function interruptedBootStep(dataDir: string, pid = process.pid): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, BOOT_PROGRESS_FILE), "utf8")) as { v?: number; state?: string; pid?: number; step?: unknown };
    if (raw?.v !== 1 || raw.state !== "starting" || raw.pid === pid) return null;
    return typeof raw.step === "string" && /^[A-Za-z0-9._:-]{1,48}$/.test(raw.step) ? raw.step : "unknown";
  } catch { return null; }
}

/** Starts the note for this start (once per process; never again after listen). Never throws: a note that cannot be written leaves the start as it was. */
export function startBootProgress(dataDir: string, options: { intervalMs?: number; step?: string } = {}): void {
  if (running || ended) return;
  const file = join(dataDir, BOOT_PROGRESS_FILE);
  const earlier = interruptedBootStep(dataDir);
  if (earlier) console.warn(`[startup] the previous start ended before listen, in step ${earlier}; this start carries on`);
  const shared = new SharedArrayBuffer(16 + LABEL_BYTES);
  running = { file, ctl: new Int32Array(shared, 0, 4), label: new Uint8Array(shared, 16, LABEL_BYTES), worker: null };
  setBootStep(options.step ?? "boot");
  try {
    const worker = new Worker(windowsHidePrelude + WORKER_SOURCE, { eval: true, workerData: { shared, file, pid: process.pid, startedAt: Date.now(), intervalMs: options.intervalMs ?? BOOT_PROGRESS_INTERVAL_MS } });
    worker.on("error", () => { /* a note never stops a start */ });
    worker.unref();
    running.worker = worker;
  } catch { running.worker = null; }
}

/** Names the step the server is in now; the next beat carries it, and its sequence number moves. No-op without a running note. */
export function setBootStep(step: string): void {
  const run = running;
  if (!run) return;
  const bytes = Buffer.from(step.replace(/[^A-Za-z0-9._:-]/g, "_"), "utf8").subarray(0, LABEL_BYTES);
  run.label.fill(0); run.label.set(bytes); Atomics.store(run.ctl, 2, bytes.length); Atomics.add(run.ctl, 3, 1);
}

/** Ends the note at listen: waits out a write in progress (none lands after this returns), then removes it. */
export function endBootProgress(): void {
  ended = true;
  const run = running;
  running = null;
  if (!run) return;
  Atomics.store(run.ctl, 1, 1);
  while (Atomics.load(run.ctl, 0) === 1) Atomics.wait(run.ctl, 0, 1, 50);
  try { void run.worker?.terminate(); } catch { /* already gone */ }
  try { rmSync(run.file, { force: true }); } catch { /* absent */ }
}

/** True when a desktop shell started this process (the same test as startup-trace.ts parentNotify): only then is anyone waiting on the note. */
export function bootProgressWanted(): boolean {
  const proc = process as NodeJS.Process & { parentPort?: unknown };
  return Boolean(proc.parentPort) || (process.env.MURAGE_DESKTOP_PARENT === "1" && typeof process.send === "function") || process.env.MURAGE_BOOT_PROGRESS === "1";
}
