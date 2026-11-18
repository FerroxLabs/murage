// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (bounded readiness and zero-pin proof).
// Consumer owner: recall-smoke (direct and room dispatch, before-submit fences).
import { database, databaseGeneration } from '../database.ts';
import { ownerPinIndexPresent } from './schema.ts';
import { RecallPreparationPending, MemoryPinProjectionPending, recallPreparationFailure } from './recall-recovery.ts';

export class RecallHeld extends RecallPreparationPending {}
export class RecallDispatchPending extends Error {
  constructor() { super('This reply is still being prepared, so this message was not sent. Send it again in a moment.'); }
}
/** Reads references only, through the partial index. Missing index means unknown. */
export function noPins(): boolean {
  const db = database();
  if (!ownerPinIndexPresent(db)) return false;
  try { return !db.prepare("SELECT 1 FROM memory_records INDEXED BY memory_records_pinned WHERE owner_pinned=1 AND state='active' LIMIT 1").get(); }
  catch { return false; }
}
export function hasMemories(): boolean { return !!database().prepare('SELECT 1 FROM memory_records LIMIT 1').get(); }
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** A rebuild after a roster revoke waits at most this long for its own view (equal to the pinned-owner probe ceiling, so no new limit). */
export const REBUILD_VIEW_WAIT_MS = 2000;
/** The rebuild's view was not published in time. This is not a refusal: the caller takes the last resort and the rebuild count does not move. */
export class RecallViewNotReady extends Error {
  readonly waitedMs: number;
  constructor(waitedMs: number) { super(`recall view not ready after ${waitedMs}ms`); this.waitedMs = waitedMs; }
}
export type RecallPublications = (listener: (event: { readonly databaseGeneration: number }) => void) => () => void;
export interface RecallAccessOptions {
  /** A dispatch after a revoke. It never takes the receipt-less held path: it waits for its view or ends in RecallViewNotReady. */
  readonly rebuild?: boolean;
  readonly publications?: RecallPublications;
}
/** One probe schedule. Every dispatch attempt that passes its own is fresh (a rebuild never shares one); a send's accesses with no explicit
 *  wait share the send's, renewed after a context change (MAIN RULING 1117T01:23Z (a)). The budget counts only time spent waiting. */
export class RecallWait {
  waited = 0;
  waitMs?: number;
  probes = 0;
}
function waitForWake(at: number, signal: AbortSignal, arm: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (next: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); next(); };
    const abort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), Math.max(0, at - performance.now()));
    signal.addEventListener('abort', abort, { once: true });
    arm(() => finish(resolve));
    if (signal.aborted) abort();
  });
}
/** One logical send owns the held proof, the single readmission and its shared RecallWait; a context change (renewAfterContextChange) starts a
 *  fresh schedule. The budget counts only time spent waiting inside access(); reset, slot and setup time between redispatches does not use it up. */
