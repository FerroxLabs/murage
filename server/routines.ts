import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import { routineEventForRun, type RoutineEvent } from "../shared/routine-event.ts";
import type { RoutineWatchBinding, RoutineWatchInput, RoutineWatchObservation, RoutineWatchRun, RoutineWatchSource } from "../shared/routine-watch.ts";
import { completeRoutineWatchCheck, createRoutineWatchState, pauseRoutineWatch, reserveRoutineWatchCheck } from "./routine-watch-state.ts";
import { readRoutineWatchBinding, routineWatchInputSchema } from "./routine-watch-integration.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "interval"; everyMinutes: number; anchorAt: number };

/** `cloud` runs the agent itself inside the bot's Box VM. `ember` keeps
 * using the provider selected on the EMBER and only borrows its configured
 * computer tools, if any. */
export type RoutineRunOn = "ember" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

const persistedSourceThreadId = z.string().trim().min(1).optional().catch(undefined);

export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "channel";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface Routine {
  watch?: RoutineWatchBinding;
  id: string;
  name: string;
  prompt: string;
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
  /** Conversation that created this routine in chat. Calendar/import-created
   * routines intentionally have no source, and older files migrate in place. */
  sourceThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  watch?: RoutineWatchRun;
  event?: RoutineEvent;
  eventBudget?: EventActionBudget;
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot the work so an edited/deleted definition cannot rewrite history. */
  prompt?: string;
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
  deliveryId?: string;
  /** Snapshot the routine's reporting destination. Execution remains on the
   * separate `threadId` so recurring work never contaminates chat context. */
  sourceThreadId?: string;
  threadId?: string;
  /** Provider identity for a Telegram turn in a reused conversation. */
  channelTurnId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  /** Human-readable reason the detached execution is waiting. */
  attention?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
}

export interface EventActionBudget {
  version: 1;
  limits: { create: 4; handoff: 4 };
  admissions: Array<{ id: string; kind: "create" | "handoff" }>;
  closed: boolean;
}
const eventAdmissionId = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const eventActionBudgetSchema = z.object({
  version: z.literal(1), limits: z.object({ create: z.literal(4), handoff: z.literal(4) }).strict(),
  admissions: z.array(z.object({ id: eventAdmissionId, kind: z.enum(["create", "handoff"]) }).strict()).max(8), closed: z.boolean(),
}).strict().refine(value => new Set(value.admissions.map(item => item.id)).size === value.admissions.length
  && value.admissions.filter(item => item.kind === "create").length <= 4 && value.admissions.filter(item => item.kind === "handoff").length <= 4);
