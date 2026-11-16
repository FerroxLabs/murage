// Receipt transaction adapter owner: new3-g5b. Replay/attempt producers owner: tri3-g2.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { failReplayShadow } from "./replay-shadow.ts";
import type { DatabaseSync } from "node:sqlite";
import { walkOf, countReplayFallback, replayShadowEnabled } from "./replay-walk.ts";
import { inTxScope, onRollback } from "../tx-scope.ts";
import { assertSendReplayProof, captureSendReplayProof, type SendReplayProof } from "./replay-lineage.ts";

export interface ReceiptReplayProof { proof?: SendReplayProof }

/** Receipt evidence can change this attempt's eligibility while its prompt is
 * being written. Advance the captured proof only across those exact changes,
 * under the receipt owner's writer lock. An unrelated epoch or source change
 * still refuses, including one committed before entry to this transaction. */
export function updateReceiptReplayProof<T>(db: DatabaseSync, state: ReceiptReplayProof,
  messageIds: readonly string[], write: () => T): T {
  if (!db.isTransaction || !inTxScope()) throw new Error("SEND_REPLAY_WRITE_SCOPE");
  if (write.constructor.name === "AsyncFunction") throw new Error("ASYNC_SEND_REPLAY_WRITE");
  const before = state.proof;
  if (!before) {
    const value = write();
    if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("ASYNC_SEND_REPLAY_WRITE");
    return value;
  }
  assertSendReplayProof(before, db);
  const allowed = new Set(messageIds);
  const read = db.prepare("SELECT reason,revision FROM send_replay_exclusions WHERE thread_id=? AND message_id=?");
  const prior = new Map([...allowed].map(id => [id, JSON.stringify(read.get(before.threadId, id) ?? null)]));
  const value = write();
  if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("ASYNC_SEND_REPLAY_WRITE");
  const changed: string[] = [];
  for (const id of allowed) if (JSON.stringify(read.get(before.threadId, id) ?? null) !== prior.get(id)) changed.push(id);
  const changes = changed.length, originalWalk = walkOf(before);
  if (originalWalk && changed.every(id => originalWalk.canRewalk(id))) {
    const child = originalWalk.fork(), journal = child.begin();
    let ancestryChanged = false;
    for (const id of changed) { child.rewalk(id, db, journal); ancestryChanged ||= child.lastRewalkAncestryChanged; }
    // Only these independently walked candidates can change exclusion. Verify
    // every touched epoch under the same writer lock; unrelated writes refuse.
    if (ancestryChanged || [...child.epochs].some(([thread, epoch]) => child.readEpoch(thread, db) !== epoch + (thread === before.threadId ? changes : 0))
      || [...child.missing].some(key => { const [thread, id] = JSON.parse(key); return db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND id=?").get(thread, id); })) throw new Error("SEND_REPLAY_CHANGED");
    child.epochs.set(before.threadId, child.epochs.get(before.threadId)! + changes);
    const after = child.toProof();
    if (replayShadowEnabled()) {
      const full = captureSendReplayProof(before.threadId, before.messageIds, before.copyRoots, db);
      if (full.ancestry !== after.ancestry || JSON.stringify(full.epochs) !== JSON.stringify(after.epochs)
        || JSON.stringify([...full.excludedIds].sort()) !== JSON.stringify([...after.excludedIds].sort())) failReplayShadow();
    }
    onRollback(() => { state.proof = before; }); state.proof = after; return value;
  }
  countReplayFallback();
  const after = captureSendReplayProof(before.threadId, before.messageIds, before.copyRoots, db);
  const oldEpochs = new Map(before.epochs), newEpochs = new Map(after.epochs);
  const changedIds = new Set([...before.excludedIds, ...after.excludedIds].filter(id => before.excludedIds.has(id) !== after.excludedIds.has(id)));
  if (after.ancestry !== before.ancestry || [...changedIds].some(id => !allowed.has(id))
    || newEpochs.size !== oldEpochs.size || [...oldEpochs].some(([thread, epoch]) => newEpochs.get(thread) !== epoch + (thread === before.threadId ? changes : 0))) {
    throw new Error("SEND_REPLAY_CHANGED");
  }
  onRollback(() => { state.proof = before; });
  state.proof = after;
  return value;
}
