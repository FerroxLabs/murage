// cause23 (TRIAGE-STOPS-1122 row 3): the steer door's memory decision.
// Owners: this decision, its log lines and its reset count: cause23-steerpending (called from the send route in index.ts).
// Proof producer: session-proof.ts proveRetainedSession (via MemoryDispatchReceipt.steerState and the no-receipt branch in index.ts).
// Owner-keep flag producer: the direct dispatch in index.ts (ownerMayKeepPending, RunningTurnLineage.ownerKeepsPending).
import type { SessionProof } from './session-proof.ts';
import { noteContinuationReset } from './reset-watch.ts';

/** What the running session's proof says for a steer: it holds, it is exactly checking:pending (a revoke walk not finished), or it is
 * refused (a settled deny, any other checking cause, no proof). */
export type SteerSessionState = 'holds' | 'pending' | 'refused';

/** The same "exactly checking:pending" the owner turn's continuation check keeps (continuationMemoryRevoked keepPending, T3). */
export function steerProofState(proof: SessionProof): SteerSessionState {
  if (proof.kind === 'resume') return 'holds';
  return proof.cause === 'checking' && proof.reason === 'checking' && proof.detail === 'pending' ? 'pending' : 'refused';
}

/** The 1.0.20 owner-keep rule at the steer door: an owner turn that may keep its session under checking:pending takes the owner's own
 * words mid-turn as well. The steer adds nothing remembered (the words alone, never a quote: the caller passes false for one), and
 * what the session already holds stays fenced by the running turn's releases as before. Every other audience and state is refused. */
export function steerStateHolds(state: SteerSessionState, ownerKeepsPending: boolean): boolean {
  return state === 'holds' || (state === 'pending' && ownerKeepsPending);
}

/** The door's decision for a steerable engine, with its one log line. A pending refusal (a non-owner turn, or a quoted steer) is deferred,
 * not a reset: nothing is reset here; the line's own turn runs its own continuation check, which counts a reset if it makes one. */
export function steerDoor(input: { state: SteerSessionState; tainted: () => boolean; ownerKeepsPending: boolean; threadId: string; engine: string }): boolean {
  const { state, threadId, engine } = input;
  if (steerStateHolds(state, input.ownerKeepsPending)) {
    if (state === 'pending') console.warn(`memory steer kept thread=${threadId} engine=${engine} reason=checking:pending (owner turn, nothing remembered added)`);
    return true;
  }
  if (input.tainted()) {
    // An intended refusal, not a reset: the queued line runs as its own turn (counted by S2 when it goes fresh).
    console.warn(`thread recall steer refused thread=${threadId} engine=${engine} reason=steer-refused sealed`);
  } else if (state === 'pending') {
    console.warn(`memory steer deferred thread=${threadId} engine=${engine} reason=checking-pending`);
  } else {
    console.warn(`memory continuation reset thread=${threadId} engine=${engine} reason=steer-refused session-invalid`);
    noteContinuationReset(threadId, engine, 'steer-refused session-invalid');
  }
  return false;
}