function newEventActionBudget(): EventActionBudget { return { version: 1, limits: { create: 4, handoff: 4 }, admissions: [], closed: false }; }

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  /** SHA-256 of the strict normalized operation carried by the card. */
  fingerprint: string;
  resultId: string;
  appliedAt: number;
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
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  /** Durable commit receipts for cross-file confirmation recovery. */
  routineRequestReceipts?: RoutineRequestReceipt[];
}

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export interface RoutineManagerOptions {
  validateWatchSource?: (ownerBotId: string, botId: string, source: RoutineWatchSource) => void;
  readWatchSource?: (ownerBotId: string, botId: string, source: RoutineWatchSource, signal: AbortSignal) => Promise<RoutineWatchObservation>;
  /** Admission only: never interrupts active work or blocks manual/channel requests. */
  automaticPaused?: () => boolean;
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  goalState?: (groupId: string, coordinatorBotId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  /** Telegram messages continue the bot's current conversation. */
  channelThread?: (botId: string) => { threadId: string } | null;
  createGoalTask?: (groupId: string, title: string) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    onDispatchError: (message: string) => void,
    eventId?: string,
  ) => Promise<void>;
  startGoal?: (
    groupId: string,
    threadId: string,
    prompt: string,
    coordinatorBotId: string,
    runId: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  interruptGoal?: (
    groupId: string,
    threadId: string,
    outcome?: { status: "stopped" | "limit-reached"; detail: string },
  ) => Promise<void>;
  /** Projects every durable transition into the source conversation. */
  onRunChanged?: (run: RoutineRun) => void;
  onRunFailed?: (run: RoutineRun) => void;
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
  if (schedule.type === "interval") {
    return { type: "interval", everyMinutes: schedule.everyMinutes, anchorAt: schedule.anchorAt };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

/** Whether two sanitized schedules describe the same occurrences. Weekdays
 * compare as a set, so a reordered selection is still the same schedule. */
function sameSchedule(a: RoutineSchedule, b: RoutineSchedule): boolean {
  if (a.type === "once" && b.type === "once") return a.at === b.at;
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

function cloneRoutine(routine: Routine): Routine {
  return {
    ...routine,
    ...(routine.watch ? { watch: structuredClone(routine.watch) } : {}),
    schedule: cloneSchedule(routine.schedule),
    attachments: cloneAttachments(routine.attachments),
  };
}

function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    ...(run.watch ? { watch: structuredClone(run.watch) } : {}),
    ...(run.event ? { event: structuredClone(run.event) } : {}),
    ...(run.eventBudget ? { eventBudget: structuredClone(run.eventBudget) } : {}),
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
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
  if (schedule.type === "interval") {
    if (schedule.anchorAt > after) return schedule.anchorAt;
    const intervalMs = schedule.everyMinutes * 60_000;
    const intervalsElapsed = Math.floor((after - schedule.anchorAt) / intervalMs);
    const candidate = schedule.anchorAt + (intervalsElapsed + 1) * intervalMs;
    return Number.isSafeInteger(candidate) && candidate <= MAX_DATE_MS ? candidate : null;
  }
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
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
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
  return {
    name,
    prompt,
    target,
    botId,
    groupId: target === "room-goal" ? groupId : undefined,
    runOn,
    enabled: input.enabled !== false,
    schedule: cleanSchedule(input.schedule),
    durationMinutes: Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) || 30))),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    attachments,
  };
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private watchReads = new Map<string, AbortController>();

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.flatMap((routine) => {
            const schedule = loadSchedule(routine.schedule);
            if (!schedule) return [];
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
            };
            if (routine.watch !== undefined) {
              try { loaded.watch = readRoutineWatchBinding(routine.watch, routine.id); }
              catch { return []; }
            }
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            return [loaded];
          })
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => {
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
            typeof receipt?.resultId === "string" &&
            Number.isFinite(receipt?.appliedAt)
          )
        : [];
    } catch {
      this.routines = [];
      this.runs = [];
      this.routineRequestReceipts = [];
    }
    // A local process cannot still own these turns after a full restart.
    const recovered: RoutineRun[] = [];
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "waiting") {
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
    if (recovered.length > 0) {
      this.save();
      for (const run of recovered) {
        this.notifyRunChanged(run);
        this.options.onRunFailed?.(run);
      }
    }
  }

  listRoutines(): Routine[] {
    return this.routines.map(cloneRoutine);
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map(cloneRun);
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  /** Active work that owns the bot's direct conversation. Room goals may use
   * the same bot as their coordinator, but execute in a separate room task. */
  activeBotRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.target === "bot" &&
        candidate.botId === botId &&
        ["running", "waiting"].includes(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
    return receipt ? { ...receipt } : null;
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

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">): Routine {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        if (committed) return cloneRoutine(committed);
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
      // Only a confirmed chat card supplies `request`; the public calendar
      // API cannot choose an arbitrary transcript as a reporting target.
      sourceThreadId: request?.threadId,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    if (watchInput && request) routine.watch = { ownerBotId: request.botId, state: createRoutineWatchState({ id: routine.id, ...watchInput }, at) };
    this.commitMutation(() => {
      this.routines.unshift(routine);
      if (request) this.rememberRoutineRequest(request, routine.id, at);
    });
    this.emitRoutine(routine);
    return cloneRoutine(routine);
  }

  update(
    id: string,
    patch: Partial<RoutineInput>,
    request?: RoutineRequestCommitFor<"update" | "pause" | "resume">,
  ): Routine | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        return committed ? cloneRoutine(committed) : null;
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
    });
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    if (routine.watch && (clean.target !== "bot" || clean.botId !== routine.botId || clean.runOn !== "ember" || clean.schedule.type !== "interval" || clean.attachments?.length)) throw new Error("A file watch must keep its approved bot, local interval and source");
    if (routine.watch && patch.enabled === true) {
      if (now >= routine.watch.state.definition.expiresAt || routine.watch.state.checks.length >= routine.watch.state.definition.maxChecks) throw new Error("This file watch expired or reached its check limit. Confirm a new watch to continue");
      this.options.validateWatchSource?.(routine.watch.ownerBotId, routine.botId, routine.watch.state.definition.source);
    }
    // An edit that leaves the schedule and the enabled state alone (a rename,
    // new instructions, a different timeout) keeps the cursor. Recomputing it
    // from `now` would silently skip an occurrence that became due since the
    // last tick, or erase an offline catch-up. A changed schedule, a pause or
    // a resume still recalculates. (#988 subset, adapted from OpenMausBot
    // 1e6737b0; FIFO dispatch order is deliberately not part of this.)
    const keepsCursor = clean.enabled && routine.enabled && sameSchedule(clean.schedule, routine.schedule);
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      Object.assign(routine, clean, {
        nextRunAt: !clean.enabled ? null : keepsCursor ? routine.nextRunAt : this.initialOccurrence(clean.schedule, now),
        // `updatedAt` doubles as the optimistic revision on durable routine
        // confirmation cards. Keep it monotonic even for two writes in one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (Object.hasOwn(patch, "timeoutMinutes") && patch.timeoutMinutes == null) {
        delete routine.timeoutMinutes;
      }
      if (patch.enabled === false) {
        for (const run of this.runs) {
          if (run.routineId !== routine.id || run.status !== "queued") continue;
          run.status = "cancelled";
          run.attention = undefined;
          run.finishedAt = this.now();
          run.error = "The routine was paused before this run started";
          cancelledRuns.push(run);
        }
      }
      if (routine.watch && patch.enabled !== undefined) {
        routine.watch.state = pauseRoutineWatch(routine.watch.state, !patch.enabled, Math.max(now, routine.watch.state.updatedAt));
        if (!patch.enabled) this.watchReads.get(routine.id)?.abort();
      }
      if (request) this.rememberRoutineRequest(request, routine.id, now);
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.emitRoutine(routine);
    return cloneRoutine(routine);
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">): boolean {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        return true;
      }
    }
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
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
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
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
        !["queued", "running", "waiting"].includes(run.status)
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
      if (receipt) {
        const committed = this.runs.find((run) => run.id === receipt.resultId);
        return committed ? cloneRun(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
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
    telegramConnectionId?: string;
  }): RoutineRun {
    const existing = this.findWebhookDelivery(input.webhookId, input.deliveryId);
    if (existing) return existing;
    if(!input.telegramConnectionId&&this.options.automaticPaused?.())throw Object.assign(new Error("Automatic work is paused. Resume automations before accepting new webhook work."),{status:409,code:"automations_paused"});
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned EMBER no longer exists"), { status: 410 });
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
      status: "queued",
      manual: false,
      triggerSource: input.telegramConnectionId ? "channel" : "webhook",
      ...(input.telegramConnectionId ? { telegramConnectionId: input.telegramConnectionId } : {}),
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      attachments: [],
      createdAt: this.now(),
    };
    run.event = routineEventForRun(run);
    run.eventBudget = newEventActionBudget();
    this.commitMutation(() => { this.runs.push(run); });
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
    return run?.eventBudget ? structuredClone(run.eventBudget) : null;
  }

  /** Charge before the caller performs external work. Uncertain work is not
   * refunded. A missing/evicted/legacy ledger never resets its allocation. */
  admitEventAction(eventId: string, admissionId: string, kind: "create" | "handoff"): boolean {
    if (!eventAdmissionId.safeParse(admissionId).success || !["create", "handoff"].includes(kind)) return false;
    const run = this.runs.find(item => item.id === eventId && item.event?.id === eventId);
    const budget = run?.eventBudget;
    if (!run || !budget || budget.closed) return false;
    const prior = budget.admissions.find(item => item.id === admissionId);
    if (prior) return prior.kind === kind;
    if (budget.admissions.filter(item => item.kind === kind).length >= budget.limits[kind]) return false;
    this.commitMutation(() => { budget.admissions.push({ id: admissionId, kind }); });
    return true;
  }

  closeEventBudget(eventId: string): boolean {
    const run = this.runs.find(item => item.id === eventId && item.event?.id === eventId);
    if (!run?.eventBudget) return false;
    if (!run.eventBudget.closed) this.commitMutation(() => { run.eventBudget!.closed = true; });
    return true;
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status),
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

  async cancelRun(id: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    this.commitMutation(() => {
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      if (run.eventBudget) run.eventBudget.closed = true;
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
        await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "ember").catch(() => {});
      }
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
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
          !["running", "waiting"].includes(run.status) ||
          run.startedAt == null ||
          run.timeoutMinutes == null ||
          now - run.startedAt < run.timeoutMinutes * 60_000
        ) continue;
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

  async tick(): Promise<void> {
    // Before the guard, on purpose — see enforceRunLimits.
    await this.enforceRunLimits();
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      let changed = false;
      const missedRuns: RoutineRun[] = [];
      for (const routine of this.routines) {
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
        // One slow interval run must not build an unbounded queue of stale
        // copies behind it. The series still advances on its original phase.
        const overlapping = routine.schedule.type === "interval" && this.runs.some(
          (run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status),
        );
        if (!overlapping) {
          if (late > CATCH_UP_MS) {
            const missed = this.newRun(routine, scheduledFor, false);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.error = "This computer was offline for more than 12 hours after the scheduled time";
            this.emitRun(missed);
            missedRuns.push(cloneRun(missed));
          } else {
            const run = this.newRun(routine, scheduledFor, false);
            this.emitRun(run);
          }
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
        changed = true;
      }
      if (changed) this.save();
      for (const missed of missedRuns) this.options.onRunFailed?.(missed);

      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
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
        const definition = triggerSource === "schedule"
          ? this.routines.find((routine) => routine.id === run.routineId)
          : undefined;
        if (definition?.schedule.type === "interval") {
          const latest = latestIntervalOccurrence(definition.schedule, now);
          if (latest !== null && latest > run.scheduledFor) {
            run.scheduledFor = latest;
            this.save();
            this.emitRun(run);
          }
        }
        const state = this.targetState(run);
        if (state === "busy") continue;
        if (state === "missing") {
          this.failRun(run, this.missingTargetMessage(run.target));
          continue;
        }
        if (run.watch) { await this.checkWatch(run); continue; }
        // A webhook is an incoming message, so make its task the bot's live
        // chat immediately. Scheduled work remains detached and unobtrusive.
        const task = run.target === "room-goal"
          ? run.groupId
            ? this.options.createGoalTask?.(run.groupId, run.routineName) ?? null
            : null
          : sharedChannel
            ? this.options.channelThread!(run.botId)
            : this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
        if (!task) {
          this.failRun(run, run.target === "room-goal"
            ? "Could not create a room task for this goal"
            : sharedChannel ? "Could not find the conversation for this channel" : "Could not create a task for this run");
          continue;
        }
        if (sharedChannel && this.runs.some((active) => active.threadId === task.threadId &&
          ["running", "waiting"].includes(active.status))) continue;
        run.threadId = task.threadId;
        run.startedAt = this.now();
        run.status = "running";
        this.save();
        this.emitRun(run);
        const failDispatch = (message: string) => {
          if (!sharedChannel) return this.failThread(task.threadId, message);
          // A delayed callback from an earlier message cannot fail the next
          // message merely because both used this conversation.
          if (!["running", "waiting"].includes(run.status)) return;
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
            await this.options.startTurn(
              run.botId,
              task.threadId,
              composeExecutionPrompt(prompt, run.attachments),
              run.runOn ?? "ember",
              triggerSource,
              failDispatch,
              run.event?.budgetId,
            );
          }
        } catch (error) {
          failDispatch(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return null;
    if (run.triggerSource === "channel" && this.options.channelThread) {
      // A reused conversation also receives late events from its previous
      // turn. Only the first fresh start can bind this delivery's identity.
      if (!event.turnId) return null;
      if (!run.channelTurnId) {
        if (event.type !== "turn.started" || this.runs.some((prior) => prior.id !== run.id &&
          prior.threadId === event.threadId && prior.channelTurnId === event.turnId)) return null;
        run.channelTurnId = event.turnId;
        this.save();
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
    if (event.type === "request.opened") {
      run.status = "waiting";
      run.attention = redactSecretsInText(event.summary).trim().slice(0, 500) || undefined;
    } else if (event.type === "request.resolved") {
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
    } else if (event.type === "turn.completed") {
      run.cost = event.cost;
      run.denials = event.denials;
      if (!event.ok) {
        this.failRun(run, event.stopReason ?? run.error ?? "The bot did not complete this run");
        queueMicrotask(() => void this.tick());
        return cloneRun(run);
      }
      run.status = "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
    } else {
      return null;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  failThread(threadId: string, message: string) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    this.failRun(run, message);
    queueMicrotask(() => void this.tick());
  }

  finishGoalRun(runId: string, status: GroupGoalRunStatus, detail: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.id === runId &&
        candidate.target === "room-goal" &&
        ["running", "waiting"].includes(candidate.status),
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
      this.save();
      this.emitRun(run);
    } else {
      run.status = status === "stopped" ? "cancelled" : "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
      if (status !== "stopped") run.output = safeDetail.slice(0, 2_000) || undefined;
      this.save();
      this.emitRun(run);
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  private failRun(run: RoutineRun, message: string) {
    run.status = "failed";
    run.attention = undefined;
    run.error = redactSecretsInText(message).slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.(cloneRun(run));
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

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      attachments: cloneAttachments(routine.attachments),
      target: routine.target,
      groupId: routine.groupId,
      botId: routine.botId,
      runOn: routine.runOn ?? "ember",
      scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      sourceThreadId: routine.sourceThreadId,
      createdAt: this.now(),
    };
    if (routine.watch) run.watch = { watchId: routine.id, ownerBotId: routine.watch.ownerBotId, source: structuredClone(routine.watch.state.definition.source), outcome: "pending" };
    run.event = routineEventForRun(run);
    run.eventBudget = newEventActionBudget();
    if (run.watch) run.eventBudget.closed = true;
    this.runs.push(run);
    return run;
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
      this.options.validateWatchSource(routine.watch.ownerBotId, routine.botId, run.watch.source);
      observation = await this.options.readWatchSource(routine.watch.ownerBotId, routine.botId, run.watch.source, controller.signal);
      this.options.validateWatchSource(routine.watch.ownerBotId, routine.botId, run.watch.source);
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

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: cloneRoutine(routine) });
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
    this.notifyRunChanged(run);
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
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) {
      if (existing.resultId !== resultId) throw new Error("Routine request receipt has another result");
      return;
    }
    this.routineRequestReceipts.unshift({ ...request, resultId, appliedAt });
  }

  /**
   * A confirmation receipt is only true once the scheduler mutation and its
   * receipt reached the same atomic file. Restore the complete in-memory
   * state if writing or renaming that file fails so a retry cannot mistake an
   * uncommitted action for a durable one.
   */
  private commitMutation(mutate: () => void): void {
    const before = {
      routines: this.routines.map(cloneRoutine),
      runs: this.runs.map(cloneRun),
      receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
    };
    try {
      mutate();
      this.save();
    } catch (error) {
      this.routines = before.routines;
      this.runs = before.runs;
      this.routineRequestReceipts = before.receipts;
      throw error;
    }
  }

  /** Inert additive batch; caller commits this file with the bot records. */
  preparePackageAddition(additions: Routine[]) {
    const ids = new Set(this.routines.map(routine => routine.id));
    for (const routine of additions) {
      if (ids.has(routine.id) || routine.enabled || routine.nextRunAt !== null) throw new Error("Unsafe package routine addition");
      ids.add(routine.id);
    }
    const next = [...this.routines, ...additions];
    return {
      bytes: Buffer.from(JSON.stringify({ version: 1, routines: next, runs: this.runs, routineRequestReceipts: this.routineRequestReceipts } satisfies RoutineFile, null, 2)),
      publish: () => { this.routines = next; },
    };
  }

  private save() {
    // Active receipts own cancellation, timeout, and provider-event routing;
    // evicting one would strand live work. Treat MAX_RUNS as a soft history
    // cap and reclaim only the oldest terminal receipts. An unusually large
    // active queue may exceed it until work settles.
    let excess = this.runs.length - MAX_RUNS;
    for (let index = 0; index < this.runs.length && excess > 0;) {
      if (["queued", "running", "waiting"].includes(this.runs[index]!.status)) {
        index += 1;
        continue;
      }
      this.runs.splice(index, 1);
      excess -= 1;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({
      version: 1,
      routines: this.routines,
      runs: this.runs,
      routineRequestReceipts: this.routineRequestReceipts,
    } satisfies RoutineFile, null, 2), { mode: 0o600 });
  }
}
