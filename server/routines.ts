import { REQUIRED_MCP_SERVERS, startsWithNotDone, toolsUnavailableRunError } from "./drivers/mcp-readiness.ts";
import { readOwnerTimeZone, nextOwnerDailyOccurrence } from "./cloud-home/timezone.ts";
import { assertHumanPrincipal, type HumanPrincipal } from "./human-principals.ts";
import { ROUTINE_INSTRUCTIONS_MAX, routineInstructionsTooLongMessage } from "../shared/routine-instructions.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { awaitWriterGate, isDatabaseBusy, writersHeldForIndexBuild } from "./database.ts";

import { DATA_DIR } from "./config.ts";
import { rateLimited } from "./observe.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { cancelCoalesced, flushCoalesced, scheduleCoalesced, writeFileAtomic } from "./atomic.ts";
import { RoutineRunsJournal, routinesCommit } from "./routine-runs-journal.ts";
import { isTracked, plainCopy, track, untracked } from "./tracked-state.ts";
import { PersistedStateRecoveryError, readPersistedJson } from "./persisted-state.ts";
import { redactSecretsInText } from "./redact.ts";
import { fenceEmailDerived } from "./email/external-marks.ts";
import { CLOUD_ROUTINE_NOT_YET, PROJECT_CLOSED_COPY, type RoutineRunCardData } from "../shared/routine-run.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import { channelOriginSchema, routineEventForRun, type ChannelOrigin, type RoutineEvent } from "../shared/routine-event.ts";
import type { RoutineWatchBinding, RoutineWatchInput, RoutineWatchObservation, RoutineWatchRun, RoutineWatchSource } from "../shared/routine-watch.ts";
import { completeRoutineWatchCheck, createRoutineWatchState, pauseRoutineWatch, reserveRoutineWatchCheck } from "./routine-watch-state.ts";
import { readRoutineWatchBinding, routineWatchInputSchema } from "./routine-watch-integration.ts";
import { turnAskStopped, turnStopped, turnSucceeded } from "./turn-outcome.ts";
import { ASK_STOP_NOTE } from "./drivers/ask-stop.ts";
import { isUnseenRoutineProblem } from "../shared/routine-problems.ts";
import { ROUTINE_RUN_ON, ROUTINE_RUN_STATUSES, ROUTINE_RUN_TRIGGERS, ROUTINE_TARGETS } from "../shared/record-values.ts";
import { ROUTINE_GRANTS_MAX, isRoutineGrantKey, loadRoutinePermissionMode, routineGrantKeys, routinePermissionModeInput, type RoutinePermissionMode } from "./routine-permissions.ts";
import { durableGrantAllowed } from "../shared/durable-grant-allowed.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "interval"; everyMinutes: number; anchorAt: number }
  /** 1.0.4 SL-I I3: runs once, five minutes after the named engine's limit resets (limit-state.json). */
  | { type: "limit_reset"; engineKey: string };

/** 1.0.4 SL-I I3: when the named engine's limit resets, read from limit-state.json (never kept in memory). Set by the host. */
let limitResetReader: (engineKey: string) => number | null = () => null;
export function setLimitResetReader(reader: (engineKey: string) => number | null): void { limitResetReader = reader; }
export const LIMIT_RESET_DELAY_MS = 5 * 60_000;
/** A routine run waits for a limit at most this many refusals; the next one fails it. */
export const LIMIT_WAIT_TRIES = 3;
export const LIMIT_WAIT_SPREAD_MS = 60_000;
/** 1.0.4 SL-I I3: a routine run that met its engine's limit before doing anything waits in `queued` for the reset. */
export interface RoutineLimitWait { engineKey: string; until: number; n: number }
export interface RoutineLimitRefusal { engineKey: string; until: number; engineName: string; line: string; failLine: string }

/** `cloud` runs the agent itself inside the bot's Box VM. `ember` keeps
 * using the provider selected on the EMBER and only borrows its configured
 * computer tools, if any. */
export type RoutineRunOn = typeof ROUTINE_RUN_ON[number];
export type RoutineTarget = typeof ROUTINE_TARGETS[number];
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

const persistedSourceThreadId = z.string().trim().min(1).optional().catch(undefined);

/** Declared in shared/record-values.ts, which the backup reads too. */
export type RoutineRunTrigger = typeof ROUTINE_RUN_TRIGGERS[number];

/** Declared in shared/record-values.ts, which the backup reads too.
 * "needs-you": the run limit came while a card was waiting on the owner. The
 * turn stays open on that card with its clock stopped; answering it resumes
 * the same run with a fresh run limit. Still active: it holds the routine's
 * next occurrences back, and Cancel run ends it. */
export type RoutineRunStatus = typeof ROUTINE_RUN_STATUSES[number];

/** A run with a live turn (working, or waiting on a person). */
const LIVE_RUN_STATUSES: readonly RoutineRunStatus[] = ["running", "waiting", "needs-you"];
/** A run that is not settled yet. */
const OPEN_RUN_STATUSES: readonly RoutineRunStatus[] = ["queued", ...LIVE_RUN_STATUSES];
/** What a locked messages.db says (DatabaseBusyError's sentence, or SQLite's own): never a reason to fail a run. */
const BUSY_MESSAGE = /Busy for a moment, try again|database is locked|SQLITE_BUSY/i;
const isLive = (status: RoutineRunStatus) => LIVE_RUN_STATUSES.includes(status);
const isOpen = (status: RoutineRunStatus) => OPEN_RUN_STATUSES.includes(status);
/** Queued, running, waiting, or waiting on you: not settled yet. */
export const isOpenRoutineRunStatus = (status: RoutineRunStatus): boolean => isOpen(status);
/** Running, waiting, or waiting on you: the run owns a live turn. */
export const isLiveRoutineRunStatus = (status: RoutineRunStatus): boolean => isLive(status);
/** The one line a routine's chat gets when a run completes after a failed one, so the failure is not its newest word. */
export const routineRecoveredLine = (routineName: string): string => `Recovered: ${routineName.trim().slice(0, 120) || "this routine"} finished OK.`;

/** The untouched routines.json from before routine ceilings were pinned. */
export function routinesPrePinFile(routinesFile: string): string {
  return join(dirname(routinesFile), "events", "routines.json.pre-pin");
}

export function routineRunCard(run: RoutineRun): RoutineRunCardData {
  const visibleSummary = run.status === "waiting" ? run.attention
    : run.status === "needs-you" ? `Waiting on you: ${run.attention ?? "an approval"}. Answer it in the routine's conversation to let this run finish.`
    : run.output;
  const summary = visibleSummary ? redactSecretsInText(visibleSummary).slice(0, 2_000) : undefined;
  const error = run.error ? redactSecretsInText(run.error).slice(0, 500) : undefined;
  const card: RoutineRunCardData = {
    runId: run.id,
    routineId: run.routineId,
    routineName: redactSecretsInText(run.routineName),
    status: run.status,
  };
  if (run.goalStatus) card.goalStatus = run.goalStatus;
  if (run.threadId) card.executionThreadId = run.threadId;
  if (summary) card.summary = summary;
  if (error) card.error = error;
  return card;
}

export interface RoutineInstructionRevision {
  id: string;
  prompt: string;
  parentId?: string;
  author: "owner" | "learned" | "rollback";
  createdAt: number;
  evaluationReceiptId?: string;
  evidence?: Array<{ kind: "source" | "record"; id: string; revision: number; scopeId: string }>;
  rollbackOf?: string;
}

export interface RoutineInstructionPromotion {
  expectedRevision: string;
  expectedUpdatedAt: number;
  prompt: string;
  evaluationReceiptId: string;
  evidence: Array<{ kind: "source" | "record"; id: string; revision: number; scopeId: string }>;
}

export interface Routine {
  watch?: RoutineWatchBinding;
  id: string;
  name: string;
  prompt: string;
  instructionRevision?: string;
  instructionHistory?: RoutineInstructionRevision[];
  target: RoutineTarget;
  /** A bot routine's owner, or the lead coordinator for a room goal. */
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  /** Legacy calendar/display length. Kept for persisted-data compatibility. */
  durationMinutes: number;
  /** Optional safety cap for active work. Missing means no timeout. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  /** What a scheduled occurrence does while this routine's previous run is
   * still queued, running or waiting (upstream #1564, e7e20663). Absent means
   * skip, which older files already did. "queue" keeps at most ONE scheduled
   * run waiting behind it; further occurrences are skipped until it starts.
   * Manual, webhook and channel runs are separate requests either way. */
  overlap?: "skip" | "queue";
  /** Set once, when a repeating bot routine is created in the editor or by a
   * confirmed chat proposal: each run then starts with the last run's report as
   * reference. Absent means off (routines made before this never change). There
   * is no control to turn it off; see routineCarry(). */
  carryLastReport?: true;
  /** The stored approval ceiling for scheduled and manual runs. The bot's
   * current level can lower it (server/routine-permissions.ts). Older files
   * receive a ceiling on load. */
  permissionMode?: RoutinePermissionMode;
  /** "Always allow for this routine": exact-command and stop-line keys the
   * owner allowed from a card in one of this routine's runs. Only granted
   * through the desktop from a pending card, removable in the editor, and
   * never a bare tool name. Absent means none. */
  alwaysAllow?: string[];
  /** The routine's own conversation: every scheduled and manual run of a
   * bot routine works in this one task, one run after another, instead of a
   * new task per run. Set by the scheduler at the first run (and again if
   * that conversation was deleted); never written by an edit. Older routines
   * have none until their next run, and their per-run tasks stay as they are. */
  threadId?: string;
  /** How many scheduled occurrences were skipped because a run was still
   * active, and when the last one was due. Absent means none. */
  skippedRuns?: number;
  lastSkippedAt?: number;
  /** Consecutive failed runs, newest first, up to the last completed one.
   * Derived from the retained run receipts on every read and never saved,
   * so it cannot disagree with the history it summarises. */
  failureStreak?: number;
  /** Conversation that created this routine in chat. Calendar/import-created
   * routines intentionally have no source, and older files migrate in place. */
  sourceThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The most history lines one run keeps. */
const RUN_NOTES_MAX = 20;

export interface RoutineRun {
  watch?: RoutineWatchRun;
  event?: RoutineEvent;
  eventBudget?: EventActionBudget;
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot the work so an edited/deleted definition cannot rewrite history. */
  prompt?: string;
  instructionRevision?: string;
  instructionEvidence?: RoutineInstructionRevision["evidence"];
  instructionEvaluationReceiptId?: string;
  /** The skills-and-instruction bundle this run's first turn pinned. Runs
   * share their routine's one conversation, which carries only the latest
   * run's pin; this keeps what each run used. */
  procedureBundleId?: string;
  /** Snapshot of the legacy calendar/display length. */
  durationMinutes?: number;
  /** Snapshot of the optional active-work safety cap. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  /** Exact terminal room outcome. `status` remains the scheduler lifecycle
   * while this preserves blocked/needs-input/limit semantics and closes the
   * cross-file crash-recovery gap with the room's goal card. */
  goalStatus?: RoutineGoalStatus;
  /** Snapshot the room as well as the coordinator so edited definitions do
   * not redirect already-queued team work. */
  groupId?: string;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  telegramConnectionId?: string;
  channelOrigin?: ChannelOrigin;
  humanPrincipal?: HumanPrincipal;
  /** Server-owned: the audience of this channel run is not the owner (a WhatsApp group). Carried into startTurn as defence beside the guest principal. */
  notOwnerAudience?: true;
  deliveryId?: string;
  /** Webhook runs: the event's name, written with the run (bot calls 1.0.9 derive the webhook.event fact from it, so a
   * crash after the save loses no call: the boot re-scan reads it back). */
  webhookEventType?: string;
  /** Snapshot the routine's reporting destination. Execution remains on the
   * separate `threadId` so recurring work never contaminates chat context. */
  sourceThreadId?: string;
  threadId?: string;
  /** Provider identity for a Telegram turn in a reused conversation. */
  channelTurnId?: string;
  startedAt?: number;
  /** When this run was due to start: its due time, plus its own place in the dispatch spread
   *  (dispatchStaggerMs) for an on-time scheduled run. Lateness is startedAt - slotAt. */
  slotAt?: number;
  /** When this occurrence was first due, recorded when it was scheduled and never moved: lateness and queue age are
   *  measured from it, though a queued interval run is later aligned to its newest occurrence (scheduledFor). */
  dueAt?: number;
  /** How many times this queued interval run was moved on to a newer occurrence while it waited. */
  coalescedOccurrences?: number;
  /** When the owner answered a card this run was waiting on after its run
   * limit; the limit counts again from here. */
  resumedAt?: number;
  /** When this run last became "needs-you" (bot calls 1.0.9): the boot re-scan replays the needs-you fact at THIS instant,
   * not the run's start, so a long run's fresh needs-you is neither late nor refused by a rule edited since the start. */
  needsYouAt?: number;
  /** SL-L L4: the run's INITIAL turn is waiting for a busy working folder,
   * computer or browser (its first seat). Status stays "running". While set
   * with no grant and no resume the run limit is not enforced, and a restart
   * puts the run back in the queue instead of failing it. */
  seatWait?: { kind: string; at: number };
  /** SL-L L4: when that first seat was granted; the run limit counts from here. */
  seatGrantedAt?: number;
  /** 1.0.4 SL-I I3: queued again after its engine's limit refused it before any work; dispatched at `until`. */
  limitWait?: RoutineLimitWait;
  /** The harness's own cards open in this run (this computer's one-time
   * consent, a paid image, a bot-to-bot contact), by requestId. They are held
   * open in a scheduled or manual run, like permission cards. */
  cardsOpen?: string[];
  /** The run's turn ended while one of those cards was still open: the run
   * is waiting on you, and answering the card starts a new turn in it. */
  turnEnded?: boolean;
  finishedAt?: number;
  output?: string;
  /** Human-readable reason the detached execution is waiting. */
  attention?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  /** Plain lines for this run's history, such as a command the routine
   * carve-out let through (server/routine-permissions.ts). */
  notes?: string[];
  /** How many more such lines this run had: a repeat of a line above, or
   * one past RUN_NOTES_MAX. Every one is counted, none is dropped silently. */
  notesMore?: number;
  /** Degraded availability, kept apart from the outcome: required tools
   * ("connected apps", "memory") that had not loaded when the run's turn
   * started. The run still completes when its task did not need them. */
  toolsUnavailable?: string[];
  /** "unknown": the engine could not say whether those tools were up. */
  toolsReadiness?: "unknown";
  createdAt: number;
  seenAt?: number;
}

/** Which required tool family a tool call belongs to (by its server name in
 * the engine's tool id), as the plain label the drivers report. */
export function requiredToolLabelOf(event: { title?: string; toolIdentity?: { namespace?: string; name?: string } }): string | null {
  const text = `${event.toolIdentity?.namespace ?? ""} ${event.toolIdentity?.name ?? ""} ${event.title ?? ""}`;
  for (const [server, label] of Object.entries(REQUIRED_MCP_SERVERS)) {
    const escaped = server.replace(/[-]/g, "[-_]");
    if (new RegExp(`(^|[^a-z0-9])${escaped}(__|[^a-z0-9_-]|$)`, "i").test(text)) return label;
  }
  return /\b(?:COMPOSIO|APPS)_[A-Z0-9_]+\b/.test(text) ? REQUIRED_MCP_SERVERS.murage_connectors! : null;
}

/** How many creates / hand-offs one event-started run may do before the owner is asked. */
export const EVENT_BASE_LIMIT = 4;
/** What one owner "Allow" adds to a run's limit. */
export const EVENT_EXTENSION = 4;
/** Where a run the owner's Full access already covers starts (before any card). */
export const EVENT_FULL_ACCESS_LIMIT = 16;
/** The most hand-offs or new bots one run can ever do, however many times the owner allows more. */
export const EVENT_MAX_LIMIT = 64;
/** Why a run's ledger was closed, so the bot can be told the true reason. */
export type EventBudgetClosedReason = "connection" | "stopped" | "watch";
export interface EventActionBudget {
  /** 2: limits are per run and can be raised; version 1 stored a fixed 4 and 4. */
  version: 2;
  limits: { create: number; handoff: number };
  /** `receipt` is what the admitted action actually produced (the delegation id, the new bot's id), so the same action asked again returns it instead of doing the work twice. */
  admissions: Array<{ id: string; kind: "create" | "handoff"; receipt?: string }>;
  /** Kinds the owner answered "Not now" to: no more actions of that kind in this run, and no further cards for it. */
  declined?: Array<"create" | "handoff">;
  closed: boolean;
  closedReason?: EventBudgetClosedReason;
}
export type EventAdmission =
  | { ok: true }
  | { ok: false; reason: "limit"; kind: "create" | "handoff"; used: number; limit: number }
  | { ok: false; reason: "closed"; closedReason?: EventBudgetClosedReason }
  | { ok: false; reason: "unavailable" };
const eventAdmissionId = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const eventAdmissionList = z.array(z.object({ id: eventAdmissionId, kind: z.enum(["create", "handoff"]), receipt: z.string().min(1).max(200).optional() }).strict());
// Older runs stored the declined request keys ("handoff:<hash>"); they load as the kind they belonged to.
const eventDeclinedList = z.array(z.string().min(1).max(200)).max(EVENT_MAX_LIMIT * 2);
function declinedKinds(marks: string[]): Array<"create" | "handoff"> {
  const kinds = new Set<"create" | "handoff">();
  for (const mark of marks) { if (mark.startsWith("handoff")) kinds.add("handoff"); else if (mark.startsWith("create")) kinds.add("create"); }
  return [...kinds];
}
const uniqueAdmissions = (value: { admissions: Array<{ id: string; kind: string }> }) => new Set(value.admissions.map(item => item.id)).size === value.admissions.length;
const eventActionBudgetV1 = z.object({
  version: z.literal(1), limits: z.object({ create: z.literal(4), handoff: z.literal(4) }).strict(),
  admissions: eventAdmissionList.max(8), closed: z.boolean(),
}).strict().refine(value => uniqueAdmissions(value)
  && value.admissions.filter(item => item.kind === "create").length <= 4 && value.admissions.filter(item => item.kind === "handoff").length <= 4)
  .transform((value): EventActionBudget => ({ ...value, version: 2 }));
const eventActionBudgetV2 = z.object({
  version: z.literal(2),
  limits: z.object({ create: z.number().int().min(EVENT_BASE_LIMIT).max(EVENT_MAX_LIMIT), handoff: z.number().int().min(EVENT_BASE_LIMIT).max(EVENT_MAX_LIMIT) }).strict(),
  admissions: eventAdmissionList.max(EVENT_MAX_LIMIT * 2), declined: eventDeclinedList.optional(), closed: z.boolean(),
  closedReason: z.enum(["connection", "stopped", "watch"]).optional(),
}).strict().refine(value => uniqueAdmissions(value)
  && value.admissions.filter(item => item.kind === "create").length <= value.limits.create
  && value.admissions.filter(item => item.kind === "handoff").length <= value.limits.handoff)
  .transform((value): EventActionBudget => {
    const { declined, ...rest } = value;
    const kinds = declined ? declinedKinds(declined) : [];
    return { ...rest, ...(kinds.length ? { declined: kinds } : {}) };
  });
/** Stored runs migrate here: a version 1 ledger loads as version 2 with the same counts. */
const eventActionBudgetSchema = z.union([eventActionBudgetV1, eventActionBudgetV2]);
function newEventActionBudget(): EventActionBudget { return { version: 2, limits: { create: EVENT_BASE_LIMIT, handoff: EVENT_BASE_LIMIT }, admissions: [], closed: false }; }

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  /** SHA-256 of the strict normalized operation carried by the card. */
  fingerprint: string;
  /** Absent while the change is being applied: SL-J J2 writes the receipt
   * (with `before`) BEFORE the change, then adds these once it is applied. */
  resultId?: string;
  appliedAt?: number;
  /** "webhook" for a webhook card; absent for a routine. */
  kind?: "webhook";
  /** The reversible configuration before the change, which Undo restores
   * exactly. `null` for delete and run now (no Undo); absent on receipts
   * written before 1.0.4 (no Undo either). Validated when Undo reads it. */
  before?: AutomationUndoBefore | null;
  /** The record's `updatedAt` the card was prepared against. */
  expectedUpdatedAt?: number;
  /** The record's `updatedAt` right after the change: Undo applies only while it still matches. */
  appliedUpdatedAt?: number;
  /** When Undo restored `before`. */
  undoneAt?: number;
}

/** What Undo restores. `absent` means the change created the record. */
export type AutomationUndoBefore =
  | { absent: true }
  | {
      name: string;
      prompt: string;
      schedule: RoutineSchedule;
      overlap: "skip" | "queue";
      timeoutMinutes: number | null;
      enabled: boolean;
    }
  | { name: string; prompt: string; eventTypes: string[]; enabled: boolean };

