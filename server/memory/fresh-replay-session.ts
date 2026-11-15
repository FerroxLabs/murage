// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Accepted-write correlation owner: tri3-g7-d. Incremental proof/durable delta owner: new3-g5.
import type { SessionKey } from "./lineage-types.ts";
import { walkOf, countReplayFallback } from "./replay-walk.ts";
import { updateReceiptReplayProof } from "./receipt-replay-proof.ts";
import { database, transaction } from "../database.ts";
import { assertSendReplayProof, captureSendReplayProof, confirmFreshReplaySession, currentSendReplaySessionProof,
  forgetSendReplaySessionProof, isConfirmedReplayProof, replaceConfirmedReplayProof, extendConfirmedReplayProof, type SendReplayProof } from "./replay-lineage.ts";

/** Preserve exact proofs across the known send's own durable transitions.
 * The write lock covers the old proof, mutation and new proof: no unrelated
 * commit can be mistaken for our own epoch bump. Copied ancestry and foreign
 * epochs stay exact; no candidate may become newly excluded, and only the
 * owned message may become positively submitted. */
export function withOwnReplayEligibilityChange<T>(proofs: readonly SendReplayProof[], ownMessageIds: readonly string[], change: () => T,
  requireCurrent = true): T {
  if (!proofs.length) return change();
  return transaction(() => {
    const unique = [...new Set(proofs)].filter(proof => {
      try { assertSendReplayProof(proof); return true; }
      catch (error) { if (requireCurrent) throw error; return false; }
    });
    const snapshots = new Map(unique.map(proof => [proof, walkOf(proof)?.fork().toProof() ?? proof]));
    const ordinary = unique.filter(proof => !isConfirmedReplayProof(proof));
    const states = new Map(ordinary.map(proof => [proof, { proof: snapshots.get(proof)! }]));
    let callbackError: unknown, completed = false, result: T;
    const invoke = () => { try { const value = change(); completed = true; result = value; return value; } catch (error) { callbackError = error; throw error; } };
    const wrapped = ordinary.reduceRight<() => T>((next, proof) => () => updateReceiptReplayProof(database(), states.get(proof)!, ownMessageIds, next), invoke);
    let strictError: unknown;
    try { wrapped(); } catch (error) { if (!completed || callbackError) throw error; strictError = error; }
    const owned = new Set(ownMessageIds);
    for (const proof of unique) {
      const original = snapshots.get(proof)!;
      let next = states.get(proof)?.proof;
      let fullComparison = false;
      if (isConfirmedReplayProof(proof) && walkOf(proof)?.witnessCurrent(database()) === "current") continue;
      if (!next || strictError) {
        // Direct legacy writers may bump an epoch for a metadata-only patch.
        // Actual receipt writers use the observer/strict incremental path.
        countReplayFallback(); fullComparison = true;
        next = captureSendReplayProof(original.threadId, original.messageIds, original.copyRoots);
      }
      const foreign = (row: SendReplayProof) => JSON.stringify(row.epochs.filter(([thread]) => thread !== row.threadId));
      const changed = ownMessageIds;
      const excluded = (p: SendReplayProof, id: string) => walkOf(p)?.excluded.has(id) ?? p.excludedIds.has(id);
      if ((fullComparison && (next.ancestry !== original.ancestry || foreign(next) !== foreign(original)))
        || changed.some(id => excluded(next!, id) && !excluded(original, id))
        || (fullComparison && [...next.excludedIds].some(id => !original.excludedIds.has(id)))
        || (fullComparison && [...original.excludedIds].some(id => !next!.excludedIds.has(id) && !owned.has(id)))) throw new Error("SEND_REPLAY_CHANGED");
      replaceConfirmedReplayProof(proof, next, ownMessageIds.filter(id => walkOf(next!)?.candidateSet.has(id)));
    }
    return result!;
  });
}

/** Linking the next owner's line changes its thread epoch before preparation.
 * Carry only a previously proven session over that specific local mutation. */
