// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (bounded readiness and zero-pin proof).
// Consumer owner: recall-smoke (direct and room dispatch, before-submit fences).
import { database, databaseGeneration } from '../database.ts';
import { ownerPinIndexPresent } from './schema.ts';
import { RecallCapacityPending, RecallPacePending, RecallPreparationPending, MemoryPinProjectionPending, recallPreparationFailure } from './recall-recovery.ts';

export class RecallHeld extends RecallPreparationPending {}
export class RecallDispatchPending extends Error {
  constructor() { super('This reply is still being prepared, so this message was not sent. Send it again in a moment.'); }
}
/** R01 owner: recall-reclaim-r2. Every recall view is in use, so the send is refused on its card and never runs without recall. */
export class RecallCapacityRefused extends RecallDispatchPending {}
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
/** q1022-jam: how often a redispatch's wait asks its read again (a build that stops on the build pace publishes nothing). */
export const REBUILD_PROBE_MS = 100;
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
  /** OWNERFB 1020: the turn's memory audience is the owner. When the view cannot be had in the bounded wait (quota full, not built,
   *  every view in use, pins still projecting) the owner's turn runs held: no recall at all, with the notice. Never sealed or refused. */
  readonly owner?: boolean;
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
  private proof?: { generation: number; owner: boolean; omittedPins?: boolean };
  private readmitted = false;
  private heldIssued = false;
  private capacity = false;
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
      catch (error) {
        const failure = recallPreparationFailure(error);
        if (!(failure instanceof RecallPreparationPending)) throw error;
        this.capacity = failure instanceof RecallCapacityPending;
        // q1023-upcatch (MAIN-RULING local-memory-budget): the view waits only on the build pace, so waiting the probes out would delay the
        // turn for memory's own pace; a turn that would end held anyway ends held now (with pins the 2 s wait is unchanged).
        if (failure instanceof RecallPacePending && (options.owner || noPins())) break;
      }
    }
    signal.throwIfAborted();
    if (options.owner) {
      // OWNERFB 1020: held carries nothing recalled (no bundle, no memory mount), so there is nothing to fence; the notice says so.
      this.heldIssued = true;
      this.proof = { generation: databaseGeneration(), owner: true, omittedPins: !noPins() };
      throw new RecallHeld();
    }
    if (noPins()) {
      // A full view store is not a fresh home: held mode would drop recall without saying so.
      if (this.capacity) throw new RecallCapacityRefused();
      if (this.heldIssued) throw new RecallDispatchPending();
      this.heldIssued = true;
      this.proof = { generation: databaseGeneration(), owner: false };
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
        catch (error) {
          const failure = recallPreparationFailure(error);
          if (!(failure instanceof RecallPreparationPending)) throw error;
          // q1023-upcatch (MAIN-RULING local-memory-budget): a rebuild that waits only on the build pace ends now, as it would at the deadline
          if (failure instanceof RecallPacePending) throw new RecallViewNotReady(Math.round(performance.now() - startedAt));
        }
        if (performance.now() >= deadline) throw new RecallViewNotReady(Math.round(performance.now() - startedAt));
        // q1022-jam (MAIN-RULING local-memory-budget): the read above may be the one that queued the build, before any step of it met
        // the build pace; no publication follows a build that stops on the pace, so the read is asked again every REBUILD_PROBE_MS
        // and the wait ends as soon as the queue reports the pace, not at the deadline.
        await waitForWake(Math.min(deadline, performance.now() + REBUILD_PROBE_MS), signal, arm => { wake = arm; });
      }
    } finally { wake = undefined; unsubscribe(); }
  }
  assertHeld(owner = false): void {
    const proof = this.proof;
    if (!proof || proof.generation !== databaseGeneration() || (proof.owner && !owner)
      || (!proof.omittedPins && !noPins())) throw new MemoryPinProjectionPending();
  }
  get heldOmittedPins(): boolean {
    return this.proof?.omittedPins === true;
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
  /** The last rebuild (or a selective drop): no stored-memory system layers and no memory tools, under the 'withheld' label. */
  readonly memoryFree?: true;
  /** SABLE-IDENTITY-1020: the system a memory-free request must carry, exactly: the bot's instructions with every stored-memory layer
   * left out. Absent (a room member's): the empty system, as before. */
  readonly memoryFreeSystem?: string;
}
export function assertRecallDispatch(input: { recall?: RecallMode; recallPrepared?: RecallPrepared; system?: string; integrations?: object; transcript?: readonly unknown[]; prompt?: { readonly parts: readonly { readonly text: string }[] } }): void {
  const prepared = input.recallPrepared;
  const names = Object.keys(input.integrations ?? {}).sort();
  if (input.recall === 'withheld' || prepared?.memoryFree) {
    // A memory-free rebuild is accepted only as exactly that: the withheld label on a request prepared memory-free, exactly the
    // prepared memory-free system (the bot's instructions without its stored-memory layers; empty only when none was prepared), no
    // memory tools mounted, and every other prepared tool still there (only the memory reader was withheld).
    const kept = [...(prepared?.integrations ?? [])].filter(name => name !== 'memory').sort();
    if (input.recall !== 'withheld' || !prepared?.memoryFree || input.system !== (prepared.memoryFreeSystem ?? '') || names.includes('memory') || JSON.stringify(names) !== JSON.stringify(kept)) throw new RecallDispatchPending();
    return;
  }
  if (!prepared || !['full', 'pins', 'held', 'off'].includes(input.recall ?? '') || !prepared.system.trim()
    || input.system !== prepared.system || JSON.stringify(names) !== JSON.stringify([...prepared.integrations].sort())
    || prepared.historyPrepared && !prepared.resumed && (prepared.historyParts
      ? !prepared.historyParts.length || !prepared.historyParts.every(part => input.prompt?.parts.includes(part))
      : !input.transcript?.length)) throw new RecallDispatchPending();
}
