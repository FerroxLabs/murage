// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which provider turn the owner's words were released to (BOTADDED-DESIGN-V3 r6 §5). A user row carries `dispatchedIn` (the
// accepted provider turn id) iff, for the attempt that admitted it, the server's submission fence passed (every adapter calls
// `beforeSubmit` synchronously right before its prompt write) AND acceptance named the provider turn. The two arrive in either
// order (Claude fences before it hands its id back; ACP and Codex hand the id back first), and whichever arrives second stamps,
// once. No driver is involved: the fence and the acceptance callback both live in the server's own dispatch closure, keyed by
// the attempt (`dispatchClaimId`, the run generation).
//
// An attempt's entry ends at its terminal outcome: a setup that failed or was refused (`ended`), or the completion of the
// provider turn it is bound to (`completed`). An older turn's late completion names its own turn id, so it can never end a
// newer attempt's entry.

export interface Attempt {
  readonly threadId: string;
  /** The rows this attempt carries to the engine: the appended, forked or handed row and any it excluded from the replay. */
  readonly rows: string[];
  fencePassed: boolean;
  turnId: string | undefined;
  stamped: boolean;
}

export interface TurnAttributionDeps {
  /** Writes `dispatchedIn = turnId` on one row (persisted, announced). Only `role:"user"` rows are stamped; the callee checks. */
  stamp(threadId: string, messageId: string, turnId: string): void;
  /** Withdraws a stamp this attempt made (only when the row still names `turnId`): the write it was released to never happened. */
  unstamp?(threadId: string, messageId: string, turnId: string): void;
  /** Most entries kept at once; the oldest goes first. A dispatch that never reaches a terminal outcome cannot grow it forever. */
  limit?: number;
}

export function createTurnAttribution(deps: TurnAttributionDeps) {
  const limit = deps.limit ?? 512;
  const attempts = new Map<string, Attempt>();
  const stampAll = (attempt: Attempt, rows: readonly string[]) => {
    for (const id of rows) {
      if (id.startsWith("card-")) continue;
      try { deps.stamp(attempt.threadId, id, attempt.turnId!); } catch (error) { console.error(`turn attribution: could not stamp ${id}`, error); }
    }
  };
  const settle = (attempt: Attempt) => {
    if (attempt.stamped || !attempt.fencePassed || attempt.turnId === undefined) return;
    attempt.stamped = true;
    stampAll(attempt, attempt.rows);
  };
  return {
    /** Admission, before the engine is asked. A re-dispatch of the same rows is a new attempt and overwrites when it stamps. */
    begin(attemptId: string, threadId: string, rows: readonly string[]): Attempt {
      const attempt: Attempt = { threadId, rows: [...new Set(rows)], fencePassed: false, turnId: undefined, stamped: false };
      attempts.delete(attemptId);
      attempts.set(attemptId, attempt);
      while (attempts.size > limit) attempts.delete(attempts.keys().next().value!);
      return attempt;
    },
    /** The server's `beforeSubmit` returned (its own checks and every added check passed): the prompt is released to the write.
     * Idempotent: a relaunch calls it again. */
    fencePassed(attemptId: string): void {
      const attempt = attempts.get(attemptId);
      if (!attempt) return;
      attempt.fencePassed = true;
      settle(attempt);
    },
    /** The write the fence released did not happen (a pre-write failure: the process never started, the connection failed before any
     * answer, the MCP wait failed, a later fence refused): I14 means "released to the engine's write", so a stamp made on the strength
     * of that fence is withdrawn and the attempt waits for a fence that precedes a real write. A relaunch passes the fence again. */
    notWritten(attemptId: string): void {
      const attempt = attempts.get(attemptId);
      if (!attempt) return;
      attempt.fencePassed = false;
      if (!attempt.stamped) return;
      attempt.stamped = false;
      if (attempt.turnId === undefined) return;
      for (const id of attempt.rows) {
        if (id.startsWith("card-")) continue;
        try { deps.unstamp?.(attempt.threadId, id, attempt.turnId); } catch (error) { console.error(`turn attribution: could not unstamp ${id}`, error); }
      }
    },
    /** Acceptance named the provider turn. */
    accepted(attemptId: string, turnId: string): void {
      const attempt = attempts.get(attemptId);
      if (!attempt || attempt.turnId !== undefined) return;
      attempt.turnId = turnId;
      settle(attempt);
    },
    /** The attempt's setup failed or was refused. */
    ended(attemptId: string): void { attempts.delete(attemptId); },
    /** The provider turn completed: the attempt bound to it is done. */
    completed(turnId: string): void {
      for (const [id, attempt] of attempts) if (attempt.turnId === turnId) attempts.delete(id);
    },
    /** Wires one attempt to the server's submission boundary: its passed fence releases the prompt, a pre-write failure takes it back. */
    bind(attemptId: string, boundary: { onPassed(listener: () => void): void; onNotWritten(listener: () => void): void }): void {
      boundary.onPassed(() => this.fencePassed(attemptId));
      boundary.onNotWritten(() => this.notWritten(attemptId));
    },
    /** The running attempt's entry, held by reference: a steer captures it before its awaited write, so the turn ending meanwhile
     * (the entry leaves the map) or a newer attempt starting cannot change which turn the steer is attributed to. */
    attempt(attemptId: string | undefined): Attempt | undefined {
      return attemptId === undefined ? undefined : attempts.get(attemptId);
    },
    /** A steered row the engine took into this attempt: stamped now when the attempt has stamped, else when it does. */
    addDelivered(attempt: Attempt, messageId: string): void {
      attempt.rows.push(messageId);
      if (attempt.stamped) stampAll(attempt, [messageId]);
    },
    /** The engine confirmed a steer it had left uncertain (`steer.confirmed`, or a late "delivered"): the turn it went into when that
     * is known (the caller stamps it with the confirmation), else the row joins the attempt and is stamped when acceptance names it. */
    confirmed(attempt: Attempt | undefined, messageId: string | undefined): string | undefined {
      if (!attempt || !messageId) return undefined;
      if (attempt.turnId !== undefined) return attempt.turnId;
      attempt.rows.push(messageId);
      return undefined;
    },
    size(): number { return attempts.size; },
  };
}
export type TurnAttribution = ReturnType<typeof createTurnAttribution>;

/** Which attempt a steer's words reach. The steer waits for the engine to be ready (up to its bound) before its write, and the turn
 * can end, or the next one begin, in that wait; the receiving attempt is therefore taken at the write's fence (the call right
 * before the write, no await between) and held by reference, never read again after the awaited acknowledgement. */
export function createSteerReceiver(lookup: () => Attempt | undefined) {
  let held: Attempt | undefined;
  return {
    /** Run by the steer's submission fence once every check passed. */
    atFence(): void { held = lookup(); },
    /** The attempt the fence found; undefined when the write never passed its fence (nothing reached the engine). */
    attempt(): Attempt | undefined { return held; },
  };
}
