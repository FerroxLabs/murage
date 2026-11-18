// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer: trainred-stopwrite (the Claude driver's stop and completion
// proofs); consumer: the server's Stop-held folder lease
// (ProjectTurnLeases.releaseStopHeld, through turnChildTracked).

export const TURN_STOP_PROOF_LIMIT = 4096;

export interface TurnStopProof {
  threadId: string;
  /** Still waiting on its child: never evicted for room. */
  pending: boolean;
  /** The proof watches a child of this turn. */
  child: boolean;
  /** Resolves when that child's close is confirmed (never, for a proof with
   * no child). The cache itself watches it (set): a confirmed close is
   * positive evidence, so the proof may then be forgotten for room without
   * leaving its turn unknown. No producer records that by hand. */
  closed: Promise<void>;
}

/** Proofs of how each provider turn's child closed, bounded. A turn whose
 * proof was refused for room (every held proof still pending), or whose
 * settled proof of a child was evicted for room, is remembered as unknown:
 * turnChildTracked reports it as holding a child, so its folder stays held,
 * never released as if it had none. The unknown memory is bounded too, and
 * forgetting an unknown is itself missing evidence: from then on a turn with
 * no proof here reads as unknown (fail closed), never as "no child". */
export class TurnStopProofs<P extends TurnStopProof> {
  private readonly proofs = new Map<string, P>();
  private readonly refused = new Map<string, string>();
  private readonly limit: number;
  /** An unknown was forgotten for room: absence no longer proves "no child". */
  private lost = false;
  /** Proofs whose `closed` resolved. Only `set` adds to it. */
  private readonly closeSeen = new WeakSet<P>();
  constructor(limit = TURN_STOP_PROOF_LIMIT) { this.limit = limit; }

  has(turnId: string): boolean { return this.proofs.has(turnId); }
  get(turnId: string): P | undefined { return this.proofs.get(turnId); }

  /** Room for this turn's proof: the oldest settled proof makes way when
   * full. False when none can, and the turn is then remembered as unknown. */
  admit(threadId: string, turnId: string): boolean {
    if (this.proofs.size < this.limit) return true;
    const oldest = [...this.proofs].find(([, proof]) => !proof.pending);
    if (oldest) {
      this.proofs.delete(oldest[0]);
      // A settled proof that watched a child is evidence the turn's later
      // terminal event may still read: forgetting it leaves the turn unknown,
      // unless that child's close was already confirmed.
      if (oldest[1].child && !this.closeSeen.has(oldest[1])) this.unknown(oldest[0], oldest[1].threadId);
      return true;
    }
    this.unknown(turnId, threadId);
    return false;
  }

  private unknown(turnId: string, threadId: string): void {
    this.refused.delete(turnId);
    this.refused.set(turnId, threadId);
    if (this.refused.size <= this.limit) return;
    this.refused.delete(this.refused.keys().next().value!);
    this.lost = true;
  }

  set(turnId: string, proof: P): void {
    this.proofs.set(turnId, proof);
    this.refused.delete(turnId);
    // A rejected `closed` confirms nothing: the proof stays unconfirmed.
    void proof.closed.then(() => { this.closeSeen.add(proof); }, () => {});
  }

  /** True while a proof of this thread's turn watches a child, or when its
   * proof was refused or evicted for room (unknown, held as a child), or once
   * any unknown was forgotten; false only when nothing of this turn reached a
   * child here. */
  childTracked(threadId: string, turnId: string): boolean {
    const proof = this.proofs.get(turnId);
    if (proof) return proof.threadId === threadId && proof.child;
    return this.lost || this.refused.get(turnId) === threadId;
  }
}
