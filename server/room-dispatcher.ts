import type { authorizeWork } from "./execution-audience.ts";
import { isSharedWorkRow } from "./shared-work.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The durable room dispatcher (SPEC-P 5.2, 8; lane E1).
//
// Reads committed `queued` rows in dispatch order (owner, coordinator, work;
// then age) and starts each one the arbiter admits:
//  - `owner_send`: the owner's message written while the room was working.
//    It stays off the transcript until the room is free, then becomes the
//    room's next message (as the in-memory channel queue did; it now
//    survives a restart and dedupes on its send id).
//  - `room_turn`: a member the arbiter refused when the room asked it (busy
//    elsewhere). It answers in place once admitted: never "skipped".
//  - `wake`: a result coming back to the bot that asked for it.
//  - `routine`: a routine run in a project (lane R records it and posts its
//    prompt in the project's chat); the lead, or the routine's bot on an
//    ongoing project's card, answers it there.
// Other verbs are started by their own executors (asks and messages by the
// delegation ledger, card runs and reviews by lane E2a); the rows are still
// the queue and the lineage.
//
// A refusal that will never clear (`retry: "never"`: unreachable, deadlock)
// cancels the row with its plain line; any other refusal stays queued with
// its code in `refusal`, which the queue shows.
//
// The dispatcher always runs for rows that already exist, whatever the
// rooms.queue flag says (SPEC-P 8), so switching the flag never strands a
// send.
import { isProjectCloseRequest } from "./project-close.ts";
import { pauseProjectGoal } from "./project-goals.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  completeRequest,
  expireOverdueRoomRequests,
  markRequestDispatched,
  queuedRoomRequests,
  readdressReviewWake,
  recordRoomRequestRefusal,
  type RoomRequest,
} from "./room-requests.ts";
import type { AdmissionClaim, AdmissionDecision, AdmissionInput, ProjectContext, WorkAdmission, WriterRoot } from "./work-admission.ts";

/** A queued room turn says once that it is still waiting (plan 3.2). */
export const ROOM_TURN_STATUS_AFTER_MS = 10 * 60_000;
/** A queued room turn expires with "Ask again" (decision 5). */
export const ROOM_TURN_DEADLINE_MS = 2 * 60 * 60_000;

export interface RoomDispatcherDeps {
  db(): DatabaseSync;
  admission: WorkAdmission;
  now(): number;
  /** False while dispatch is closed (restore review, provider reload, a
   * backup restart): nothing is started and nothing is refused. */
  open(): boolean;
  /** The room (group) exists and still owns this thread. */
  roomUsable(request: RoomRequest): boolean;
  authorize?(request: RoomRequest): ReturnType<typeof authorizeWork>;
  ready?(request: RoomRequest): boolean;
  /** A room operation is running on this thread (one speaker at a time). */
  roomBusy(groupId: string, threadId: string): boolean;
  projectContext(request: RoomRequest): ProjectContext | undefined;
  /** The room's current members (a review wake moves only to a lead that is one). */
  memberIds(groupId: string): readonly string[];
  /** The work root a project room turn claims when free (SPEC-P 5.4a). */
  writerRoot?(request: RoomRequest): WriterRoot | undefined;
  /** Lineage-derived audience, recomputed at dispatch (6.1): false cancels. */
  audienceStillValid(request: RoomRequest): boolean;
  ownerOrigin(request: RoomRequest): boolean;
  /** Start the owner's queued message as the room's next message. */
  startOwnerSend(request: RoomRequest): void;
  /** Start a member's room turn (room_turn, wake or routine) under this claim. The
   * turn reports its end through finishRequestTurn and releases the claim. */
  startMemberTurn(request: RoomRequest, claim: AdmissionClaim): void;
  /** A row was cancelled or expired here: say so in the room. */
  onClosed(request: RoomRequest, line: string): void;
  /** A queued room turn has waited ROOM_TURN_STATUS_AFTER_MS. */
  onStillWaiting(request: RoomRequest, line: string): void;
  /** Rows changed (SSE `room.requests`). */
  changed(groupId: string, threadId: string | null): void;
  /** A queued row was refused for a new reason (the first time only). */
  onRefused?(request: RoomRequest, decision: Extract<AdmissionDecision, { admit: false }>): void;
  /** The dispatcher paused a goal (a review wake held for a lead that is not a member): say so in the room. */
  onGoalPaused?(request: RoomRequest, line: string): void;
}