export class RecallReadiness {
  readonly hadMemories = hasMemories();
  private wait = new RecallWait();
  private proof?: { generation: number };
  private readmitted = false;
  private heldIssued = false;
  /** MAIN RULING 1117T01:23Z (a): a redispatch after a roster or authority change (the prepared context was revoked) reads a context
   *  that did not exist when the earlier probes ran, so it gets a fresh probe schedule with the same 300/2000 ms per wait. The held
   *  and readmission tickets stay spent: one held send and one readmission per logical send. The redispatch count stays bounded. */
  renewAfterContextChange(): void {
    this.wait = new RecallWait();
  }
  claimReadmission(): boolean {
    if (this.readmitted) return false;
    this.readmitted = true;
    return true;
  }
  async access<T>(read: () => T, signal: AbortSignal, wait: RecallWait = this.wait, options: RecallAccessOptions = {}): Promise<T> {
    signal.throwIfAborted();
    if (options.rebuild) return this.rebuildAccess(read, signal, options.publications ?? (() => () => {}));
    const empty = noPins();
    if (!empty) wait.waitMs = 2000;
    else wait.waitMs ??= 300;
    const schedule = wait.waitMs === 300 ? [0, 50, 300] : [0, 50, 300, 2000];
    while (wait.probes < schedule.length) {
      const offset = schedule[wait.probes++];
      if (offset > wait.waited) { await waitFor(offset - wait.waited, signal); wait.waited = offset; }
      signal.throwIfAborted();
      try { return read(); }
      catch (error) { if (!(recallPreparationFailure(error) instanceof RecallPreparationPending)) throw error; }
    }
    signal.throwIfAborted();
    if (noPins()) {
      if (this.heldIssued) throw new RecallDispatchPending();
      this.heldIssued = true;
      this.proof = { generation: databaseGeneration() };
      throw new RecallHeld();
    }
    throw new MemoryPinProjectionPending();
  }
  /** A publication only wakes the wait. Authority is a fresh read for this database generation. */
  private async rebuildAccess<T>(read: () => T, signal: AbortSignal, publications: RecallPublications): Promise<T> {
    const generation = databaseGeneration(), startedAt = performance.now(), deadline = startedAt + REBUILD_VIEW_WAIT_MS;
    let wake: (() => void) | undefined;
    const unsubscribe = publications(event => { if (event.databaseGeneration === generation) wake?.(); });
    try {
      for (;;) {
        signal.throwIfAborted();
        try { return read(); }
        catch (error) { if (!(recallPreparationFailure(error) instanceof RecallPreparationPending)) throw error; }
        if (performance.now() >= deadline) throw new RecallViewNotReady(Math.round(performance.now() - startedAt));
        await waitForWake(deadline, signal, arm => { wake = arm; });
      }
    } finally { wake = undefined; unsubscribe(); }
  }
  assertHeld(): void {
    if (!this.proof || this.proof.generation !== databaseGeneration() || !noPins()) throw new MemoryPinProjectionPending();
  }
}
/** 'withheld': the message-only recovery (last resort, selective drop). It reaches dispatch without a recall admission and carries no memory reader. */
export type RecallMode = 'full' | 'pins' | 'held' | 'off' | 'withheld';
/** Server facts captured before any recovery branch can clear the prepared request. */
export interface RecallPrepared {
  readonly system: string;
  readonly integrations: readonly string[];
  readonly historyPrepared: boolean;
  readonly resumed: boolean;
  /** Room history travels in these immutable prompt parts, never in a synthetic transcript. */
  readonly historyParts?: readonly { readonly text: string }[];
  /** The last rebuild (or a selective drop) sends only the message: no system layers and no memory tools, under the 'withheld' label. */
  readonly memoryFree?: true;
}
export function assertRecallDispatch(input: { recall?: RecallMode; recallPrepared?: RecallPrepared; system?: string; integrations?: object; transcript?: readonly unknown[]; prompt?: { readonly parts: readonly { readonly text: string }[] } }): void {
  const prepared = input.recallPrepared;
  const names = Object.keys(input.integrations ?? {}).sort();
  if (input.recall === 'withheld' || prepared?.memoryFree) {
    // A memory-free rebuild is accepted only as exactly that: the withheld label on a request prepared memory-free, an empty
    // system, no memory tools mounted, and every other prepared tool still there (only the memory reader was withheld).
    const kept = [...(prepared?.integrations ?? [])].filter(name => name !== 'memory').sort();
    if (input.recall !== 'withheld' || !prepared?.memoryFree || input.system !== '' || names.includes('memory') || JSON.stringify(names) !== JSON.stringify(kept)) throw new RecallDispatchPending();
    return;
  }
  if (!prepared || !['full', 'pins', 'held', 'off'].includes(input.recall ?? '') || !prepared.system.trim()
    || input.system !== prepared.system || JSON.stringify(names) !== JSON.stringify([...prepared.integrations].sort())
    || prepared.historyPrepared && !prepared.resumed && (prepared.historyParts
      ? !prepared.historyParts.length || !prepared.historyParts.every(part => input.prompt?.parts.includes(part))
      : !input.transcript?.length)) throw new RecallDispatchPending();
}
