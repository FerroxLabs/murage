import type { authorizeWork } from "./execution-audience.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import { classifyError } from "./drivers/retry.ts";
import type { DatabaseSync } from "node:sqlite";
import type { SteerDelivery } from "./contracts.ts";
import { enqueueCardRun, applyCardRunDispatched, applyCardWaiting, applyCardRunResumed } from "./project-cards.ts";
import { projectCardById, insertProjectActivity } from "./project-records.ts";
import { completeRequest, finishRequestTurn, markRequestDispatched, queuedRoomRequests, recordRoomRequestRefusal, roomRequest, isTerminalRoomRequestState, type CompletionHooks, type RoomRequest } from "./room-requests.ts";
import type { AdmissionClaim, ProjectContext, WorkAdmission, WriterRoot } from "./work-admission.ts";

/** The card note for the owner's own Stop. */
export const STOPPED_BY_YOU = "Stopped by you";
/** The card note when the project or goal budget ended a run (SPEC-P 5.4, 2026-09-29). */
export const BUDGET_STOPPED = "Budget reached";

export function cardSteeringMode(adapter: { capabilities: { queueing?: boolean }; steer?: unknown }): "steer" | "queue" {
  return adapter.capabilities.queueing && typeof adapter.steer === "function" ? "steer" : "queue";
}
function cardReviewRequest(db: DatabaseSync, request: RoomRequest): RoomRequest | null {
  let current: RoomRequest | null = request;
  for (let depth = 0; current && depth < 20; depth++) {
    if (current.verb === "review") return current;
    if (current.verb !== "wake" || !current.parentId) return null;
    current = roomRequest(db, current.parentId);
    if (current?.workItemId !== request.workItemId) return null;
  }
  return null;
}
/** The review run a card request belongs to (itself, or the review its
 * continuation wake carries on), or null. */
export function cardReviewRequestOf(db: DatabaseSync, request: RoomRequest): RoomRequest | null {
  return cardReviewRequest(db, request);
}
export function cardRequestIsReview(db: DatabaseSync, request: RoomRequest): boolean {
  return cardReviewRequest(db, request) !== null;
}
/** Owner approval follows only the persisted assign for this exact run. */
export function cardRequestOwnerApproved(db: DatabaseSync, request: RoomRequest): boolean {
  let current: RoomRequest | null = request;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.workItemId !== request.workItemId || current.attempt !== request.attempt
      || current.cardGeneration !== request.cardGeneration || current.groupId !== request.groupId
      || current.notOwnerAudience) return false;
    if (current.verb === "assign") return current.fromKind === "owner" && (current.origin === "desktop" || current.origin === "companion");
    if (current.verb !== "wake" || !current.parentId) return false;
    current = roomRequest(db, current.parentId);
  }
  return false;
}
export function isCardRequest(request: RoomRequest): boolean {
  return Boolean(request.workItemId) && (request.verb === "assign" || request.verb === "review" || request.verb === "wake");
}
interface CardExecutorDeps {
  db(): DatabaseSync;
  admission: WorkAdmission;
  now(): number;
  open(): boolean;
  context(request: RoomRequest): ProjectContext | undefined;
  usable(request: RoomRequest): boolean;
  desk(request: RoomRequest): string;
  authorize?(request: RoomRequest, threadId: string): ReturnType<typeof authorizeWork>;
  writerRoot(request: RoomRequest): WriterRoot | undefined;
  start(request: RoomRequest, claim: AdmissionClaim, retry: boolean): void;
  /** Re-enter through the room dispatcher so coordinator work always goes first. */
  wake?(): void;
  hooks: CompletionHooks;
  changed(groupId: string): void;
}

/** Owns admission until a terminal event, including after Stop or reassign.
 * R owns card transitions; E1 owns completion, fencing and the durable outbox. */
