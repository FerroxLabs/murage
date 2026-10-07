// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One admission arbiter (SPEC-P section 7, lane E1).
//
// Every start in a room or project asks this one predicate: a room turn, a
// wake, a card run, a review, a routine request, an ask or message between
// bots, and the owner's direct send (for the reserved owner slot). It is
// generalised from server/handoff-admission.ts, which exists because
// `bot.busy` (the union over all of a bot's threads) refused work a free
// thread could take. A refusal says why in plain words, which the queue and
// the strip show ("Dax is on card 12", "Waiting for the folder").
//
// The arbiter also holds the live claims it admitted, so a bot-level Stop and
// a project's Stop all can enumerate every live turn (`liveTurns`). A claim
// is released from the turn's terminal `finally`; release is idempotent.
//
// Decision order (7.2, first refusal wins): restore_review, autonomy_off,
// project_paused, plan_not_approved, not_reachable, deadlock, dependency,
// root_cap, thread_running, speaking_in_room, bot_thread_ceiling,
// bot_card_in_project, project_card_cap, install_card_cap, writer_root_busy,
// (lane X caps), budget_reached, stagger.
//
// Its in-memory state starts empty at boot: every request that was running
// has been turned `unknown` (room-requests.ts) before anything is admitted.
import { randomUUID } from "node:crypto";

export type AdmissionKind =
  | "owner_direct" | "room_turn" | "wake" | "lead_turn" | "card_run" | "review"
  | "routine" | "delegation" | "ask" | "message";
export type AdmissionPriority = "owner" | "coordinator" | "work";

export interface WriterRoot { canonicalPath: string; dev: string; ino: string }

export type ProjectGoalState = "draft" | "planning" | "awaiting_plan_ok" | "working" | "awaiting_signoff" | "done" | "paused" | "stopped" | "failed";

/** Resolved by the caller from the request row and the project rows before
 * admit(); the arbiter never reads a model-supplied value. */
export interface ProjectContext {
  groupId: string;
  isProject: boolean;
  closed: boolean;
  runState: "running" | "paused";
  /** `conversation` for channels and goal-less projects (6.2 cap applies). */
  mode: "conversation" | "ongoing";
  goalId?: string;
  goalState?: ProjectGoalState;
  leadBotId?: string | null;
  boardOn: boolean;
  parallelCards: number;
  deskArchived?: boolean;
}

/** Lane X (SPEC-P 17.2). E1 copies it and never issues one. */
export type ExecutionAudience =
  | { v: 1; kind: "project"; human: "owner"; projectId: string; rootRequestId: string }
  | { v: 1; kind: "team"; human: "owner"; team: string; rootRequestId: string }
  | { v: 1; kind: "home"; human: "owner"; rootRequestId: string };

export interface AdmissionInput {
  kind: AdmissionKind;
  priority: AdmissionPriority;
  botId: string;
  /** The exact thread the turn will run on. */
  threadId: string;
  /** Any room request carries its group; `isProject=false` for channels. */
  project?: ProjectContext;
  requestId?: string;
  rootId?: string;
  workItemId?: string;
  cardGeneration?: number;
  /** The owner_send this is the lead's one reply to [AMB-5]. */
  ownerReplyTo?: string;
  /** The close-summary wake, which runs while the project is paused for closing. */
  closeSummary?: boolean;
  /** For ask and message: who is asking. */
  fromBotId?: string;
  writerRoot?: WriterRoot;
  ownerOrigin: boolean;
  /** PF deviation from SPEC-P 5.3: an owner-issued assign approves its own card. */
  ownerApprovedCard?: boolean;
  audience: { ownerAudience: boolean; fingerprint: string; execution?: ExecutionAudience };
  now: number;
}

export type RefusalReason =
  | "thread_running" | "speaking_in_room" | "bot_thread_ceiling" | "bot_card_in_project"
  | "project_card_cap" | "install_card_cap" | "writer_root_busy" | "budget_reached"
  | "autonomy_off" | "project_paused" | "plan_not_approved" | "root_cap" | "deadlock"
  | "shared_paused" | "sharing_removed" | "team_deleted" | "binding_mismatch" | "archived"
  | "dependency" | "not_reachable" | "shared_team_cap" | "shared_total_cap" | "restore_review" | "stagger";