/** Written with the receipt before the change is applied. */
export interface RoutineRequestIntent {
  kind?: "webhook";
  before: AutomationUndoBefore | null;
  expectedUpdatedAt?: number;
}

export interface RoutineRequestCommit {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
}

type RoutineRequestCommitFor<Action extends RoutineRequestOperation["action"]> =
  Omit<RoutineRequestCommit, "action"> & { action: Action };

export interface RoutineInput {
  watch?: RoutineWatchInput;
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  /** `null` deliberately clears a room when changing the target back to a bot. */
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
  /** `null` deliberately removes an existing safety cap. */
  timeoutMinutes?: number | null;
  attachments?: RoutineContextAttachment[];
  overlap?: "skip" | "queue";
  /** Creation only (editor and confirmed chat proposal): see Routine.carryLastReport. An update never changes it. */
  carryLastReport?: boolean;
  /** A ceiling, or `inherit` / null to pin the bot's current level. */
  permissionMode?: RoutinePermissionMode | "inherit" | null;
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
  /** Empty since 0.1.62 (kept so 0.1.61 still reads and restores the file):
   * runs live in events/routine-runs/. Read only to migrate. */
  runs?: RoutineRun[];
  /** The journal commit this file records (routine-runs-journal.ts). */
  runsCommit?: number;
  /** Renewed by every full write: routine state lines written against it apply on top (routine-runs-journal.ts). */
  stateGeneration?: string;
  /** Durable commit receipts for cross-file confirmation recovery. */
  routineRequestReceipts?: RoutineRequestReceipt[];
}

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export interface RoutineManagerOptions {
  /** The bot's current level when a routine's ceiling is pinned. */
  botMode?: (botId: string) => RoutinePermissionMode | undefined;
  /** Host evaluator must validate the retained receipt, exact candidate and current source authority. */
  validateInstructionPromotion?: (routine: Readonly<Routine>, proposal: Readonly<RoutineInstructionPromotion>) => boolean;
  validateInstructionEvidence?: (context: Pick<Routine, "botId" | "groupId" | "target">, evidence: NonNullable<RoutineInstructionRevision["evidence"]>) => boolean;
  /** New channel adapters must prove their exact binding/Chief at admission and dispatch. */
  isChannelCurrent?: (origin: ChannelOrigin, botId: string) => boolean;
  validateWatchSource?: (ownerBotId: string, botId: string, source: RoutineWatchSource) => void;
  readWatchSource?: (ownerBotId: string, botId: string, source: RoutineWatchSource, signal: AbortSignal) => Promise<RoutineWatchObservation>;
  /** Admission only: never interrupts active work or blocks manual/channel requests. */
  automaticPaused?: () => boolean;
  /** Until this answers true a tick does nothing at all: the host is still creating the state a dispatch reads
   * (server/index.ts opens it as its last step, right before start()). Work that arrives meanwhile is kept, queued,
   * for the first tick after. Absent: always open. */
  dispatchOpen?: () => boolean;
  /** Startup gate: true once the connected-apps inventory has loaded and the
   * MCP mounts have settled. Scheduled runs (including catch-up runs for
   * occurrences missed while the app was closed) wait for it, bounded by
   * `startupWaitMs`, then run anyway with a note in their prompt. */
  startupReady?: () => boolean | Promise<boolean>;
  /** Longest a scheduled run waits for `startupReady` after start(). */
  startupWaitMs?: number;
  /** Gap between two catch-up runs, so they never start at the same instant. */
  catchUpStaggerMs?: number;
  /** Spread on-time scheduled runs over this window (F19, A21): each routine starts at its own fixed offset
   * after its due time (a hash of its id), so sixty routines due at 9:00 do not all start in one tick. The run
   * is queued and saved at its due time as before; only its start waits. 0 or absent: no spread. */
  dispatchStaggerMs?: number;
  /** Install-wide cap on automatic runs (schedule and webhook) running at once, across every bot. A due run
   * over the cap stays queued, in order, until one finishes. Absent: no cap (each bot's three threads only). */
  maxConcurrentAutomaticRuns?: number;
  /** The most the cap above may grow to when measured service time says it must (automaticRunCap). Absent: it never grows. */
  automaticCapCeiling?: number;
  /** Owner first (owner-first.ts): false while the owner's own work should go first. An automatic run then
   * stays queued for a later tick; the gate admits it at its bound. `waitedMs` is how long this run has been
   * held back at the cap or the gate, on a monotonic clock (0 the first time it is asked). */
  admitAutomatic?: (run: Readonly<RoutineRun>, waitedMs: number) => boolean;
  /** A run is starting (1.0.2 bgwork): held from its dispatch until startTurn/startGoal has returned, so
   * background work yields between a due run and its engine start (owner-first.ts beginStart). */
  beginStart?: () => () => void;
  /** Project routine work still queued or running in project rooms (room_requests): it counts against
   * maxConcurrentAutomaticRuns like a running automatic run. */
  activeProjectRoutineRuns?: () => number;
  /** An automatic run held back this long (cap or owner-first gate) gets past the cap, up to twice the cap
   * (aging: never starved behind newer runs). Default 120 s, the owner-first gate's own bound. */
  automaticAgingMs?: number;
  /** A monotonic clock for the waits above (default performance.now; tests pass their own). */
  monotonicNow?: () => number;
  /** Whether the reply a run left in the routine's own conversation can still be carried into the next run: the newest bot
   * text row of that conversation written between `from` and `to` is present, was captured, is not forgotten, and the
   * conversation was not deleted (server/routine-carry.ts). Absent: nothing is ever carried. */
  priorReplyCarryable?: (threadId: string, from: number, to: number) => boolean;
  /** Bot email (5.4): the reply the report came from was written after reading outside mail; the report is handed on fenced. */
  priorReplyEmailDerived?: (threadId: string, from: number, to: number) => boolean;
  /** Step 0 check for a scheduled bot run: true while this bot should have
   * connected-app tools and they have not registered. The run is deferred
   * (see CONNECTOR_DEFER_DELAYS_MS) instead of running without them. */
  connectorsMissing?: (botId: string) => boolean | Promise<boolean>;
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** A shared channel conversation can be busy with other work while its bot
   * still has a free thread slot; its next message waits for the conversation. */
  threadBusy?: (botId: string, threadId: string) => boolean;
  goalState?: (groupId: string, coordinatorBotId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  /** Does this bot still have this conversation? A routine's own
   * conversation is reused only while it does. Without it, every run gets a
   * new task as before. */
  taskExists?: (botId: string, threadId: string) => boolean;
  /** Whether a room task (a room goal's thread) still exists in its room. */
  goalTaskExists?: (groupId: string, threadId: string) => boolean;
  /** A bot routine run is about to start in its conversation; `reused` says
   * an earlier run (or the owner) already worked there. */
  onRunDispatch?: (run: RoutineRun, reused: boolean) => void;
  /** Telegram messages continue the bot's current conversation. */
  channelThread?: (botId: string, principal?: HumanPrincipal) => { threadId: string } | null;
  /** Returns the existing chat after durable project delivery, or null for a channel. */
  projectRoutine?: (run: RoutineRun) => { threadId: string } | null;
  createGoalTask?: (groupId: string, title: string) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    onDispatchError: (message: string) => void,
    eventId?: string,
    notOwnerAudience?: boolean,
    /** SL-L L4: this run's id, so its first-seat wait is recorded (initial dispatch only).
     * 1.0.4 SL-K K2: the same run id lets the turn resolve its model from the bot, never from the reused thread's pin. */
    routineRunId?: string,
  ) => Promise<void>;
  /** 1.0.4 SL-I I3: is this failure the engine's limit, refused before the run did anything (a turn's
   * failure, or a dispatch refusal such as a paused plan)? Null: an ordinary failure. */
  limitRefusal?: (run: RoutineRun, refusal: { event?: RuntimeEvent; message?: string }) => RoutineLimitRefusal | null;
  startGoal?: (
    groupId: string,
    threadId: string,
    prompt: string,
    coordinatorBotId: string,
    runId: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  /** generation: the turn the Stop is for, when the caller knows it (a held rebuild it already released): a turn that took the thread since is left alone. */
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn, generation?: string) => Promise<void>;
  interruptGoal?: (
    groupId: string,
    threadId: string,
    outcome?: { status: "stopped" | "limit-reached"; detail: string },
  ) => Promise<void>;
  /** Projects every durable transition into the source conversation. */
  onRunChanged?: (run: RoutineRun) => void;
  onRunFailed?: (run: RoutineRun) => void;
  /** A run completed and the routine's run before it had failed: the failure is no longer the newest word (upstream
   *  84b63940c). Called once per recovery, with the failed run it answers. */
  onRunRecovered?: (run: RoutineRun, failed: RoutineRun) => void;
  /** The run limit came while a card was waiting on the owner. */
  onRunNeedsYou?: (run: RoutineRun) => void;
  /** F2 (1.0.4): false when this group is a project that is closed or ended. Run now refuses such a project's routine. */
  projectOpen?: (groupId: string) => boolean;
  /** F2 (1.0.4): true when the bot's own engine is the Cloud VM (the boxAgent driver). The scheduler's early refusal;
   * startTurn (index.ts) repeats it on the engine it resolves, which is the one that counts. */
  boxEngine?: (botId: string) => boolean;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_RUNS = 2_000;
const MAX_ATTACHMENTS = 50;
const attachmentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["file", "image"]),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  size: z.number().finite().nonnegative(),
});
const ROUTINE_REQUEST_ACTIONS = new Set<RoutineRequestOperation["action"]>([
  "create",
  "update",
  "pause",
  "resume",
  "run_now",
  "delete",
]);

function isRoutineRequestAction(value: unknown): value is RoutineRequestOperation["action"] {
  return typeof value === "string" && ROUTINE_REQUEST_ACTIONS.has(value as RoutineRequestOperation["action"]);
}

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanAttachments(value: unknown): RoutineContextAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Add no more than ${MAX_ATTACHMENTS} attachments`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const parsed = attachmentSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.name.includes("\0") || parsed.data.path.includes("\0")) {
      throw new Error("Choose a valid attachment");
    }
    if (ids.has(parsed.data.id)) throw new Error("Each attachment must be unique");
    ids.add(parsed.data.id);
    return { ...parsed.data };
  });
}

function cleanTimeoutMinutes(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 240) {
    throw new Error("Run limit must be a whole number from 5 to 240 minutes");
  }
  return value;
}

function loadTimeoutMinutes(value: unknown): number | undefined {
  try {
    return cleanTimeoutMinutes(value);
  } catch {
    return undefined;
  }
}

/** A malformed legacy metadata field must not make the scheduler forget the
 * otherwise valid routine or run that owns it. New writes still fail closed. */
function loadAttachments(value: unknown): RoutineContextAttachment[] {
  try {
    return cleanAttachments(value);
  } catch {
    return [];
  }
}

function cloneSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "limit_reset") return { type: "limit_reset", engineKey: schedule.engineKey };
  if (schedule.type === "interval") {
    return { type: "interval", everyMinutes: schedule.everyMinutes, anchorAt: schedule.anchorAt };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

/** Whether two sanitized schedules describe the same occurrences. Weekdays
 * compare as a set, so a reordered selection is still the same schedule. */
function sameSchedule(a: RoutineSchedule, b: RoutineSchedule): boolean {
  if (a.type === "once" && b.type === "once") return a.at === b.at;
  if (a.type === "limit_reset" && b.type === "limit_reset") return a.engineKey === b.engineKey;
  if (a.type === "interval" && b.type === "interval") {
    return a.everyMinutes === b.everyMinutes && a.anchorAt === b.anchorAt;
  }
  if (a.type === "daily" && b.type === "daily") {
    const days = new Set(a.weekdays);
    return a.time === b.time && days.size === new Set(b.weekdays).size && b.weekdays.every((day) => days.has(day));
  }
  return false;
}

function cloneAttachments(attachments: readonly RoutineContextAttachment[] | undefined): RoutineContextAttachment[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

function loadTarget(value: unknown): RoutineTarget {
  return value === "room-goal" ? "room-goal" : "bot";
}

const ROUTINE_GOAL_STATUSES = new Set<RoutineGoalStatus>([
  "completed",
  "needs-input",
  "blocked",
  "limit-reached",
  "paused",
  "stopped",
  "failed",
]);

function loadGoalStatus(value: unknown, target: RoutineTarget): RoutineGoalStatus | undefined {
  return target === "room-goal" && typeof value === "string" && ROUTINE_GOAL_STATUSES.has(value as RoutineGoalStatus)
    ? value as RoutineGoalStatus
    : undefined;
}

function loadGroupId(value: unknown, target: RoutineTarget): string | undefined {
  if (target !== "room-goal" || typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export function routineInstructionRevision(routine: Pick<Routine, "id" | "prompt" | "updatedAt" | "instructionRevision">): string {
  return routine.instructionRevision ?? createHash("sha256").update(JSON.stringify([routine.id, routine.prompt, routine.updatedAt])).digest("hex");
}

function retainRoutineInstructions(routine: Routine): RoutineInstructionRevision[] {
  const id = routineInstructionRevision(routine);
  const history = plainCopy(routine.instructionHistory ?? []);
  const current = history.find(item => item.id === id);
  if (current && current.prompt !== routine.prompt) throw new Error("ROUTINE_INSTRUCTION_CORRUPT");
  if (!current) history.push({ id, prompt: routine.prompt, author: "owner", createdAt: routine.updatedAt });
  return history;
}

function cloneRoutine(tracked: Routine): Routine {
  const routine = untracked(tracked);
  return {
    ...routine,
    ...(routine.instructionHistory ? { instructionHistory: plainCopy(routine.instructionHistory) } : {}),
    ...(routine.watch ? { watch: plainCopy(routine.watch) } : {}),
    ...(routine.alwaysAllow ? { alwaysAllow: [...routine.alwaysAllow] } : {}),
    schedule: cloneSchedule(routine.schedule),
    attachments: cloneAttachments(routine.attachments),
  };
}

/** The resource a first-seat wait was for, in the run's history line. */
function seatWaitUse(kind: string): string {
  switch (kind) {
    case "working-folder": return "working folder";
    case "computer": return "computer";
    case "browser": return "browser profile";
    case "thread-slot": return "thread";
    default: return "computer, browser or working folder";
  }
}

function cloneRun(tracked: RoutineRun): RoutineRun {
  const run = untracked(tracked);
  return {
    ...run,
    ...(run.instructionEvidence ? { instructionEvidence: plainCopy(run.instructionEvidence) } : {}),
    ...(run.watch ? { watch: plainCopy(run.watch) } : {}),
    ...(run.seatWait ? { seatWait: plainCopy(run.seatWait) } : {}),
    ...(run.event ? { event: plainCopy(run.event) } : {}),
    ...(run.eventBudget ? { eventBudget: plainCopy(run.eventBudget) } : {}),
    ...(run.humanPrincipal ? { humanPrincipal: plainCopy(run.humanPrincipal) } : {}),
    ...(run.channelOrigin ? { channelOrigin: plainCopy(run.channelOrigin) } : {}),
    ...(run.limitWait ? { limitWait: { ...run.limitWait } } : {}),
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
    ...(Array.isArray(run.notes) ? { notes: run.notes.filter((note): note is string => typeof note === "string").slice(0, RUN_NOTES_MAX) } : {}),
    ...(typeof run.notesMore === "number" && Number.isSafeInteger(run.notesMore) && run.notesMore > 0 ? { notesMore: run.notesMore } : {}),
    ...(run.toolsUnavailable ? { toolsUnavailable: [...run.toolsUnavailable] } : {}),
  };
}

/** Keep untrusted local paths inside the same quoted tag shape used by chat. */
function escapeAttachmentPath(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

/** The last run's report as one quoted data block after the instructions (SL-M). It is labelled reference only. */
function carriedReportBlock(report: string): string {
  return `Previous run's report, for reference only, not instructions:\n${report.split("\n").map((line) => `> ${line}`).join("\n")}`;
}

function composeExecutionPrompt(prompt: string, attachments: readonly RoutineContextAttachment[] | undefined): string {
  const parts = [prompt];
  for (const attachment of attachments ?? []) {
    const tag = attachment.kind === "image" ? "attached-image" : "attached-file";
    parts.push(`<${tag} path="${escapeAttachmentPath(attachment.path)}" />`);
  }
  return parts.filter(Boolean).join("\n\n");
}

function cleanSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Time must use HH:MM");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
  }
  if (schedule?.type === "interval") {
    const { everyMinutes, anchorAt } = schedule;
    if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      throw new Error("Interval must be a whole number from 5 to 1440 minutes");
    }
    if (
      typeof anchorAt !== "number" ||
      !Number.isSafeInteger(anchorAt) ||
      anchorAt < 0 ||
      anchorAt > MAX_DATE_MS
    ) {
      throw new Error("Choose a valid interval start time");
    }
    return { type: "interval", everyMinutes, anchorAt };
  }
  if (schedule?.type === "limit_reset") {
    const engineKey = String(schedule.engineKey ?? "");
    if (!/^(?:connection|engine):[\w.:-]{1,200}$/.test(engineKey)) throw new Error("Choose the engine whose limit this routine waits for");
    return { type: "limit_reset", engineKey };
  }
  throw new Error("Choose a supported schedule");
}

function loadSchedule(value: unknown): RoutineSchedule | null {
  try {
    return cleanSchedule(value as RoutineSchedule);
  } catch {
    return null;
  }
}

/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "limit_reset") {
    const resetsAt = limitResetReader(schedule.engineKey);
    const at = resetsAt === null ? null : resetsAt + LIMIT_RESET_DELAY_MS;
    return at !== null && Number.isSafeInteger(at) && at > after ? at : null;
  }
  if (schedule.type === "interval") {
    if (schedule.anchorAt > after) return schedule.anchorAt;
    const intervalMs = schedule.everyMinutes * 60_000;
    const intervalsElapsed = Math.floor((after - schedule.anchorAt) / intervalMs);
    const candidate = schedule.anchorAt + (intervalsElapsed + 1) * intervalMs;
    return Number.isSafeInteger(candidate) && candidate <= MAX_DATE_MS ? candidate : null;
  }
  if (process.env.MURAGE_CLOUD_ROLE === "home") return nextOwnerDailyOccurrence(schedule.time, cleanDays(schedule.weekdays), after, readOwnerTimeZone(DATA_DIR));
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
  }
  return null;
}

function latestIntervalOccurrence(
  schedule: Extract<RoutineSchedule, { type: "interval" }>,
  at: number,
): number | null {
  if (schedule.anchorAt > at) return null;
  const intervalMs = schedule.everyMinutes * 60_000;
  return schedule.anchorAt + Math.floor((at - schedule.anchorAt) / intervalMs) * intervalMs;
}