export function createProjectCardExecutor(deps: CardExecutorDeps) {
  const live = new Map<string, AdmissionClaim>();
  /** Runs being stopped, with the note their card gets ("Stopped by you", or why the server stopped it). */
  const stopping = new Map<string, string>();
  const cancellationHolds = new Map<string, number>();
  const retryCounts = new Map<string, number>();
  const retries = new Map<string, { count: number; at: number }>();
  let pumping = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Infinity;
  const wake = () => { if (!stopped) (deps.wake ?? pump)(); };
  function schedule(at: number) {
    if (stopped || at >= timerAt) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = undefined; timerAt = Infinity;
      // The room dispatcher may not call pump yet. Keep one slow fallback;
      // a successful pump clears it and installs its actual next deadline.
      schedule(deps.now() + 1000);
      wake();
    }, Math.max(1, at - deps.now()));
    timer.unref?.();
  }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; timerAt = Infinity; retries.clear(); retryCounts.clear(); stopping.clear(); cancellationHolds.clear(); }
  /** Only a terminal, empty, rate-limited start may be retried. A dispatched
   * queued row survives a crash as unknown, never as new work. */
  function retryStart(id: string, error: Error, worked: boolean): boolean {
    const db = deps.db(), request = roomRequest(db, id);
    const card = request?.workItemId ? projectCardById(db, request.workItemId) : null;
    const count = retryCounts.get(id) ?? 0;
    const delays = [5000, 15000, 45000, 120000];
    if (stopped || stopping.has(id) || cancellationHolds.has(id) || worked || !live.has(id) || !request || request.state !== "running" || !card
      || request.cardGeneration !== card.generation || request.attempt !== card.attempt
      || count >= delays.length || classifyError(error).reason !== "rate_limited") return false;
    db.prepare("UPDATE room_requests SET state='queued', refusal='stagger' WHERE id=? AND state='running'").run(id);
    const at = deps.now() + delays[count];
    retryCounts.set(id, count + 1);
    retries.set(id, { count: count + 1, at }); schedule(at);
    deps.changed(request.groupId);
    return true;
  }
  function finish(id: string, outcome: { ok: boolean; stopped?: boolean; resultMessageId?: string; note?: string; deliver?: () => void }) {
    // Shutdown closes engines after stop(). Leave durable runs for boot's
    // unknown/restart decision, even if disposal emits a terminal callback.
    if (stopped) { live.get(id)?.release(); live.delete(id); return; }
    const db = deps.db(), request = roomRequest(db, id);
    if (!request) { forgetRequest(id); wake(); return; }
    if (stopping.has(id) || outcome.stopped) outcome = { ...outcome, stopped: true, ok: false, note: stopping.get(id) ?? (outcome.stopped ? outcome.note : undefined) ?? STOPPED_BY_YOU };
    retries.delete(id); retryCounts.delete(id); stopping.delete(id); cancellationHolds.delete(id);
    let deliver = false;
    let result: ReturnType<typeof finishRequestTurn>;
    db.exec("SAVEPOINT card_terminal");
    try {
      // A review run that ends with no verdict is no longer taken as
      // "changes" (lane review): its completion records "No verdict given"
      // and the lead decides (project-turn-engine.ts applyReviewRunEffect).
      // Stop ends the turn, not its recorded review result. Leaving the note
      // unset also preserves a waiting review parent's verdict on completion.
      const stoppedReview = outcome.stopped && cardReviewRequest(db, request) !== null;
      result = outcome.stopped
        ? completeRequest(db, id, { state: "failed", outcomeNote: stoppedReview ? undefined : outcome.note, now: deps.now(), resultMessageId: outcome.resultMessageId }, deps.hooks, { suppressReturnWake: !stoppedReview, stopped: stoppedReview })
        : finishRequestTurn(db, id, { ...outcome, outcomeNote: outcome.note, now: deps.now() }, deps.hooks);
      if (result.request.state === "waiting_bot" && request.verb === "assign" && request.workItemId) {
        applyCardWaiting(db, { cardId: request.workItemId, requestId: id, actor: { kind: "server" }, waiting: { kind: "ask" }, now: deps.now() });
      }
      deliver = !isTerminalRoomRequestState(request.state) && isTerminalRoomRequestState(result.request.state)
        && (!deps.hooks.cardGenerationCurrent || deps.hooks.cardGenerationCurrent(db, request));
      deps.changed(request.groupId);
      db.exec("RELEASE card_terminal");
    } catch (error) {
      db.exec("ROLLBACK TO card_terminal; RELEASE card_terminal");
      throw error;
    } finally { live.get(id)?.release(); live.delete(id); }
    if (deliver) {
      try { outcome.deliver?.(); }
      catch { console.warn("Project card result delivery failed", id); }
    }
    if (deps.wake) wake();
    return result;
  }
  /** A deleted row has no terminal callback contract left to retain. */
  function forgetRequest(id: string) {
    live.get(id)?.release(); live.delete(id);
    retries.delete(id); retryCounts.delete(id); stopping.delete(id); cancellationHolds.delete(id);
    if (timer) clearTimeout(timer); timer = undefined; timerAt = Infinity;
    for (const retry of retries.values()) schedule(Math.max(deps.now() + 1, retry.at));
    if (queuedRoomRequests(deps.db()).some(row => isCardRequest(row) && row.refusal === "stagger")) schedule(deps.now() + 1000);
  }
  function pump() {
    if (pumping || stopped || !deps.open()) return;
    pumping = true;
    try {
      if (timer) clearTimeout(timer); timer = undefined; timerAt = Infinity;
      for (const id of new Set([...live.keys(), ...retries.keys(), ...retryCounts.keys(), ...stopping.keys(), ...cancellationHolds.keys()])) {
        if (!roomRequest(deps.db(), id)) forgetRequest(id);
      }
      for (const id of stopping.keys()) {
        const request = roomRequest(deps.db(), id);
        if (!request || isTerminalRoomRequestState(request.state)) stopping.delete(id);
      }
      for (const [id] of retries) {
        const request = roomRequest(deps.db(), id);
        if (!request || isTerminalRoomRequestState(request.state)) cancelBackoff(id);
      }
      for (const request of queuedRoomRequests(deps.db())) {
        if (!isCardRequest(request) || stopping.has(request.id) || cancellationHolds.has(request.id)) continue;
        const db = deps.db(), card = projectCardById(db, request.workItemId!);
        const retry = retries.get(request.id);
        const current = card && request.attempt === card.attempt && (request.verb === "assign"
          ? (retry ? card.state === "doing" && card.generation === request.cardGeneration && card.requestId === request.id : card.state === "todo" && card.generation + 1 === request.cardGeneration) && card.assigneeBotId === request.toBotId
          : card.generation === request.cardGeneration);
        if (!current || !deps.usable(request)) {
          completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: "This card run is no longer available." }, deps.hooks);
          cancelBackoff(request.id); deps.changed(request.groupId); continue;
        }
        if (retry && retry.at > deps.now()) { schedule(retry.at); continue; }
        if (card.dependsOn.some(id => projectCardById(db, id)?.state !== "done")) {
          recordRoomRequestRefusal(db, request.id, "dependency"); continue;
        }
        const threadId = deps.desk(request);
        const allowed = deps.authorize?.(request, threadId);
        if (allowed && !allowed.ok) {
          if (allowed.retry === "queue") recordRoomRequestRefusal(db, request.id, allowed.code);
          else completeRequest(db, request.id, { state: "cancelled", now: deps.now(), outcomeNote: allowed.code }, deps.hooks);
          deps.changed(request.groupId); continue;
        }
        const decision = deps.admission.admit({ kind: cardRequestIsReview(db, request) ? "review" : "card_run", priority: request.priority,
          botId: request.toBotId!, threadId, project: deps.context(request), requestId: request.id, rootId: request.rootId,
          workItemId: card.id, cardGeneration: request.cardGeneration ?? undefined, writerRoot: deps.writerRoot(request),
          ownerApprovedCard: cardRequestOwnerApproved(db, request),
          ownerOrigin: false, audience: { ownerAudience: !request.notOwnerAudience, fingerprint: request.audienceFingerprint }, now: deps.now() }, retry ? live.get(request.id) : undefined);
        if (!decision.admit) {
          recordRoomRequestRefusal(db, request.id, decision.reason);
          if (decision.reason === "stagger") schedule(decision.retryAt ?? deps.now() + 2000);
          if (request.refusal !== decision.reason && decision.reason !== "stagger") deps.changed(request.groupId);
          continue;
        }
        try {
          db.exec("BEGIN IMMEDIATE");
          // PF deviation from SPEC-P 5.3: also recover owner-approved cards
          // queued before this fix; their authenticated assign is the approval.
          // With plan_first on, only this card is approved, never the goal.
          if (request.fromKind === "owner" && !request.notOwnerAudience && (request.origin === "desktop" || request.origin === "companion") && card.goalId) {
            const changed = db.prepare("UPDATE project_goals SET state='working',state_reason=NULL,revision=revision+1 WHERE id=? AND state='planning' AND plan_first=0").run(card.goalId);
            if (changed.changes) insertProjectActivity(db, { groupId: card.groupId, goalId: card.goalId, requestId: request.id, kind: "goal_state", actor: "owner", at: deps.now(), detail: { from: "planning", to: "working", ownerCard: card.id } });
          }
          const lead = deps.context(request)?.leadBotId;
          if (lead && request.verb === "assign") db.prepare("UPDATE room_requests SET return_bot_id=COALESCE(return_bot_id,?) WHERE id=?").run(lead, request.id);
          if (request.verb === "assign" && !retry) {
            const dispatched = applyCardRunDispatched(db, { cardId: card.id, requestId: request.id, deskThreadId: threadId, now: deps.now() });
            if (!dispatched.ok) throw new Error(dispatched.reason);
          } else if (!markRequestDispatched(db, request.id, { now: deps.now(), targetThreadId: threadId })) throw new Error("Card request changed before dispatch");
          if (request.verb === "wake" && card.state === "waiting") applyCardRunResumed(db, { cardId: card.id, now: deps.now() });
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          decision.claim.release(); live.delete(request.id); retries.delete(request.id); retryCounts.delete(request.id);
          completeRequest(db, request.id, { state: "cancelled", now: deps.now(),
            outcomeNote: error instanceof Error ? error.message.slice(0, 200) : "Card dispatch was refused." }, deps.hooks);
          deps.changed(request.groupId);
          continue;
        }
        // Retry history survives until completion; a dormant reservation does
        // not. Terminal-row cleanup must never release this active run.
        retries.delete(request.id);
        live.set(request.id, decision.claim);
        try { deps.start(roomRequest(db, request.id)!, decision.claim, Boolean(retry)); }
        catch (error) { if (!retryStart(request.id, error instanceof Error ? error : new Error(String(error)), false)) finish(request.id, { ok: false, note: "Could not start this card. Try again shortly." }); }
        deps.changed(request.groupId);
      }
    } finally { pumping = false; }
  }
  /** Hold the retry intact while the route awaits other engines and commits. */
  function prepareBackoffCancellation(id: string) {
    if (!retries.has(id) || roomRequest(deps.db(), id)?.state !== "queued") return;
    cancellationHolds.set(id, (cancellationHolds.get(id) ?? 0) + 1);
    const release = () => {
      const remaining = (cancellationHolds.get(id) ?? 1) - 1;
      if (remaining) cancellationHolds.set(id, remaining); else cancellationHolds.delete(id);
    };
    let settled = false;
    return {
      commit() {
        if (settled) return;
        settled = true; release(); cancelBackoff(id);
      },
      abort() {
        if (settled) return;
        settled = true; release();
        const retry = retries.get(id);
        if (retry) schedule(Math.max(deps.now() + 1, retry.at));
      },
    };
  }
  /** Detach after a committed transition, or for an immediate Stop. */
  function cancelBackoff(id: string): boolean {
    const request = roomRequest(deps.db(), id);
    if (!retries.has(id) || request?.state === "running" || request?.state === "waiting_owner") return false;
    retries.delete(id); retryCounts.delete(id);
    // The route applies after its interrupt callback yields. A pump in that
    // gap must not treat this dispatched row as a fresh queued card.
    if (request?.state === "queued") stopping.set(id, stopping.get(id) ?? STOPPED_BY_YOU); else stopping.delete(id);
    live.get(id)?.release(); live.delete(id);
    if (timer) clearTimeout(timer); timer = undefined; timerAt = Infinity;
    for (const retry of retries.values()) schedule(Math.max(deps.now() + 1, retry.at));
    // A different queued card may still be staggered.
    if (queuedRoomRequests(deps.db()).some(row => row.id !== id && isCardRequest(row) && row.refusal === "stagger")) schedule(deps.now() + 1000);
    return true;
  }
  /** `note`: what the card says about the stop (the owner's Stop by default). */
  function requestStop(id: string, note = STOPPED_BY_YOU) {
    if (cancelBackoff(id)) { finish(id, { ok: false, stopped: true, note }); return; }
    if (live.has(id)) stopping.set(id, note);
  }
  function cancelBackoffs(filter: { botId?: string; groupId?: string }): number {
    let cancelled = 0;
    for (const [id] of retries) {
      const request = roomRequest(deps.db(), id);
      if (request?.state !== "queued" || (filter.botId && request.toBotId !== filter.botId) || (filter.groupId && request.groupId !== filter.groupId)) continue;
      cancelBackoff(id); finish(id, { ok: false, stopped: true }); cancelled++;
    }
    return cancelled;
  }
  /** A stop was asked for this running request before its turn could end it. */
  function stopRequested(id: string): boolean { return stopping.has(id); }
  /** Shutdown stopped the executor: finish only releases a claim. */
  function isStopped(): boolean { return stopped; }
  return { pump, finish, retryStart, prepareBackoffCancellation, cancelBackoff, cancelBackoffs, requestStop, stopRequested, isStopped, stop };
}

