// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The v9 cold-lineage indexes, built in the background after an upgrade (1.0.2).
//
// memory_disclosure_outputs_cover and memory_sources_kind_outcome each read a whole table once (tens of seconds on a large history), so the
// upgrade does not build them: the schema transaction leaves them out, the validator accepts a v9 file that has not got them yet, and the
// queries that use them fall back to what they did before (settlement.ts reads a turn's source through its key range; the listings use the
// (thread, message) index). Once the server is listening and the owner is not in a turn, this builds them one at a time on a connection of
// its own in a worker thread, so the event loop stays free while a statement reads a table. The writers of the main connection are held
// off with the writer gate (holdWritersForIndexBuild) only while a statement runs: they wait asynchronously instead of meeting the lock
// as a busy error. A stop in the middle loses nothing (an index is built whole or not at all) and the next start builds what is missing.
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { holdWritersForIndexBuild } from "../database.ts";
import { COLD_LINEAGE_INDEX_STATEMENTS, coldLineageIndexesMissing } from "./schema.ts";

/** Builds every missing v9 index on this connection, now. For tests and for a caller that has the time (nothing else runs meanwhile). */
export function buildColdLineageIndexesNow(db: DatabaseSync): string[] {
  const built: string[] = [];
  for (const statement of COLD_LINEAGE_INDEX_STATEMENTS) {
    if (!coldLineageIndexesMissing(db).includes(statement.name)) continue;
    db.exec(statement.sql);
    built.push(statement.name);
  }
  return built;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout=120000");
  parentPort.on("message", message => {
    if (message.type === "stop") { try { db.close(); } catch {} process.exit(0); }
    try { db.exec(message.sql); parentPort.postMessage({ type: "built", name: message.name }); }
    catch (error) { parentPort.postMessage({ type: "failed", name: message.name, message: String(error && error.message || error) }); }
  });
  parentPort.postMessage({ type: "ready" });
} catch (error) { parentPort.postMessage({ type: "failed", message: String(error && error.message || error) }); }
`;

export interface ColdIndexBuildOptions {
  /** The database file (default: the connection's own). */
  file?: string;
  /** True while the owner is in a turn: the next statement waits. */
  busy?: () => boolean;
  /** Wait before the first statement and between them, so writers get a window; the poll interval while busy. */
  gapMs?: number;
  busyPollMs?: number;
  onBuilt?: (name: string) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
  /** Test seam: builds one statement (in place of the worker). */
  run?: (statement: { name: string; sql: string }) => Promise<void>;
}
export interface ColdIndexBuild { stop(): void; done: Promise<void> }

/** Starts the background build of whatever v9 indexes are missing. Never throws; a failure is reported to `onError` and leaves the file as it was. */
export function startColdLineageIndexBuild(db: DatabaseSync, options: ColdIndexBuildOptions = {}): ColdIndexBuild {
  const gapMs = options.gapMs ?? 1000, pollMs = options.busyPollMs ?? 30_000;
  let stopped = false, worker: Worker | null = null, timer: ReturnType<typeof setTimeout> | null = null, held = false;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const release = () => { if (held) { held = false; holdWritersForIndexBuild(false); } };
  const end = () => {
    release();
    if (timer) clearTimeout(timer);
    timer = null;
    if (worker) { try { worker.postMessage({ type: "stop" }); void worker.terminate(); } catch { /* gone */ } worker = null; }
    finish();
  };
  const fail = (error: unknown) => { try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* reporting never stops the build */ } end(); };
  const file = (() => {
    if (options.file) return options.file;
    try { return String(db.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get()?.file ?? ""); } catch { return ""; }
  })();
  let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const settleWith = (error: Error | null) => { const waiting = pending; pending = null; if (waiting) { if (error) waiting.reject(error); else waiting.resolve(); } };
  const startWorker = (): Worker => {
    const started = new Worker(WORKER_SOURCE, { eval: true, workerData: { file } });
    started.on("error", error => settleWith(error instanceof Error ? error : new Error(String(error))));
    started.on("exit", () => { if (worker === started) worker = null; settleWith(new Error("index build worker ended")); });
    started.on("message", (message: { type: string; message?: string }) => {
      if (message.type === "built") settleWith(null);
      else if (message.type === "failed") settleWith(new Error(message.message ?? "index build failed"));
    });
    started.unref();
    return started;
  };
  const runInWorker = (statement: { name: string; sql: string }): Promise<void> => new Promise<void>((resolve, reject) => {
    if (!file) { reject(new Error("no database file")); return; }
    pending = { resolve, reject };
    // the worker takes its first statement once it is ready; its "ready" message is the one that is not an answer
    if (!worker) {
      worker = startWorker();
      const first = worker;
      first.once("message", () => first.postMessage({ type: "build", ...statement }));
    } else worker.postMessage({ type: "build", ...statement });
  });
  const run = options.run ?? runInWorker;
  const next = () => {
    timer = null;
    if (stopped) return;
    let missing: string[];
    try { missing = coldLineageIndexesMissing(db); } catch (error) { fail(error); return; }
    const statement = COLD_LINEAGE_INDEX_STATEMENTS.find(candidate => missing.includes(candidate.name));
    if (!statement) { try { options.onDone?.(); } catch { /* as above */ } end(); return; }
    if (options.busy?.()) { timer = setTimeout(next, pollMs); timer.unref?.(); return; }
    held = true; holdWritersForIndexBuild(true);
    run(statement).then(() => {
      release();
      try { options.onBuilt?.(statement.name); } catch { /* as above */ }
      if (stopped) { end(); return; }
      timer = setTimeout(next, gapMs); timer.unref?.();
    }, fail);
  };
  timer = setTimeout(next, gapMs);
  timer.unref?.();
  return { stop() { stopped = true; end(); }, done };
}