function sanitizeInput(input: RoutineInput): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  // Never shortened: a cut brief loses its task, usually in its last lines.
  const prompt = String(input.prompt ?? "").trim();
  if (prompt.length > ROUTINE_INSTRUCTIONS_MAX) throw new Error(routineInstructionsTooLongMessage(prompt.length));
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const target = input.target ?? "bot";
  if (target !== "bot" && target !== "room-goal") throw new Error("Choose a valid routine target");
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  if (target === "room-goal" && !groupId) throw new Error("Choose a room for this goal");
  const runOn = input.runOn ?? "ember";
  if (runOn !== "ember" && runOn !== "cloud") throw new Error("Choose where this routine runs");
  const attachments = cleanAttachments(input.attachments);
  const timeoutMinutes = cleanTimeoutMinutes(input.timeoutMinutes);
  if (target === "room-goal" && runOn === "cloud") {
    throw new Error("Room goals can only run on this computer");
  }
  if (target === "room-goal" && attachments.length > 0) {
    throw new Error("Room goals do not support attachments yet");
  }
  if (runOn === "cloud" && attachments.length > 0) {
    throw new Error("Attachments can only run on this computer until cloud file staging is available");
  }
  if (input.overlap !== undefined && input.overlap !== "skip" && input.overlap !== "queue") {
    throw new Error("Choose skip or queue for overlapping runs");
  }
  const permissionMode = input.permissionMode === undefined ? null : routinePermissionModeInput(input.permissionMode);
  const schedule = cleanSchedule(input.schedule);
  return {
    name,
    prompt,
    target,
    botId,
    groupId: target === "room-goal" ? groupId : undefined,
    runOn,
    enabled: input.enabled !== false,
    schedule,
    durationMinutes: Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) || 30))),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    attachments,
    ...(input.overlap === "queue" ? { overlap: "queue" as const } : {}),
    ...(input.carryLastReport === true && target === "bot" && schedule.type !== "once" ? { carryLastReport: true as const } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

/** A scheduled run whose connected-app tools are still missing waits this
 * long, then this long again, before it runs anyway with a note. */
export const CONNECTOR_DEFER_DELAYS_MS = [2 * 60_000, 10 * 60_000] as const;
export const STARTUP_WAIT_MS = 90_000;
export const STARTUP_NOTE =
  "Note: connected apps had not finished loading when this run started, so their tools may be missing. If a tool you need is not available, say so plainly and stop instead of guessing; this run will be retried.";

class MissingRoutinesFile extends Error {}
const KNOWN_FILE_FIELDS = new Set(["version", "routines", "runs", "routineRequestReceipts", "runsCommit", "stateGeneration"]);

/** Automatic runs whose service time sizes the cap (the median of these). */
const AUTOMATIC_SERVICE_SAMPLES = 20;
/**
 * The install-wide cap on automatic runs, sized from measured service time (Little's law): the runs waiting
 * now arrive over one dispatch window, so draining them inside it takes waiting x service / window places at
 * once. Never below `base` (the fixed floor) and never above `ceiling` (the machine's own bound). With no
 * measurement yet, or quick runs, it is `base`.
 */
export function automaticRunCap(input: { base: number; ceiling: number; serviceMs: number | undefined; waiting: number; windowMs: number }): number {
  const { base, serviceMs, waiting, windowMs } = input;
  const ceiling = Math.max(base, input.ceiling);
  if (!serviceMs || serviceMs <= 0 || waiting <= 0 || !(windowMs > 0)) return base;
  return Math.max(base, Math.min(ceiling, Math.ceil(waiting * serviceMs / windowMs)));
}

export class RoutineManager {
  private startedAt: number;
  private gateOpened = false;
  private gateForced = false;
  private lastCatchUpAt: number | null = null;
  private readonly heldByStartup = new Set<string>();
  /** The task a run's start opened when that start could not be saved, by run id. The run went back to queued; its next
   *  start uses this task instead of opening another one (upstream f4f2e3d8b + 22bfaa817, every target). In memory only: the
   *  failed save is exactly what did not record it. */
  private readonly unsavedStartTasks = new Map<string, string>();
  private readonly deferrals = new Map<string, { attempts: number; notBefore: number }>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  /** Automatic runs held back at the cap or the owner-first gate, by run id: how long each has waited. Elapsed time,
   * not awake time: a Mac asleep counts (the wall clock moved while the monotonic one did not), a relaunch starts from
   * the age the run's own stored creation time gives, and a wall clock set back adds nothing (the monotonic step counts). */
  private readonly automaticHeldSince = new Map<string, { waitedMs: number; monotonic: number; wall: number }>();
  private readonly options: RoutineManagerOptions;
  private routinesRaw: Routine[] = [];
  /** Stored routines this build could not load (a schedule or watch it cannot
   * read), kept exactly as stored. They never run and never show as live, but
   * every write of routines.json carries them back out, so an unrelated save
   * cannot delete them. By id: why each one could not load. */
  private unloadedRoutines: Routine[] = [];
  /** Top-level routines.json fields this version does not know; written back unchanged (104 S4). */
  private unknownFileFields: Record<string, unknown> = {};
  private unloadedReasons = new Map<string, "schedule" | "watch">();
  private runsRaw: RoutineRun[] = [];
  private routinesView: Routine[] = this.routinesRaw;
  private runsView: RoutineRun[] = this.runsRaw;
  /** Set when a whole list was replaced or an element was put in raw: the next sweep walks the list once. */
  private walkRoutines = true;
  private walkRuns = true;
  /** Runs put into the run list since the last sweep (index writes only; a trim works on the raw list and adds none). */
  private joinedRuns: RoutineRun[] = [];
  /** The lists seen through a write watch on the list itself (not on the elements, which tracked-state.ts covers):
   * a run pushed in is queued for the next sweep, a routine put in or taken out forces a full save, and a run taken
   * out other than by the history cap does too. Reads and iteration cost nothing extra. */
  private get routines(): Routine[] { return this.routinesView; }
  private set routines(list: Routine[]) { this.routinesRaw = list; this.routinesView = this.watchList(list, "routines"); this.walkRoutines = true; this.fullSave = true; }
  private get runs(): RoutineRun[] { return this.runsView; }
  /** F2: moves whenever the whole run list is replaced (a load, a commitMutation rollback): run objects held from before are stale. */
  private runsGeneration = 0;
  private set runs(list: RoutineRun[]) { this.runsGeneration++; this.runsRaw = list; this.runsView = this.watchList(list, "runs"); this.walkRuns = true; this.fullSave = true; }
  private watchList<T extends object>(list: T[], kind: "routines" | "runs"): T[] {
    const isIndex = (key: PropertyKey) => typeof key === "string" && key !== "length" && /^\d+$/.test(key);
    return new Proxy(list, {
      set: (target, key, value, receiver) => {
        if (isIndex(key)) { if (kind === "runs") this.joinedRuns.push(value as unknown as RoutineRun); else { this.fullSave = true; this.walkRoutines = true; } }
        return Reflect.set(target, key, value, receiver);
      },
      deleteProperty: (target, key) => { if (isIndex(key)) this.fullSave = true; return Reflect.deleteProperty(target, key); },
    });
  }
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** The earliest time any routine needs the fleet walk (a due run, a watch expiry), or null when unknown.
   * Every definition change goes through a save or a commit, which forget it. */
  private fleetDueAt: number | null = null;
  /** When the cap last said it was holding runs back (the log says so once a minute). */
  private capLoggedAt = -Infinity;
  private watchReads = new Map<string, AbortController>();
  private readonly journal: RoutineRunsJournal;
  /** What routines.json last held, so an unchanged file is never rewritten. */
  private lastWritten: { text: string; size: number; mtimeMs: number; ino: number } | null = null;
  /** The journal commit routines.json holds; undefined for a pre-0.1.62 file. */
  private runsCommit: number | undefined;
  /** A tag whose routines.json write has not succeeded yet: every later save
   * reuses it until one does, so no line from that save counts early. */
  private pendingCommit: number | null = null;
  /** This file's stateGeneration (routine-runs-journal.ts); undefined until one is written. */
  private generation: string | undefined;
  /** Runs and routines written since the last save, persisted incrementally by the next saveNow. Every run,
   * routine and the receipt list sit behind a write-tracking proxy (tracked-state.ts), so any write to them, from
   * any path and at any depth, lands here: no path can change persisted state without the next save writing it. */
  private dirtyRuns = new Set<RoutineRun>();
  private dirtyRoutines = new Set<Routine>();
  /** A save that named nothing (or a failed one): the next saveNow compares everything, as before 1.0.2. */
  private fullSave = true;
  /** Runs this manager has already accounted for in a save, and how many runs and routines that save left. */
  private knownRuns = new WeakSet<RoutineRun>();
  private savedRunCount = -1;
  private savedRoutineCount = -1;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.journal = new RoutineRunsJournal(dirname(this.file));
    flushCoalesced(); // a load reads the files: deferred writes land first
    let migratedLegacyRuns = false;
    let prePin: string | undefined;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
    this.startedAt = this.now();
    // A missing file is a fresh start. Any other read, parse or shape failure
    // stops startup (like webhooks.json) instead of loading empty state that
    // the next save would write over the person's routines.
    let original = "";
    const parsedDisk = readPersistedJson(this.file, (path) => (original = readFileSync(path, "utf8")));
    try {
      if (parsedDisk === undefined) throw new MissingRoutinesFile();
      const disk = parsedDisk as Partial<RoutineFile>;
      // Run history and routine state lines (routine-runs-journal.ts) are read before the routines: a
      // state line of this file's generation is the routine's newer state (a moved cursor, an adopted thread).
      this.runsCommit = routinesCommit(disk);
      this.unknownFileFields = Object.fromEntries(Object.entries(disk).filter(([key]) => !KNOWN_FILE_FIELDS.has(key)));
      this.generation = typeof disk.stateGeneration === "string" ? disk.stateGeneration : undefined;
      const journalRuns = this.journal.load(this.runsCommit, this.generation) as RoutineRun[];
      const states = this.journal.routineStates;
      const diskRoutines = Array.isArray(disk.routines)
        ? disk.routines.map((routine) => (routine && typeof routine.id === "string" ? states.get(routine.id) as Routine | undefined : undefined) ?? routine)
        : undefined;
      // UX-TRUST-MOMENTS-1012 2.3.3: a stored payment grant is never kept for
      // good (routineGrantKeys drops it); counted once below, no payee
      let refusedGrants = 0;
      const countRefusedGrants = (keys: unknown): unknown => {
        if (Array.isArray(keys)) refusedGrants += keys.filter((key) => typeof key === "string" && key.startsWith("stop:") && !durableGrantAllowed(key)).length;
        return keys;
      };
      this.routines = diskRoutines
        ? diskRoutines.flatMap((routine) => {
            const cleanedSchedule = loadSchedule(routine.schedule);
            if (!cleanedSchedule) return this.keepUnloaded(routine, "schedule");
            // A field a person or tool added to the schedule rides along unchanged (104 S4).
            const schedule = { ...(routine.schedule as unknown as object), ...cleanedSchedule } as RoutineSchedule;
            const target = loadTarget(routine.target);
            const loaded: Routine = {
              ...routine,
              schedule,
              target,
              groupId: loadGroupId(routine.groupId, target),
              runOn: routine.runOn ?? "ember",
              timeoutMinutes: loadTimeoutMinutes(routine.timeoutMinutes),
              attachments: loadAttachments(routine.attachments),
              sourceThreadId: persistedSourceThreadId.parse(routine.sourceThreadId),
              threadId: persistedSourceThreadId.parse(routine.threadId),
              overlap: routine.overlap === "queue" ? "queue" : undefined,
              carryLastReport: routine.carryLastReport === true ? true : undefined,
              permissionMode: loadRoutinePermissionMode(routine.permissionMode) ?? this.options.botMode?.(routine.botId) ?? "ask",
              alwaysAllow: routineGrantKeys(countRefusedGrants(routine.alwaysAllow)),
              skippedRuns: Number.isSafeInteger(routine.skippedRuns) && routine.skippedRuns! > 0 ? routine.skippedRuns : undefined,
              lastSkippedAt: Number.isSafeInteger(routine.lastSkippedAt) && routine.lastSkippedAt! >= 0 && routine.lastSkippedAt! <= MAX_DATE_MS ? routine.lastSkippedAt : undefined,
            };
            // Keep optional metadata absent when it has no stored value.
            for (const key of ["overlap", "carryLastReport", "threadId", "skippedRuns", "lastSkippedAt"] as const) if (loaded[key] === undefined) delete loaded[key];
            if (!loaded.alwaysAllow?.length) delete loaded.alwaysAllow;
            delete loaded.failureStreak;
            if (routine.watch !== undefined) {
              try { loaded.watch = readRoutineWatchBinding(routine.watch, routine.id); }
              catch { return this.keepUnloaded(routine, "watch"); }
            }
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            if (loaded.permissionMode !== routine.permissionMode) prePin = original;
            return [loaded];
          })
        : [];
      // Run history lives in routine-runs/ (routine-runs-journal.ts). A
      // routines.json from 0.1.61 or earlier still carries `runs`; those are
      // overlaid on the journal (the file is the newer copy when a downgrade
      // happened in between) and moved out below. Idempotent: a crash after the
      // journal write but before the file rewrite just repeats this on next boot.
      if (refusedGrants) console.warn(`[routines] dropped ${refusedGrants} remembered routine ${refusedGrants === 1 ? "approval" : "approvals"} that are never kept for good (payments)`);
      let diskRuns: RoutineRun[] = journalRuns;
      if (Array.isArray(disk.runs) && disk.runs.length > 0) {
        const byId = new Map(journalRuns.map((run) => [run.id, run] as const));
        for (const run of disk.runs) if (run && typeof run.id === "string") byId.set(run.id, run);
        diskRuns = [...byId.values()];
        migratedLegacyRuns = true;
      }
      // Journals are per routine; restore the global creation order that
      // history trimming and channel FIFO dispatch read from this.runs.
      diskRuns = diskRuns.map((run, index) => ({ run, index }))
        .sort((a, b) => (Number(a.run.createdAt) || 0) - (Number(b.run.createdAt) || 0) || a.index - b.index)
        .map(({ run }) => run);
      this.runs = diskRuns.length > 0
        ? diskRuns.map((run) => {
            const target = loadTarget(run.target);
            const loaded: RoutineRun = {
              ...run,
              target,
              goalStatus: loadGoalStatus(run.goalStatus, target),
              groupId: loadGroupId(run.groupId, target),
              runOn: run.runOn ?? "ember",
              timeoutMinutes: loadTimeoutMinutes(run.timeoutMinutes),
              attachments: loadAttachments(run.attachments),
              sourceThreadId: persistedSourceThreadId.parse(run.sourceThreadId),
            };
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            loaded.event = routineEventForRun(loaded);
            const budget = eventActionBudgetSchema.safeParse(run.eventBudget);
            loaded.eventBudget = budget.success ? budget.data : undefined;
            const watched = this.routines.find(item => item.id === loaded.routineId)?.watch;
            if (run.watch !== undefined || watched) {
              const parsedWatch = z.object({ watchId: z.string().min(1), ownerBotId: z.string().min(1), source: routineWatchInputSchema.shape.source,
                outcome: z.enum(["pending", "baseline", "unchanged", "changed", "failed", "abandoned"]) }).strict().safeParse(run.watch);
              if (!parsedWatch.success || parsedWatch.data.watchId !== loaded.routineId || watched && parsedWatch.data.ownerBotId !== watched.ownerBotId) {
                loaded.status = "failed"; loaded.finishedAt = this.now(); loaded.error = "Saved file watch receipt is invalid; no check was started";
                delete loaded.watch;
              } else loaded.watch = parsedWatch.data;
            }
            return loaded;
          })
        : [];
      this.routineRequestReceipts = Array.isArray(disk.routineRequestReceipts)
        ? disk.routineRequestReceipts.filter((receipt): receipt is RoutineRequestReceipt =>
            typeof receipt?.requestId === "string" &&
            typeof receipt?.messageId === "string" &&
            typeof receipt?.botId === "string" &&
            typeof receipt?.threadId === "string" &&
            isRoutineRequestAction(receipt?.action) &&
            receipt?.fingerprintVersion === 1 &&
            typeof receipt?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
            // A receipt written before its change was applied has neither (SL-J J2).
            ((receipt?.resultId === undefined && receipt?.appliedAt === undefined) ||
              (typeof receipt?.resultId === "string" && Number.isFinite(receipt?.appliedAt)))
          )
        : [];
    } catch (error) {
      if (!(error instanceof MissingRoutinesFile)) throw new PersistedStateRecoveryError(this.file, "invalid-shape", error);
      prePin = undefined;
      this.routines = [];
      this.unloadedRoutines = [];
      this.unloadedReasons.clear();
      this.runs = [];
      this.routineRequestReceipts = [];
    }
    // From here on every write to persisted state is tracked (tracked-state.ts).
    this.routines = this.routines.map((routine) => this.trackRoutine(routine));
    this.runs = this.runs.map((run) => this.trackRun(run));
    this.routineRequestReceipts = this.trackReceipts(this.routineRequestReceipts);
    // A local process cannot still own these turns after a full restart.
    const recovered: RoutineRun[] = [];
    // SL-L L4: a run whose initial turn was still waiting for its first seat
    // never started any work, so it goes back in the queue (or yields to the
    // occurrence already queued behind it). Anything else is failed as before.
    const requeued: RoutineRun[] = [];
    for (const run of this.runs) {
      // Fail closed: only a well-formed wait record proves the run never started.
      const seatWait = run.seatWait as unknown;
      const provenWaiting = typeof seatWait === "object" && seatWait !== null && typeof (seatWait as { kind?: unknown }).kind === "string" &&
        Number.isFinite((seatWait as { at?: unknown }).at);
      if (isLive(run.status) && provenWaiting && run.seatGrantedAt === undefined && run.resumedAt === undefined) {
        const queuedBehind = this.runs.some((other) => other !== run && other.routineId === run.routineId && other.status === "queued");
        const kind = run.seatWait!.kind;
        if (queuedBehind) {
          run.status = "cancelled";
          run.finishedAt = this.now();
          this.appendRunNote(run, "a later occurrence is already queued");
        } else {
          run.status = "queued";
          run.startedAt = undefined;
          delete run.seatWait;
          this.appendRunNote(run, `waited for a busy ${seatWaitUse(kind)} across a restart`);
        }
        run.attention = undefined;
        requeued.push(cloneRun(run));
        continue;
      }
      if (isLive(run.status)) {
        run.status = "failed";
        if (run.target === "room-goal") run.goalStatus = "failed";
        run.error = "Murage restarted while this routine was running";
        run.attention = undefined;
        run.finishedAt = this.now();
        if (run.watch) {
          run.watch.outcome = "abandoned";
          const routine = this.routines.find(item => item.id === run.routineId);
          if (routine?.watch) {
            const now = Math.max(this.now(), routine.watch.state.updatedAt);
            routine.watch.state = pauseRoutineWatch(routine.watch.state, true, now);
            if (routine.enabled) routine.watch.state = pauseRoutineWatch(routine.watch.state, false, now);
          }
        }
        recovered.push(cloneRun(run));
      }
    }
    // Preserve the original before any migrating save, including run recovery.
    // Atomic replacement leaves complete JSON at both paths after interruption.
    // It sits under events/, an owner folder every shipped release backs up:
    // a new name at the top of the data folder stops a backup as unclassified
    // (data-dir-inventory.ts), in this release and after a downgrade.
    const prePinFile = routinesPrePinFile(this.file);
    if (prePin !== undefined && !existsSync(prePinFile)) {
      mkdirSync(dirname(prePinFile), { recursive: true, mode: 0o700 });
      writeFileAtomic(prePinFile, prePin, { mode: 0o600 });
    }
    if ((migratedLegacyRuns || prePin !== undefined) && recovered.length === 0 && requeued.length === 0) this.save();
    if (recovered.length > 0 || requeued.length > 0) {
      this.save();
      for (const run of requeued) this.notifyRunChanged(run);
      for (const run of recovered) {
        this.notifyRunChanged(run);
        this.options.onRunFailed?.(run);
      }
    }
  }

  listRoutines(): Routine[] {
    return this.routines.map((routine) => this.routineWithHealth(routine));
  }

  /** Each routine's name, bot and whether it is on: no run history is read (a turn's working context lists them). */
  listRoutineNames(): Array<{ name: string; botId: string; enabled: boolean }> {
    return this.routines.map((routine) => ({ name: routine.name, botId: routine.botId, enabled: routine.enabled }));
  }

  /** A copy with the derived failure streak. Only failed and completed runs
   * are attempts: a cancelled run was stopped on purpose and a missed one
   * never started. */
  private routineWithHealth(routine: Routine): Routine {
    const outcomes = this.runs
      .filter((run) => run.routineId === routine.id && (run.status === "failed" || run.status === "completed"))
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.createdAt - a.createdAt);
    const success = outcomes.findIndex((run) => run.status === "completed");
    const failures = success < 0 ? outcomes.length : success;
    return { ...cloneRoutine(routine), ...(failures ? { failureStreak: failures } : {}) };
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map(cloneRun);
  }

  private runRevision = 0;
  /** Changes on any write to a run (or the list of runs), so a caller holding something built from the live runs can keep it until they move. */
  get runsRevision(): number { return this.runRevision; }

  /** The conversations of this bot's runs that are still going (queued,
   * running, waiting, or needing the owner). Their cards link to the task, so
   * the roster keeps those tasks whatever their age. */
  liveRunThreadIds(botId: string): Set<string> {
    const ids = new Set<string>();
    for (const run of this.runs) if (run.botId === botId && run.threadId && OPEN_RUN_STATUSES.includes(run.status)) ids.add(run.threadId);
    return ids;
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && isLive(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  /** Active work that owns the bot's direct conversation. Room goals may use
   * the same bot as their coordinator, but execute in a separate room task. */
  activeBotRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.target === "bot" &&
        candidate.botId === botId &&
        isLive(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  /** Several routines can share a bot's thread slots; Stop must resolve the
   * run by the exact thread it names, never by "the bot's routine". */
  activeBotRunForThread(botId: string, threadId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.target === "bot" &&
        candidate.botId === botId &&
        candidate.threadId === threadId &&
        isLive(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  activeBotRunsForBot(botId: string): RoutineRun[] {
    return this.runs
      .filter((candidate) => candidate.target === "bot" &&
        candidate.botId === botId &&
        isLive(candidate.status))
      .map(cloneRun);
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
    // a deep copy: `before` is a nested object inside tracked state
    return receipt ? plainCopy(receipt) : null;
  }

  /** Small startup index used to locate only transcripts that may need
   * cross-file commit recovery. Most launches have no receipts and therefore
   * do not read or cache any transcript for this feature. */
  routineRequestReceiptOwners(): RoutineRequestOwner[] {
    return this.routineRequestReceipts.map(({ requestId, messageId, botId, threadId }) => ({
      requestId,
      messageId,
      botId,
      threadId,
    }));
  }

  /** Once the transcript card is durably settled, its scheduler receipt is
   * redundant. Unsettled receipts are intentionally never count-evicted: an
   * actionable card may survive indefinitely and must retain its exact-once
   * recovery record for the same lifetime. */
  forgetRoutineRequestReceipt(request: RoutineRequestCommit): boolean {
    const receipt = this.matchingRoutineRequestReceipt(request);
    if (!receipt) return false;
    const index = this.routineRequestReceipts.indexOf(receipt);
    this.commitMutation(() => {
      this.routineRequestReceipts.splice(index, 1);
    });
    return true;
  }

  forgetRoutineRequestReceiptsForThread(threadId: string): number {
    const kept = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  /** Drop only receipts whose confirmation transcript no longer exists.
   * Reachable open cards retain exact-once recovery for their full lifetime. */
  reconcileRoutineRequestReceipts(reachable: readonly RoutineRequestOwner[]): number {
    const keys = new Set(reachable.map(routineRequestOwnerKey));
    const kept = this.routineRequestReceipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  /** SL-J J2 step 1: the receipt, with `before`, saved BEFORE the change is
   * applied. A receipt already written for this card (a Confirm pressed again
   * after a crash) is returned as it is. */
  beginRoutineRequest(request: RoutineRequestCommit, intent: RoutineRequestIntent): RoutineRequestReceipt {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) return { ...existing };
    const receipt: RoutineRequestReceipt = {
      ...request,
      ...(intent.kind ? { kind: intent.kind } : {}),
      before: intent.before === null ? null : plainCopy(intent.before),
      ...(intent.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: intent.expectedUpdatedAt }),
    };
    this.commitMutation(() => { this.routineRequestReceipts.unshift(receipt); });
    return { ...receipt };
  }

  /** SL-J J2 step 2 for a webhook: its change is saved in webhooks.json, then
   * the receipt gains the result in a second routines.json write. */
  completeRoutineRequest(request: RoutineRequestCommit, resultId: string, appliedAt: number, appliedUpdatedAt?: number): void {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing?.resultId === resultId) return;
    this.commitMutation(() => { this.rememberRoutineRequest(request, resultId, appliedAt, appliedUpdatedAt); });
  }

  /** Undo stamped on a receipt whose record lives in another file (a webhook). */
  markRoutineRequestUndone(requestId: string, at: number): void {
    const index = this.routineRequestReceipts.findIndex((candidate) => candidate.requestId === requestId);
    if (index === -1) return;
    this.commitMutation(() => { this.routineRequestReceipts[index] = { ...this.routineRequestReceipts[index]!, undoneAt: at }; });
  }

  /** Undo of a routine change (SL-J J2): restore `before` and stamp the
   * receipt in ONE routines.json write, only while the routine's `updatedAt`
   * is still the one the change left. Never rebuilds an inverse from the
   * current record. */
  undoRoutineRequest(
    requestId: string,
    routineId: string,
    expectedUpdatedAt: number,
    restore: { remove: true } | { patch: Partial<RoutineInput> },
  ): "undone" | "changed" | "missing" {
    const index = this.routineRequestReceipts.findIndex((candidate) => candidate.requestId === requestId);
    if (index === -1) return "missing";
    const routine = this.routines.find((candidate) => candidate.id === routineId);
    if (!routine) return "missing";
    if (routine.updatedAt !== expectedUpdatedAt) return "changed";
    const stamp = () => { this.routineRequestReceipts[index] = { ...this.routineRequestReceipts[index]!, undoneAt: this.now() }; };
    if ("remove" in restore) return this.remove(routineId, undefined, stamp) ? "undone" : "missing";
    return this.update(routineId, restore.patch, undefined, stamp) ? "undone" : "missing";
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && isLive(run.status),
    );
  }

  /** Why the run working in this thread exists, and for whom (Full access
   * reads it to tell the owner's channel message from everything else). */
  activeRunOrigin(threadId: string): { triggerSource: RoutineRunTrigger; humanPrincipal?: HumanPrincipal } | null {
    const run = this.runs.find((candidate) => candidate.threadId === threadId && isLive(candidate.status));
    if (!run) return null;
    return { triggerSource: run.triggerSource ?? (run.manual ? "manual" : "schedule"), ...(run.humanPrincipal ? { humanPrincipal: plainCopy(run.humanPrincipal) } : {}) };
  }

  /** One of the harness's own cards opened in this thread. In a scheduled or
   * manual bot run it is held open (true) and the run waits on the owner. */
  cardOpened(threadId: string, requestId: string, summary: string): boolean {
    if (!this.routineRunForThread(threadId)) return false;
    const run = this.runs.find((candidate) => candidate.threadId === threadId && isLive(candidate.status));
    if (!run) return false;
    this.commitMutation(() => {
      run.cardsOpen = [...new Set([...(run.cardsOpen ?? []), requestId])];
      if (run.status !== "needs-you") run.status = "waiting";
      run.attention = redactSecretsInText(summary).trim().slice(0, 500) || run.attention;
    });
    this.emitRun(run);
    return true;
  }

  /** That card was answered or closed. True when the run's turn had already
   * ended: the caller starts a new turn in the run's conversation, which
   * carries the same run on with a fresh run limit. */
  cardClosed(threadId: string, requestId: string): boolean {
    const run = this.runs.find((candidate) => candidate.threadId === threadId && isLive(candidate.status) && candidate.cardsOpen?.includes(requestId));
    if (!run) return false;
    const resume = run.turnEnded === true;
    this.commitMutation(() => {
      run.cardsOpen = run.cardsOpen!.filter((id) => id !== requestId);
      if (!run.cardsOpen.length) delete run.cardsOpen;
      if (resume) { run.turnEnded = undefined; run.resumedAt = this.now(); }
      if (resume || (!run.cardsOpen && run.status === "waiting")) { run.status = "running"; run.attention = undefined; }
    });
    this.emitRun(run);
    return resume;
  }

  /** The stored ceiling for scheduled and manual work, including room goals. */
  routineRunForThread(threadId: string): { runId: string; routineId: string; botId: string; permissionMode?: RoutinePermissionMode; alwaysAllow: string[] } | null {
    const run = this.runs.find((candidate) => candidate.threadId === threadId && isLive(candidate.status));
    if (!run) return null;
    const trigger = run.triggerSource ?? (run.manual ? "manual" : "schedule");
    if (trigger !== "schedule" && trigger !== "manual") return null;
    const routine = this.routines.find((candidate) => candidate.id === run.routineId);
    if (!routine) return null;
    return { runId: run.id, routineId: routine.id, botId: run.botId, ...(routine.permissionMode ? { permissionMode: routine.permissionMode } : {}), alwaysAllow: [...(routine.alwaysAllow ?? [])] };
  }

  /** The routine whose own conversation this is (Routine.threadId), with
   * its level (absent = inherit). The composer's level in that conversation
   * is the routine's, so the owner's own turns there are judged at it too. */
  routineForConversation(threadId: string): { routineId: string; botId: string; permissionMode?: RoutinePermissionMode } | null {
    const routine = this.routines.find((candidate) => candidate.target === "bot" && candidate.threadId === threadId);
    return routine ? { routineId: routine.id, botId: routine.botId, ...(routine.permissionMode ? { permissionMode: routine.permissionMode } : {}) } : null;
  }

  /** Remember "Always allow for this routine". The caller has proved the key
   * sits on a pending card this routine's run raised; this only refuses a
   * key that is not one of the two scoped kinds, and a full list. */
  grantAlwaysAllow(id: string, key: string): Routine | null {
    return this.grantAlwaysAllowSet(id, [key]);
  }

  /** Rule 81b (AMEND-13): remember a WHOLE set at once. Every key is
   * validated first; existing keys are deduplicated; a set that would pass
   * the cap, or any invalid key, saves none of it (no slicing, no partial
   * success). Saving keys already held is a no-op, so a retry is idempotent. */
  grantAlwaysAllowSet(id: string, keys: readonly string[]): Routine | null {
    return this.rememberAlwaysAllowSet(id, keys)?.routine ?? null;
  }

  /** As grantAlwaysAllowSet, and the keys it added, so the approval choke
   * point (server/index.ts rememberAndAnswer) can take back exactly those
   * when its answer does not land (A13-FIX-DESIGN C1). */
  rememberAlwaysAllowSet(id: string, keys: readonly string[]): { routine: Routine; added: string[] } | null {
    const plan = this.planAlwaysAllowSet(id, keys);
    if (!plan) return null;
    const { routine, added: fresh } = plan;
    if (!fresh.length) return { routine: this.routineWithHealth(routine), added: [] };
    // A grant is not a definition edit: `updatedAt` stays, so a pending
    // routine confirmation card is not made stale by it.
    this.commitMutation(() => { routine.alwaysAllow = [...(routine.alwaysAllow ?? []), ...fresh]; });
    this.emitRoutine(routine);
    return { routine: this.routineWithHealth(routine), added: fresh };
  }

  /** What rememberAlwaysAllowSet would add, without writing: the choke point
   * validates a choice with this BEFORE its answer is delivered, and writes
   * only after. Null for no such routine; throws (with a status) for a key
   * outside the scoped kinds and past the cap. */
  planAlwaysAllowSet(id: string, keys: readonly string[]): { routine: Routine; added: string[] } | null {
    const routine = this.routines.find((candidate) => candidate.id === id);
    if (!routine) return null;
    if (!keys.length || !keys.every(isRoutineGrantKey)) throw Object.assign(new Error("Only exact actions, an exact command or a scoped place can be always allowed for a routine"), { status: 400 });
    const held = routine.alwaysAllow ?? [];
    const fresh = [...new Set(keys)].filter((key) => !held.includes(key));
    if (fresh.length && held.length + fresh.length > ROUTINE_GRANTS_MAX) throw Object.assign(new Error(`This routine already remembers ${ROUTINE_GRANTS_MAX} approvals. Remove some in the routine editor, then try again.`), { status: 409 });
    return { routine, added: fresh };
  }

  revokeAlwaysAllow(id: string, key: string): Routine | null {
    const routine = this.routines.find((candidate) => candidate.id === id);
    if (!routine) return null;
    if (!routine.alwaysAllow?.includes(key)) return this.routineWithHealth(routine);
    this.commitMutation(() => {
      const kept = routine.alwaysAllow!.filter((held) => held !== key);
      if (kept.length) routine.alwaysAllow = kept;
      else delete routine.alwaysAllow;
    });
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">): Routine {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt?.resultId !== undefined) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        if (committed) return this.routineWithHealth(committed);
        throw new Error("This routine request was already applied");
      }
    }
    const clean = sanitizeInput(input);
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    const at = this.now();
    const watchInput = input.watch === undefined ? undefined : routineWatchInputSchema.parse(input.watch);
    if (watchInput) {
      if (!request || !this.options.validateWatchSource || !this.options.readWatchSource) throw new Error("Confirm a file watch in its routine card before enabling it");
      if (clean.target !== "bot" || clean.runOn !== "ember" || clean.schedule.type !== "interval" || clean.attachments?.length) throw new Error("File watches use an interval on this computer without attachments");
      this.options.validateWatchSource(request.botId, clean.botId, watchInput.source);
    }
    const routine: Routine = {
      id: randomUUID(),
      ...clean,
      permissionMode: clean.permissionMode ?? this.options.botMode?.(clean.botId) ?? "ask",
      // Only a confirmed chat card supplies `request`; the public calendar
      // API cannot choose an arbitrary transcript as a reporting target.
      sourceThreadId: request?.threadId,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    routine.instructionRevision = routineInstructionRevision(routine);
    routine.instructionHistory = retainRoutineInstructions(routine);
    if (watchInput) delete routine.carryLastReport; // a file watch never starts an agent turn, so there is no report to carry
    if (watchInput && request) routine.watch = { ownerBotId: request.botId, state: createRoutineWatchState({ id: routine.id, ...watchInput }, at) };
    this.commitMutation(() => {
      this.routines.unshift(this.trackRoutine(routine));
      if (request) this.rememberRoutineRequest(request, routine.id, at, routine.updatedAt);
    });
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  update(
    id: string,
    patch: Partial<RoutineInput>,
    request?: RoutineRequestCommitFor<"update" | "pause" | "resume">,
    /** Runs inside the same routines.json write (Undo stamps its receipt here). */
    inCommit?: () => void,
  ): Routine | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt?.resultId !== undefined) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        return committed ? this.routineWithHealth(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    if (Object.hasOwn(patch, "watch")) throw new Error("Confirm a new file watch to change its source, expiry or check limit");
    const now = this.now();
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      target: patch.target ?? routine.target,
      botId: patch.botId ?? routine.botId,
      groupId: Object.hasOwn(patch, "groupId") ? patch.groupId : routine.groupId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      schedule: patch.schedule ?? routine.schedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
      timeoutMinutes: Object.hasOwn(patch, "timeoutMinutes") ? patch.timeoutMinutes : routine.timeoutMinutes,
      attachments: patch.attachments ?? routine.attachments,
      overlap: Object.hasOwn(patch, "overlap") ? patch.overlap : routine.overlap,
      permissionMode: Object.hasOwn(patch, "permissionMode") ? patch.permissionMode : routine.permissionMode,
    });
    clean.permissionMode ??= this.options.botMode?.(clean.botId) ?? "ask";
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    if (routine.watch && (clean.target !== "bot" || clean.botId !== routine.botId || clean.runOn !== "ember" || clean.schedule.type !== "interval" || clean.attachments?.length)) throw new Error("A file watch must keep its approved bot, local interval and source");
    if (routine.watch && patch.enabled === true) {
      if (now >= routine.watch.state.definition.expiresAt || routine.watch.state.checks.length >= routine.watch.state.definition.maxChecks) throw new Error("This file watch expired or reached its check limit. Confirm a new watch to continue");
      this.options.validateWatchSource?.(routine.watch.ownerBotId, routine.botId, untracked(routine.watch.state.definition.source));
    }
    // An edit that leaves the schedule and the enabled state alone (a rename,
    // new instructions, a different timeout) keeps the cursor. Recomputing it
    // from `now` would silently skip an occurrence that became due since the
    // last tick, or erase an offline catch-up. A changed schedule, a pause or
    // a resume still recalculates. (#988 subset, adapted from OpenMausBot
    // 1e6737b0; FIFO dispatch order is deliberately not part of this.)
    const keepsCursor = clean.enabled && routine.enabled && sameSchedule(clean.schedule, routine.schedule);
    const cancelledRuns: RoutineRun[] = [];
    const reassigned = clean.botId !== routine.botId;
    this.commitMutation(() => {
      if (clean.prompt !== routine.prompt) {
        const history = retainRoutineInstructions(routine);
        const revision = randomUUID();
        history.push({ id: revision, parentId: routineInstructionRevision(routine), prompt: clean.prompt, author: "owner", createdAt: now });
        routine.instructionHistory = history;
        routine.instructionRevision = revision;
      } else if (!routine.instructionRevision) {
        routine.instructionRevision = routineInstructionRevision(routine);
        routine.instructionHistory = retainRoutineInstructions(routine);
      }
      Object.assign(routine, clean, {
        nextRunAt: !clean.enabled ? null : keepsCursor ? routine.nextRunAt : this.initialOccurrence(clean.schedule, now),
        // `updatedAt` doubles as the optimistic revision on durable routine
        // confirmation cards. Keep it monotonic even for two writes in one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (Object.hasOwn(patch, "timeoutMinutes") && patch.timeoutMinutes == null) {
        delete routine.timeoutMinutes;
      }
      // Object.assign cannot remove a key, and skip is stored as absence.
      if (clean.overlap !== "queue") delete routine.overlap;
      if (patch.enabled === false || reassigned) {
        for (const run of this.runs) {
          if (run.routineId !== routine.id || run.status !== "queued") continue;
          run.status = "cancelled";
          run.attention = undefined;
          run.finishedAt = this.now();
          run.error = reassigned ? "The routine changed bots before this run started. Run it again with its current bot." : "The routine was paused before this run started";
          cancelledRuns.push(run);
        }
      }
      if (routine.watch && patch.enabled !== undefined) {
        routine.watch.state = pauseRoutineWatch(routine.watch.state, !patch.enabled, Math.max(now, routine.watch.state.updatedAt));
        if (!patch.enabled) this.watchReads.get(routine.id)?.abort();
      }
      if (request) this.rememberRoutineRequest(request, routine.id, now, routine.updatedAt);
      inCommit?.();
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  /** Internal evaluated publication, deliberately narrower than update(). */
  promoteInstructions(id: string, proposal: RoutineInstructionPromotion): Routine | null {
    const routine = this.routines.find(item => item.id === id);
    if (!routine) return null;
    if (routineInstructionRevision(routine) !== proposal.expectedRevision || routine.updatedAt !== proposal.expectedUpdatedAt) throw new Error("ROUTINE_INSTRUCTION_CONFLICT");
    const prompt = z.string().trim().min(1).max(ROUTINE_INSTRUCTIONS_MAX).parse(proposal.prompt);
    if (!proposal.evaluationReceiptId || !proposal.evidence.length || !proposal.evidence.every(item => ["source", "record"].includes(item.kind) && typeof item.id === "string" && item.id.length > 0 && typeof item.scopeId === "string" && item.scopeId.length > 0 && Number.isSafeInteger(item.revision) && item.revision > 0)) throw new Error("ROUTINE_EVALUATION_REQUIRED");
    if (!this.options.validateInstructionPromotion?.(cloneRoutine(routine), plainCopy({ ...proposal, prompt }))) throw new Error("ROUTINE_EVALUATION_REQUIRED");
    if (routineInstructionRevision(routine) !== proposal.expectedRevision || routine.updatedAt !== proposal.expectedUpdatedAt) throw new Error("ROUTINE_INSTRUCTION_CONFLICT");
    if (prompt === routine.prompt) return cloneRoutine(routine);
    const at = this.now(), history = retainRoutineInstructions(routine), revision = randomUUID();
    history.push({ id: revision, parentId: proposal.expectedRevision, prompt, author: "learned", createdAt: at, evaluationReceiptId: proposal.evaluationReceiptId, evidence: plainCopy(proposal.evidence) });
    this.commitMutation(() => {
      routine.prompt = prompt;
      routine.instructionRevision = revision;
      routine.instructionHistory = history;
      routine.updatedAt = Math.max(at, routine.updatedAt + 1);
    });
    this.emitRoutine(routine);
    return cloneRoutine(routine);
  }

  /** Caller is the owner management route; rollback never rewrites an existing run. */
  rollbackInstructions(id: string, expectedRevision: string, expectedUpdatedAt: number, targetRevision: string): Routine | null {
    const routine = this.routines.find(item => item.id === id);
    if (!routine) return null;
    if (routineInstructionRevision(routine) !== expectedRevision || routine.updatedAt !== expectedUpdatedAt) throw new Error("ROUTINE_INSTRUCTION_CONFLICT");
    const history = retainRoutineInstructions(routine), target = history.find(item => item.id === targetRevision);
    if (!target) throw new Error("ROUTINE_INSTRUCTION_UNAVAILABLE");
    if (target.evidence?.length && !this.options.validateInstructionEvidence?.(cloneRoutine(routine), plainCopy(target.evidence))) throw new Error("ROUTINE_INSTRUCTION_EVIDENCE_REVOKED");
    const prompt = z.string().trim().min(1).max(ROUTINE_INSTRUCTIONS_MAX).parse(target.prompt);
    const at = this.now(), revision = randomUUID();
    history.push({ id: revision, parentId: expectedRevision, prompt, author: "rollback", createdAt: at, rollbackOf: target.id,
      ...(target.evidence ? { evidence: plainCopy(target.evidence), evaluationReceiptId: target.evaluationReceiptId } : {}) });
    this.commitMutation(() => {
      routine.prompt = prompt;
      routine.instructionRevision = revision;
      routine.instructionHistory = history;
      routine.updatedAt = Math.max(at, routine.updatedAt + 1);
    });
    this.emitRoutine(routine);
    return cloneRoutine(routine);
  }

  /** Set aside a stored routine this build cannot load: kept as stored, never
   * scheduled, written back on every save. The name and schedule stay out of
   * the log; the id is enough to find it. */
  private keepUnloaded(routine: Routine, reason: "schedule" | "watch"): [] {
    if (!routine || typeof routine !== "object") return [];
    const id = typeof routine.id === "string" ? routine.id : undefined;
    // Every stored row is kept, even two that share an id: dropping one would
    // be the very loss this exists to prevent.
    this.unloadedRoutines.push(routine);
    if (id !== undefined) this.unloadedReasons.set(id, reason);
    console.warn(`routines: kept routine ${id ?? "(no id)"} without running it; its ${reason} could not be loaded`);
    return [];
  }

  /** The stored routines this build could not load, and why. */
  unloadable(): Array<{ id: string; name?: string; botId: string; reason: "schedule" | "watch" }> {
    return this.unloadedRoutines
      .filter((routine) => typeof routine.id === "string")
      .map((routine) => ({
        id: routine.id,
        ...(typeof routine.name === "string" ? { name: routine.name } : {}),
        botId: routine.botId,
        reason: this.unloadedReasons.get(routine.id) ?? "schedule",
      }));
  }

  /** Delete a kept routine this build could not load. It never ran, so there
   * are no runs to cancel; routines.json is rewritten without it. */
  private removeUnloaded(id: string): boolean {
    const at = this.unloadedRoutines.findIndex((routine) => routine.id === id);
    if (at === -1) return false;
    const [taken] = this.unloadedRoutines.splice(at, 1);
    const reason = this.unloadedReasons.get(id);
    if (!this.unloadedRoutines.some((routine) => routine.id === id)) this.unloadedReasons.delete(id);
    try {
      this.commitMutation(() => {});
    } catch (error) {
      this.unloadedRoutines.splice(at, 0, taken);
      if (reason) this.unloadedReasons.set(id, reason);
      throw error;
    }
    return true;
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">, inCommit?: () => void): boolean {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt?.resultId !== undefined) {
        return true;
      }
    }
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return this.removeUnloaded(id);
    this.watchReads.get(id)?.abort();
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      this.routines.splice(at, 1);
      for (const run of this.runs) {
        if (run.routineId !== id || run.status !== "queued") continue;
        run.status = "cancelled";
        run.attention = undefined;
        run.finishedAt = this.now();
        cancelledRuns.push(run);
      }
      if (request) this.rememberRoutineRequest(request, id, this.now());
      inCommit?.();
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      if (routine.watch) {
        this.watchReads.get(routine.id)?.abort();
        routine.watch.state = pauseRoutineWatch(routine.watch.state, true, Math.max(this.now(), routine.watch.state.updatedAt));
      }
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !isOpen(run.status)) continue;
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId) {
        if (run.target === "room-goal" && run.groupId) {
          void this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
        } else {
          void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "ember").catch(() => {});
        }
      }
      changed = true;
    }
    if (changed) this.save();
  }

  disableForGroup(groupId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.target !== "room-goal" || routine.groupId !== groupId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (
        run.target !== "room-goal" ||
        run.groupId !== groupId ||
        !isOpen(run.status)
      ) continue;
      run.status = "cancelled";
      run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned room was deleted";
      this.emitRun(run);
      if (run.threadId) {
        void this.options.interruptGoal?.(groupId, run.threadId).catch(() => {});
      }
      changed = true;
    }
    if (changed) this.save();
  }

  runNow(id: string, request?: RoutineRequestCommitFor<"run_now">): RoutineRun | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt?.resultId !== undefined) {
        const committed = this.runs.find((run) => run.id === receipt.resultId);
        return committed ? cloneRun(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    // F2: a closed or ended project's routine does not start (an Error, so the route keeps this message)
    if (routine.target === "room-goal" && routine.groupId && this.options.projectOpen?.(routine.groupId) === false) {
      throw Object.assign(new Error(PROJECT_CLOSED_COPY), { status: 409 });
    }
    if (routine.watch && (!routine.enabled || this.now() >= routine.watch.state.definition.expiresAt || routine.watch.state.checks.length >= routine.watch.state.definition.maxChecks)) throw new Error("This file watch is paused, expired or has reached its check limit");
    let run!: RoutineRun;
    this.commitMutation(() => {
      run = this.newRun(routine, this.now(), true);
      // A chat-confirmed "run now" reports back to the conversation that
      // invoked this one run. It must not silently rebind future schedules.
      if (request) run.sourceThreadId = request.threadId;
      if (request) this.rememberRoutineRequest(request, run.id, this.now());
    });
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** Queue an event-driven job without inventing a calendar schedule. Webhook
   * definitions live in their own store; the execution receipt deliberately
   * reuses this manager so busy-bot ordering, task creation and VM routing stay
   * identical for every unattended job. */
  enqueueWebhook(input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
    eventType?: string;
    telegramConnectionId?: string;
    channelOrigin?: ChannelOrigin;
    humanPrincipal?: HumanPrincipal;
    /** Group audiences only (WhatsApp). Stored on the run and forwarded to startTurn. */
    notOwnerAudience?: true;
    /** Images a channel message carried (WhatsApp). Validated and cloned like a routine's attachments; the run's prompt
     * names them, so the engine can look at them. Local runs only: the files live on this computer. */
    attachments?: RoutineContextAttachment[];
  }): RoutineRun {
    if(input.telegramConnectionId || input.channelOrigin){if(!input.humanPrincipal)throw new Error("HUMAN_LINK_REQUIRED");assertHumanPrincipal(input.humanPrincipal);}
    const existing = this.findWebhookDelivery(input.webhookId, input.deliveryId);
    if (existing) return existing;
    const attachments = cleanAttachments(input.attachments);
    if (attachments.length > 0 && (input.runOn === "cloud" || !input.channelOrigin)) throw new Error("Attachments can only run on this computer from a channel message");
    if (input.channelOrigin !== undefined && (!channelOriginSchema.safeParse(input.channelOrigin).success || input.telegramConnectionId || this.options.isChannelCurrent?.(input.channelOrigin, input.botId) !== true)) throw new Error("Channel binding is not current");
    if(!input.telegramConnectionId&&!input.channelOrigin&&this.options.automaticPaused?.())throw Object.assign(new Error("Automatic work is paused. Resume automations before accepting new webhook work."),{status:409,code:"automations_paused"});
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The bot this runs on no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.webhookId,
      routineName: input.webhookName,
      prompt: input.prompt,
      target: "bot",
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      dueAt: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: input.telegramConnectionId || input.channelOrigin ? "channel" : "webhook",
      ...(input.telegramConnectionId ? { telegramConnectionId: input.telegramConnectionId } : {}),
      ...(input.channelOrigin ? { channelOrigin: { ...input.channelOrigin } } : {}),
      ...(input.humanPrincipal?{humanPrincipal:{...input.humanPrincipal}}:{}),
      ...(input.notOwnerAudience === true ? { notOwnerAudience: true as const } : {}),
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      ...(typeof input.eventType === "string" && input.eventType && !input.telegramConnectionId && !input.channelOrigin ? { webhookEventType: input.eventType.slice(0, 200) } : {}),
      attachments: cloneAttachments(attachments),
      createdAt: this.now(),
    };
    run.event = routineEventForRun(run);
    run.eventBudget = newEventActionBudget();
    this.commitMutation(() => { this.runs.push(this.trackRun(run)); });
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** Retained receipts only: history eviction also ends this dedup window. */
  findWebhookDelivery(webhookId: string, deliveryId: string): RoutineRun | null {
    const run = this.runs.find(candidate => (candidate.triggerSource === "webhook" || candidate.triggerSource === "channel")
      && candidate.webhookId === webhookId && candidate.deliveryId === deliveryId);
    return run ? cloneRun(run) : null;
  }

  getEventBudget(eventId: string): EventActionBudget | null {
    const run = this.runs.find(item => item.id === eventId && item.event?.id === eventId);
    return run?.eventBudget ? plainCopy(run.eventBudget) : null;
  }

  /** Charge before the caller performs external work. Uncertain work is not
   * refunded. A missing/evicted/legacy ledger never resets its allocation.
   * The same admission id is charged once, so a retry of one hand-off is free. */
  admitEventActionDetailed(eventId: string, admissionId: string, kind: "create" | "handoff"): EventAdmission {
    if (!eventAdmissionId.safeParse(admissionId).success || !["create", "handoff"].includes(kind)) return { ok: false, reason: "unavailable" };
    const run = this.runs.find(item => item.id === eventId && item.event?.id === eventId);
    const budget = run?.eventBudget;
    if (!run || !budget) return { ok: false, reason: "unavailable" };
    if (budget.closed) return { ok: false, reason: "closed", ...(budget.closedReason ? { closedReason: budget.closedReason } : {}) };
    const prior = budget.admissions.find(item => item.id === admissionId);
    if (prior) return prior.kind === kind ? { ok: true } : { ok: false, reason: "unavailable" };
    const used = budget.admissions.filter(item => item.kind === kind).length;
    if (used >= budget.limits[kind]) return { ok: false, reason: "limit", kind, used, limit: budget.limits[kind] };
    this.commitMutation(() => { budget.admissions.push({ id: admissionId, kind }); });
    return { ok: true };
  }

  admitEventAction(eventId: string, admissionId: string, kind: "create" | "handoff"): boolean {
    return this.admitEventActionDetailed(eventId, admissionId, kind).ok;
  }

  /** Raise one kind's limit for this run (the owner allowed it, or Full access
   * already covers it). Never lowers a limit; null when the run cannot take more. */
  raiseEventLimit(eventId: string, kind: "create" | "handoff", to: number): EventActionBudget | null {
    const run = this.runs.find(item => item.id === eventId && item.event?.id === eventId);
    const budget = run?.eventBudget;
    if (!budget || budget.closed) return null;
    const next = Math.min(EVENT_MAX_LIMIT, Math.max(budget.limits[kind], Math.trunc(to)));
    if (next !== budget.limits[kind]) this.commitMutation(() => { budget.limits[kind] = next; });
    return plainCopy(budget);
  }

  /** The owner's "Allow": this run may do another EVENT_EXTENSION of this kind.
   * A kind the owner already said "Not now" to never reaches a card, so this
   * cannot undo a refusal. */
  extendEventBudget(eventId: string, kind: "create" | "handoff"): EventActionBudget | null {
    const budget = this.getEventBudget(eventId);
    if (!budget) return null;
    return this.raiseEventLimit(eventId, kind, budget.limits[kind] + EVENT_EXTENSION);
  }

  /** What an already-admitted action produced, if it got that far. */
  eventAdmissionReceipt(eventId: string, admissionId: string): string | undefined {
    return this.runs.find(item => item.id === eventId && item.event?.id === eventId)?.eventBudget?.admissions.find(item => item.id === admissionId)?.receipt;
  }

  /** Remember what an admitted action produced, saved with the run so it holds after a restart. */
  recordEventAdmissionReceipt(eventId: string, admissionId: string, receipt: string): boolean {
    const admission = this.runs.find(item => item.id === eventId && item.event?.id === eventId)?.eventBudget?.admissions.find(item => item.id === admissionId);
    if (!admission) return false;
    if (admission.receipt !== receipt) this.commitMutation(() => { admission.receipt = receipt.slice(0, 200); });
    return true;
  }

  /** The owner said "Not now" to more actions of this kind: none for the rest of this run, and no more cards for it. */
  declineEventKind(eventId: string, kind: "create" | "handoff"): void {
    const budget = this.runs.find(item => item.id === eventId && item.event?.id === eventId)?.eventBudget;
    if (!budget || budget.closed || budget.declined?.includes(kind)) return;
    this.commitMutation(() => { budget.declined = [...(budget.declined ?? []), kind]; });
  }

  eventKindDeclined(eventId: string, kind: "create" | "handoff"): boolean {
    return this.runs.find(item => item.id === eventId && item.event?.id === eventId)?.eventBudget?.declined?.includes(kind) === true;
  }

  /** Give back a charge for an action that never ran (it failed its checks after the owner's OK). A recorded action is never released. */
  releaseEventAdmission(eventId: string, admissionId: string): boolean {
    const budget = this.runs.find(item => item.id === eventId && item.event?.id === eventId)?.eventBudget;
    const index = budget?.admissions.findIndex(item => item.id === admissionId) ?? -1;
    if (!budget || index < 0 || budget.admissions[index].receipt) return false;
    this.commitMutation(() => { budget.admissions.splice(index, 1); });
    return true;
  }

  /** After a restart nothing in this process tracks a synchronous ask that ran past its wait: a `timeout:<task>` receipt
   * whose task can no longer be found (not finished, not queued, not running) becomes `ended:interrupted`, so asking
   * again is a new, charged attempt and never returns a task id nothing can answer. */
  interruptUnresolvedEventTimeouts(resolvable: (taskId: string) => boolean): number {
    const stale: Array<{ receipt: string; set: (value: string) => void }> = [];
    for (const run of this.runs) for (const admission of run.eventBudget?.admissions ?? []) {
      if (admission.receipt?.startsWith("timeout:") && !resolvable(admission.receipt.slice("timeout:".length))) stale.push({ receipt: admission.receipt, set: value => { admission.receipt = value; } });
    }
    if (stale.length === 0) return 0;
    this.commitMutation(() => { for (const item of stale) item.set("ended:interrupted"); });
    return stale.length;
  }

  /** Is this admission already charged to the run? */
  eventAdmissionExists(eventId: string, admissionId: string): boolean {
    return this.runs.find(item => item.id === eventId && item.event?.id === eventId)?.eventBudget?.admissions.some(item => item.id === admissionId) === true;
  }

  closeEventBudget(eventId: string, reason: EventBudgetClosedReason = "connection"): boolean {
    const run = this.runs.find(item => item.id === eventId && item.event?.id === eventId);
    if (!run?.eventBudget) return false;
    if (!run.eventBudget.closed) this.commitMutation(() => { run.eventBudget!.closed = true; run.eventBudget!.closedReason = reason; });
    return true;
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && isOpen(run.status),
    ).length;
  }

  cancelQueuedWebhook(webhookId: string, message: string): void {
    let changed = false;
    for (const run of this.runs) {
      if (run.webhookId !== webhookId || run.status !== "queued") continue;
      run.status = "cancelled";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  /** interruptGeneration: the turn generation the caller is stopping (see interruptTurn). */
  async cancelRun(id: string, interruptGeneration?: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !isOpen(run.status)) return null;
    // a cancelled run never starts again: the task an unsaved start kept for it is not kept
    this.unsavedStartTasks.delete(run.id);
    this.commitMutation(() => {
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      if (run.eventBudget) { run.eventBudget.closed = true; run.eventBudget.closedReason ??= "stopped"; }
      if (run.watch) {
        const routine = this.routines.find(item => item.id === run.routineId);
        if (routine?.watch) {
          const now = Math.max(this.now(), routine.watch.state.updatedAt);
          routine.watch.state = pauseRoutineWatch(routine.watch.state, true, now);
          if (routine.enabled) routine.watch.state = pauseRoutineWatch(routine.watch.state, false, now);
        }
        run.watch.outcome = "abandoned";
        this.watchReads.get(run.routineId)?.abort();
      }
    });
    this.emitRun(run);
    if (run.threadId) {
      if (run.target === "room-goal" && run.groupId) {
        await this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
      } else {
        const runOn = run.runOn ?? "ember";
        await (interruptGeneration === undefined ? this.options.interruptTurn?.(run.botId, run.threadId, runOn)
          : this.options.interruptTurn?.(run.botId, run.threadId, runOn, interruptGeneration))?.catch(() => {});
      }
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** Clear every problem indicator at once (upstream #1629): stamp seenAt on
   * each unseen failed or missed run in one committed save, then emit the
   * updated runs so connected clients drop their dots. A failed save rolls
   * the stamps back, so a retry still finds them. */
  markAllSeen(): RoutineRun[] {
    if (!this.runs.some(isUnseenRoutineProblem)) return [];
    const stampAt = this.now();
    const updated: RoutineRun[] = [];
    this.commitMutation(() => {
      for (const run of this.runs) {
        if (!isUnseenRoutineProblem(run)) continue;
        run.seenAt = stampAt;
        updated.push(run);
      }
    });
    for (const run of updated) this.emitRun(run);
    return updated.map(cloneRun);
  }

  /** Delete one past run's record from the routine's history. Never the
   * routine itself and never another run. A run that is not settled yet
   * (queued, working or waiting on the owner) is cancelled, not deleted, so
   * it is refused here. The routine's own conversation stays: every run of the
   * routine works in it. Removed through the full save, so the run journal
   * writes a tombstone and the run stays gone after a restart. */
  deleteRun(id: string): RoutineRun | null {
    const at = this.runs.findIndex((run) => run.id === id);
    if (at === -1) return null;
    const run = this.runs[at]!;
    if (isOpen(run.status)) throw Object.assign(new Error("This run is still going. Cancel it first, then delete it."), { status: 409 });
    const removed = cloneRun(run);
    this.commitMutation(() => { this.runs.splice(at, 1); });
    this.options.emit?.({ kind: "routine.run.deleted", runId: removed.id, routineId: removed.routineId });
    return removed;
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save({ defer: true, runs: [run] });
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  start() {
    if (this.timer) return;
    this.startedAt = this.now();
    this.gateOpened = false;
    this.gateForced = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.busyRetry) clearTimeout(this.busyRetry);
    this.busyRetry = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const read of this.watchReads.values()) read.abort();
  }

  /** Stop runs that have outrun their wall-clock limit.
   *
   * DELIBERATELY OUTSIDE the dispatch guard. This scan used to live at the
   * top of `tick()`, inside `if (this.ticking) return`, which meant a single
   * dispatch that never settled — a provider wedged mid-handshake — left
   * `ticking` true forever, every later tick returned immediately, and the
   * run limit was never enforced again for ANY routine. The one mechanism
   * whose entire job is to stop a runaway was disabled by exactly the kind of
   * stuck call it exists to survive.
   *
   * Its own reentrancy flag, because it awaits interrupt callbacks that can
   * themselves be slow; a slow interrupt must not stack scans, but it also
   * must not block dispatch. Found by an external audit, 2026-09-05. */
  private enforcing = false;

  async enforceRunLimits(): Promise<void> {
    if (this.enforcing) return;
    this.enforcing = true;
    try {
      const now = this.now();
      for (const run of this.runs) {
        if (
          (run.status !== "running" && run.status !== "waiting") ||
          run.startedAt == null ||
          run.timeoutMinutes == null ||
          // SL-L section 8: time in line for a first seat is not the routine's
          // own work, so no limit runs until that seat is granted.
          (run.seatWait !== undefined && run.seatGrantedAt === undefined && run.resumedAt === undefined) ||
          now - (run.resumedAt ?? run.seatGrantedAt ?? run.startedAt) < run.timeoutMinutes * 60_000
        ) continue;
        // Waiting on the owner is not a runaway. A bot routine whose card is
        // still open ends its active time as "waiting on you", naming what it
        // is waiting for, and keeps the turn open on the card so answering it
        // carries on. (A room goal keeps its own limit rules.)
        if (run.status === "waiting" && run.target === "bot") {
          this.commitMutation(() => { run.status = "needs-you"; run.needsYouAt = now; });
          this.emitRun(run);
          try { this.options.onRunNeedsYou?.(cloneRun(run)); }
          catch (error) { console.error("routine: waiting-on-you notice failed", error); }
          continue;
        }
        const threadId = run.threadId;
        const detail = `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`;
        if (run.target === "room-goal") run.goalStatus = "limit-reached";
        this.failRun(run, detail);
        if (!threadId) continue;
        if (run.target === "room-goal" && run.groupId) {
          await this.options.interruptGoal?.(run.groupId, threadId, {
            status: "limit-reached",
            detail,
          }).catch(() => {});
        } else {
          await this.options.interruptTurn?.(run.botId, threadId, run.runOn ?? "ember").catch(() => {});
        }
      }
    } finally {
      this.enforcing = false;
    }
  }

  private busyRetry: ReturnType<typeof setTimeout> | null = null;
  /** The scheduler tick. It waits (asynchronously) while the revocation index build holds the writer lock, and it NEVER
   * rejects: callers use `void this.tick()`, and a rejection there would end the server. A lock failure that still gets
   * through leaves every run as it was (queued) and the tick runs again shortly; no run fails terminally on contention. */
  async tick(): Promise<void> {
    try {
      if (writersHeldForIndexBuild()) await awaitWriterGate();
      await this.tickBody();
      this.tickFailures = 0;
    } catch (error) {
      if (isDatabaseBusy(error)) this.retrySoon();
      else {
        this.tickFailures += 1;
        this.lastTickFault = error instanceof Error ? error.message : String(error);
        // Rate limited like the database's busy line: a save that keeps failing logs once a minute, with a count.
        rateLimited("routine-tick-failed", 60_000, (suppressed) => `routine: tick failed (${this.tickFailures} in a row${suppressed ? `, ${suppressed} more since the last line` : ""}): ${this.lastTickFault}`);
      }
    }
  }

  /** Consecutive ticks that failed for a reason other than a locked database (reset by the next good tick). */
  private tickFailures = 0;
  private lastTickFault = "";
  /** After this many failed ticks in a row the scheduler reports itself as not running on time. */
  static readonly TICK_FAILURES_BEFORE_STALLED = 5;
  /** Saves that failed while a run was being failed (failRun never throws), reset by the next save that succeeds. A
   * disk that cannot record runs is shown the same way as a scheduler that cannot tick. */
  private saveFaults = 0;
  /** The scheduler's own health, for whatever surface shows routine status: `stalled` once ticks keep failing, or once
   * runs keep failing to save. */
  schedulerStatus(): { stalled: boolean; consecutiveFailures: number; saveFaults: number } {
    const limit = RoutineManager.TICK_FAILURES_BEFORE_STALLED;
    return { stalled: this.tickFailures >= limit || this.saveFaults >= limit, consecutiveFailures: this.tickFailures, saveFaults: this.saveFaults };
  }

  private retrySoon(): void {
    if (this.busyRetry) return;
    this.busyRetry = setTimeout(() => { this.busyRetry = null; void this.tick(); }, 1_000);
    this.busyRetry.unref?.();
  }

  /** A run that met a locked database goes back to queued, with nothing of it lost, and the tick runs again. */
  private requeueBusy(run: RoutineRun): void {
    if (isLive(run.status)) { run.status = "queued"; run.startedAt = undefined; }
    this.save({ runs: [run] });
    this.emitRun(run);
    this.retrySoon();
  }

  private async tickBody(): Promise<void> {
    if (this.options.dispatchOpen && !this.options.dispatchOpen()) return;
    // Before the guard, on purpose — see enforceRunLimits.
    await this.enforceRunLimits();
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      let changed = false;
      const missedRuns: RoutineRun[] = [];
      // What the fleet walk below touched: its save appends only these (1.0.2 bgwork).
      const touchedRoutines: Routine[] = [], createdRuns: RoutineRun[] = [];
      // Indexed (A21): nothing to do in the fleet walk before the earliest due time, and one pass over the runs
      // answers every routine's overlap question instead of a scan of all runs per due routine.
      // 1.0.4 SL-I I3: a "when a limit resets" routine takes its next time from limit-state on every tick;
      // after it fired for one reset nothing is ahead until the engine records a new one (fires once per reset).
      for (const routine of this.routines) {
        if (!routine.enabled || routine.schedule.type !== "limit_reset") continue;
        const next = nextOccurrence(routine.schedule, now);
        if (next !== null && next !== routine.nextRunAt) { routine.nextRunAt = next; touchedRoutines.push(routine); changed = true; }
      }
      const fleetDue = now >= this.nextFleetDue();
      const openByRoutine = new Map<string, { open: boolean; scheduledQueued: boolean }>();
      if (fleetDue) for (const run of this.runs) {
        if (!isOpen(run.status)) continue;
        const entry = openByRoutine.get(run.routineId) ?? { open: false, scheduledQueued: false };
        entry.open = true;
        if (run.status === "queued" && (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule") entry.scheduledQueued = true;
        openByRoutine.set(run.routineId, entry);
      }
      for (const routine of fleetDue ? this.routines : []) {
        if(this.options.automaticPaused?.())break;
        if (routine.watch && (now >= routine.watch.state.definition.expiresAt || routine.watch.state.checks.length >= routine.watch.state.definition.maxChecks)) {
          if (routine.enabled || routine.nextRunAt !== null) {
            this.commitMutation(() => { routine.enabled = false; routine.nextRunAt = null; });
            this.emitRoutine(routine);
          }
          continue;
        }
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now) continue;
        const pendingAt = routine.nextRunAt;
        const late = now - pendingAt;
        const scheduledFor = routine.schedule.type === "interval" && late <= CATCH_UP_MS
          ? latestIntervalOccurrence(routine.schedule, now) ?? pendingAt
          : pendingAt;
        // One slow run must not build an unbounded queue of stale copies
        // behind it. The series still advances on its original phase. Every
        // recurring schedule needs this, not intervals alone: a daily routine
        // whose run is still running or waiting when tomorrow comes round
        // stacked another copy every day, and nothing ever cleared them.
        const open = openByRoutine.get(routine.id);
        const overlapping = routine.schedule.type !== "once" && open?.open === true;
        // "queue" (upstream #1564) lets ONE scheduled occurrence wait behind
        // the active run, never a backlog: while a scheduled run is already
        // queued, later occurrences are skipped as before.
        const scheduledQueued = overlapping && open?.scheduledQueued === true;
        if (!overlapping || (routine.overlap === "queue" && !scheduledQueued)) {
          if (late > CATCH_UP_MS) {
            const missed = this.newRun(routine, scheduledFor, false);
            createdRuns.push(missed);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.error = "This computer was offline for more than 12 hours after the scheduled time";
            this.emitRun(missed);
            missedRuns.push(cloneRun(missed));
          } else {
            const run = this.newRun(routine, scheduledFor, false);
            createdRuns.push(run);
            openByRoutine.set(routine.id, { open: true, scheduledQueued: true });
            this.emitRun(run);
          }
        } else {
          // Counted so a routine that never gets to run says so, instead of
          // its schedule silently doing nothing while an old run hangs.
          routine.skippedRuns = Math.min(Number.MAX_SAFE_INTEGER, (routine.skippedRuns ?? 0) + 1);
          routine.lastSkippedAt = scheduledFor;
        }
        routine.nextRunAt =
          routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
        // `updatedAt` is the optimistic definition revision carried by
        // routine confirmation cards. Moving the scheduler cursor is runtime
        // progress, not a definition edit, so recurring ticks must not make a
        // still-accurate pending confirmation stale. A one-time routine does
        // mutate its definition by auto-disabling after its occurrence.
        if (routine.schedule.type === "once") {
          routine.enabled = false;
          routine.updatedAt = Math.max(now, routine.updatedAt + 1);
        }
        this.emitRoutine(routine);
        touchedRoutines.push(routine);
        changed = true;
      }
      if (changed) this.save({ routines: touchedRoutines, runs: createdRuns });
      for (const missed of missedRuns) this.options.onRunFailed?.(missed);

      // One pass for the install-wide cap and the per-routine and per-thread "already working" questions below.
      let cap = this.options.maxConcurrentAutomaticRuns;
      const agingMs = this.options.automaticAgingMs ?? 120_000;
      let automaticRunning = 0, capHeld = 0;
      const liveRoutines = new Set<string>(), liveThreads = new Set<string>();
      for (const other of this.runs) {
        if (!isLive(other.status)) continue;
        liveRoutines.add(other.routineId);
        if (other.threadId) liveThreads.add(other.threadId);
        const source = other.triggerSource ?? (other.manual ? "manual" : "schedule");
        if (other.status === "running" && (source === "schedule" || source === "webhook")) automaticRunning++;
      }
      const automatic = (run: RoutineRun) => {
        const source = run.triggerSource ?? (run.manual ? "manual" : "schedule");
        return source === "schedule" || source === "webhook";
      };
      // Project routines run as room work after delivery (index.ts): they hold a place under the cap too.
      if (cap !== undefined && this.options.activeProjectRoutineRuns && this.runs.some(run => run.status === "queued" && automatic(run))) {
        try { automaticRunning += Math.max(0, Number(this.options.activeProjectRoutineRuns()) || 0); } catch { /* unknown: not counted */ }
      }
      // Order: the owner's own and channel runs newest first (as before), then automatic runs OLDEST first, so a
      // freed place under the cap goes to the run that has waited longest, never to the newest arrival.
      const queuedNow = this.runs.filter(run => run.status === "queued");
      const byAge = queuedNow.map((run, index) => ({ run, index })).filter(entry => automatic(entry.run))
        .sort((a, b) => (Number(a.run.createdAt) || 0) - (Number(b.run.createdAt) || 0) || a.index - b.index).map(entry => entry.run);
      const dispatchOrder = [...queuedNow.filter(run => !automatic(run)).reverse(), ...byAge];
      // the cap is sized from how long automatic runs take here, for the runs waiting now (automaticRunCap)
      if (cap !== undefined) cap = automaticRunCap({ base: cap, ceiling: this.options.automaticCapCeiling ?? cap, serviceMs: this.automaticServiceMs(), waiting: byAge.length + automaticRunning, windowMs: this.options.dispatchStaggerMs || 60_000 });
      // aging lets a long-held run past the cap (up to twice it), never past the machine's own ceiling
      const machineCeiling = this.options.automaticCapCeiling === undefined ? Infinity : Math.max(this.options.maxConcurrentAutomaticRuns ?? 0, this.options.automaticCapCeiling);
      const admissionLimit = (limit: number, aged: boolean) => Math.min(aged ? limit * 2 : limit, Math.max(limit, machineCeiling));
      const queuedIds = new Set(queuedNow.map(run => run.id));
      for (const id of [...this.automaticHeldSince.keys()]) if (!queuedIds.has(id)) this.automaticHeldSince.delete(id);
      // F2: is the run object this pass holds still the live one, and still queued? Another path can settle a run while the
      // pass awaits (a cancel), and a failed commitMutation replaces every run object with a clone (rollback): then every
      // later dispatchOrder entry is stale and a write through one would be persisted by dirtyRuns, so a replaced list ends
      // the tick ("replaced"); the next tick reacquires. No await sits between the last check and the start commit below.
      const generation = this.runsGeneration;
      // a fault on a run that had already left the queue: reported as this tick's own fault once the pass is over, so it
      // still counts in schedulerStatus() (tickFailures) and is never hidden behind a good tick
      let laterFault: unknown;
      const recheck = (run: RoutineRun): "go" | "skip" | "replaced" =>
        this.runsGeneration !== generation ? "replaced" : run.status === "queued" ? "go" : "skip";
      for (const run of dispatchOrder) {
        // F2: one bad run never holds the queue. Any non-busy throw before the run starts fails THAT run (failRun never
        // throws) and the loop goes on; a run another path settled meanwhile, or one already running, is left as it is.
        try {
        const head = recheck(run);
        if (head === "replaced") break;
        if (head === "skip") continue;
        // 1.0.4 SL-I I3: waiting for its engine's limit to reset
        if (run.limitWait && this.now() < run.limitWait.until) continue;
        // the build can start while this tick is between runs: the next dispatch waits it out before its first mutation
        if (writersHeldForIndexBuild()) {
          await awaitWriterGate();
          const after = recheck(run);
          if (after === "replaced") break;
          if (after === "skip") continue;
        }
        if (run.instructionEvidence?.length && !this.options.validateInstructionEvidence?.(untracked(run), plainCopy(run.instructionEvidence))) {
          this.failRun(run, "The evidence supporting these learned instructions is no longer available to this routine. Review its instructions before running it again.");
          continue;
        }
        if (run.channelOrigin !== undefined && (!channelOriginSchema.safeParse(run.channelOrigin).success || run.telegramConnectionId || this.options.isChannelCurrent?.(untracked(run.channelOrigin), run.botId) !== true)) {
          this.failRun(run, "Channel binding changed; review it in Murage."); continue;
        }
        if(run.triggerSource==="channel"){try{if(!run.humanPrincipal)throw new Error("HUMAN_LINK_REQUIRED");assertHumanPrincipal(run.humanPrincipal);}catch(error){this.failRun(run,error instanceof Error?error.message:String(error));continue;}}
        const sharedChannel = run.triggerSource === "channel" && run.target === "bot" && !!this.options.channelThread;
        // Channel messages share history: dispatch the oldest queued message
        // first, even though detached routine jobs retain their existing order.
        if (sharedChannel && this.runs.slice(0, this.runs.indexOf(run)).some(
          (prior) => prior.botId === run.botId && prior.triggerSource === "channel" && prior.status === "queued",
        )) continue;
        // A queued interval represents the latest useful check, not a backlog
        // item. If the bot stayed busy across later occurrences, align this
        // scheduled receipt to the newest due point immediately before it can
        // dispatch. Manual runs and webhook deliveries retain their exact
        // requested/received timestamps.
        const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
        if((triggerSource==="schedule"||triggerSource==="webhook")&&this.options.automaticPaused?.())continue;
        let startupNote = "";
        if (triggerSource === "schedule" && run.target === "bot") {
          if (this.options.startupReady && !this.gateOpened) {
            const open = await this.startupGateOpen(this.now());
            const after = recheck(run);
            if (after === "replaced") break;
            if (after === "skip") continue;
            if (!open) { this.heldByStartup.add(run.id); continue; }
          }
          if (this.heldByStartup.has(run.id) && this.gateForced) startupNote = STARTUP_NOTE;
          const stagger = this.options.catchUpStaggerMs ?? 0;
          if (run.scheduledFor < this.startedAt && stagger > 0 && this.lastCatchUpAt !== null && this.now() - this.lastCatchUpAt < stagger) continue;
          const deferral = this.deferrals.get(run.id);
          if (deferral && deferral.notBefore > this.now()) continue;
          if (this.options.connectorsMissing) {
            let missing = false;
            try { missing = await this.options.connectorsMissing(run.botId); } catch { missing = false; }
            // before any write: the deferral below must not write over a cancel
            const after = recheck(run);
            if (after === "replaced") break;
            if (after === "skip") continue;
            const attempts = deferral?.attempts ?? 0;
            if (missing && attempts < CONNECTOR_DEFER_DELAYS_MS.length) {
              const notBefore = this.now() + CONNECTOR_DEFER_DELAYS_MS[attempts];
              this.deferrals.set(run.id, { attempts: attempts + 1, notBefore });
              run.attention = `Waiting for connected apps to load. Retrying in ${Math.round(CONNECTOR_DEFER_DELAYS_MS[attempts] / 60_000)} minutes (attempt ${attempts + 1} of ${CONNECTOR_DEFER_DELAYS_MS.length + 1}).`;
              this.save({ defer: true, runs: [run] });
              this.emitRun(run);
              continue;
            }
            if (missing) startupNote = STARTUP_NOTE;
          }
        }
        const definition = triggerSource === "schedule" || triggerSource === "manual"
          ? this.routines.find((routine) => routine.id === run.routineId)
          : undefined;
        if (definition && definition.botId !== run.botId) {
          run.status = "cancelled";
          run.finishedAt = this.now();
          run.error = "The routine changed bots before this run started. Run it again with its current bot.";
          this.save({ runs: [run] });
          this.emitRun(run);
          continue;
        }
        if (triggerSource === "schedule" && definition?.schedule.type === "interval") {
          const latest = latestIntervalOccurrence(definition.schedule, now);
          if (latest !== null && latest > run.scheduledFor) {
            run.dueAt ??= run.scheduledFor;
            run.coalescedOccurrences = (run.coalescedOccurrences ?? 0) + 1;
            run.scheduledFor = latest;
            this.save({ runs: [run] });
            this.emitRun(run);
          }
        }
        // A queued occurrence waits for THIS routine's active run to finish,
        // not merely for a free thread slot on its bot: the bot may have
        // spare slots while the earlier run waits on a teammate. Resource
        // admission is unchanged; this only holds the run before it.
        const sameRoutineWorking = triggerSource === "schedule" && liveRoutines.has(run.routineId);
        const state = sameRoutineWorking ? "busy" : this.targetState(run);
        if (state === "busy") continue;
        if (state === "missing") {
          this.failRun(run, this.missingTargetMessage(run.target));
          continue;
        }
        // Fail closed: work on the Cloud VM cannot ask for approval yet, so neither a routine's level nor the unattended
        // rules can be enforced there. That holds for webhook runs and for a bot whose engine is the Cloud VM. startTurn
        // repeats this check on the engine it resolves, which is the one that counts.
        if ((triggerSource === "schedule" || triggerSource === "manual" || triggerSource === "webhook") &&
          (run.runOn === "cloud" || this.options.boxEngine?.(run.botId) === true)) {
          this.failRun(run, CLOUD_ROUTINE_NOT_YET);
          continue;
        }
        // Automatic runs (schedule, webhook) are spread, capped and owner-first (F19, A21), project routines
        // included (they are room work once delivered). The run stays queued with its id, so a held-back run starts
        // exactly once, on a later tick; nothing is missed. Oldest first (dispatchOrder); a run held back past
        // automaticAgingMs gets past the cap (up to twice the cap) and the gate admits it at its bound.
        if (!run.watch && (triggerSource === "schedule" || triggerSource === "webhook")) {
          const stagger = this.options.dispatchStaggerMs ?? 0;
          if (triggerSource === "schedule" && stagger > 0 && run.scheduledFor >= this.startedAt &&
            this.now() < run.scheduledFor + RoutineManager.staggerOffset(run.routineId, stagger)) continue;
          const monotonic = this.monotonicNow();
          const wall = this.now();
          let held = this.automaticHeldSince.get(run.id);
          if (!held) { // A run queued before this launch keeps the wait it had (from its stored creation time), short of the aging bound,
            // so a relaunch does not reset it and does not start every old run aged at once.
            const before = Number(run.createdAt) < this.startedAt ? Math.max(0, wall - Number(run.createdAt)) : 0;
            held = { waitedMs: Math.min(before, Math.max(0, agingMs - 1)), monotonic, wall }; this.automaticHeldSince.set(run.id, held); }
          else {
            held.waitedMs += Math.max(0, monotonic - held.monotonic, wall - held.wall);
            held.monotonic = monotonic; held.wall = wall;
          }
          const waitedMs = held.waitedMs;
          const aged = waitedMs >= agingMs;
          if (cap !== undefined && automaticRunning >= admissionLimit(cap, aged)) { capHeld++; continue; }
          if (this.options.admitAutomatic && !this.options.admitAutomatic(untracked(run), waitedMs)) continue;
        }
        if (run.target === "room-goal" && this.options.projectRoutine) {
          // a refusal (a closed or ended project) or any other fault fails this run in the guard below
          const delivered = this.options.projectRoutine(cloneRun(run));
          if (delivered) {
            if (triggerSource === "schedule" || triggerSource === "webhook") automaticRunning++;
            run.threadId = delivered.threadId;
            run.startedAt = this.now();
            run.slotAt = this.slotAt(run, triggerSource);
            run.finishedAt = this.now();
            run.status = "completed";
            run.goalStatus = "completed";
            run.attention = "Posted to the project chat";
            this.save({ runs: [run] });
            this.emitRun(run);
            continue;
          }
        }
        if (run.watch) { await this.checkWatch(run); continue; }
        // One conversation per routine: a scheduled or manual run of a bot
        // routine works in the routine's own task, after the one before it.
        // It waits while that conversation is busy (an earlier run, or the
        // owner talking there) rather than opening another.
        const owner = run.target === "bot" && !sharedChannel && (triggerSource === "schedule" || triggerSource === "manual")
          ? this.routines.find((routine) => routine.id === run.routineId && routine.botId === run.botId)
          : undefined;
        // 1.0.4 SL-I I3: a run back from a limit wait carries on in its own conversation
        const limitRetry = Boolean(run.limitWait && run.threadId && run.target === "bot" && !sharedChannel && this.options.taskExists?.(run.botId, run.threadId));
        const reusable = limitRetry ? run.threadId : owner?.threadId && this.options.taskExists?.(run.botId, owner.threadId) ? owner.threadId : undefined;
        if (reusable && (liveThreads.has(reusable) || this.options.threadBusy?.(run.botId, reusable))) continue;
        // A webhook is an incoming message, so make its task the bot's live
        // chat immediately. Scheduled work remains detached and unobtrusive.
        // From here to its engine start the run is starting: background work waits (owner-first.ts).
        let releaseStart: () => void = () => {};
        try { releaseStart = this.options.beginStart?.() ?? releaseStart; } catch { /* no gate: nothing held */ }
        try {
        const unsaved = !reusable && !sharedChannel ? this.unsavedStartTasks.get(run.id) : undefined;
        const keptTask = unsaved && (run.target === "room-goal"
          ? Boolean(run.groupId && this.options.goalTaskExists?.(run.groupId, unsaved))
          : !this.options.taskExists || this.options.taskExists(run.botId, unsaved)) ? unsaved : undefined;
        if (unsaved && !keptTask) this.unsavedStartTasks.delete(run.id);
        const task = keptTask
          ? { threadId: keptTask }
          : run.target === "room-goal"
          ? run.groupId
            ? this.options.createGoalTask?.(run.groupId, run.routineName) ?? null
            : null
          : sharedChannel
            ? this.options.channelThread!(run.botId,run.humanPrincipal)
            : reusable
              ? { threadId: reusable }
              : this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
        if (!task) {
          this.failRun(run, run.target === "room-goal"
            ? "Could not create a room task for this goal"
            : sharedChannel ? "Could not find the conversation for this channel" : "Could not create a task for this run");
          continue;
        }
        if (sharedChannel && (this.runs.some((active) => active.threadId === task.threadId &&
          isLive(active.status)) || this.options.threadBusy?.(run.botId, task.threadId))) continue;
        const before = { threadId: run.threadId, startedAt: run.startedAt, slotAt: run.slotAt, attention: run.attention, ownerThreadId: owner?.threadId };
        const wasLiveRoutine = liveRoutines.has(run.routineId);
        const wasLiveThread = liveThreads.has(task.threadId);
        const countedAutomatic = triggerSource === "schedule" || triggerSource === "webhook";
        run.threadId = task.threadId;
        run.startedAt = this.now();
        run.slotAt = this.slotAt(run, triggerSource);
        run.status = "running";
        liveRoutines.add(run.routineId); liveThreads.add(task.threadId);
        if (countedAutomatic) automaticRunning++;
        if (triggerSource === "schedule" && run.scheduledFor < this.startedAt) this.lastCatchUpAt = this.now();
        if (this.deferrals.delete(run.id) && run.attention?.startsWith("Waiting for connected apps")) run.attention = undefined;
        this.heldByStartup.delete(run.id);
        const adopted = owner && this.options.taskExists && owner.threadId !== task.threadId;
        if (adopted) owner.threadId = task.threadId;
        try {
          this.save({ runs: [run], routines: adopted ? [owner] : [] });
          this.unsavedStartTasks.delete(run.id);
        } catch (error) {
          // No engine turn has started: a run that could not be recorded as running goes back to queued, so it is
          // retried or failed by the guard below instead of sitting as a running run no engine is working on.
          run.status = "queued";
          run.threadId = before.threadId; run.startedAt = before.startedAt; run.slotAt = before.slotAt; run.attention = before.attention;
          // The task this start opened is kept for the run's next start: restoring the old thread alone orphaned it, and
          // every later pass opened another one.
          if (!reusable && !sharedChannel) this.unsavedStartTasks.set(run.id, task.threadId);
          if (adopted && owner) owner.threadId = before.ownerThreadId;
          if (!wasLiveRoutine) liveRoutines.delete(run.routineId);
          if (!wasLiveThread) liveThreads.delete(task.threadId);
          if (countedAutomatic) automaticRunning--;
          throw error;
        }
        this.emitRun(run);
        if (adopted) this.emitRoutine(owner);
        if (owner && !limitRetry) {
          try { this.options.onRunDispatch?.(cloneRun(run), Boolean(reusable)); }
          catch (error) { console.error("routine: run marker failed", error); }
        }
        const failDispatch = (message: string) => {
          if (run.target === "bot" && isLive(run.status) && this.limitWaitFor(run, { message })) return;
          if (BUSY_MESSAGE.test(message)) {
            // contention is not a failure of the run: it goes back to the queue with its occurrence intact
            if (isLive(run.status)) this.requeueBusy(run);
            return;
          }
          if (!sharedChannel) return this.failThread(task.threadId, message);
          // A delayed callback from an earlier message cannot fail the next
          // message merely because both used this conversation.
          if (!isLive(run.status)) return;
          this.failRun(run, message);
          queueMicrotask(() => void this.tick());
        };
        try {
          const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
          if (!prompt) {
            failDispatch("The routine was deleted before it could start");
            continue;
          }
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          if (run.target === "room-goal") {
            if (!run.groupId || !this.options.startGoal) {
              this.failThread(task.threadId, "Room goal routines are unavailable");
              continue;
            }
            await this.options.startGoal(
              run.groupId,
              task.threadId,
              prompt,
              run.botId,
              run.id,
              (message) => this.failThread(task.threadId, message),
            );
          } else {
            const carried = owner ? this.carriedReport(run, owner, task.threadId) : null;
            const instructions = carried ? `${prompt}\n\n${carriedReportBlock(carried)}` : prompt;
            await this.options.startTurn(
              run.botId,
              task.threadId,
              startupNote ? `${startupNote}\n\n${composeExecutionPrompt(instructions, run.attachments)}` : composeExecutionPrompt(instructions, run.attachments),
              run.runOn ?? "ember",
              triggerSource,
              failDispatch,
              run.event?.budgetId,
              run.notOwnerAudience === true,
              run.id,
            );
          }
        } catch (error) {
          failDispatch(error instanceof Error ? error.message : String(error));
        }
        } finally { releaseStart(); }
        } catch (error) {
          const live = this.runsGeneration === generation ? run : this.runs.find((candidate) => candidate.id === run.id);
          // a locked database is contention, not a failure of the run: it stays queued and the tick runs again shortly
          if (isDatabaseBusy(error)) this.retrySoon();
          else if (live?.status === "queued") this.failRun(live, error instanceof Error ? error.message : String(error));
          else laterFault ??= error;
          if (this.runsGeneration !== generation) break;
        }
      }
      if (capHeld && this.now() - this.capLoggedAt >= 60_000) {
        this.capLoggedAt = this.now();
        console.log(`[routines] ${capHeld} due run${capHeld === 1 ? "" : "s"} waiting: ${automaticRunning} automatic runs already running (install-wide cap ${cap})`);
      }
      if (laterFault !== undefined) throw laterFault;
    } finally {
      this.ticking = false;
    }
  }

  /** min(nextRunAt of enabled routines, watch expiry of watched ones): nothing in the fleet walk can happen before it. */
  private nextFleetDue(): number {
    if (this.fleetDueAt !== null) return this.fleetDueAt;
    let due = Infinity;
    for (const routine of this.routines) {
      if (routine.watch && (routine.enabled || routine.nextRunAt !== null)) {
        // a watch that has used up its checks is closed on the next tick
        if (routine.watch.state.checks.length >= routine.watch.state.definition.maxChecks) return (this.fleetDueAt = -Infinity);
        due = Math.min(due, routine.watch.state.definition.expiresAt);
      }
      if (routine.enabled && routine.nextRunAt != null) due = Math.min(due, routine.nextRunAt);
    }
    return (this.fleetDueAt = due);
  }

  /** A routine's fixed start offset inside the stagger window (FNV-1a of its id): the same every tick and every start. */
  /** When the run was due to start: an on-time scheduled run starts at its own offset in the spread, any other at its due time. */
  private slotAt(run: RoutineRun, triggerSource: RoutineRunTrigger): number {
    const stagger = this.options.dispatchStaggerMs ?? 0;
    // from the due time recorded when the run was scheduled, never the one a queued interval run was moved on to
    const due = run.dueAt ?? run.scheduledFor;
    return triggerSource === "schedule" && stagger > 0 && due >= this.startedAt
      ? due + RoutineManager.staggerOffset(run.routineId, stagger) : due;
  }

  static staggerOffset(routineId: string, windowMs: number): number {
    if (!(windowMs > 0)) return 0;
    let hash = 0x811c9dc5;
    for (let index = 0; index < routineId.length; index++) { hash ^= routineId.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return hash % Math.floor(windowMs);
  }

  private async startupGateOpen(now: number): Promise<boolean> {
    if (this.gateOpened) return true;
    const gate = this.options.startupReady;
    if (!gate) { this.gateOpened = true; return true; }
    try { if (await gate()) { this.gateOpened = true; return true; } }
    catch { /* a failing check counts as not ready until the bound */ }
    if (now - this.startedAt >= (this.options.startupWaitMs ?? STARTUP_WAIT_MS)) {
      this.gateOpened = true;
      this.gateForced = true;
      return true;
    }
    return false;
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && isLive(r.status));
    if (!run) return null;
    if (run.triggerSource === "channel" && this.options.channelThread) {
      // A reused conversation also receives late events from its previous
      // turn. Only the first fresh start can bind this delivery's identity.
      if (!event.turnId) return null;
      if (!run.channelTurnId) {
        if (event.type !== "turn.started" || this.runs.some((prior) => prior.id !== run.id &&
          prior.threadId === event.threadId && prior.channelTurnId === event.turnId)) return null;
        run.channelTurnId = event.turnId;
        this.save({ defer: true, runs: [run] });
      }
      if (event.turnId !== run.channelTurnId) return null;
    }
    // A room goal contains several provider turns. Its orchestrator owns the
    // terminal decision and reports it through finishGoalRun; one member's
    // completion and private coordinator envelope are only intermediate
    // protocol, never the routine receipt's result.
    if (
      run.target === "room-goal" &&
      (event.type === "turn.completed" || (event.type === "item.completed" && event.itemType === "assistant_text"))
    ) return null;
    if (event.type === "item.started" && event.itemType === "tool") {
      // A call to a required tool family: if that family turns out not to have
      // loaded and the call failed, the run needed it and it was blocked.
      const label = requiredToolLabelOf(event);
      if (label && event.itemId) {
        const calls = this.requiredToolCalls.get(run.id) ?? new Map<string, { label: string; failed: boolean; op: string }>();
        // The operation is the tool and what it was asked to do: a later
        // success of the same operation (a retry) settles an earlier failure.
        let input = "";
        try { input = JSON.stringify((event as { input?: unknown }).input ?? null) ?? ""; } catch { /* unserialisable input: the title alone names it */ }
        calls.set(event.itemId, { label, failed: false, op: `${label}\0${event.title ?? ""}\0${input}` });
        this.requiredToolCalls.set(run.id, calls);
      }
      return null;
    }
    if (event.type === "item.completed" && event.itemType === "tool") {
      const all = this.requiredToolCalls.get(run.id);
      const call = event.itemId ? all?.get(event.itemId) : undefined;
      if (call && !event.ok) call.failed = true;
      else if (call && all) for (const other of all.values()) if (other.op === call.op) other.failed = false;
      return null;
    }
    if (event.type === "request.opened") {
      run.status = "waiting";
      run.attention = redactSecretsInText(event.summary).trim().slice(0, 500) || undefined;
    } else if (event.type === "request.resolved") {
      // answered after the run limit: the limit counts again from now
      if (run.status === "needs-you") run.resumedAt = this.now();
      run.status = "running";
      run.attention = undefined;
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = redactSecretsInText(event.text).trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      run.error = redactSecretsInText(event.message).slice(0, 500);
    } else if (event.type === "turn.retrying") {
      // the driver will relaunch this same run; a transient blip is not a
      // receipt-worthy failure, so keep the run running and stay quiet
      return null;
    } else if (event.type === "turn.completed" && run.cardsOpen?.length && turnSucceeded(event)) {
      // The turn ended, but one of the harness's own cards is still open (its
      // tool call could not wait that long). Not a finished run and not a
      // failure: it is waiting on you, and answering carries it on.
      run.cost = event.cost;
      run.turnEnded = true;
      if (run.status !== "needs-you") run.needsYouAt = this.now();
      run.status = "needs-you";
      this.save({ runs: [run] });
      this.emitRun(run);
      try { this.options.onRunNeedsYou?.(cloneRun(run)); }
      catch (error) { console.error("routine: waiting-on-you notice failed", error); }
      return cloneRun(run);
    } else if (event.type === "turn.completed") {
      run.cost = event.cost;
      run.denials = event.denials;
      // A stopped turn settles ok:true "cancelled"; it is not a completed run
      // (STOP1). The user's own cancel sets the run cancelled before its turn
      // stops, so this is a host stop (watchdog, connection change).
      if (!turnSucceeded(event)) {
        // 1.0.4 SL-I I3: the engine's limit, before the run did anything: it waits for the reset instead of failing
        if (!turnStopped(event) && run.target === "bot" && this.limitWaitFor(run, { event })) return cloneRun(run);
        // A bare "error" or "tool_error" says less than the runtime.error that
        // came before it; keep the detailed one (OpenMausBot #2214, Apache-2.0).
        const genericStopReason = event.stopReason === "error" || event.stopReason === "tool_error";
        // Murage's own Ask stop (a change ran anyway on an Ask run) fails the run with the Ask note, not as completed work.
        this.failRun(run, turnAskStopped(event)
          ? ASK_STOP_NOTE
          : turnStopped(event)
          ? "The run was stopped before it finished"
          : (genericStopReason ? run.error : undefined) ?? event.stopReason ?? run.error ?? "The bot did not complete this run");
        queueMicrotask(() => void this.tick());
        return cloneRun(run);
      }
      // Required tools that had not loaded are degraded availability, recorded
      // on the run. The run fails only when its task needed them: a call to
      // one of them failed, or the bot said the task is not done (the notice
      // asks it to start its reply with NOT_DONE_PREFIX then). A run that
      // summarises supplied text completes while bot messaging is down.
      const calls = [...(this.requiredToolCalls.get(run.id)?.values() ?? [])];
      this.requiredToolCalls.delete(run.id);
      if (event.toolsUnavailable?.length || event.mcpReadiness === "unknown") {
        run.toolsUnavailable = event.toolsUnavailable?.length ? [...event.toolsUnavailable] : undefined;
        run.toolsReadiness = event.mcpReadiness;
        const unavailable = new Set(event.toolsUnavailable ?? []);
        const blocked = [...new Set(calls.filter((call) => call.failed && unavailable.has(call.label)).map((call) => call.label))];
        const saidNotDone = startsWithNotDone(run.output ?? "");
        if (blocked.length || saidNotDone) {
          this.failRun(run, toolsUnavailableRunError(blocked.length ? blocked : [...unavailable]));
          queueMicrotask(() => void this.tick());
          return cloneRun(run);
        }
      }
      run.status = "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
    } else {
      return null;
    }
    this.save({ runs: [run] });
    this.emitRun(run);
    if (run.status === "completed") this.noteRecovery(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** The routine's last finished run before `run` failed: say the routine recovered. Best-effort, never throws. */
  private noteRecovery(run: RoutineRun) {
    if (!this.options.onRunRecovered) return;
    let previous: RoutineRun | undefined;
    for (const other of this.runs) {
      if (other.id === run.id || other.routineId !== run.routineId || other.finishedAt === undefined) continue;
      if (other.status !== "failed" && other.status !== "completed") continue;
      if (other.finishedAt > (run.finishedAt ?? Infinity)) continue;
      // runs are kept in creation order: on a tie the later one is the newer word
      if (!previous || other.finishedAt >= previous.finishedAt!) previous = other;
    }
    if (previous?.status !== "failed") return;
    try { this.options.onRunRecovered(cloneRun(run), cloneRun(previous)); }
    catch (error) { console.error("routine: recovery note failed", error); }
  }

  failThread(threadId: string, message: string) {
    const run = this.runs.find((r) => r.threadId === threadId && isLive(r.status));
    if (!run) return;
    this.failRun(run, message);
    queueMicrotask(() => void this.tick());
  }

  finishGoalRun(runId: string, status: GroupGoalRunStatus, detail: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.id === runId &&
        candidate.target === "room-goal" &&
        isLive(candidate.status),
    );
    if (!run || status === "working") return null;
    const safeDetail = redactSecretsInText(detail).trim();
    run.goalStatus = status;
    // Only a completed goal is a completed run. A team asking the human a
    // question is still waiting on them, and a blocked or turn-capped goal
    // did not finish — reporting either as "completed" would silence the
    // one outcome that most needs a person's attention.
    if (status === "failed" || status === "blocked" || status === "limit-reached") {
      this.failRun(
        run,
        safeDetail ||
          (status === "limit-reached" ? "The room goal reached its turn limit" : "The room goal is blocked"),
      );
    } else if (status === "needs-input" || status === "paused") {
      run.status = "waiting";
      run.attention = safeDetail.slice(0, 500) || (status === "paused" ? "The room goal is paused" : "The team needs your input");
      run.error = undefined;
      this.save({ runs: [run] });
      this.emitRun(run);
    } else {
      run.status = status === "stopped" ? "cancelled" : "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
      if (status !== "stopped") run.output = safeDetail.slice(0, 2_000) || undefined;
      this.save({ runs: [run] });
      this.emitRun(run);
      if (run.status === "completed") this.noteRecovery(run);
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** Calls to required tool families in each live run's turn, by item id. */
  private readonly requiredToolCalls = new Map<string, Map<string, { label: string; failed: boolean; op: string }>>();

  /** 1.0.4 SL-I I3: back to `queued` until the engine's limit resets (spread a minute per other run waiting on it);
   * the third refusal fails the run. Not a failure meanwhile, so the failure streak is untouched. */
  private limitWaitFor(run: RoutineRun, refusal: { event?: RuntimeEvent; message?: string }): boolean {
    let info: RoutineLimitRefusal | null = null;
    try { info = this.options.limitRefusal?.(cloneRun(run), refusal) ?? null; } catch { info = null; }
    if (!info) return false;
    const n = (run.limitWait?.n ?? 0) + 1;
    if (n >= LIMIT_WAIT_TRIES) { this.failRun(run, info.failLine); queueMicrotask(() => void this.tick()); return true; }
    const others = this.runs.filter(other => other.id !== run.id && other.status === "queued" && other.limitWait?.engineKey === info!.engineKey).length;
    this.requiredToolCalls.delete(run.id);
    run.status = "queued";
    run.startedAt = undefined;
    run.limitWait = { engineKey: info.engineKey, until: Math.max(this.now(), info.until) + others * LIMIT_WAIT_SPREAD_MS, n };
    run.attention = redactSecretsInText(info.line).slice(0, 500);
    this.save({ runs: [run] });
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return true;
  }

  /** Never throws (F2): the card and the owner hear first, then the save. A save that fails (a full disk) leaves the run
   * failed in memory, so this process never dispatches it again, and is counted in schedulerStatus().saveFaults; after a
   * restart the run reloads as it was last saved and is evaluated afresh. Owner notification is best-effort. */
  private failRun(run: RoutineRun, message: string) {
    this.requiredToolCalls.delete(run.id);
    this.unsavedStartTasks.delete(run.id);
    run.status = "failed";
    run.attention = undefined;
    run.error = redactSecretsInText(message).slice(0, 500);
    run.finishedAt = this.now();
    const fault = (what: string, error: unknown) => rateLimited(`routine-fail-${what}`, 60_000, (suppressed) =>
      `routine: a failed run's ${what} did not complete${suppressed ? ` (${suppressed} more since the last line)` : ""}: ${error instanceof Error ? error.message : String(error)}`);
    try { this.emitRun(run); } catch (error) { fault("update", error); }
    try { this.options.onRunFailed?.(cloneRun(run)); } catch (error) { fault("notification", error); }
    try { this.save({ runs: [run] }); }
    catch (error) {
      this.saveFaults += 1;
      fault("save", error);
    }
  }

  private targetState(target: Pick<RoutineRun, "target" | "groupId" | "botId">): "ready" | "busy" | "missing" {
    if (target.target === "room-goal") {
      if (!target.groupId || !this.options.goalState) return "missing";
      return this.options.goalState(target.groupId, target.botId);
    }
    return this.options.botState(target.botId);
  }

  private missingTargetMessage(target: RoutineTarget): string {
    return target === "room-goal"
      ? "The assigned room or coordinator no longer exists"
      : "The assigned bot no longer exists";
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    // Return the original time, not max(at, now): tick() already decides
    // whether a stale "once" run fires or is recorded as "missed" based on
    // how far past the scheduled time it is. Clamping to now here hides the
    // original schedule from the run receipt (scheduledFor would read "now"
    // instead of the time the user chose) and prevents the 12-hour missed
    // threshold from ever triggering for a "once" routine created late.
    if (schedule.type === "once") return schedule.at;
    return nextOccurrence(schedule, now);
  }

  /** The last run's report for this run to start with, or null. Derived at the moment the run starts and never stored (SL-M).
   * Anything that cannot be proved carries nothing: the run is then exactly the run it always was. */
  private carriedReport(run: RoutineRun, routine: Routine, threadId: string): string | null {
    const source = (item: RoutineRun) => item.triggerSource ?? (item.manual ? "manual" : "schedule");
    const plain = (item: RoutineRun) => (source(item) === "schedule" || source(item) === "manual") && !item.humanPrincipal && !item.notOwnerAudience;
    if (routine.carryLastReport !== true || routine.schedule.type === "once" || routine.target !== "bot" || run.target !== "bot") return null;
    if (!plain(run) || run.prompt !== routine.prompt) return null;
    if (!routine.threadId || routine.threadId !== threadId) return null;
    let prior: RoutineRun | undefined;
    let priorAt = -Infinity;
    for (const item of this.runs) {
      if (item.routineId !== routine.id || item.id === run.id || isOpen(item.status)) continue;
      const at = item.finishedAt ?? item.createdAt;
      if (!prior || at > priorAt || (at === priorAt && item.createdAt > prior.createdAt)) { prior = item; priorAt = at; }
    }
    if (!prior || prior.status !== "completed") return null;
    if (prior.botId !== run.botId || prior.threadId !== threadId || !plain(prior) || prior.prompt !== routine.prompt) return null;
    const output = prior.output?.trim();
    if (!output || prior.startedAt === undefined || prior.finishedAt === undefined) return null;
    try {
      if (this.options.priorReplyCarryable?.(threadId, prior.startedAt, prior.finishedAt) !== true) return null;
    } catch { return null; }
    const report = redactSecretsInText(output).slice(0, 2_000);
    let derived = true;
    try { derived = this.options.priorReplyEmailDerived?.(threadId, prior.startedAt, prior.finishedAt) ?? false; } catch { /* fenced */ }
    return derived ? fenceEmailDerived(report, `routine-run-${prior.id}`) : report;
  }

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const instruction = routine.instructionHistory?.find(item => item.id === routineInstructionRevision(routine));
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      instructionRevision: routineInstructionRevision(routine),
      ...(instruction?.evidence ? { instructionEvidence: plainCopy(instruction.evidence), instructionEvaluationReceiptId: instruction.evaluationReceiptId } : {}),
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      attachments: cloneAttachments(routine.attachments),
      target: routine.target,
      groupId: routine.groupId,
      botId: routine.botId,
      runOn: routine.runOn ?? "ember",
      scheduledFor,
      dueAt: scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      sourceThreadId: routine.sourceThreadId,
      createdAt: this.now(),
    };
    if (routine.watch) run.watch = { watchId: routine.id, ownerBotId: routine.watch.ownerBotId, source: plainCopy(routine.watch.state.definition.source), outcome: "pending" };
    run.event = routineEventForRun(run);
    run.eventBudget = newEventActionBudget();
    if (run.watch) { run.eventBudget.closed = true; run.eventBudget.closedReason = "watch"; }
    const tracked = this.trackRun(run);
    this.runs.push(tracked);
    return tracked;
  }

  private async checkWatch(run: RoutineRun): Promise<void> {
    const routine = this.routines.find(item => item.id === run.routineId);
    if (!routine?.watch || !run.watch || !routine.enabled || run.watch.watchId !== routine.id) {
      this.commitMutation(() => { run.status = "cancelled"; if (run.watch) run.watch.outcome = "abandoned"; run.finishedAt = this.now(); });
      this.emitRun(run); return;
    }
    const now = Math.max(this.now(), routine.watch.state.updatedAt);
    const admission = reserveRoutineWatchCheck(routine.watch.state, run.id, now);
    if (admission.outcome !== "admitted") {
      this.commitMutation(() => { run.status = "cancelled"; run.watch!.outcome = "abandoned"; run.finishedAt = now; });
      this.emitRun(run); return;
    }
    const controller = new AbortController();
    this.commitMutation(() => { routine.watch!.state = admission.state; run.status = "running"; run.startedAt = now; });
    this.watchReads.set(routine.id, controller);
    let observation: RoutineWatchObservation | null = null;
    let failure: string | undefined;
    try {
      if (!this.options.readWatchSource || !this.options.validateWatchSource) throw new Error("File watch source access is unavailable");
      this.options.validateWatchSource(routine.watch.ownerBotId, routine.botId, untracked(run.watch.source));
      observation = await this.options.readWatchSource(routine.watch.ownerBotId, routine.botId, untracked(run.watch.source), controller.signal);
      this.options.validateWatchSource(routine.watch.ownerBotId, routine.botId, untracked(run.watch.source));
    } catch { failure = "The selected watch file is unavailable or no longer permitted. Review its working folder and source."; }
    finally { this.watchReads.delete(routine.id); }
    const current = this.routines.find(item => item.id === routine.id);
    if (!current?.watch) {
      if (run.status === "running") {
        this.commitMutation(() => { run.status = "cancelled"; run.watch!.outcome = "abandoned"; run.finishedAt = this.now(); });
        this.emitRun(run);
      }
      return;
    }
    if (run.status !== "running") return;
    const completedAt = Math.max(this.now(), current.watch.state.updatedAt);
    const automatic = run.triggerSource !== "manual";
    this.commitMutation(() => {
      if (controller.signal.aborted || !current.enabled || automatic && this.options.automaticPaused?.()) {
        current.watch!.state = pauseRoutineWatch(current.watch!.state, true, completedAt);
        if (current.enabled) current.watch!.state = pauseRoutineWatch(current.watch!.state, false, completedAt);
      }
      const completion = completeRoutineWatchCheck(current.watch!.state, run.id, failure ? null : observation, completedAt);
      current.watch!.state = completion.state;
      run.watch!.outcome = completion.outcome === "stale" ? "abandoned" : completion.outcome;
      run.status = ["stale", "abandoned"].includes(completion.outcome) ? "cancelled" : completion.outcome === "failed" ? "failed" : "completed";
      run.finishedAt = completedAt;
      if (completion.outcome === "changed") run.output = `File changed: ${run.watch!.source.sourceId}`;
      if (completion.outcome === "failed") run.error = failure;
      if (completedAt >= completion.state.definition.expiresAt || completion.state.checks.length >= completion.state.definition.maxChecks) { current.enabled = false; current.nextRunAt = null; }
    });
    this.emitRoutine(current);
    this.emitRun(run);
    if (run.watch?.outcome === "failed") this.options.onRunFailed?.(cloneRun(run));
  }

  /** One line in the history of the live run working in this conversation:
   * a new line up to RUN_NOTES_MAX, and every repeat or line past that
   * counted in `notesMore`. False when no live run works there. */
  noteRunLine(threadId: string, line: string): boolean {
    const run = this.runs.find((item) => item.threadId === threadId && isLive(item.status));
    if (!run) return false;
    this.appendRunNote(run, line);
    this.save({ runs: [run] });
    this.emitRun(run);
    return true;
  }

  private appendRunNote(run: RoutineRun, line: string): void {
    const notes = Array.isArray(run.notes) ? run.notes : [];
    if (notes.includes(line) || notes.length >= RUN_NOTES_MAX) run.notesMore = (typeof run.notesMore === "number" ? run.notesMore : 0) + 1;
    else run.notes = [...notes, line];
  }

  /** SL-L L4: the host reports the resource wait of this run's INITIAL turn
   * (`kind`), or that the wait ended with the seat granted (`null`). Only the
   * first seat is recorded: after a grant, or for a card continuation (which
   * has `resumedAt`), nothing changes. */
  runSeatWait(runId: string, kind: string | null): void {
    const run = this.runs.find((item) => item.id === runId);
    if (!run || !isLive(run.status) || run.seatGrantedAt !== undefined || run.resumedAt !== undefined) return;
    if (kind === null) {
      if (run.seatWait === undefined) return;
      delete run.seatWait;
      run.seatGrantedAt = this.now();
    } else {
      if (run.seatWait?.kind === kind) return;
      run.seatWait = { kind, at: run.seatWait?.at ?? this.now() };
    }
    this.save({ runs: [run] });
    this.emitRun(run);
  }

  /** The live run working in this conversation pinned `bundleId` (first pin only). */
  notePinnedBundle(threadId: string, bundleId: string): void {
    const run = this.runs.find((item) => item.threadId === threadId && isLive(item.status));
    if (!run || run.procedureBundleId) return;
    run.procedureBundleId = bundleId;
    this.save({ runs: [run] });
    this.emitRun(run);
  }

  private emitRoutine(routine: Routine) {
    this.fleetDueAt = null;
    this.options.emit?.({ kind: "routine", routine: this.routineWithHealth(routine) });
  }

  /** How long recent automatic runs took, start to finish (the last AUTOMATIC_SERVICE_SAMPLES of them). */
  private readonly automaticServiceTimes = new Map<string, number>();
  private automaticServiceMs(): number | undefined {
    const times = [...this.automaticServiceTimes.values()].sort((a, b) => a - b);
    return times.length ? times[Math.floor(times.length / 2)] : undefined;
  }
  private noteServiceTime(run: RoutineRun) {
    const source = run.triggerSource ?? (run.manual ? "manual" : "schedule");
    if ((source !== "schedule" && source !== "webhook") || isLive(run.status) || run.startedAt === undefined || run.finishedAt === undefined || run.watch) return;
    if (this.automaticServiceTimes.has(run.id) || run.target === "room-goal") return;
    this.automaticServiceTimes.set(run.id, Math.max(0, run.finishedAt - run.startedAt));
    if (this.automaticServiceTimes.size > AUTOMATIC_SERVICE_SAMPLES) this.automaticServiceTimes.delete(this.automaticServiceTimes.keys().next().value!);
  }

  private emitRun(run: RoutineRun) {
    this.noteServiceTime(run);
    this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
    this.notifyRunChanged(run);
    // A settled attempt moves the routine's failure streak.
    if (run.status === "completed" || run.status === "failed") {
      const routine = this.routines.find((candidate) => candidate.id === run.routineId);
      if (routine) this.emitRoutine(routine);
    }
  }

  private notifyRunChanged(run: RoutineRun) {
    try {
      this.options.onRunChanged?.(cloneRun(run));
    } catch (error) {
      // Reporting is secondary to scheduler truth. A transcript write must
      // never strand the run in memory or prevent the next tick.
      console.error("routine: source-thread lifecycle update failed", error);
    }
  }

  private matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt) return null;
    if (
      receipt.action !== request.action ||
      receipt.messageId !== request.messageId ||
      receipt.botId !== request.botId ||
      receipt.threadId !== request.threadId ||
      receipt.fingerprintVersion !== request.fingerprintVersion ||
      receipt.fingerprint !== request.fingerprint
    ) {
      throw new Error("Routine request receipt does not match this confirmation card");
    }
    return receipt;
  }

  private rememberRoutineRequest(
    request: RoutineRequestCommit,
    resultId: string,
    appliedAt: number,
    appliedUpdatedAt?: number,
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing?.resultId !== undefined) {
      if (existing.resultId !== resultId) throw new Error("Routine request receipt has another result");
      return;
    }
    const applied = { resultId, appliedAt, ...(appliedUpdatedAt === undefined ? {} : { appliedUpdatedAt }) };
    if (existing) {
      // The receipt written before apply (SL-J J2) gains its result in this same write.
      this.routineRequestReceipts[this.routineRequestReceipts.indexOf(existing)] = { ...existing, ...applied };
      return;
    }
    this.routineRequestReceipts.unshift({ ...request, ...applied });
  }

  /**
   * A confirmation receipt is only true once the scheduler mutation and its
   * receipt reached the same atomic file. Restore the complete in-memory
   * state if writing or renaming that file fails so a retry cannot mistake an
   * uncommitted action for a durable one.
   */
  private commitMutation(mutate: () => void): void {
    this.runRevision++;
    this.fleetDueAt = null;
    const before = {
      routines: this.routines.map(cloneRoutine),
      runs: this.runs.map(cloneRun),
      receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
    };
    try {
      mutate();
      this.save();
    } catch (error) {
      this.routines = before.routines.map((routine) => this.trackRoutine(routine));
      this.runs = before.runs.map((run) => this.trackRun(run));
      this.routineRequestReceipts = this.trackReceipts(before.receipts);
      throw error;
    }
  }

  /** Inert additive batch; caller commits this file with the bot records. */
  preparePackageAddition(additions: Routine[]) {
    const ids = new Set([...this.routines, ...this.unloadedRoutines].map(routine => routine.id));
    for (const routine of additions) {
      if (ids.has(routine.id) || routine.enabled || routine.nextRunAt !== null) throw new Error("A package routine must be new and switched off");
      ids.add(routine.id);
    }
    // An imported routine arrives with its ceiling pinned: imported bots start at Ask, so does the routine.
    const next = [...this.routines, ...additions.map(routine => routine.permissionMode ? routine : { ...routine, permissionMode: "ask" as const })];
    // The bytes take their own generation, and publish records it, so correctness never rests on diskIsOurs() failing:
    // every state line written before this file is spent, and the routines folded into `next` are the whole state.
    const stateGeneration = randomUUID();
    return {
      // runsCommit stays as recorded: a file without it accepts every journal line, including
      // those of a save that was interrupted before its routines.json write (audit A-3).
      bytes: Buffer.from(JSON.stringify({ ...this.unknownFileFields, version: 1, routines: [...next, ...this.unloadedRoutines], routineRequestReceipts: this.routineRequestReceipts, ...(this.runsCommit === undefined ? {} : { runsCommit: this.runsCommit }), stateGeneration } satisfies RoutineFile, null, 2)),
      publish: () => { this.routines = next.map((routine) => this.trackRoutine(routine)); this.fleetDueAt = null; this.fullSave = true; this.generation = stateGeneration; this.journal.setGeneration(stateGeneration); },
    };
  }

  /** Persist routines.json and the run journal. Immediate by default (receipts,
   * grants, schedules and run starts rely on it throwing); `defer` coalesces to
   * once per 250 ms for cosmetic bookkeeping such as marking a run seen.
   * Passing `runs`/`routines` (1.0.2 bgwork) allows an incremental save: it
   * appends to the journal only what was written since the last save, found by
   * write tracking (tracked-state.ts), not by what the caller names, so its
   * bytes follow the change, never the number of routines or runs, and nothing
   * written by another path is left out. A save that passes neither rewrites
   * routines.json and compares everything, as before. */
  private save(options: { defer?: boolean; runs?: readonly RoutineRun[]; routines?: readonly Routine[] } = {}) {
    this.runRevision++;
    const hinted = options.runs !== undefined || options.routines !== undefined;
    if (hinted) {
      for (const run of options.runs ?? []) this.dirtyRuns.add(run);
      for (const routine of options.routines ?? []) this.dirtyRoutines.add(routine);
    } else this.fullSave = true;
    // only a routine change can move the fleet's earliest due time
    if (!hinted || options.routines?.length) this.fleetDueAt = null;
    if (options.defer) { scheduleCoalesced(this.file, () => this.saveNow()); return; }
    this.saveNow();
    cancelCoalesced(this.file);
  }

  private saveNow() {
    // Active receipts own cancellation, timeout, and provider-event routing;
    // evicting one would strand live work. Treat MAX_RUNS as a soft history
    // cap and reclaim only the oldest terminal receipts. An unusually large
    // active queue may exceed it until work settles.
    const removed: RoutineRun[] = [];
    let excess = this.runsRaw.length - MAX_RUNS;
    // on the raw list: the cap's own removals are accounted for (`trimmed`), so the list watch must not see them
    for (let index = 0; index < this.runsRaw.length && excess > 0;) {
      if (isOpen(this.runsRaw[index]!.status)) {
        index += 1;
        continue;
      }
      removed.push(...this.runsRaw.splice(index, 1));
      excess -= 1;
    }
    for (const run of removed) this.dirtyRuns.delete(run);
    this.sweep(removed.length);
    try {
      if (this.fullSave || this.pendingCommit !== null || this.generation === undefined || !this.diskIsOurs()) this.saveFull();
      else {
        // written since the last save, in list order; a run or routine that left the lists is not written back
        // straight from the dirty sets: a run or routine that left a list did so through a path that forces a full save
        const runs = [...this.dirtyRuns].map(untracked);
        const routines = [...this.dirtyRoutines].map(untracked);
        this.journal.append({ runs, routines, removed: removed.map(untracked) });
      }
      this.fullSave = false;
      this.dirtyRuns.clear();
      this.dirtyRoutines.clear();
      this.saveFaults = 0;
      this.savedRunCount = this.runs.length;
      this.savedRoutineCount = this.routines.length;
    } catch (error) {
      // what reached the disk is unknown: the next save compares everything
      this.fullSave = true;
      throw error;
    }
  }

  private trackRun(run: RoutineRun): RoutineRun {
    if (isTracked(run)) return run;
    const tracked: RoutineRun = track(run, () => { this.dirtyRuns.add(tracked); this.runRevision++; });
    return tracked;
  }

  private trackRoutine(routine: Routine): Routine {
    if (isTracked(routine)) return routine;
    // a routine write can move the fleet's earliest due time
    const tracked: Routine = track(routine, () => { this.dirtyRoutines.add(tracked); this.fleetDueAt = null; });
    return tracked;
  }

  /** Receipts live only in routines.json: any write to them makes the next save a full one. */
  private trackReceipts(receipts: RoutineRequestReceipt[]): RoutineRequestReceipt[] {
    return isTracked(receipts) ? receipts : track(receipts, () => { this.fullSave = true; });
  }

  /** Bring anything put into the lists without tracking under it, and account for what joined or left them since
   * the last save. A routine that joined or left, a list replaced, or a run that left other than by the history cap
   * (`trimmed`) makes this save a full one; a run that joined is written. */
  private sweep(trimmed: number): void {
    if (!isTracked(this.routineRequestReceipts)) { this.routineRequestReceipts = this.trackReceipts(this.routineRequestReceipts); this.fullSave = true; }
    // Incremental: the list watch queues what joined, so the walk over every routine and run happens only after a
    // list was replaced or an element was put in raw, never per save.
    if (this.walkRoutines) {
      this.walkRoutines = false;
      for (let index = 0; index < this.routinesRaw.length; index++) {
        const routine = this.routinesRaw[index]!;
        if (!isTracked(routine)) { this.routinesRaw[index] = this.trackRoutine(routine); this.fullSave = true; }
      }
    }
    if (this.routinesRaw.length !== this.savedRoutineCount) this.fullSave = true;
    let joined = 0;
    if (this.walkRuns) {
      this.walkRuns = false;
      this.joinedRuns.length = 0;
      for (let index = 0; index < this.runsRaw.length; index++) {
        let run = this.runsRaw[index]!;
        if (!isTracked(run)) run = this.runsRaw[index] = this.trackRun(run);
        if (!this.knownRuns.has(run)) { this.knownRuns.add(run); this.dirtyRuns.add(run); joined += 1; }
      }
    } else {
      const queued = this.joinedRuns.splice(0);
      for (const candidate of queued) {
        let run = candidate;
        if (!isTracked(run)) { run = this.trackRun(run); const at = this.runsRaw.indexOf(candidate); if (at >= 0) this.runsRaw[at] = run; this.fullSave = true; }
        if (!this.knownRuns.has(run)) { this.knownRuns.add(run); this.dirtyRuns.add(run); joined += 1; }
      }
    }
    if (this.runsRaw.length !== this.savedRunCount + joined - trimmed) this.fullSave = true;
  }

  /** routines.json is still the file this process last wrote (one stat). */
  private diskIsOurs(): boolean {
    const last = this.lastWritten;
    if (!last) return false;
    try {
      const stat = statSync(this.file);
      return stat.size === last.size && stat.mtimeMs === last.mtimeMs && stat.ino === last.ino;
    } catch { return false; }
  }

  private saveFull() {
    mkdirSync(dirname(this.file), { recursive: true });
    // History first: if routines.json then fails, nothing is lost, and a run
    // that exists only in the journal is still loaded on the next start.
    // When routines.json changes too, the appended lines carry a commit tag
    // that only counts once routines.json records it (routine-runs-journal.ts):
    // a crash between the two writes rolls both back, so a tick or a confirmed
    // action is applied exactly once on the next start.
    const textFor = (runsCommit: number | undefined, stateGeneration: string | undefined) => JSON.stringify({
      version: 1,
      ...this.unknownFileFields,
      routines: [...this.routines.map(untracked), ...this.unloadedRoutines],
      runs: [],
      routineRequestReceipts: untracked(this.routineRequestReceipts),
      ...(runsCommit === undefined ? {} : { runsCommit }),
      ...(stateGeneration === undefined ? {} : { stateGeneration }),
    } satisfies RoutineFile, null, 2);
    // A live state line means routines.json alone is not the whole state: rewrite it even if it reads the same.
    if (this.pendingCommit === null && !this.journal.hasRoutineLines() && this.fileUnchanged(textFor(this.runsCommit, this.generation))) {
      this.journal.sync(this.runs.map(untracked));
      return;
    }
    const tag = this.pendingCommit ?? Math.max(this.runsCommit ?? 0, this.journal.highestTag) + 1;
    this.pendingCommit = tag;
    this.journal.sync(this.runs.map(untracked), tag);
    const generation = randomUUID();
    const text = textFor(tag, generation);
    writeFileAtomic(this.file, text, { mode: 0o600 });
    this.runsCommit = tag;
    this.pendingCommit = null;
    this.generation = generation;
    this.journal.setGeneration(generation);
    try { const stat = statSync(this.file); this.lastWritten = { text, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }; }
    catch { this.lastWritten = null; }
    this.journal.compact();
  }

  /** True only when the file on disk is still exactly what this process wrote
   * last (size, mtime and inode checked), so an outside replacement is never
   * mistaken for our own content. */
  private fileUnchanged(text: string): boolean {
    const last = this.lastWritten;
    if (!last || last.text !== text) return false;
    try {
      const stat = statSync(this.file);
      return stat.size === last.size && stat.mtimeMs === last.mtimeMs && stat.ino === last.ino;
    } catch { return false; }
  }
}