/** The direct-send route rechecks ownership after this awaited engine call. */
/** A driver's steer answer in the three-state contract (a boolean is the older shape). */
export function steerDelivery(answer: boolean | SteerDelivery): SteerDelivery {
  return answer === true ? "delivered" : answer === false ? "rejected" : answer;
}

/** "uncertain": the engine may still take it, so the caller records it once and never queues a copy.
 * `beforeWrite` is the submission fence, run by the driver right before its write. */
export async function steerBusyDesk(adapter: { capabilities: { queueing?: boolean }; steer?: (threadId: string, text: string, beforeWrite?: () => void, interjectionId?: string) => Promise<boolean | SteerDelivery> } | undefined, threadId: string, text: string, allowed: boolean, beforeWrite?: () => void, interjectionId?: string): Promise<"steer" | "queue" | "uncertain"> {
  if (!allowed || !adapter || cardSteeringMode(adapter) !== "steer") return "queue";
  // steer() carries text only, so a picture folded into a live turn reaches
  // the engine as its `<attached-image path>` tag and nothing else (the bot
  // answers "only its file path"). A message with a picture waits in the
  // queue and runs as its own turn, where the image goes in as an image.
  if (splitTranscriptAttachments(text).images.length) return "queue";
  const delivery = steerDelivery(await adapter.steer!(threadId, text, beforeWrite, interjectionId).catch(() => false as const));
  return delivery === "delivered" ? "steer" : delivery === "uncertain" ? "uncertain" : "queue";
}