export interface AdmissionClaim {
  readonly id: string;
  readonly kind: AdmissionKind;
  readonly botId: string;
  readonly threadId: string;
  readonly groupId?: string;
  readonly requestId?: string;
  readonly cardGeneration?: number;
  /** Per-turn string for TurnResources and internal capabilities (fact 19). */
  readonly turnGeneration: string;
  readonly startedAt: number;
  readonly writerRoot?: WriterRoot;
  release(): void;
}

export type AdmissionDecision =
  | { admit: true; claim: AdmissionClaim }
  | { admit: false; reason: RefusalReason; retry: "queue" | "never"; line: string; retryAt?: number };

export interface BudgetGate {
  check(input: { groupId: string; goalId?: string; kind: AdmissionKind; now: number }):
    { ok: true } | { ok: false; budgetId: string; line: string };
}

/** E1's always-ok gate, only so E1 merges and tests before lane B. The train
 * must not qualify with it: lane B installs the real gate at boot. */
export const PLACEHOLDER_BUDGET_GATE: BudgetGate = Object.freeze({ check: () => ({ ok: false as const, budgetId: "uninstalled", line: "Project budgets are still starting." }) });

export interface WorkAdmission {
  admit(input: AdmissionInput, retryClaim?: AdmissionClaim): AdmissionDecision;
  liveTurns(filter: { botId?: string; groupId?: string }): AdmissionClaim[];
  setBudgetGate(gate: BudgetGate): void;
  budgetGateIsPlaceholder(): boolean;
}

export interface WorkAdmissionDeps {
  /** The install is in restore review (existing automation admission). */
  restoreReview(): boolean;
  flags(): { autonomy: boolean; budgets: boolean; autoWake?: boolean };
  /** A live turn on exactly this thread (direct run, task, or room). */
  threadRunning(botId: string, threadId: string): boolean;
  /** The bot is the speaker of a room turn (speaker lock). */
  speakingInRoom(botId: string): boolean;
  /** Direct (1:1 and task) runs, which the arbiter does not hold itself. */
  directThreads(botId: string): number;
  maxThreads: number;
  installCardCap: number;
  /** The conversation cap's budget for this turn's room thread (6.2). */
  rootCounters(rootId: string, input: AdmissionInput): { wakes: number; workMs: number };
  askWouldDeadlock(fromBotId: string, toBotId: string): boolean;
  /** Membership, canReach/messageAllow, contact-bound threads, archived desks. */
  reachable(input: AdmissionInput): boolean;
  authorize?(input: AdmissionInput): { ok: true } | { ok: false; reason: RefusalReason; retryable: boolean };
  dependencyOpen(workItemId: string): boolean;
  /** Take the root's writer claim now; the release, or null when held. */
  claimWriterRoot(root: WriterRoot, owner: { botId: string; threadId: string; turnGeneration: string }, previous?: { botId: string; threadId: string; turnGeneration: string }): (() => void) | null;
  botName?(botId: string): string;
  now(): number;
}

/** Conversation cap (6.2, plan 3.2). */
export const ROOT_CAP_WAKES = 6;
export const ROOT_CAP_WORK_MS = 30 * 60_000;
/** Card starts are staggered install-wide (plan 3.3 E2b). */
export const CARD_STAGGER_MS = 2_000;

const AUTONOMOUS_KINDS: ReadonlySet<AdmissionKind> = new Set(["wake", "card_run", "review", "lead_turn", "routine"]);
const CARD_KINDS: ReadonlySet<AdmissionKind> = new Set(["card_run", "review"]);
const ROOT_CAPPED_KINDS: ReadonlySet<AdmissionKind> = new Set(["wake", "card_run", "review", "ask"]);

