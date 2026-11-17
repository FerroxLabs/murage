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
/** One logical send owns its wait budget and finite probes across every redispatch, except that a context change (renewAfterContextChange) starts a fresh schedule. The budget counts only time spent waiting inside access(); reset, slot and setup time between redispatches does not use it up. */
export class RecallReadiness {
  readonly hadMemories = hasMemories();
  private waited = 0;
  private waitMs?: number;
  private proof?: { generation: number };
  private probes = 0;
  private readmitted = false;
  private heldIssued = false;
  /** MAIN RULING 1117T01:23Z (a): a redispatch after a roster or authority change (the prepared context was revoked) reads a context
   *  that did not exist when the earlier probes ran, so it gets a fresh probe schedule with the same 300/2000 ms per wait. The held
   *  and readmission tickets stay spent: one held send and one readmission per logical send. The redispatch count stays bounded. */
  renewAfterContextChange(): void {
    this.probes = 0;
    this.waited = 0;
    this.waitMs = undefined;
  }
  claimReadmission(): boolean {
    if (this.readmitted) return false;
    this.readmitted = true;
    return true;
  }
  async access<T>(read: () => T, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const empty = noPins();
    if (!empty) this.waitMs = 2000;
    else this.waitMs ??= 300;
    const schedule = this.waitMs === 300 ? [0, 50, 300] : [0, 50, 300, 2000];
    while (this.probes < schedule.length) {
      const offset = schedule[this.probes++];
      if (offset > this.waited) { await waitFor(offset - this.waited, signal); this.waited = offset; }
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
