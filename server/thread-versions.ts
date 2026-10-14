// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What changed in this thread since the page you hold?", answered from
// memory. Every transcript write the store emits (StoreChange) bumps one
// process-wide counter; a client's version is that counter as of its page
// (`<epoch>.<seq>`), and the answer to `since=` is the ids written after it.
//
// The log is bounded: a thread keeps its newest LOG_PER_THREAD writes, and
// only the THREADS most recently written threads are tracked. Whenever the
// log cannot vouch for a version (another server run, a branch move, writes
// that fell off the log, more changes than a page), `since` says so with
// null and the caller answers with the whole page instead. A null is always
// safe; a list is only returned when it is complete.
import { randomUUID } from "node:crypto";

import type { StoreChange } from "./store.ts";

export const LOG_PER_THREAD = 128;
export const THREADS = 512;

interface ThreadLog {
  /** Writes at or before this seq are not in `ids`. */
  floor: number;
  /** The last branch move (an edit that forks, a rewind). */
  leafAt: number;
  /** message id -> the seq of its latest write, oldest first. */
  ids: Map<string, number>;
}

export class ThreadVersions {
  private seq = 0;
  /** Writes at or before this seq may belong to a thread no longer tracked. */
  private lostThrough = 0;
  private readonly threads = new Map<string, ThreadLog>();

  readonly epoch: string;
  private readonly perThread: number;
  private readonly maxThreads: number;

  constructor(epoch: string = randomUUID().slice(0, 8), perThread = LOG_PER_THREAD, maxThreads = THREADS) {
    this.epoch = epoch;
    this.perThread = perThread;
    this.maxThreads = maxThreads;
  }

  /** The version a page read now is current with. */
  token(): string {
    return `${this.epoch}.${this.seq}`;
  }

  note(change: StoreChange): void {
    switch (change.type) {
      case "message":
      case "message.patch": {
        const log = this.log(change.threadId);
        this.seq += 1;
        log.ids.delete(change.message.id);
        log.ids.set(change.message.id, this.seq);
        if (log.ids.size > this.perThread) {
          const [oldest, at] = log.ids.entries().next().value as [string, number];
          log.ids.delete(oldest);
          log.floor = Math.max(log.floor, at);
        }
        return;
      }
      case "thread": {
        const log = this.log(change.threadId);
        this.seq += 1;
        log.leafAt = this.seq;
        return;
      }
      case "thread.deleted":
        this.seq += 1;
        this.forget(change.threadId, this.seq);
        return;
      default:
        return;
    }
  }

  /** The ids written in `threadId` after `version`, oldest first, or null
   * when the log cannot say (the caller sends the whole page). More than
   * `max` changes is null too: the page is the cheaper answer. */
  since(threadId: string, version: string | null | undefined, max: number): string[] | null {
    const parsed = /^([\w-]+)\.(\d+)$/.exec(version ?? "");
    if (!parsed || parsed[1] !== this.epoch) return null;
    const at = Number(parsed[2]);
    if (!Number.isSafeInteger(at) || at > this.seq) return null;
    const log = this.threads.get(threadId);
    if (!log) return at >= this.lostThrough ? [] : null;
    if (at < log.floor || log.leafAt > at) return null;
    const changed: string[] = [];
    for (const [id, written] of log.ids) if (written > at) changed.push(id);
    return changed.length > max ? null : changed;
  }

  private log(threadId: string): ThreadLog {
    let log = this.threads.get(threadId);
    if (log) {
      // most recently written last, so the oldest is evicted first
      this.threads.delete(threadId);
    } else {
      log = { floor: this.lostThrough, leafAt: 0, ids: new Map() };
    }
    this.threads.set(threadId, log);
    if (this.threads.size > this.maxThreads) {
      const [oldest] = this.threads.keys();
      if (oldest !== undefined && oldest !== threadId) this.forget(oldest, this.seq);
    }
    return log;
  }

  private forget(threadId: string, through: number): void {
    if (!this.threads.delete(threadId)) return;
    this.lostThrough = Math.max(this.lostThrough, through);
  }
}