export function createWorkAdmission(deps: WorkAdmissionDeps): WorkAdmission {
  const claims = new Map<string, AdmissionClaim>();
  let budgetGate: BudgetGate = PLACEHOLDER_BUDGET_GATE;
  let lastCardStart = Number.NEGATIVE_INFINITY;
  const name = (botId: string) => deps.botName?.(botId) ?? botId;
  const refuse = (reason: RefusalReason, line: string, retry: "queue" | "never" = "queue"): AdmissionDecision =>
    ({ admit: false, reason, retry, line });
  const live = (filter: (claim: AdmissionClaim) => boolean) => [...claims.values()].filter(filter);

  function admit(input: AdmissionInput, retryClaim?: AdmissionClaim): AdmissionDecision {
    // Retry retains its reservation until all gates pass. Only that exact
    // request may replace it; a new card still counts every held slot.
    const reservation = retryClaim && claims.get(retryClaim.id) === retryClaim && retryClaim.requestId !== undefined && retryClaim.requestId === input.requestId
      && retryClaim.kind === input.kind && retryClaim.groupId === input.project?.groupId && retryClaim.cardGeneration === input.cardGeneration
      && retryClaim.botId === input.botId && retryClaim.threadId === input.threadId ? retryClaim : undefined;
    const live = (filter: (claim: AdmissionClaim) => boolean) => [...claims.values()].filter(claim => claim !== reservation && filter(claim));
    const project = input.project;
    const ownerDirect = input.kind === "owner_direct";
    const ownerReply = Boolean(input.ownerReplyTo) && (input.kind === "room_turn" || input.kind === "lead_turn");
    // 1. restore review
    if (!ownerDirect && deps.restoreReview()) return refuse("restore_review", "Waiting for you to finish checking the restore");
    // 2. autonomy (budgets off forces it off, SPEC-P 14)
    const flags = deps.flags();
    if (flags.budgets && budgetGate === PLACEHOLDER_BUDGET_GATE) return refuse("budget_reached", "Project budgets are still starting.");
    if (AUTONOMOUS_KINDS.has(input.kind) && !ownerReply && !input.closeSummary && (!flags.autonomy || !flags.budgets)) {
      return refuse("autonomy_off", "Projects work on their own is off");
    }
    // projects.autoWake off: results still post, but wake nobody (SPEC-P 14)
    if (input.kind === "wake" && !input.closeSummary && flags.autoWake === false) return refuse("autonomy_off", "Waking is off");
    // 3. project paused (and the goal dispatch gate, 5.3)
    if (project?.isProject && AUTONOMOUS_KINDS.has(input.kind) && !ownerReply && !input.closeSummary) {
      const goalStopped = input.project?.goalId && (project.goalState === "paused" || project.goalState === "stopped" || project.goalState === "failed");
      const leadOff = (input.kind === "wake" || input.kind === "lead_turn") && !project.leadBotId;
      const boardOff = input.kind === "card_run" && !project.boardOn;
      if (project.closed || project.runState === "paused" || project.deskArchived || goalStopped || leadOff || boardOff) {
        return refuse("project_paused", "Paused");
      }
    }
    // 4. plan not approved
    if (input.kind === "card_run" && !input.ownerApprovedCard && project?.goalId && (project.goalState === "awaiting_plan_ok" || project.goalState === "planning")) {
      return refuse("plan_not_approved", project.goalState === "planning" ? `Waiting for ${project.leadBotId ? name(project.leadBotId) : "the lead"}'s plan` : "Waiting for your OK on the plan");
    }
    // 3a. reach, 3b. deadlock
    const authorized = deps.authorize?.(input);
    if (authorized && !authorized.ok) return refuse(authorized.reason, `${name(input.botId)} cannot be reached from here`, authorized.retryable ? "queue" : "never");
    if (!deps.authorize && !ownerDirect && !deps.reachable(input)) return refuse("not_reachable", `${name(input.botId)} cannot be reached from here`, "never");
    if (input.kind === "ask" && input.fromBotId && deps.askWouldDeadlock(input.fromBotId, input.botId)) {
      return refuse("deadlock", `${name(input.botId)} is already waiting on you, so answer him first.`, "never");
    }
    // 4a. dependency
    if (input.kind === "card_run" && input.workItemId && deps.dependencyOpen(input.workItemId)) {
      return refuse("dependency", "Waiting for another card");
    }
    // 5. conversation cap: no active goal and not ongoing
    const conversation = !project || (project.mode === "conversation" && !(project.goalId && project.goalState && !["done", "stopped", "failed", "draft"].includes(project.goalState)));
    if (conversation && ROOT_CAPPED_KINDS.has(input.kind) && input.rootId && !input.closeSummary) {
      const counters = deps.rootCounters(input.rootId, input);
      if (counters.wakes >= ROOT_CAP_WAKES || counters.workMs >= ROOT_CAP_WORK_MS) {
        // stays queued behind the owner's next message, whose budget it then
        // runs under (6.2)
        return refuse("root_cap", `Paused: ${ROOT_CAP_WAKES} team steps since your last message. Say continue.`);
      }
    }
    // 6. that exact thread
    if (deps.threadRunning(input.botId, input.threadId) || live((claim) => claim.threadId === input.threadId && claim.botId === input.botId).length) {
      return refuse("thread_running", `${name(input.botId)} is already working here`);
    }
    // 7. speaker lock
    const roomKind = input.kind === "room_turn" || input.kind === "wake" || input.kind === "lead_turn";
    if (roomKind && (deps.speakingInRoom(input.botId) || live((claim) => claim.botId === input.botId && (claim.kind === "room_turn" || claim.kind === "wake" || claim.kind === "lead_turn")).length)) {
      return refuse("speaking_in_room", `${name(input.botId)} is answering in another room`);
    }
    // 8. thread ceiling (owner first: one reserved slot above it) [AMB-6]
    const held = live((claim) => claim.botId === input.botId && claim.kind !== "owner_direct");
    const used = deps.directThreads(input.botId) + held.length;
    if (used >= deps.maxThreads) {
      const reservedFree = !live((claim) => claim.botId === input.botId && claim.kind === "owner_direct").length;
      if (!(ownerDirect && input.ownerOrigin && reservedFree && used < deps.maxThreads + 1)) {
        return refuse("bot_thread_ceiling", `${name(input.botId)} is busy in another conversation`);
      }
    }
    // 9-11. card caps (coordinator kinds never take a card slot)
    let groupCards = 0;
    if (CARD_KINDS.has(input.kind) && !reservation) {
      const groupId = project?.groupId;
      if (live((claim) => CARD_KINDS.has(claim.kind) && claim.botId === input.botId && claim.groupId === groupId).length) {
        return refuse("bot_card_in_project", `${name(input.botId)} is on another card`);
      }
      groupCards = live((claim) => claim.kind === "card_run" && claim.groupId === groupId).length;
      if (input.kind === "card_run" && groupCards >= Math.max(1, project?.parallelCards ?? 1)) {
        return refuse("project_card_cap", "Waiting for a free slot");
      }
      if (input.kind === "card_run" && live((claim) => claim.kind === "card_run").length >= deps.installCardCap) {
        return refuse("install_card_cap", "Waiting for a free slot");
      }
    }
    // 14. budget: everything but the owner and the lead's one reply
    if (!ownerDirect && !ownerReply && !(input.kind === "room_turn" && input.priority === "owner") && project) {
      const verdict = budgetGate.check({ groupId: project.groupId, goalId: project.goalId, kind: input.kind, now: input.now });
      if (!verdict.ok) return refuse("budget_reached", verdict.line);
    }
    // 15. stagger
    if (input.kind === "card_run" && input.now - lastCardStart < CARD_STAGGER_MS) return { admit: false, reason: "stagger", retry: "queue", line: "Starting shortly", retryAt: lastCardStart + CARD_STAGGER_MS };
    // 12. writer root, taken last so no refusal after it can strand the claim
    // Keep the reservation until writer acquisition or transfer succeeds.
    const turnGeneration = randomUUID();
    let releaseRoot: (() => void) | null = null;
    let writerRoot: WriterRoot | undefined;
    if (input.writerRoot) {
      releaseRoot = deps.claimWriterRoot(input.writerRoot, { botId: input.botId, threadId: input.threadId, turnGeneration }, reservation);
      if (releaseRoot) writerRoot = input.writerRoot;
      // a project room turn runs outside the root while a writer holds it (5.4a)
      else if (!roomKind) return refuse("writer_root_busy", "Waiting for the folder");
    }
    reservation?.release();
    if (input.kind === "card_run") lastCardStart = input.now;
    const id = randomUUID();
    let released = false;
    const claim: AdmissionClaim = Object.freeze({
      id,
      kind: input.kind,
      botId: input.botId,
      threadId: input.threadId,
      ...(project ? { groupId: project.groupId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.cardGeneration !== undefined ? { cardGeneration: input.cardGeneration } : {}),
      turnGeneration,
      startedAt: input.now,
      ...(writerRoot ? { writerRoot } : {}),
      release: () => {
        if (released) return;
        released = true;
        claims.delete(id);
        releaseRoot?.();
      },
    });
    claims.set(id, claim);
    return { admit: true, claim };
  }

  return {
    admit,
    liveTurns: (filter) => live((claim) => (!filter.botId || claim.botId === filter.botId) && (!filter.groupId || claim.groupId === filter.groupId)),
    setBudgetGate: (gate) => { budgetGate = gate; },
    budgetGateIsPlaceholder: () => budgetGate === PLACEHOLDER_BUDGET_GATE,
  };
}
