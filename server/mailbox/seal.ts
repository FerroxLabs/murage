// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W's seal call before a mailbox tool returns mail (email design r9 3.6 steps 1-3). Store.beginMailboxSeal commits the pending marker
// (generic readers project from that commit); C0's migrateMailboxMessageBatch copies and projects at most 500 rows per commit with
// its cursor. Then (step 2) the managed media the sealed rows name moves into sealed file custody, one page of rows per step
// (media-custody.ts). The marker turns complete only in the commit after the last media step, so a crash anywhere leaves the thread
// pending (and its tools paused) and the next call resumes at the saved cursors. One call runs a bounded number of steps (I-16).
import type { DatabaseSync } from "node:sqlite";
import { mailboxSealState } from "./custody.ts";

export const SEAL_BATCHES_PER_CALL = 4;

export interface SealDeps {
  begin(threadId: string): "pending" | "complete";
  batch(threadId: string): { copied: number; done: boolean };
  /** One bounded media step (moveMailboxMediaBatch), asked only after every message batch is done. */
  media(threadId: string): { done: boolean };
  transaction<T>(fn: (db: DatabaseSync) => T): T;
}

/** `progress.mediaBehind` is set when a seal that was already complete still has sealed rows its media walk has not reached (a seal
 *  completed before media custody existed, or files named by rows sealed after completion): the caller hands it to the resumer. */
export function sealMailboxThread(deps: SealDeps, threadId: string, batches = SEAL_BATCHES_PER_CALL, progress: { mediaBehind?: boolean } = {}): "pending" | "complete" {
  if (deps.begin(threadId) === "complete") {
    // mail already flows for this conversation; its media walk still catches up, bounded like any call (a failure throws to the caller)
    let done = false;
    for (let run = 0; run < batches && !done; run++) done = deps.media(threadId).done;
    progress.mediaBehind = !done;
    return "complete";
  }
  let rowsDone = false;
  for (let run = 0; run < batches; run++) {
    if (!rowsDone) { rowsDone = deps.batch(threadId).done; continue; }
    // media custody before complete: mail is never released while a file the conversation names is still on the generic plane
    if (!deps.media(threadId).done) continue;
    // The answer is the ledger as committed, never the update's row count: only a stored 'complete' releases mail.
    return deps.transaction(db => {
      db.prepare("UPDATE mailbox_sealed_threads SET state='complete' WHERE thread_id=? AND state='pending'").run(threadId);
      return mailboxSealState(db, threadId) === "complete" ? "complete" as const : "pending" as const;
    });
  }
  return "pending";
}

export interface SealResumeDeps extends SealDeps {
  /** Pending ledger rows and complete ones whose media walk is behind, oldest generation first (one bounded read). */
  pending(): string[];
  log?(line: string): void;
}

const PENDING_PAGE = 1000;

/** 3.6 step 3: a pending seal finishes without waiting for another tool call. Boot queues every pending ledger row (a crash between
 *  batches) and a call that stopped at its batch bound queues its thread. Each tick runs one bounded sealMailboxThread call (I-16)
 *  and yields; the thread stays pending, so paused, until the ledger commits complete. Nothing here throws to its caller or out of a
 *  timer: a failed load or tick (a busy database, a read-only start) keeps every thread pending and retries with backoff. */
export class MailboxSealResumer {
  private readonly deps: SealResumeDeps;
  private readonly queue = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private load = false;
  private failures = 0;
  constructor(deps: SealResumeDeps) { this.deps = deps; }

  resumeAll(): void {
    this.load = true;
    this.schedule(0);
  }

  resume(threadId: string): void {
    this.queue.add(threadId);
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.timer || (this.queue.size === 0 && !this.load)) return;
    this.timer = setTimeout(() => this.tick(), delayMs);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    let ok = true;
    try {
      if (this.load && this.queue.size === 0) {
        const pending = this.deps.pending();
        for (const threadId of pending) this.queue.add(threadId);
        // the read is bounded; a full page means more rows wait behind it, read again once these are done
        this.load = pending.length >= PENDING_PAGE;
      } else {
        const [threadId] = this.queue;
        if (threadId !== undefined) {
          this.queue.delete(threadId);
          try {
            const progress: { mediaBehind?: boolean } = {};
            if (sealMailboxThread(this.deps, threadId, SEAL_BATCHES_PER_CALL, progress) !== "complete" || progress.mediaBehind) this.queue.add(threadId);
          } catch (error) {
            // a deleted conversation has nothing left to seal; any other failure (or an unreadable ledger) keeps it pending, and a
            // complete seal whose media step failed retries too
            let state: string | undefined = "pending";
            try { state = this.deps.transaction(db => mailboxSealState(db, threadId)); } catch { /* unreadable: still pending */ }
            if (state === "pending" || state === "complete") { this.queue.add(threadId); ok = false; }
            this.deps.log?.(`[mailbox] seal resume: ${(error as Error)?.name ?? "error"}`);
          }
        }
      }
    } catch (error) {
      ok = false;
      this.deps.log?.(`[mailbox] seal resume load: ${(error as Error)?.name ?? "error"}`);
    }
    this.failures = ok ? 0 : this.failures + 1;
    this.schedule(ok ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(this.failures - 1, 6)));
  }
}

export function pendingMailboxSeals(db: DatabaseSync): string[] {
  // a complete seal is behind when a held row lies past its media cursor (no cursor row: a seal completed before media custody)
  const behind = "(s.state='complete' AND EXISTS (SELECT 1 FROM mailbox_sealed_rows r WHERE r.thread_id=s.thread_id AND r.rowid > COALESCE((SELECT c.cursor FROM mailbox_sealed_media_cursor c WHERE c.thread_id=s.thread_id), 0)))";
  return db.prepare(`SELECT s.thread_id FROM mailbox_sealed_threads s WHERE s.state='pending' OR ${behind} ORDER BY s.generation LIMIT ${PENDING_PAGE}`).all().map(row => String(row.thread_id));
}