export function withCurrentReplaySessionChange<T>(threadId: string, instanceId: string, sessionId: string | undefined,
  ownMessageIds: readonly string[], change: () => T): T {
  const proof = sessionId === undefined ? undefined : currentSendReplaySessionProof(threadId, instanceId, sessionId);
  return withOwnReplayEligibilityChange(proof ? [proof] : [], ownMessageIds, change);
}

/** Join the dispatch's acceptance, confirmed write and positively fresh native
 * session. Adapters may report those in any order, including synchronously
 * before sendTurn resolves. A resumed or unrelated session proves nothing. */
export class FreshReplaySessionConfirmation {
  private acceptedTurn?: string;
  private written = false;
  private session?: { turnId: string; key: SessionKey };
  private confirmed = false;
  private readonly proof: SendReplayProof;
  private readonly instanceId: string;
  private readonly assertAccepted: () => void;
  private readonly ownMessageIds: readonly string[];
  private readonly retainedSession?: string;
  private readonly retainedProof?: SendReplayProof;
  private extended = false;
  private readonly additionalProofs: SendReplayProof[] = [];
  private readonly generation?: string;

  constructor(proof: SendReplayProof, instanceId: string, assertAccepted: () => void,
    options: { ownMessageIds?: readonly string[]; retainedSession?: string; generation?: string } = {}) {
    this.proof = proof;
    this.generation = options.generation;
    this.instanceId = instanceId;
    this.assertAccepted = assertAccepted;
    this.ownMessageIds = options.ownMessageIds ?? [];
    this.retainedSession = options.retainedSession;
    if (options.retainedSession !== undefined) this.retainedProof = currentSendReplaySessionProof(proof.threadId, instanceId, options.retainedSession);
  }

  ownEligibilityChange<T>(change: () => T, requireCurrent = true): T {
    return withOwnReplayEligibilityChange([this.proof, ...this.additionalProofs, ...(this.retainedProof ? [this.retainedProof] : [])], this.ownMessageIds, change, requireCurrent);
  }

  includeProof(proof: SendReplayProof): void { this.additionalProofs.push(proof); }

  accepted(turnId: string): void { this.acceptedTurn = turnId; this.confirm(); }
  engineWritten(): void { this.written = true; this.confirm(); }
  sessionStarted(turnId: string | undefined, key: SessionKey, fresh: boolean): void {
    if (!fresh || !turnId || key.threadId !== this.proof.threadId || key.driverInstance !== this.instanceId) return;
    this.session ??= { turnId, key };
    this.confirm();
  }

  private confirm(): void {
    if (this.written && this.acceptedTurn && !this.extended && this.retainedProof) {
      this.assertAccepted();
      transaction(() => {
        assertSendReplayProof(this.proof); assertSendReplayProof(this.retainedProof!);
        try { extendConfirmedReplayProof(this.retainedProof!, this.proof, this.ownMessageIds); }
        catch (error) {
          if ((error as Error).message === "SEND_REPLAY_LIMIT") forgetSendReplaySessionProof(this.proof.threadId, this.instanceId, this.retainedSession!);
          else throw error;
        }
      });
      this.extended = true;
    }
    if (this.confirmed || !this.written || !this.session || this.session.turnId !== this.acceptedTurn) return;
    this.assertAccepted();
    if (this.generation) {
      assertSendReplayProof(this.proof);
      const delivered = captureSendReplayProof(this.proof.threadId,
        [...new Set([...this.proof.messageIds, ...this.ownMessageIds])], this.proof.copyRoots);
      if (this.ownMessageIds.some(id => delivered.excludedIds.has(id))) throw new Error("SEND_REPLAY_CHANGED");
      replaceConfirmedReplayProof(this.proof, delivered, this.ownMessageIds);
      confirmFreshReplaySession(this.proof.threadId, this.instanceId, this.session.key.nativeSession, this.proof,
        { generation: this.generation, turnId: this.acceptedTurn! });
    } else confirmFreshReplaySession(this.proof.threadId, this.instanceId, this.session.key.nativeSession, this.proof);
    this.confirmed = true;
  }
}