export function projectRestartLine(cards: ReadonlyArray<{ name: string; number: number }>): string {
  const names = cards.map(card => `${card.name}'s card ${card.number}`).join(", ");
  return `${names} ${cards.length === 1 ? "was" : "were"} interrupted by a restart. ${cards.length === 1 ? "It waits" : "They wait"} for the owner: Retry step or Skip.`;
}

/** The caller owns the transaction; the routine's assign child is replayable. */
export function queueRoutineCardRun(db: DatabaseSync, request: RoomRequest, now: number, hooks: CompletionHooks) {
  const existing = db.prepare("SELECT id FROM room_requests WHERE parent_id=? AND verb='assign'").get(request.id) as { id: string } | undefined;
  const prior = new Set((db.prepare("SELECT id FROM room_requests WHERE work_item_id=? AND verb='assign'").all(request.workItemId!) as Array<{ id: string }>).map(row => row.id));
  const queued = existing ? { ok: true as const, requestId: existing.id } : enqueueCardRun(db, { cardId: request.workItemId!, actor: { kind: "server" }, now });
  if (queued.ok && queued.requestId && !prior.has(queued.requestId)) {
    db.prepare(`UPDATE room_requests SET parent_id=?, root_id=?, root_thread_id=?, origin=?, audience_fingerprint=?, not_owner_audience=?, unattended=?, execution_audience=?
        WHERE id=? AND state='queued' AND dispatched_at IS NULL`)
      .run(request.id, request.rootId, request.rootThreadId, request.origin, request.audienceFingerprint, request.notOwnerAudience ? 1 : 0, request.unattended ? 1 : 0, request.executionAudience ? JSON.stringify(request.executionAudience) : null, queued.requestId);
  }
  const completion = completeRequest(db, request.id, queued.ok ? { state: "done", now, outcomeNote: "card run queued" }
    : { state: "failed", now, outcomeNote: queued.reason.slice(0, 200) }, hooks);
  return { ...queued, completion };
}

/** Return undefined for refusals owned by the general room queue. */
export function projectCardRefusalLine(db: DatabaseSync, request: RoomRequest, name: string): string | null | undefined {
  if (!isCardRequest(request)) return undefined;
  if (request.refusal === "stagger") return null;
  if (request.refusal === "project_card_cap" || request.refusal === "install_card_cap") return "Waiting for a free slot";
  if (request.refusal === "bot_card_in_project" || request.refusal === "thread_running") {
    const current = db.prepare(`SELECT w.number FROM room_requests r JOIN project_work_items w ON w.id=r.work_item_id
      WHERE r.group_id=? AND r.to_bot_id=? AND r.state IN ('running','waiting_owner') AND r.verb IN ('assign','review','wake') ORDER BY r.created_at,r.id LIMIT 1`).get(request.groupId, request.toBotId);
    if (current) return `${name} is on card ${current.number}`;
  }
  return undefined;
}
