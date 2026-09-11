// Release of a room member turn that never started (RED2J, RED2K).
//
// runGroupMemberTurn claims the room (busyBotId, the speaker record) and the
// bot (busy) before it dispatches a provider turn. Every exit between that
// claim and an accepted provider turn — Stop, a revoked owner, a restore
// lease refused, a rejected dispatch — must give both back through this one
// path, or the room stays silently busy: working, no chip, no reply (RED2J).
// The steps are the ones a rejected dispatch always took: the skill-authoring
// claim handed back so the next eligible member can take /learn, the speaker
// and busyBotId cleared, the bot idle and the delegations waiting on it
// retried, this turn's browser capability released, and the queues drained
// (no turn.completed follows a turn that never started, so nothing else
// would retry what was queued while this bot briefly owned the room).
//
// The room and the bot are touched only while this attempt still owns the
// room (busyBotId === botId) — the guard the settle fallback in
// runGroupMemberTurn uses. A room another owner already took (the stall
// watchdog or a Stop released this claim and a later round claimed it for
// another member, or this bot picked up a 1:1 turn since) is never idled by
// a stale exit (RED2K, RED2J verifier). The browser release is scoped to
// this attempt's owner id for the same reason, as the direct path scopes it
// to its dispatch claim.

export interface UnstartedRoomTurn {
  groupId: string;
  threadId: string;
  botId: string;
  /** This attempt's internal generation: the owner id its browser capability
   * was registered under. */
  ownerId: string;
  /** Whether this attempt took the round's skill-authoring claim. */
  skillAuthoring: boolean;
  skillAuthoringClaim: { claimed: boolean };
}

export interface UnstartedRoomTurnReleaseDeps {
  roomBusyBotId(groupId: string): string | null | undefined;
  botBusy(botId: string): boolean;
  /** Clear the speaker record and busyBotId (unread: the room changed). */
  clearRoomClaim(groupId: string, threadId: string): void;
  /** Idle the bot and retry the delegations waiting on it. */
  idleBot(botId: string): void;
  releaseBrowser(threadId: string, ownerId: string): Promise<void>;
  drainQueues(): void;
}

export type UnstartedRoomTurnRelease = "released" | "stale";

export async function releaseUnstartedRoomTurn(
  deps: UnstartedRoomTurnReleaseDeps,
  turn: UnstartedRoomTurn,
): Promise<UnstartedRoomTurnRelease> {
  if (turn.skillAuthoring) turn.skillAuthoringClaim.claimed = false;
  const owned = deps.roomBusyBotId(turn.groupId) === turn.botId;
  if (owned) {
    deps.clearRoomClaim(turn.groupId, turn.threadId);
    if (deps.botBusy(turn.botId)) deps.idleBot(turn.botId);
  }
  await deps.releaseBrowser(turn.threadId, turn.ownerId);
  deps.drainQueues();
  return owned ? "released" : "stale";
}
