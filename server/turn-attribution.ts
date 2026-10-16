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
    size(): number { return attempts.size; },
  };
}
export type TurnAttribution = ReturnType<typeof createTurnAttribution>;
