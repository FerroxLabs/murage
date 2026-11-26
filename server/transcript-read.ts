// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from "node:worker_threads";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import type { ForgottenText } from "./harness/event-log.ts";
import { registerWalReader } from "./wal-maintenance.ts";

export type TranscriptReadRequest = { kind: "forgotten"; after: number };
type ForgottenPage = { items: ForgottenText[]; last: number | null };
type Pending = { resolve: (value: ForgottenPage) => void; reject: (error: Error) => void };
export const TRANSCRIPT_READ_PENDING = 8;

/** One read-only worker over messages.db for the event-log prune's forgotten-message lookup: message bodies (megabytes, for a long
 * turn) are read and parsed off the main thread, and only turn ids and short needles cross back. Admission is bounded. A worker that
 * cannot start or exits rejects its reads; the caller decides on its own bounded fallback (index.ts startEventLogPrune). Idle, the
 * worker is unreferenced so it never holds the process open; close() terminates it and resolves once it has gone, before the
 * data-directory lease is released. Search is not read here: the search route and message-db.ts own it. */
export class TranscriptReader {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  /** B5: half-gate releases waiting for the reads in flight to end. */
  private drained: Array<() => void> = [];
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private file: string;
  private options: { createWorker?: () => Worker; gate?: SharedArrayBuffer };
  constructor(file: string, options: { createWorker?: () => Worker; gate?: SharedArrayBuffer } = {}) {
    this.file = file; this.options = options;
  }

  /** True once close() was called: a rejection after this is the shutdown, not a worker failure. */
  get isStopped(): boolean { return this.stopped; }

  /** One page of forgotten messages; `after` 0 starts the sequence, otherwise the last page's continuation token. */
  forgotten(after: number): Promise<ForgottenPage> { return this.read({ kind: "forgotten", after }); }

  private read(request: TranscriptReadRequest): Promise<ForgottenPage> {
    if (this.stopped) return Promise.reject(new Error("Transcript reader stopped"));
    if (this.pending.size >= TRANSCRIPT_READ_PENDING) return Promise.reject(new Error("Transcript reader busy"));
    return new Promise((resolve, reject) => {
      try {
        if (!this.worker) {
          const worker = this.options.createWorker ? this.options.createWorker() : new Worker(SPAWNED_PROXIES.transcriptReadWorker, { workerData: { file: this.file, gate: this.options.gate } });
          this.worker = worker;
          worker.on("message", (message: { id: number; result: ForgottenPage; error?: string }) => {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
            if (!this.pending.size) { worker.unref(); for (const done of this.drained.splice(0)) done(); }
          });
          worker.on("error", error => this.fail(error instanceof Error ? error : new Error(String(error))));
          // 1.0.21 B5 (memv2-D): a read holds a snapshot only while a message runs. At the WAL half gate the release waits for the reads in
          // flight to end (an idle worker holds none) and never ends the worker, so the prune keeps reading off the main thread; only a
          // worker still busy at the 5 s bound is ended (restart), and its reads reject as an exit (the caller's bounded fallback).
          const unregister = registerWalReader({ name: "transcript-read", memory: true,
            release: done => { if (this.worker !== worker || !this.pending.size) done(); else this.drained.push(done); },
            restart: () => { if (this.worker === worker && this.pending.size) void worker.terminate().catch(() => {}); } });
          worker.on("exit", () => {
            unregister();
            if (this.worker === worker) { this.worker = undefined; this.fail(new Error("Transcript reader exited")); }
          });
        }
        const id = ++this.sequence;
        this.pending.set(id, { resolve, reject });
        this.worker.ref();
        this.worker.postMessage({ id, request });
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); reject(error); }
    });
  }

  private fail(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const done of this.drained.splice(0)) done();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.fail(new Error("Transcript reader stopped"));
    this.closing = this.worker ? this.worker.terminate().then(() => {}) : Promise.resolve();
    return this.closing;
  }
}