/** A review wake held for a lead that is not a member of the room pauses its goal once (round 14). */
export const LEAD_NOT_MEMBER_LINE = "Paused: the lead is not in this project. Pick a lead to resume.";

export interface RoomDispatcher {
  pump(): void;
  /** Expiry and the 10-minute status lines; call on a timer. */
  tick(): void;
}

const DISPATCHED_BY_ROOM = new Set(["owner_send", "room_turn", "wake", "routine"]);
/** The queue's code for a review wake held for a lead that is not a member. */
const LEAD_NOT_MEMBER = "lead_not_member";

export function createRoomDispatcher(deps: RoomDispatcherDeps): RoomDispatcher {
  let pumping = false;
  let again = false;
  const statusSent = new Set<string>();

  const refusalLine = (decision: Extract<AdmissionDecision, { admit: false }>) => decision.line;

  function admissionFor(request: RoomRequest, project: ProjectContext | undefined): AdmissionInput {
    return {
      kind: request.verb === "wake" ? "wake" : request.verb === "routine" ? "routine" : "room_turn",
      priority: request.priority,
      botId: request.toBotId ?? "",
      threadId: request.targetThreadId ?? request.rootThreadId,
      ...(project ? { project } : {}),
      requestId: request.id,
      rootId: request.rootId,
      ...(request.workItemId ? { workItemId: request.workItemId } : {}),
      ...(request.cardGeneration !== null ? { cardGeneration: request.cardGeneration } : {}),
      ...(request.verb === "room_turn" && request.fromKind === "owner" ? { ownerReplyTo: request.parentId ?? request.rootId } : {}),
      ...(isProjectCloseRequest(deps.db(), request) ? { closeSummary: true } : {}),
      ...(deps.writerRoot?.(request) ? { writerRoot: deps.writerRoot(request) } : {}),
      ownerOrigin: deps.ownerOrigin(request),
      audience: { ownerAudience: !request.notOwnerAudience, fingerprint: request.audienceFingerprint },
      now: deps.now(),
    };
  }

  function once(): void {
    const db = deps.db();
    const busyRooms = new Set<string>();
    for (const request of queuedRoomRequests(db)) {
      if (isSharedWorkRow(request)) continue;
      if (!DISPATCHED_BY_ROOM.has(request.verb) || (request.verb === "wake" && request.workItemId)) continue;
      const threadId = request.targetThreadId ?? request.rootThreadId;
      const roomKey = `${request.groupId}:${threadId}`;
      // a review wake goes to whoever leads now, not to the lead at the
      // card's completion; the old lead keeps what else it absorbed while it
      // is still a member. With no lead at all it is held: by the arbiter
      // (the goal is paused) while its bot is still a member, and here when
      // that bot left the room, never cancelled as if the room were gone,
      // until a lead is set and it moves to them. A lead that is not a
      // member holds it where it is, run by nobody (round 13); nothing
      // clears such a lead, so the goal pauses once with a line saying why,
      // and the old lead's own answers go to it now (round 14).
      const reviewProject = request.verb === "wake" ? deps.projectContext(request) : undefined;
      const readdressed = request.verb === "wake"
        ? readdressReviewWake(db, request, { leadBotId: reviewProject?.leadBotId, memberIds: deps.memberIds(request.groupId), now: deps.now(), keepForOldLead: deps.roomUsable(request) })
        : null;
      if (readdressed?.held) {
        if (readdressed.wakes.length) again = true;
        if (request.refusal !== LEAD_NOT_MEMBER) {
          recordRoomRequestRefusal(db, request.id, LEAD_NOT_MEMBER);
          const goalId = reviewProject?.goalId ?? request.projectGoalId;
          if (goalId && pauseProjectGoal(db, { goalId, reason: LEAD_NOT_MEMBER_LINE, actor: { kind: "server" }, now: deps.now() }).ok) deps.onGoalPaused?.(request, LEAD_NOT_MEMBER_LINE);
        }
        if (readdressed.wakes.length || request.refusal !== LEAD_NOT_MEMBER) deps.changed(request.groupId, threadId);
        continue;
      }
      if (readdressed?.readdressed) {
        deps.changed(request.groupId, threadId);
        if (readdressed.wakes.length) again = true;
        continue;
      }
      if (!deps.roomUsable(request) && request.verb === "wake" && request.admissionKey.startsWith("wake:review:") && reviewProject?.isProject && !reviewProject.leadBotId
        && deps.roomUsable({ ...request, toBotId: null })) continue;
      if (!deps.roomUsable(request)) {
        const members = deps.memberIds(request.groupId);
        if (request.verb === "owner_send" && request.toBotId && members.length && !members.includes(request.toBotId)) {
          const line = "The member you picked is no longer in this room; ask again.";
          completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: line });
          deps.onClosed(request, line);
        } else completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: "the room is gone" });
        deps.changed(request.groupId, threadId);
        continue;
      }
      if (busyRooms.has(roomKey) || deps.roomBusy(request.groupId, threadId)) {
        busyRooms.add(roomKey);
        continue;
      }
      if (!deps.audienceStillValid(request)) {
        const line = "This conversation's audience changed; ask again.";
        completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: line });
        deps.onClosed(request, line);
        deps.changed(request.groupId, threadId);
        continue;
      }
      if (request.verb === "owner_send") {
        if (!markRequestDispatched(db, request.id, { now: deps.now(), targetThreadId: threadId })) continue;
        busyRooms.add(roomKey);
        deps.startOwnerSend({ ...request, state: "running", targetThreadId: threadId });
        deps.changed(request.groupId, threadId);
        continue;
      }
      const allowed = deps.authorize?.(request);
      if (allowed && !allowed.ok) {
        if (allowed.retry === "queue") recordRoomRequestRefusal(db, request.id, allowed.code);
        else { completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: allowed.code }); deps.onClosed(request, allowed.line); }
        deps.changed(request.groupId, threadId); continue;
      }
      if (deps.ready?.(request) === false) continue;
      const project = deps.projectContext(request);
      const decision = deps.admission.admit(admissionFor(request, project));
      if (!decision.admit) {
        if (decision.retry === "never") {
          completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: decision.line });
          deps.onClosed(request, refusalLine(decision));
        } else if (request.refusal !== decision.reason) {
          recordRoomRequestRefusal(db, request.id, decision.reason);
          deps.onRefused?.(request, decision);
        } else continue;
        deps.changed(request.groupId, threadId);
        continue;
      }
      if (!markRequestDispatched(db, request.id, { now: deps.now(), targetThreadId: threadId })) {
        decision.claim.release();
        continue;
      }
      busyRooms.add(roomKey);
      statusSent.delete(request.id);
      try {
        deps.startMemberTurn({ ...request, state: "running", targetThreadId: threadId }, decision.claim);
      } catch (error) {
        decision.claim.release();
        throw error;
      }
      deps.changed(request.groupId, threadId);
    }
  }

  function pump(): void {
    if (!deps.open()) return;
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do { again = false; once(); } while (again);
    } finally { pumping = false; }
  }

  function tick(): void {
    const db = deps.db();
    const now = deps.now();
    for (const expired of expireOverdueRoomRequests(db, now, {}, row => !isSharedWorkRow(row))) {
      statusSent.delete(expired.id);
      deps.onClosed(expired, "Not answered in time. Ask again.");
      deps.changed(expired.groupId, expired.targetThreadId);
    }
    for (const request of queuedRoomRequests(db)) {
      if (isSharedWorkRow(request)) continue;
      if (request.verb !== "room_turn" || statusSent.has(request.id)) continue;
      if (now - request.createdAt < ROOM_TURN_STATUS_AFTER_MS) continue;
      statusSent.add(request.id);
      deps.onStillWaiting(request, "Still waiting to answer. It runs as soon as it is free.");
    }
    pump();
  }

  return { pump, tick };
}
