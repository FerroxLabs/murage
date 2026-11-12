import { serviceNoLimits } from './service-no-limits.ts';
import { ProducerApprovalQueue, producerBase, type ServiceAuthority } from "./narrow-denials.ts";
import { readApproval, lookupApproval, answerApprovalSync, type PendingQueueApproval, type ApprovalAnswer } from "./decision/index.ts";
import { createHash } from "node:crypto";
import { ROUTINE_INSTRUCTIONS_LIMIT_SENTENCE, ROUTINE_INSTRUCTIONS_MAX } from "../shared/routine-instructions.ts";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { plainClock, plainTimeZone, plainWeekdays } from "../shared/plain-time-zone.ts";
import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import {
  nextOccurrence,
  type AutomationUndoBefore,
  type Routine,
  type RoutineInput,
  type RoutineManager,
  type RoutineRequestCommit,
  type RoutineRequestReceipt,
  type RoutineSchedule,
} from "./routines.ts";
import {
  AUTOMATION_UNDO_WINDOW_MS,
  automationActionUndoable,
  type AutomationRequestCardData,
  type RoutineRequestCardData,
  type RoutineRequestChanges,
  type RoutineRequestDefinition,
  type RoutineRequestOperation,
  type RoutineRequestRunOn,
  type RoutineRequestSchedule,
  type WebhookRequestCardData,
  type WebhookRequestChanges,
  type WebhookRequestOperation,
} from "../shared/routine-request.ts";
import type { WebhookTrigger, WebhookWriteGuard } from "./webhooks.ts";
import type { RoutineWatchSource } from "../shared/routine-watch.ts";
import { routineFileWatchProposalSchema, routineWatchInput, routineWatchInputSchema } from "./routine-watch-integration.ts";
import { murageToolOnThisServer } from "./murage-tool-surface.ts";
import type { AutoApprover, AutoContext } from "./auto-approve.ts";

const WEEKDAY_NUMBER = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

const RFC3339_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ROUTINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const ACTION_COPY = {
  create: { title: "Schedule", detail: "Create routine" },
  update: { title: "Update", detail: "Update routine" },
  pause: { title: "Pause", detail: "Pause routine" },
  resume: { title: "Resume", detail: "Resume routine" },
  run_now: { title: "Run now", detail: "Run routine now" },
  delete: { title: "Delete", detail: "Delete routine" },
} as const satisfies Record<RoutineRequestOperation["action"], { title: string; detail: string }>;
const ROUTINE_REQUEST_FINGERPRINT_VERSION = 1 as const;
const jsonObjectSchema = z.record(z.string(), z.custom<JsonValue>());

const routineToolScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.string().max(64) }).strict(),
  z.object({
    type: z.literal("weekly"),
    time: z.string().max(5),
    weekdays: z.array(z.string().max(9)).min(1).max(7),
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number(),
    anchorAt: z.string().max(64).optional(),
  }).strict(),
]);

const routineToolDefinitionSchema = z.object({
  watch: routineFileWatchProposalSchema.optional(),
  name: z.string().max(80),
  instructions: z.string().max(ROUTINE_INSTRUCTIONS_MAX, ROUTINE_INSTRUCTIONS_LIMIT_SENTENCE),
  schedule: routineToolScheduleSchema,
  runOn: z.enum(["ember", "cloud"]).optional(),
  durationMinutes: z.number().optional(),
  timeoutMinutes: z.number().nullable().optional(),
}).strict();

const routineToolChangesSchema = routineToolDefinitionSchema
  .omit({ timeoutMinutes: true, watch: true })
  .partial()
  .extend({ timeoutMinutes: z.number().nullable().optional() })
  .strict()
  .refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Choose at least one routine field to update",
);

/** Resolved and authorized by the harness route (existence + same section)
 * before it reaches this service; re-authorized again at confirm time. */
const targetBotSchema = z.object({
  botId: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
}).strict();
const routineProposalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), routine: routineToolDefinitionSchema, forBot: targetBotSchema.optional() }).strict(),
  z.object({ action: z.literal("update"), routineId: z.string().max(128), changes: routineToolChangesSchema }).strict(),
  z.object({ action: z.literal("pause"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("resume"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("run_now"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("delete"), routineId: z.string().max(128) }).strict(),
]);

const storedWeekdaysSchema = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(
  (weekdays) => new Set(weekdays).size === weekdays.length,
  "Stored routine weekdays must be unique",
);
const storedScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(TIME),
    weekdays: storedWeekdaysSchema,
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number().int().min(5).max(1_440),
    anchorAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  }).strict(),
]);
const storedDefinitionSchema = z.object({
  watch: routineWatchInputSchema.optional(),
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(ROUTINE_INSTRUCTIONS_MAX),
  schedule: storedScheduleSchema,
  runOn: z.enum(["ember", "cloud"]),
  durationMinutes: z.number().int().min(5).max(240),
  timeoutMinutes: z.number().int().min(5).max(240).optional(),
}).strict();
const storedChangesSchema = storedDefinitionSchema
  .omit({ timeoutMinutes: true, watch: true })
  .partial()
  .extend({ timeoutMinutes: z.number().int().min(5).max(240).nullable().optional() })
  .strict()
  .refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Stored routine update must change at least one field",
);
const storedManageBase = {
  routineId: z.string().regex(ROUTINE_ID),
  expectedUpdatedAt: z.number().int().nonnegative(),
};
const storedOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), routine: storedDefinitionSchema, forBot: targetBotSchema.optional() }).strict(),
  z.object({ action: z.literal("update"), ...storedManageBase, changes: storedChangesSchema }).strict(),
  z.object({ action: z.literal("pause"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("resume"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("run_now"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("delete"), ...storedManageBase }).strict(),
]);
const routineRequestCardDataSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  operation: storedOperationSchema,
  appliedAt: z.number().int().nonnegative().optional(),
  resultId: z.string().min(1).max(128).optional(),
}).strict();

// ---- Webhooks from chat (SL-J J1) ------------------------------------------
const WEBHOOK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const webhookEventTypesSchema = z.array(z.string().max(200)).max(20);
const webhookToolDefinitionSchema = z.object({
  name: z.string().max(80),
  instructions: z.string().max(20_000),
  eventTypes: webhookEventTypesSchema.optional(),
}).strict();
const webhookToolChangesSchema = webhookToolDefinitionSchema.partial().strict().refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Choose at least one webhook field to update",
);
const webhookProposalSchema = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("webhook"), action: z.literal("create"), webhook: webhookToolDefinitionSchema }).strict(),
  z.object({ kind: z.literal("webhook"), action: z.literal("update"), webhookId: z.string().max(128), changes: webhookToolChangesSchema }).strict(),
  z.object({ kind: z.literal("webhook"), action: z.literal("pause"), webhookId: z.string().max(128) }).strict(),
  z.object({ kind: z.literal("webhook"), action: z.literal("resume"), webhookId: z.string().max(128) }).strict(),
  z.object({ kind: z.literal("webhook"), action: z.literal("delete"), webhookId: z.string().max(128) }).strict(),
]);
const storedEventTypesSchema = z.array(z.string().trim().min(1).max(200)).max(20);
const storedWebhookManageBase = {
  webhookId: z.string().regex(WEBHOOK_ID),
  expectedUpdatedAt: z.number().int().nonnegative(),
};
const storedWebhookOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    webhook: z.object({
      id: z.string().regex(WEBHOOK_ID),
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().min(1).max(20_000),
      eventTypes: storedEventTypesSchema.min(1).optional(),
    }).strict(),
  }).strict(),
  z.object({
    action: z.literal("update"),
    ...storedWebhookManageBase,
    changes: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      prompt: z.string().trim().min(1).max(20_000).optional(),
      eventTypes: storedEventTypesSchema.optional(),
    }).strict().refine(
      (changes) => Object.values(changes).some((value) => value !== undefined),
      "Stored webhook update must change at least one field",
    ),
  }).strict(),
  z.object({ action: z.literal("pause"), ...storedWebhookManageBase }).strict(),
  z.object({ action: z.literal("resume"), ...storedWebhookManageBase }).strict(),
  z.object({ action: z.literal("delete"), ...storedWebhookManageBase }).strict(),
]);
const webhookRequestCardDataSchema = z.object({
  version: z.literal(1),
  kind: z.literal("webhook"),
  requestId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  operation: storedWebhookOperationSchema,
  appliedAt: z.number().int().nonnegative().optional(),
  resultId: z.string().min(1).max(128).optional(),
}).strict();

/** What Undo restores, read back from the receipt and checked before use. */
const routineBeforeSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule: z.custom<RoutineSchedule>((value) => value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"),
  overlap: z.enum(["skip", "queue"]),
  timeoutMinutes: z.number().int().nullable(),
  enabled: z.boolean(),
}).strict();
const webhookBeforeSchema = z.object({
  name: z.string().min(1),
  prompt: z.string(),
  eventTypes: z.array(z.string()).max(20),
  enabled: z.boolean(),
}).strict();
const absentBeforeSchema = z.object({ absent: z.literal(true) }).strict();

/** Bound to the request id, so a Confirm pressed again finds the same record. */
export function webhookIdForRequest(requestId: string): string {
  const hex = createHash("sha256").update(`murage-chat-webhook:${requestId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const AUTOMATION_CHANGED_SINCE =
  "This changed after it was applied (an edit, a new link, a delivery or a run), so Undo cannot put it back. Change it on the Automations page instead.";

/** The narrow view of the webhook manager this service uses. */
export interface WebhookRequestTarget {
  get(id: string): WebhookTrigger | null;
  create(input: JsonValue, options: { id: string; mint: false }): { webhook: WebhookTrigger };
  update(id: string, value: JsonValue, guard?: WebhookWriteGuard): WebhookTrigger | null;
  remove(id: string, guard?: WebhookWriteGuard): boolean;
}

export type RoutineToolScheduleInput = z.infer<typeof routineToolScheduleSchema>;
export type RoutineToolDefinitionInput = z.infer<typeof routineToolDefinitionSchema>;
export type RoutineToolChangesInput = z.infer<typeof routineToolChangesSchema>;
export type RoutineProposalInput = z.input<typeof routineProposalSchema>;
type ParsedRoutineProposal = z.output<typeof routineProposalSchema>;

export interface RoutineRequestOptionCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  answeredAt?: number;
  dismissed?: boolean;
  detail?: string;
  requestId?: string;
  tool?: string;
  held?: string;
  routineRequest?: AutomationRequestCardData;
  /** Mirrors OptionCardData.routineProposalDigest — see store.ts. */
  routineProposalDigest?: string;
  /** Undo restored what this applied change replaced (SL-J J2). */
  undone?: boolean;
}

export interface RoutineRequestMessage {
  id: string;
  card?: RoutineRequestOptionCard;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
export interface RoutineRequestStore {
  messagesFor(threadId: string): RoutineRequestMessage[];
  /** TODO(s2p-r5): replace the store's terminal-card scan with known-message-ID lookup. */
  cardForRequest?(threadId: string, requestId: string, test?: (message: RoutineRequestMessage) => boolean): RoutineRequestMessage | undefined;
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options";
      card: RoutineRequestOptionCard;
      from?: { botId: string; name: string; color: string };
    },
  ): RoutineRequestMessage;
  patchMessage(
    threadId: string,
    messageId: string,
    patch: { card: RoutineRequestOptionCard },
  ): RoutineRequestMessage | null;
}

export interface RoutineRequestServiceOptions {
  holdTarget?: (targetBotId: string, payload: AutomationRequestCardData) => boolean;
  resolveWatchSource?: (ownerBotId: string, botId: string, relativePath: string) => RoutineWatchSource;
  store: RoutineRequestStore;
  routines: RoutineManager;
  now?: () => number;
  timeZone?: () => string;
  /** Harness-owned readiness check for proposals that would execute in cloud. */
  cloudReady?: () => Promise<{ ready: boolean; reason?: string }>;
  /** Revalidates conversation ownership and capacity synchronously, directly
   * before the card append. This closes races across an async cloud probe. */
  canPersist?: (
    botId: string,
    threadId: string,
  ) => { ok: true } | { ok: false; status: number; error: string };
  /** Re-authorizes a cross-bot target (the card can sit open while the target
   * bot is deleted or moved to another section). Returns the sentence to
   * refuse with, or null to allow. Checked at propose AND confirm time. */
  validateTarget?: (proposerBotId: string, target: { botId: string; name: string }, threadId?: string) => string | null;
  /** Webhooks proposed from chat apply through here (SL-J J1). */
  webhooks?: () => WebhookRequestTarget;
  /** Test observation only; all sources share the same tick budget. */
  onVisit?: (source: ReceiptSource, requestId: string) => void;
}

export interface ProposeRoutineRequestArgs {
  authority?: ServiceAuthority | (() => { bot: AutoApprover | null; context: AutoContext });
  botId: string;
  threadId: string;
  /** Untrusted model output; normalized by routineProposalSchema in propose(). */
  proposal: unknown;
  /** Room cards retain the member attribution used by every other bot message. */
  from?: { botId: string; name: string; color: string };
  /** Exact initiating turn must still own authority after async readiness. */
  canCommit?: () => void;
}

export interface RoutineProposalResult {
  applied?: boolean;
  resultId?: string;
  requestId: string;
  messageId: string;
  title: string;
  /** Short response returned to the proposing agent. */
  summary: string;
  /** Exact approval text persisted in the card. */
  detail: string;
  nextRunAt: number | null;
  timeZone: string;
}

interface RoutineCardCopy {
  title: string;
  summary: string;
  detail: string;
  nextRunAt: number | null;
  tool: "schedule_routine" | "manage_routine" | "create_webhook" | "manage_webhook";
}

export type ResolveRoutineRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number; code?: "changed_since" }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "held" }
  | { claimed: true; state: "undone"; action: RoutineRequestOperation["action"] }
  | {
      claimed: true;
      state: "applied";
      action: RoutineRequestOperation["action"];
      resultId: string;
    };

export class RoutineRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RoutineRequestError";
    this.status = status;
  }
}

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RoutineRequestError(`${field} is required`);
  if (trimmed.length > max) throw new RoutineRequestError(`${field} must be ${max.toLocaleString("en-US")} characters or fewer`);
  // This payload is hidden under the visible card fields, so the store's
  // shallow card redaction cannot reach it. Scrub before it is persisted.
  const redacted = redactSecretsInText(trimmed);
  if (redacted.length > max) {
    throw new RoutineRequestError(
      `${field} must remain ${max.toLocaleString("en-US")} characters or fewer after credentials are removed`,
    );
  }
  return redacted;
}

function runOn(value: RoutineRequestRunOn | undefined): RoutineRequestRunOn {
  return value ?? "ember";
}

function duration(value: number | undefined): number {
  const normalized = value ?? 30;
  if (!Number.isInteger(normalized) || normalized < 5 || normalized > 240) {
    throw new RoutineRequestError("durationMinutes must be a whole number from 5 to 240");
  }
  return normalized;
}

function timeout(value: number | null | undefined): number | null | undefined {
  if (value == null) return value;
  if (!Number.isInteger(value) || value < 5 || value > 240) {
    throw new RoutineRequestError("timeoutMinutes must be a whole number from 5 to 240");
  }
  return value;
}

function rfc3339Instant(value: string, offsetMessage: string): number {
  const parts = RFC3339_WITH_OFFSET.exec(value);
  if (!parts) throw new RoutineRequestError(offsetMessage);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = Number(parts[7] ?? 0);
  const offsetMinute = Number(parts[8] ?? 0);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new RoutineRequestError("Choose a valid RFC3339 date and time");
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new RoutineRequestError("Choose a valid RFC3339 date and time");
  return at;
}

function normalizeSchedule(schedule: RoutineToolScheduleInput, now: number): RoutineRequestSchedule {
  if (schedule.type === "once") {
    const at = rfc3339Instant(
      schedule.at,
      "One-time schedules need an RFC3339 date-time with an explicit timezone offset",
    );
    if (at <= now) throw new RoutineRequestError("The scheduled date and time must be in the future");
    return { type: "once", at };
  }
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.everyMinutes) || schedule.everyMinutes < 5 || schedule.everyMinutes > 1_440) {
      throw new RoutineRequestError("everyMinutes must be a whole number from 5 to 1440");
    }
    if (schedule.anchorAt === undefined) {
      return { type: "interval", everyMinutes: schedule.everyMinutes };
    }
    const anchorAt = rfc3339Instant(
      schedule.anchorAt,
      "Interval starts need an RFC3339 date-time with an explicit timezone offset",
    );
    if (!Number.isSafeInteger(anchorAt) || anchorAt < 0 || anchorAt > MAX_DATE_MS) {
      throw new RoutineRequestError("Choose a valid interval start time");
    }
    return { type: "interval", everyMinutes: schedule.everyMinutes, anchorAt };
  }
  if (!TIME.test(schedule.time)) {
    throw new RoutineRequestError("Weekly schedule time must use 24-hour HH:MM");
  }
  if (schedule.weekdays.length === 0) throw new RoutineRequestError("Choose at least one weekday");
  const weekdays = schedule.weekdays.map((day) => {
    // SAFETY: every key in WEEKDAY_NUMBER is lower-case; membership is
    // checked immediately below before the numeric value is retained.
    const number = WEEKDAY_NUMBER[day.toLowerCase() as keyof typeof WEEKDAY_NUMBER];
    if (number === undefined) throw new RoutineRequestError(`Unsupported weekday: ${day}`);
    return number;
  });
  return { type: "daily", time: schedule.time, weekdays: [...new Set(weekdays)].sort() };
}

function normalizeDefinition(input: RoutineToolDefinitionInput, now: number): RoutineRequestDefinition {
  const timeoutMinutes = timeout(input.timeoutMinutes);
  return {
    name: text(input.name, "name", 80),
    instructions: text(input.instructions, "instructions", 20_000),
    schedule: normalizeSchedule(input.schedule, now),
    runOn: runOn(input.runOn),
    durationMinutes: duration(input.durationMinutes),
    ...(timeoutMinutes == null ? {} : { timeoutMinutes }),
  };
}

function normalizeChanges(input: RoutineToolChangesInput, now: number): RoutineRequestChanges {
  const changes: RoutineRequestChanges = {};
  if (input.name !== undefined) changes.name = text(input.name, "name", 80);
  if (input.instructions !== undefined) changes.instructions = text(input.instructions, "instructions", 20_000);
  if (input.schedule !== undefined) changes.schedule = normalizeSchedule(input.schedule, now);
  if (input.runOn !== undefined) changes.runOn = runOn(input.runOn);
  if (input.durationMinutes !== undefined) changes.durationMinutes = duration(input.durationMinutes);
  if (input.timeoutMinutes !== undefined) changes.timeoutMinutes = timeout(input.timeoutMinutes);
  return changes;
}

function routineId(value: string): string {
  if (!ROUTINE_ID.test(value)) throw new RoutineRequestError("Choose a valid routine id");
  return value;
}

function ownedRoutine(manager: RoutineManager, id: string, botId: string): Routine | null {
  return manager.listRoutines().find((routine) => routine.id === id && (routine.watch?.ownerBotId ?? routine.botId) === botId) ?? null;
}

function normalizedOperation(
  manager: RoutineManager,
  botId: string,
  validated: ParsedRoutineProposal,
  now: number,
): RoutineRequestOperation {
  if (validated.action === "create") {
    const operation: Extract<RoutineRequestOperation, { action: "create" }> = {
      action: "create",
      routine: normalizeDefinition(validated.routine, now),
    };
    if (validated.forBot) operation.forBot = validated.forBot;
    return operation;
  }
  const id = routineId(validated.routineId);
  const current = ownedRoutine(manager, id, botId);
  if (!current) throw new RoutineRequestError("That routine does not exist", 404);
  if (validated.action === "update") {
    return {
      action: "update",
      routineId: id,
      expectedUpdatedAt: current.updatedAt,
      changes: normalizeChanges(validated.changes, now),
    };
  }
  if (validated.action === "resume" && nextOccurrence(current.schedule, now) === null) {
    throw new RoutineRequestError(
      "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.",
      409,
    );
  }
  return { action: validated.action, routineId: id, expectedUpdatedAt: current.updatedAt };
}

function asSchedule(schedule: RoutineRequestSchedule, now: number): RoutineSchedule {
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "interval") {
    return { type: "interval", everyMinutes: schedule.everyMinutes, anchorAt: schedule.anchorAt ?? now };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

function nextForOperation(operation: RoutineRequestOperation, manager: RoutineManager, now: number): number | null {
  if (operation.action === "create") {
    if (operation.routine.schedule.type === "interval" && operation.routine.schedule.anchorAt === undefined) return null;
    return nextOccurrence(asSchedule(operation.routine.schedule, now), now);
  }
  const current = manager.listRoutines().find((routine) => routine.id === operation.routineId);
  if (!current) return null;
  if (operation.action === "pause" || operation.action === "delete") return null;
  if (operation.action === "run_now") return now;
  if (operation.action === "resume") return nextOccurrence(current.schedule, now);
  if (!("changes" in operation)) return null;
  if (!current.enabled) return null;
  if (operation.changes.schedule?.type === "interval" && operation.changes.schedule.anchorAt === undefined) return null;
  const schedule = operation.changes.schedule ? asSchedule(operation.changes.schedule, now) : current.schedule;
  return nextOccurrence(schedule, now);
}

function formatInstant(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

/** 1.0.18 U6 E32: "Mon, Nov 9, 9:00 AM", the way the first or next run is said. */
function formatRunAt(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(at));
  } catch {
    return formatInstant(at, timeZone);
  }
}

// 1.0.18 U6 E32 (upstream 698cef40c): the zone in plain words ("India time"), never the IANA id.
export function scheduleText(schedule: RoutineRequestSchedule, timeZone: string): string {
  const zone = plainTimeZone(timeZone);
  if (schedule.type === "once") return `${formatInstant(schedule.at, timeZone)} ${zone}`;
  if (schedule.type === "interval") {
    return schedule.anchorAt === undefined
      ? `Every ${schedule.everyMinutes} minutes, starting one interval after confirmation`
      : `Every ${schedule.everyMinutes} minutes, anchored at ${formatInstant(schedule.anchorAt, timeZone)} ${zone}`;
  }
  return `${plainWeekdays(schedule.weekdays)} at ${plainClock(schedule.time)} ${zone}`;
}

function effectiveDefinition(operation: RoutineRequestOperation, manager: RoutineManager): RoutineRequestDefinition | null {
  if (operation.action === "create") return operation.routine;
  const existing = manager.listRoutines().find((routine) => routine.id === operation.routineId);
  // 1.0.4 SL-I I3: a routine that waits for an engine's limit is changed in the app, not through a bot's request
  // 1.0.11 APP-TRIGGERS: so is a connected-app routine (its kind and trigger never change through a request)
  if (!existing || existing.schedule.type === "limit_reset" || existing.schedule.type === "app_event") return null;
  const base: RoutineRequestDefinition = {
    ...(existing.watch ? { watch: routineWatchInput(existing.watch) } : {}),
    name: existing.name,
    instructions: existing.prompt,
    schedule: { ...existing.schedule },
    runOn: existing.runOn,
    durationMinutes: existing.durationMinutes,
    ...(existing.timeoutMinutes === undefined ? {} : { timeoutMinutes: existing.timeoutMinutes }),
  };
  if (operation.action !== "update") return base;
  const { timeoutMinutes, ...changes } = operation.changes;
  const merged: RoutineRequestDefinition = { ...base, ...changes };
  if (timeoutMinutes === null) delete merged.timeoutMinutes;
  else if (timeoutMinutes !== undefined) merged.timeoutMinutes = timeoutMinutes;
  return merged;
}

function cardCopy(
  operation: RoutineRequestOperation,
  manager: RoutineManager,
  timeZone: string,
  now: number,
): RoutineCardCopy {
  const definition = effectiveDefinition(operation, manager);
  const actionCopy = ACTION_COPY[operation.action];
  const actionLabel = actionCopy.title;
  const name = redactSecretsInText(definition?.name ?? "routine");
  const forBot = operation.action === "create" ? operation.forBot : undefined;
  const forSuffix = forBot ? ` for @${redactSecretsInText(forBot.name)}` : "";
  const title = `${actionLabel} “${name}”${forSuffix}?`;
  if (!definition) {
    return {
      title,
      summary: title,
      detail: `Action: ${actionCopy.detail}\nName: ${name}`,
      nextRunAt: null,
      tool: "manage_routine",
    };
  }
  const nextRunAt = nextForOperation(operation, manager, now);
  const when = operation.action === "run_now" ? "Now" : scheduleText(definition.schedule, timeZone);
  // Upstream #1554: "Cloud VM" read as the person's own VPS.
  const destination = definition.runOn === "cloud" ? "Box-hosted runner" : "Bot's current setup";
  const current = operation.action === "create"
    ? null
    : manager.listRoutines().find((routine) => routine.id === operation.routineId) ?? null;
  const remainsPaused = operation.action === "update" && current?.enabled === false;
  const deferredInterval = definition.schedule.type === "interval" && definition.schedule.anchorAt === undefined;
  const nextDescription = remainsPaused
    ? "None: this routine remains paused"
    : deferredInterval
      ? "One interval after confirmation"
      : nextRunAt !== null
        ? `${formatRunAt(nextRunAt, timeZone)} ${plainTimeZone(timeZone)}`
        : operation.action === "pause"
          ? "None: this routine will be paused"
          : operation.action === "delete"
            ? "None: this routine will be deleted"
            : "None";
  const status = remainsPaused ? " · Remains paused" : "";
  // 1.0.18 U6 E32: a routine that has never started a run says so ("First run Mon, Nov 9, 9:00 AM India time").
  const neverRun = operation.action === "create" || (current !== null && !manager.hasStartedRun(current.id));
  // A new interval with no anchor has a first run too: one interval after confirmation (Astra r1 M2).
  const nextLabel = neverRun && (nextRunAt !== null || deferredInterval) && !remainsPaused ? "First run" : "Next run";
  // Existing routines may predate nested-card redaction. The approval still
  // shows every instruction, but credential-shaped values never travel back
  // through the bot's MCP response or into the transcript.
  const visibleInstructions = redactSecretsInText(definition.instructions);
  if (definition.watch) {
    const watch = definition.watch;
    const detail = [`Action: ${actionCopy.detail} (read-only file watch)`, `Name: ${name}`,
      ...(forBot ? [`Working folder: @${redactSecretsInText(forBot.name)}`] : []),
      `Selected file: ${watch.source.sourceId}`, `Schedule: ${when}`, `Next check: ${nextDescription}`,
      `Expires: ${formatInstant(watch.expiresAt, timeZone)} ${plainTimeZone(timeZone)}`, `Maximum checks: ${watch.maxChecks}`,
      "Only changes are reported in Inbox. The first check records a baseline. Quiet hours follow notification settings.",
      "This watch only reads this file. It cannot run an agent, send messages to others, spend, or change files."].join("\n");
    return { title, summary: `${actionLabel} file watch “${name}”${forSuffix} · ${when} · ${watch.maxChecks} checks`, detail,
      nextRunAt, tool: operation.action === "create" ? "schedule_routine" : "manage_routine" };
  }
  const runLimit = definition.timeoutMinutes === undefined
    ? "no run limit"
    : `${definition.timeoutMinutes} min limit`;
  return {
    title,
    summary: `${actionLabel} “${name}”${forSuffix} · ${when} · ${destination} · ${runLimit}${status}`,
    detail: [
      `Action: ${actionCopy.detail}`,
      `Name: ${name}`,
      ...(forBot ? [`For: @${redactSecretsInText(forBot.name)} (each run uses that bot's engine and permissions)`] : []),
      `Schedule: ${when}`,
      `${nextLabel}: ${nextDescription}`,
      `Runs on: ${destination}`,
      `Run limit: ${definition.timeoutMinutes === undefined ? "No limit" : `${definition.timeoutMinutes} minutes`}`,
      ...(definition.schedule.type !== "once" && (operation.action === "create" || current?.carryLastReport === true)
        ? ["Starts each run with the last run's report"] : []),
      "",
      "Instructions:",
      visibleInstructions,
    ].join("\n"),
    nextRunAt,
    tool: operation.action === "create" ? "schedule_routine" : "manage_routine",
  };
}

function inputFromDefinition(definition: RoutineRequestDefinition, botId: string, now: number): RoutineInput {
  return {
    ...(definition.watch ? { watch: structuredClone(definition.watch) } : {}),
    name: definition.name,
    prompt: definition.instructions,
    botId,
    runOn: definition.runOn,
    enabled: true,
    schedule: asSchedule(definition.schedule, now),
    durationMinutes: definition.durationMinutes,
    ...(definition.timeoutMinutes === undefined ? {} : { timeoutMinutes: definition.timeoutMinutes }),
    carryLastReport: true,
  };
}

function updateFromChanges(changes: RoutineRequestChanges, now: number): Partial<RoutineInput> {
  const patch: Partial<RoutineInput> = {};
  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.instructions !== undefined) patch.prompt = changes.instructions;
  if (changes.schedule !== undefined) patch.schedule = asSchedule(changes.schedule, now);
  if (changes.runOn !== undefined) patch.runOn = changes.runOn;
  if (changes.durationMinutes !== undefined) patch.durationMinutes = changes.durationMinutes;
  if (changes.timeoutMinutes !== undefined) patch.timeoutMinutes = changes.timeoutMinutes;
  return patch;
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const parsedObject = jsonObjectSchema.safeParse(value);
  if (!parsedObject.success) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(parsedObject.data).sort()) {
    const child = parsedObject.data[key];
    if (child !== undefined) sorted[key] = canonicalValue(child);
  }
  return sorted;
}

/** Bind exact-once recovery to the immutable card owner as well as its
 * operation. Recursive key sorting keeps old receipts valid if a future
 * schema refactor changes object construction order. */
export function routineRequestFingerprint(
  payload: Pick<AutomationRequestCardData, "version" | "requestId" | "botId" | "threadId" | "operation" | "kind">,
  messageId: string,
): string {
  const document = parseJson(JSON.stringify({
    fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
    // a routine card's fingerprint is unchanged from 1.0.3 (no kind)
    ...(payload.kind ? { kind: payload.kind } : {}),
    cardVersion: payload.version,
    requestId: payload.requestId,
    messageId,
    botId: payload.botId,
    threadId: payload.threadId,
    operation: payload.operation,
  }));
  return createHash("sha256").update(JSON.stringify(canonicalValue(document))).digest("hex");
}

/** What the person actually read, hashed.
 *
 * `routineRequestFingerprint` above binds a COMMIT RECEIPT so a crash between
 * apply and settle can be recovered. It is computed at confirmation time over
 * whatever is stored then, and on a FIRST approval there is no receipt to
 * compare it against — so by itself it attests to nothing about what was
 * displayed. It also excludes the card's title and subtitle, which are the
 * only parts a person reads.
 *
 * This digest closes that: it is taken once, when the card is written, over
 * the operation AND the rendered copy. Confirmation recomputes it and refuses
 * on a mismatch, so an operation cannot be swapped underneath copy the user
 * already read. Found by an external audit, 2026-09-05. */
export function routineProposalDigest(
  payload: Pick<AutomationRequestCardData, "version" | "requestId" | "botId" | "threadId" | "operation" | "kind">,
  display: { title: string; subtitle: string },
): string {
  const document = parseJson(JSON.stringify({
    digestVersion: 1,
    ...(payload.kind ? { kind: payload.kind } : {}),
    cardVersion: payload.version,
    requestId: payload.requestId,
    botId: payload.botId,
    threadId: payload.threadId,
    operation: payload.operation,
    title: display.title,
    subtitle: display.subtitle,
  }));
  return createHash("sha256").update(JSON.stringify(canonicalValue(document))).digest("hex");
}

function verifyManageSnapshot(
  operation: Exclude<RoutineRequestOperation, { action: "create" }>,
  manager: RoutineManager,
  botId: string,
): Routine {
  const current = ownedRoutine(manager, operation.routineId, botId);
  if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
  if (current.updatedAt !== operation.expectedUpdatedAt) {
    throw new RoutineRequestError(
      "That routine changed after this confirmation card was prepared. Ask the bot to review it and propose the action again.",
      409,
    );
  }
  return current;
}

function requestCommit(payload: AutomationRequestCardData, messageId: string): RoutineRequestCommit {
  return {
    requestId: payload.requestId,
    messageId,
    botId: payload.botId,
    threadId: payload.threadId,
    action: payload.operation.action,
    fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
    fingerprint: routineRequestFingerprint(payload, messageId),
  };
}

/** Two file watches over different files are different work, however alike
 * their instructions and interval are. The source is the only thing that
 * tells them apart, so it must match exactly, in both directions. */
function sameWatchSource(current?: RoutineWatchSource, proposed?: RoutineWatchSource): boolean {
  if (!current || !proposed) return !current && !proposed;
  return current.adapterId === proposed.adapterId
    && current.sourceId === proposed.sourceId
    && current.scopeId === proposed.scopeId;
}

/** The model cannot see that it already scheduled this. A retried tool call,
 * or a second reading of the same request, otherwise leaves the owner with
 * two enabled routines running identical instructions on the same schedule,
 * neither aware of the other, both reporting for ever.
 *
 * Only an exact match counts. The name is deliberately not compared: renaming
 * the same work does not make it new. */
function duplicateRoutine(
  definition: RoutineRequestDefinition,
  owner: string,
  manager: RoutineManager,
  now: number,
): Routine | undefined {
  const proposed = asSchedule(definition.schedule, now);
  return manager.listRoutines().find((routine) => {
    if (
      !routine.enabled
      || routine.target !== "bot"
      || routine.botId !== owner
      || routine.runOn !== definition.runOn
      || routine.prompt !== definition.instructions
      || routine.durationMinutes !== definition.durationMinutes
      || routine.timeoutMinutes !== definition.timeoutMinutes
      || (routine.attachments?.length ?? 0) > 0
      || !sameWatchSource(routine.watch?.state.definition.source, definition.watch?.source)
    ) return false;
    // An omitted start means "every N minutes", not a fresh phase each time
    // the model retries. An explicit start, and every other field, stays exact.
    const candidate = proposed.type === "interval"
      && routine.schedule.type === "interval"
      && definition.schedule.type === "interval"
      && definition.schedule.anchorAt === undefined
      ? { ...proposed, anchorAt: routine.schedule.anchorAt }
      : proposed;
    return isDeepStrictEqual(candidate, routine.schedule);
  });
}

function revalidateOperation(operation: RoutineRequestOperation, manager: RoutineManager, botId: string, now: number): void {
  if (operation.action === "create") {
    const duplicate = duplicateRoutine(operation.routine, operation.forBot?.botId ?? botId, manager, now);
    // Name the existing routine so the model can act on it. It cannot choose
    // where results go, so creating a second copy is never the right recovery.
    if (duplicate) {
      throw new RoutineRequestError(
        `An enabled routine with the same instructions and settings already exists (${duplicate.id}). Use ${murageToolOnThisServer("list_routines")} to review it, then update or run that routine instead.`,
        409,
      );
    }
  }
  const current = operation.action === "create"
    ? null
    : verifyManageSnapshot(operation, manager, botId);
  const schedule = operation.action === "create"
    ? operation.routine.schedule
    : operation.action === "update"
      ? operation.changes.schedule
      : undefined;
  if (operation.action === "create" && operation.routine.watch && operation.routine.watch.expiresAt <= now) throw new RoutineRequestError("This watch expiry has passed. Choose a new expiry and confirm a fresh watch.", 409);
  if (schedule?.type === "once" && schedule.at <= now) {
    throw new RoutineRequestError("That one-time schedule is now in the past. Ask the bot to propose a new time.", 409);
  }
  if (operation.action === "resume") {
    if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
    if (nextOccurrence(current.schedule, now) === null) {
      throw new RoutineRequestError(
        "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.",
        409,
      );
    }
  }
}

// ---- Webhook cards (SL-J J1) ----------------------------------------------
const WEBHOOK_ACTION_COPY = {
  create: { title: "Create webhook", detail: "Create webhook" },
  update: { title: "Update webhook", detail: "Update webhook" },
  pause: { title: "Pause webhook", detail: "Pause webhook" },
  resume: { title: "Resume webhook", detail: "Resume webhook" },
  delete: { title: "Delete webhook", detail: "Delete webhook" },
} as const satisfies Record<WebhookRequestOperation["action"], { title: string; detail: string }>;

function eventTypeList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return Array.from(new Set(values.map((value) => redactSecretsInText(value.trim()).slice(0, 200)).filter(Boolean))).slice(0, 20);
}

function webhookId(value: string): string {
  if (!WEBHOOK_ID.test(value)) throw new RoutineRequestError("Choose a valid webhook id");
  return value;
}

function ownedWebhook(webhooks: WebhookRequestTarget, id: string, botId: string): WebhookTrigger | null {
  const current = webhooks.get(id);
  return current && current.botId === botId ? current : null;
}

function verifyWebhookSnapshot(
  operation: Exclude<WebhookRequestOperation, { action: "create" }>,
  webhooks: WebhookRequestTarget,
  botId: string,
): WebhookTrigger {
  const current = ownedWebhook(webhooks, operation.webhookId, botId);
  if (!current) throw new RoutineRequestError("That webhook no longer exists", 404);
  if (current.updatedAt !== operation.expectedUpdatedAt) {
    throw new RoutineRequestError(
      "That webhook changed after this confirmation card was prepared. Ask the bot to review it and propose the action again.",
      409,
    );
  }
  return current;
}

function normalizedWebhookOperation(
  webhooks: WebhookRequestTarget,
  botId: string,
  validated: z.output<typeof webhookProposalSchema>,
): WebhookRequestOperation {
  if (validated.action === "create") {
    const eventTypes = eventTypeList(validated.webhook.eventTypes);
    return {
      action: "create",
      // replaced by the request-bound id once the request id exists (propose)
      webhook: {
        id: "pending",
        name: text(validated.webhook.name, "name", 80),
        prompt: text(validated.webhook.instructions, "instructions", 20_000),
        ...(eventTypes?.length ? { eventTypes } : {}),
      },
    };
  }
  const id = webhookId(validated.webhookId);
  const current = ownedWebhook(webhooks, id, botId);
  if (!current) throw new RoutineRequestError("That webhook does not exist", 404);
  if (validated.action === "update") {
    const changes: WebhookRequestChanges = {};
    if (validated.changes.name !== undefined) changes.name = text(validated.changes.name, "name", 80);
    if (validated.changes.instructions !== undefined) changes.prompt = text(validated.changes.instructions, "instructions", 20_000);
    if (validated.changes.eventTypes !== undefined) changes.eventTypes = eventTypeList(validated.changes.eventTypes) ?? [];
    return { action: "update", webhookId: id, expectedUpdatedAt: current.updatedAt, changes };
  }
  return { action: validated.action, webhookId: id, expectedUpdatedAt: current.updatedAt };
}

function webhookCardCopy(operation: WebhookRequestOperation, webhooks: WebhookRequestTarget): RoutineCardCopy {
  const current = operation.action === "create" ? null : webhooks.get(operation.webhookId);
  const name = redactSecretsInText(
    operation.action === "create" ? operation.webhook.name
      : operation.action === "update" && operation.changes.name !== undefined ? operation.changes.name
        : current?.name ?? "webhook",
  );
  const prompt = operation.action === "create" ? operation.webhook.prompt
    : operation.action === "update" && operation.changes.prompt !== undefined ? operation.changes.prompt
      : current?.prompt ?? "";
  const eventTypes = operation.action === "create" ? operation.webhook.eventTypes
    : operation.action === "update" && operation.changes.eventTypes !== undefined ? operation.changes.eventTypes
      : current?.eventTypes;
  const copy = WEBHOOK_ACTION_COPY[operation.action];
  const title = `${copy.title} “${name}”?`;
  const events = eventTypes?.length ? eventTypes.map((value) => redactSecretsInText(value)).join(", ") : "Every event";
  const status = operation.action === "pause" ? "Paused: calls are refused until it is resumed"
    : operation.action === "resume" ? "On: calls start a task again"
      : operation.action === "delete" ? "Deleted with its history"
        : operation.action === "update" && current?.enabled === false ? "Remains paused" : "On";
  const detail = [
    `Action: ${copy.detail}`,
    `Name: ${name}`,
    "Runs: each time another app calls this webhook's link",
    `Events: ${events}`,
    `Status: ${status}`,
    ...(operation.action === "create"
      ? ["Link: none yet. You make it on the Automations page with Copy command. The bot never sees the link or its secret."]
      : []),
    ...(prompt ? ["", "Instructions:", redactSecretsInText(prompt)] : []),
  ].join("\n");
  return {
    title,
    summary: `${copy.title} “${name}” · ${events} · ${status}`,
    detail,
    nextRunAt: null,
    tool: operation.action === "create" ? "create_webhook" : "manage_webhook",
  };
}

function routineBefore(routine: Routine): AutomationUndoBefore {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedule: structuredClone(routine.schedule),
    overlap: routine.overlap ?? "skip",
    timeoutMinutes: routine.timeoutMinutes ?? null,
    enabled: routine.enabled,
  };
}

function webhookBefore(webhook: WebhookTrigger): AutomationUndoBefore {
  return { name: webhook.name, prompt: webhook.prompt, eventTypes: [...(webhook.eventTypes ?? [])], enabled: webhook.enabled };
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 400;
}

function changedSince(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "webhook_changed";
}

// Private copies until S1-CA3 supplies the shared predicate.
function isAllowedAnswer(answered: unknown): boolean {
  return answered === "Allowed" || answered === "allow";
}

type ReceiptSource = 'parkQ' | 'doneQ' | 'undoQ';
interface ReceiptEntry {
  receipt: RoutineRequestReceipt;
  dueAt: number;
}

/** Head-index FIFO: no shift of the whole live array on each visit. */
class ReceiptQueue {
  private entries: ReceiptEntry[] = [];
  private head = 0;
  get length(): number { return this.entries.length - this.head; }
  at(offset = 0): ReceiptEntry | undefined { return this.entries[this.head + offset]; }
  push(entry: ReceiptEntry): void { this.entries.push(entry); }
  shift(): void {
    this.head++;
    if (this.head >= 64 && this.head * 2 >= this.entries.length) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }
}

export class RoutineRequestService {
  private readonly approvals = new ProducerApprovalQueue('routine',undefined,(item,answer)=>this.acceptApproval(item,answer),(item,answer)=>this.acceptApproval(item,answer));
  pendingApprovals(){return this.approvals.pendingApprovals();}
  approvalQueue(){return this.approvals;}
  private acceptApproval(item:PendingQueueApproval,answer:ApprovalAnswer):void {
    if(answer.behavior!=='allow')return;
    const parsed=parseCardPayload(item.call.approval.action.routineRequest);
    if(!parsed.success)throw new RoutineRequestError('This routine request is invalid',409);
    const payload=parsed.data, record=readApproval(item.approvalId);
    if(!record||record.queue?.ref!==item.ref||record.queue.epoch!==item.epoch)throw new RoutineRequestError('This routine request id does not match its confirmation card',409);
    const receipt=this.routines.routineRequestReceipt(payload.requestId);
    if(receipt){
      if(receipt.botId!==payload.botId||receipt.threadId!==payload.threadId||receipt.messageId!==record.chatMessageId||receipt.fingerprint!==routineRequestFingerprint(payload,record.chatMessageId))throw new RoutineRequestError('This routine request does not match its durable commit receipt',409);
      if(receipt.resultId!==undefined){this.stampApplied(payload.threadId,record.chatMessageId,payload.requestId);return;}
      if(payload.kind==='webhook'&&payload.operation.action==='create'){
        const existing=this.webhooks().get(payload.operation.webhook.id);
        if(existing&&existing.botId===payload.botId){this.routines.completeRoutineRequest(requestCommit(payload,record.chatMessageId),existing.id,this.now(),existing.createdAt);this.stampApplied(payload.threadId,record.chatMessageId,payload.requestId);return;}
      }
    }
    if(payload.kind==='webhook')this.applyWebhook(payload,record.chatMessageId);
    else {revalidateOperation(payload.operation,this.routines,payload.botId,this.now());this.apply(payload,record.chatMessageId,routineRequestFingerprint(payload,record.chatMessageId));}
    this.stampApplied(payload.threadId,record.chatMessageId,payload.requestId);
  }

  private byId = new Map<string, ReceiptEntry>();
  private receiptQueues = { parkQ: new ReceiptQueue(), doneQ: new ReceiptQueue(), undoQ: new ReceiptQueue() };
  private receiptsSeeded = false;
  private lastUndoDueAt = 0;
  private readonly onVisit?: RoutineRequestServiceOptions['onVisit'];

  private stampApplied(threadId: string, messageId: string, requestId: string): void {
    const receipt = this.routines.routineRequestReceipt(requestId);
    if (!receipt) return;
    // TODO(s2p-r5): admission at 256 must reclaim accepted parked receipts too.
    // No history sweep runs from proposal, resolution, or receipt replay.
    if (!this.byId.has(requestId)) this.enqueueReceipt(receipt, 'parkQ');
    else this.byId.get(requestId)!.receipt = receipt;
    const message = this.store.cardForRequest?.(threadId, requestId);
    if (message?.id === messageId) this.stampReceipt(receipt, message);
  }

  private stampReceipt(receipt: RoutineRequestReceipt, message: RoutineRequestMessage): void {
    const card = message.card;
    if (!card || typeof card.answered !== 'string' || typeof receipt.appliedAt !== 'number'
      || receipt.undoneAt !== undefined || card.answeredAt === receipt.appliedAt) return;
    try {
      if (!this.store.patchMessage(receipt.threadId, receipt.messageId, { card: { ...card, answeredAt: receipt.appliedAt } })) {
        throw new Error('routine-stamp-unavailable');
      }
    } catch {
      // Execution already committed; recovery can retry this terminal-only patch.
      console.warn('routine-stamp-failed');
    }
  }

  private receiptProtected(receipt: RoutineRequestReceipt, message?: RoutineRequestMessage): boolean {
    const record = lookupApproval(receipt.threadId, receipt.messageId);
    // S1-CA2 will expose delivery in ApprovalRecordView; keep this slice additive.
    const delivery = (record as { delivery?: string } | null)?.delivery;
    if (record) return record.state === 'open'
      || (record.state === 'answered' && (delivery === 'pending' || delivery === 'failed'));
    return Boolean(message?.card && typeof message.card.answered !== 'string' && !message.card.dismissed);
  }

  private enqueueReceipt(receipt: RoutineRequestReceipt, source: ReceiptSource): void {
    const entry = { receipt, dueAt: 0 };
    this.byId.set(receipt.requestId, entry);
    this.moveReceipt(entry, source);
  }

  private moveReceipt(entry: ReceiptEntry, source: ReceiptSource): void {
    if (source === 'undoQ') {
      entry.dueAt = Math.max(this.lastUndoDueAt, entry.receipt.appliedAt! + AUTOMATION_UNDO_WINDOW_MS);
      this.lastUndoDueAt = entry.dueAt;
    }
    this.receiptQueues[source].push(entry);
  }

  /** One snapshot, one bulk reconcile. Only startup may walk receipt history. */
  reconcileAtStartup(): void {
    const snapshot = this.routines.routineRequestReceiptSnapshot();
    const rejected = new Set<string>();
    this.byId.clear();
    this.receiptQueues = { parkQ: new ReceiptQueue(), doneQ: new ReceiptQueue(), undoQ: new ReceiptQueue() };
    this.lastUndoDueAt = 0;
    // Receipts are persisted newest first. Reverse traversal keeps each FIFO oldest first.
    for (let i = snapshot.length - 1; i >= 0; i--) {
      const receipt = snapshot[i]!;
      // TODO(s2p-r5): use the known message ID; cardForRequest scans terminal history today.
      const message = this.store.cardForRequest?.(receipt.threadId, receipt.requestId);
      if (message?.id === receipt.messageId && message.card && this.undoOffered(receipt, message.card)) this.stampReceipt(receipt, message);
      if (this.receiptProtected(receipt, message)) this.enqueueReceipt(receipt, 'parkQ');
      else if (message?.id === receipt.messageId && message.card && this.undoOffered(receipt, message.card)) {
        this.enqueueReceipt(receipt, 'undoQ');
      } else {
        rejected.add(receipt.requestId);
        this.enqueueReceipt(receipt, 'doneQ');
      }
    }
    // TODO(s2p-r5): enforce capacity after accepted parked receipts can be reclaimed.
    if (this.dropReceipts(rejected, snapshot) === 'removed') {
      for (const id of rejected) this.byId.delete(id);
      // The entire done queue was rejected; a failed save keeps it for the next tick.
      this.receiptQueues.doneQ = new ReceiptQueue();
    }
    this.receiptsSeeded = true;
  }

  private dropReceipts(ids: ReadonlySet<string>, snapshot?: RoutineRequestReceipt[]): 'removed' | 'failed' {
    if (ids.size === 0) return 'removed';
    try {
      const survivors = (snapshot ?? this.routines.routineRequestReceiptSnapshot()).filter(receipt => !ids.has(receipt.requestId));
      this.routines.reconcileRoutineRequestReceipts(survivors);
      return 'removed';
    } catch {
      return 'failed';
    }
  }

  /** Fixed rotation, shared budget, and one atomic drop. No proposal calls this. */
  sweepReceipts(now = this.now(), budget = 64): void {
    if (!this.receiptsSeeded) { this.reconcileAtStartup(); return; }
    const sources: ReceiptSource[] = ['parkQ', 'doneQ', 'undoQ'];
    // Preview only the visited prefixes. Queue heads move after the batch save succeeds.
    const previews = sources.map(source => ({ source, consumed: 0, base: this.receiptQueues[source].length, tail: [] as ReceiptEntry[] }));
    const transitions: { source: ReceiptSource; entry: ReceiptEntry; target?: ReceiptSource }[] = [];
    const drops = new Set<string>();
    const stagedDueAt = new Map<ReceiptEntry, number>();
    let lastDueAt = this.lastUndoDueAt;
    let visits = 0;
    while (visits < Math.min(64, budget)) {
      let progressed = false;
      for (const preview of previews) {
        if (visits >= Math.min(64, budget)) break;
        const entry = preview.consumed < preview.base
          ? this.receiptQueues[preview.source].at(preview.consumed)
          : preview.tail[preview.consumed - preview.base];
        if (!entry || (preview.source === 'undoQ' && (stagedDueAt.get(entry) ?? entry.dueAt) > now)) continue;
        preview.consumed++;
        visits++;
        progressed = true;
        this.onVisit?.(preview.source, entry.receipt.requestId);
        const receipt = entry.receipt;
        // One indexed decision lookup per visit, including obsolete entries.
        const message = this.store.cardForRequest?.(receipt.threadId, receipt.requestId);
        const protectedReceipt = this.receiptProtected(receipt, message);
        let target: ReceiptSource | undefined;
        if (this.byId.get(receipt.requestId) === entry) {
          if (protectedReceipt) target = 'parkQ';
          else if (preview.source === 'parkQ' && message?.id === receipt.messageId
            && message.card && this.undoOffered(receipt, message.card)) {
            this.stampReceipt(receipt, message);
            target = 'undoQ';
          } else drops.add(receipt.requestId);
        }
        transitions.push({ source: preview.source, entry, target });
        if (target === 'undoQ') {
          lastDueAt = Math.max(lastDueAt, receipt.appliedAt! + AUTOMATION_UNDO_WINDOW_MS);
          stagedDueAt.set(entry, lastDueAt);
        }
        if (target) previews[sources.indexOf(target)]!.tail.push(entry);
      }
      if (!progressed) break;
    }
    if (this.dropReceipts(drops) === 'failed') return;
    for (const { source, entry, target } of transitions) {
      this.receiptQueues[source].shift();
      if (target) this.moveReceipt(entry, target);
      else if (this.byId.get(entry.receipt.requestId) === entry) this.byId.delete(entry.receipt.requestId);
    }
  }

  private readonly store: RoutineRequestStore;
  private readonly routines: RoutineManager;
  private readonly now: () => number;
  private readonly timeZone: () => string;
  private readonly cloudReady?: () => Promise<{ ready: boolean; reason?: string }>;
  private readonly canPersist?: RoutineRequestServiceOptions["canPersist"];
  private readonly holdTarget?: RoutineRequestServiceOptions["holdTarget"];
  private readonly validateTarget?: RoutineRequestServiceOptions["validateTarget"];
  private readonly resolveWatchSource?: RoutineRequestServiceOptions["resolveWatchSource"];
  private readonly webhookTarget?: RoutineRequestServiceOptions["webhooks"];

  constructor(options: RoutineRequestServiceOptions) {
    this.onVisit = options.onVisit;
    this.webhookTarget = options.webhooks;
    this.store = options.store;
    this.routines = options.routines;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.cloudReady = options.cloudReady;
    this.canPersist = options.canPersist;
    this.validateTarget = options.validateTarget;
    this.holdTarget = options.holdTarget;
    this.resolveWatchSource = options.resolveWatchSource;
  }

  private webhooks(): WebhookRequestTarget {
    const target = this.webhookTarget?.();
    if (!target) throw new RoutineRequestError("Webhooks are unavailable here", 409);
    return target;
  }

  async propose(args: ProposeRoutineRequestArgs): Promise<RoutineProposalResult> {
    const botId = text(args.botId, "botId", 128);
    const threadId = text(args.threadId, "threadId", 128);
    if ((args.proposal as { kind?: unknown } | null)?.kind === "webhook") return this.proposeWebhook(args, botId, threadId);
    const at = this.now();
    const parsedProposal = routineProposalSchema.safeParse(args.proposal);
    if (!parsedProposal.success) {
      throw new RoutineRequestError(schemaIssue(parsedProposal.error, "Invalid routine proposal"));
    }
    const operation = normalizedOperation(this.routines, botId, parsedProposal.data, at);
    if (parsedProposal.data.action === "create" && parsedProposal.data.routine.watch && operation.action === "create") {
      if (!this.resolveWatchSource) throw new RoutineRequestError("File watches are unavailable here", 409);
      if (operation.routine.runOn !== "ember" || operation.routine.schedule.type !== "interval") throw new RoutineRequestError("File watches use an interval on this computer");
      const input = parsedProposal.data.routine.watch;
      operation.routine.watch = routineWatchInputSchema.parse({
        source: this.resolveWatchSource(botId, operation.forBot?.botId ?? botId, input.relativePath),
        expiresAt: Date.parse(input.expiresAt), maxChecks: input.maxChecks,
      });
    }
    if (operation.action === "create" && operation.forBot && this.validateTarget) {
      const refusal = this.validateTarget(botId, operation.forBot, threadId);
      if (refusal) throw new RoutineRequestError(refusal, 403);
    }
    await this.requireCloudReadiness(operation);
    // The readiness probe is asynchronous. Another request can edit or
    // delete the routine while it is in flight, so re-check the captured
    // revision before rendering and persisting the confirmation snapshot.
    const cardAt = this.now();
    revalidateOperation(operation, this.routines, botId, cardAt);
    const requestId = newId();
    const payload: RoutineRequestCardData = {
      version: 1,
      requestId,
      botId,
      threadId,
      createdAt: cardAt,
      operation,
    };
    const timeZone = this.timeZone();
    const copy = cardCopy(operation, this.routines, timeZone, cardAt);
    const messageInput: Parameters<RoutineRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: ["Confirm", "Cancel"],
        requestId,
        tool: copy.tool,
        routineRequest: payload,
        routineProposalDigest: routineProposalDigest(payload, { title: copy.title, subtitle: copy.detail }),
      },
    };
    if (args.from) messageInput.from = args.from;
    // This check and append are deliberately adjacent and synchronous. JS
    // cannot interleave another completed proposal between the capacity /
    // ownership decision and the durable transcript write.
    const persistence = this.canPersist?.(botId, threadId);
    if (persistence && !persistence.ok) {
      throw new RoutineRequestError(persistence.error, persistence.status);
    }
    args.canCommit?.();
    const {title,subtitle,detail:_detail,answered:_answered,answeredAt:_answeredAt,dismissed:_dismissed,...action}=messageInput.card;
    const verified=typeof args.authority === "function" ? undefined : args.authority;
    const approval=this.approvals.open({authority:verified,ref:requestId,tool:copy.tool,input:operation,
      action:{...action,routineRequest:{...payload,id:requestId}},view:{title,subtitle},base:producerBase(!serviceNoLimits(verified?.identity?.generation??'',threadId,botId))});
    const executed=await this.approvals.execute(approval,async(call)=>{
      const parsed=parseCardPayload(call.approval!.action.routineRequest);if(!parsed.success||parsed.data.kind==='webhook')throw new RoutineRequestError('This routine request is invalid',409);
      const frozenPayload=parsed.data;
      const targetBotId=frozenPayload.operation.action==='create'?frozenPayload.operation.forBot?.botId??botId:botId;
      if(frozenPayload.operation.action==='create'&&frozenPayload.operation.forBot&&this.validateTarget){
        const refusal=this.validateTarget(botId,frozenPayload.operation.forBot,threadId);
        if(refusal)throw new RoutineRequestError(refusal,403);
      }
      if(this.holdTarget?.(targetBotId,frozenPayload))throw new RoutineRequestError('This action is unavailable.',409);
      return this.apply(frozenPayload,requestId,routineRequestFingerprint(frozenPayload,requestId));
    });
    if(executed.kind==='executed'){this.forgetReceipt(requestCommit(payload,requestId));return {requestId,messageId:requestId,title:copy.title,summary:copy.summary,detail:copy.detail,nextRunAt:copy.nextRunAt,timeZone,applied:true,resultId:executed.value};}
    if(executed.kind==='refuse')throw new RoutineRequestError(executed.message,409);
    await this.approvals.present(approval,executed.ref);
    const message={id:readApproval(executed.ref.approvalId)!.chatMessageId};
    return {
      requestId,
      messageId: message.id,
      title: copy.title,
      summary: copy.summary,
      detail: copy.detail,
      nextRunAt: copy.nextRunAt,
      timeZone,
    };
  }

  /** A webhook card: same card, same guard, same Confirm (SL-J J1). */
  private async proposeWebhook(args: ProposeRoutineRequestArgs, botId: string, threadId: string): Promise<RoutineProposalResult> {
    const parsedProposal = webhookProposalSchema.safeParse(args.proposal);
    if (!parsedProposal.success) {
      throw new RoutineRequestError(schemaIssue(parsedProposal.error, "Invalid webhook proposal"));
    }
    const webhooks = this.webhooks();
    const operation = normalizedWebhookOperation(webhooks, botId, parsedProposal.data);
    const requestId = newId();
    // The id is derived once, here, from the request id (section 8 item 1).
    if (operation.action === "create") operation.webhook.id = webhookIdForRequest(requestId);
    else verifyWebhookSnapshot(operation, webhooks, botId);
    const cardAt = this.now();
    const payload: WebhookRequestCardData = { version: 1, kind: "webhook", requestId, botId, threadId, createdAt: cardAt, operation };
    const copy = webhookCardCopy(operation, webhooks);
    const messageInput: Parameters<RoutineRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: ["Confirm", "Cancel"],
        requestId,
        tool: copy.tool,
        routineRequest: payload,
        routineProposalDigest: routineProposalDigest(payload, { title: copy.title, subtitle: copy.detail }),
      },
    };
    if (args.from) messageInput.from = args.from;
    const persistence = this.canPersist?.(botId, threadId);
    if (persistence && !persistence.ok) throw new RoutineRequestError(persistence.error, persistence.status);
    args.canCommit?.();
    const {title,subtitle,detail:_detail,answered:_answered,answeredAt:_answeredAt,dismissed:_dismissed,...action}=messageInput.card;
    const verified=typeof args.authority === "function" ? undefined : args.authority;
    const approval=this.approvals.open({authority:verified,ref:requestId,tool:copy.tool,input:operation,
      action:{...action,routineRequest:{...payload,id:requestId}},view:{title,subtitle},base:producerBase(!serviceNoLimits(verified?.identity?.generation??'',threadId,botId))});
    const executed=await this.approvals.execute(approval,async(call)=>{const parsed=parseCardPayload(call.approval!.action.routineRequest);if(!parsed.success||parsed.data.kind!=='webhook')throw new RoutineRequestError('This routine request is invalid',409);return this.applyWebhook(parsed.data,requestId);});
    if(executed.kind==='executed'){this.forgetReceipt(requestCommit(payload,requestId));return {requestId,messageId:requestId,title:copy.title,summary:copy.summary,detail:copy.detail,nextRunAt:null,timeZone:this.timeZone(),applied:true,resultId:executed.value};}
    if(executed.kind==='refuse')throw new RoutineRequestError(executed.message,409);
    await this.approvals.present(approval,executed.ref);
    const message={id:readApproval(executed.ref.approvalId)!.chatMessageId};
    return {
      requestId,
      messageId: message.id,
      title: copy.title,
      summary: copy.summary,
      detail: copy.detail,
      nextRunAt: null,
      timeZone: this.timeZone(),
    };
  }

  private async requireCloudReadiness(operation: RoutineRequestOperation): Promise<void> {
    if (!this.cloudReady || operation.action === "pause" || operation.action === "delete") return;
    const definition = effectiveDefinition(operation, this.routines);
    if (definition?.runOn !== "cloud") return;
    let readiness: { ready: boolean; reason?: string };
    try {
      readiness = await this.cloudReady();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoutineRequestError(`Could not verify cloud readiness: ${detail}`, 503);
    }
    if (readiness.ready) return;
    throw new RoutineRequestError(
      readiness.reason?.trim() || "Cloud execution is not configured yet. Set up a cloud computer first.",
      409,
    );
  }

  /**
   * Claims a routine card even after it was settled. That distinction is
   * important: duplicate clicks must never fall through to a provider that
   * did not create the request id.
   */
  resolve(args:{botId:string;threadId:string;requestId:string;behavior:string|undefined}):ResolveRoutineRequestResult {
    const message=this.store.cardForRequest?.(args.threadId,args.requestId,candidate=>Boolean(candidate.card?.routineRequest));
    if(!message?.card?.routineRequest)return {claimed:false,state:'not_found'};
    const record=lookupApproval(args.threadId,message.id);
    if(!record||record.botId!==args.botId||record.queue?.kind!=='routine')return {claimed:true,state:'invalid',error:'This routine request belongs to another conversation',status:403};
    if(args.behavior==='undo'){
      if(!this.undoOffered(this.routines.routineRequestReceipt(args.requestId),message.card))return {claimed:true,state:'invalid',error:AUTOMATION_CHANGED_SINCE,status:409};
      return this.undo(args,message.id,message.card,message.card.routineRequest);
    }
    if(args.behavior!=='allow'&&args.behavior!=='deny')return {claimed:true,state:'invalid',error:'Routine confirmations must be confirmed or cancelled',status:400};
    if(record.state!=='open'){return {claimed:true,state:'already_settled',behavior:message.card.answered??'unavailable'};}
    if(answerApprovalSync(record.ref,{behavior:args.behavior}).state==='failed')return {claimed:true,state:'invalid',error:'This routine request is invalid',status:409};
    if(args.behavior==='deny')return {claimed:true,state:'denied'};
    const receipt=this.routines.routineRequestReceipt(args.requestId);
    return {claimed:true,state:'applied',action:message.card.routineRequest.operation.action,resultId:receipt?.resultId??args.requestId};
  }

  /** Undo is offered while the card is applied, not undone, its change has a
   * `before`, and it was applied in the last 7 days (section 8 item 2). */
  private undoOffered(receipt: RoutineRequestReceipt | null, card: RoutineRequestOptionCard): boolean {
    return Boolean(
      receipt
      && isAllowedAnswer(card.answered)
      && !card.undone
      && receipt.undoneAt === undefined
      && automationActionUndoable(receipt.action)
      && receipt.before !== undefined && receipt.before !== null
      && receipt.appliedAt !== undefined
      && this.now() - receipt.appliedAt <= AUTOMATION_UNDO_WINDOW_MS,
    );
  }

  /** A settled card's receipt is kept while it offers Undo; otherwise it is
   * redundant once the transcript is settled. */
  private forgetSettledReceipt(payload: AutomationRequestCardData, messageId: string): void {
    this.forgetReceipt(requestCommit(payload, messageId));
  }

  private forgetReceipt(request: RoutineRequestCommit): void {
    try {
      this.routines.forgetRoutineRequestReceipt(request);
      this.byId.delete(request.requestId);
    } catch {
      // The transcript is already durably settled. Retaining a redundant
      // receipt after a cleanup write failure is safe and a later duplicate
      // response will retry this cleanup.
    }
  }

  /** Crash after the webhook was saved and before its receipt gained the
   * result: the request-bound id finds the record, nothing is made twice. */
  private applyWebhook(payload: WebhookRequestCardData, messageId: string): string {
    const webhooks = this.webhooks();
    const operation = payload.operation;
    const commit = requestCommit(payload, messageId);
    const current = operation.action === "create" ? null : verifyWebhookSnapshot(operation, webhooks, payload.botId);
    // TODO(s2p-r5): reclaim accepted parkQ entries and enforce admission before begin.
    this.routines.beginRoutineRequest(commit, {
      kind: "webhook",
      before: operation.action === "create" ? { absent: true } : operation.action === "delete" ? null : webhookBefore(current!),
      ...(operation.action === "create" ? {} : { expectedUpdatedAt: operation.expectedUpdatedAt }),
    });
    let resultId: string;
    let appliedUpdatedAt: number | undefined;
    try {
      if (operation.action === "create") {
        const created = webhooks.create({
          name: operation.webhook.name,
          prompt: operation.webhook.prompt,
          botId: payload.botId,
          runOn: "ember",
          enabled: true,
          ...(operation.webhook.eventTypes ? { eventTypes: [...operation.webhook.eventTypes] } : {}),
        }, { id: operation.webhook.id, mint: false });
        resultId = created.webhook.id;
        appliedUpdatedAt = created.webhook.updatedAt;
      } else if (operation.action === "delete") {
        if (!webhooks.remove(operation.webhookId, { expectedUpdatedAt: operation.expectedUpdatedAt })) {
          throw new RoutineRequestError("That webhook no longer exists", 404);
        }
        resultId = operation.webhookId;
      } else {
        const patch: JsonObject = operation.action === "update"
          ? {
              ...(operation.changes.name === undefined ? {} : { name: operation.changes.name }),
              ...(operation.changes.prompt === undefined ? {} : { prompt: operation.changes.prompt }),
              ...(operation.changes.eventTypes === undefined ? {} : { eventTypes: [...operation.changes.eventTypes] }),
            }
          : { enabled: operation.action === "resume" };
        const updated = webhooks.update(operation.webhookId, patch, { expectedUpdatedAt: operation.expectedUpdatedAt });
        if (!updated) throw new RoutineRequestError("That webhook no longer exists", 404);
        resultId = updated.id;
        appliedUpdatedAt = updated.updatedAt;
      }
    } catch (error) {
      // nothing changed: the receipt written before it goes too
      this.forgetReceipt(commit);
      if (error instanceof RoutineRequestError) throw error;
      throw new RoutineRequestError(error instanceof Error ? error.message : String(error), statusOf(error));
    }
    this.routines.completeRoutineRequest(commit, resultId, this.now(), appliedUpdatedAt);
    return resultId;
  }

  private apply(payload: RoutineRequestCardData, messageId: string, fingerprint: string): string {
    const operation = payload.operation;
    const confirmationAt = this.now();
    // SL-J J2 step 1: the receipt with `before`, saved before the change. The
    // change below fills its result in the same write as the change itself.
    const current = operation.action === "create" ? null : verifyManageSnapshot(operation, this.routines, payload.botId);
    const commit = requestCommit(payload, messageId);
    // TODO(s2p-r5): reclaim accepted parkQ entries and enforce admission before begin.
    this.routines.beginRoutineRequest(commit, {
      before: operation.action === "create" ? { absent: true }
        : automationActionUndoable(operation.action) ? routineBefore(current!) : null,
      ...(operation.action === "create" ? {} : { expectedUpdatedAt: operation.expectedUpdatedAt }),
    });
    try {
      return this.applyRoutine(payload, messageId, fingerprint, confirmationAt);
    } catch (error) {
      // the routine change and its result are one write: nothing changed
      if (this.routines.routineRequestReceipt(payload.requestId)?.resultId === undefined) this.forgetReceipt(commit);
      throw error;
    }
  }

  private applyRoutine(payload: RoutineRequestCardData, messageId: string, fingerprint: string, confirmationAt: number): string {
    const operation = payload.operation;
    switch (operation.action) {
      case "create":
        return this.routines.create(inputFromDefinition(
          operation.routine,
          operation.forBot?.botId ?? payload.botId,
          confirmationAt,
        ), {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "create",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        }).id;
      case "update": {
        verifyManageSnapshot(operation, this.routines, payload.botId);
        const updated = this.routines.update(operation.routineId, updateFromChanges(operation.changes, confirmationAt), {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "update",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "pause":
      case "resume": {
        verifyManageSnapshot(operation, this.routines, payload.botId);
        const updated = this.routines.update(operation.routineId, { enabled: operation.action === "resume" }, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: operation.action,
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "run_now": {
        verifyManageSnapshot(operation, this.routines, payload.botId);
        const run = this.routines.runNow(operation.routineId, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "run_now",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!run) throw new RoutineRequestError("That routine no longer exists", 404);
        return run.id;
      }
      case "delete":
        verifyManageSnapshot(operation, this.routines, payload.botId);
        if (!this.routines.remove(operation.routineId, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "delete",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        })) {
          throw new RoutineRequestError("That routine no longer exists", 404);
        }
        return operation.routineId;
      default:
        throw new RoutineRequestError("Unsupported persisted routine action");
    }
  }

  /** SL-J J2: Undo restores the receipt's `before` exactly, as one manage
   * operation guarded by the `updatedAt` the change left. It never reads the
   * current record to build an inverse. */
  private undo(
    args: { botId: string; threadId: string; requestId: string },
    messageId: string,
    card: RoutineRequestOptionCard,
    rawPayload: AutomationRequestCardData,
  ): ResolveRoutineRequestResult {
    const refuse = (error: string, status = 409, code?: "changed_since"): ResolveRoutineRequestResult =>
      ({ claimed: true, state: "invalid", error, status, ...(code ? { code } : {}) });
    if (rawPayload.botId !== args.botId || rawPayload.threadId !== args.threadId) {
      return refuse("This routine request belongs to another conversation", 403);
    }
    if (card.undone) return { claimed: true, state: "already_settled", behavior: "undo" };
    if (!isAllowedAnswer(card.answered)) return refuse("Only a change that was applied can be undone.");
    const parsed = parseCardPayload(rawPayload);
    if (!parsed.success || parsed.data.requestId !== args.requestId) return refuse("This change cannot be undone because its card could not be read.");
    const payload = parsed.data;
    if (!automationActionUndoable(payload.operation.action)) return refuse("Undo is not offered for delete or run now.");
    const receipt = this.routines.routineRequestReceipt(payload.requestId);
    const unavailable = "Undo is no longer available for this change. Change it on the Automations page instead.";
    if (
      !receipt
      || receipt.messageId !== messageId
      || receipt.botId !== payload.botId
      || receipt.threadId !== payload.threadId
      || receipt.action !== payload.operation.action
      || receipt.fingerprint !== routineRequestFingerprint(payload, messageId)
      || (receipt.kind ?? undefined) !== payload.kind
    ) return refuse(unavailable);
    // Undo finished, then the card was not marked: mark it now.
    if (receipt.undoneAt !== undefined) return this.settleUndone(args.threadId, messageId, card, payload);
    if (receipt.resultId === undefined || receipt.appliedUpdatedAt === undefined || receipt.appliedAt === undefined) return refuse(unavailable);
    if (this.now() - receipt.appliedAt > AUTOMATION_UNDO_WINDOW_MS) {
      return refuse("Undo is available for 7 days after a change. Change it on the Automations page instead.");
    }
    const absent = absentBeforeSchema.safeParse(receipt.before);
    const resultId = receipt.resultId;
    const expectedUpdatedAt = receipt.appliedUpdatedAt;
    try {
      if (payload.kind === "webhook") {
        const webhooks = this.webhooks();
        if (!ownedWebhook(webhooks, resultId, payload.botId)) return refuse(AUTOMATION_CHANGED_SINCE, 409, "changed_since");
        if (absent.success) {
          if (!webhooks.remove(resultId, { expectedUpdatedAt })) return refuse(AUTOMATION_CHANGED_SINCE, 409, "changed_since");
        } else {
          const before = webhookBeforeSchema.safeParse(receipt.before);
          if (!before.success) return refuse(unavailable);
          if (!webhooks.update(resultId, { ...before.data, eventTypes: [...before.data.eventTypes] }, { expectedUpdatedAt })) {
            return refuse(AUTOMATION_CHANGED_SINCE, 409, "changed_since");
          }
        }
        this.routines.markRoutineRequestUndone(payload.requestId, this.now());
      } else {
        if (!ownedRoutine(this.routines, resultId, payload.botId)) return refuse(AUTOMATION_CHANGED_SINCE, 409, "changed_since");
        let outcome: "undone" | "changed" | "missing";
        if (absent.success) outcome = this.routines.undoRoutineRequest(payload.requestId, resultId, expectedUpdatedAt, { remove: true });
        else {
          const before = routineBeforeSchema.safeParse(receipt.before);
          if (!before.success) return refuse(unavailable);
          outcome = this.routines.undoRoutineRequest(payload.requestId, resultId, expectedUpdatedAt, {
            patch: {
              name: before.data.name,
              prompt: before.data.prompt,
              schedule: structuredClone(before.data.schedule),
              overlap: before.data.overlap,
              timeoutMinutes: before.data.timeoutMinutes,
              enabled: before.data.enabled,
            },
          });
        }
        if (outcome !== "undone") return refuse(AUTOMATION_CHANGED_SINCE, 409, "changed_since");
      }
    } catch (error) {
      if (changedSince(error)) return refuse(AUTOMATION_CHANGED_SINCE, 409, "changed_since");
      return refuse(error instanceof Error ? error.message : String(error), statusOf(error));
    }
    return this.settleUndone(args.threadId, messageId, card, payload);
  }

  private settleUndone(
    threadId: string,
    messageId: string,
    card: RoutineRequestOptionCard,
    payload: AutomationRequestCardData,
  ): ResolveRoutineRequestResult {
    const settled = this.store.patchMessage(threadId, messageId, { card: { ...card, answered: "undone" } });
    if (!settled) {
      return { claimed: true, state: "invalid", error: "This routine confirmation card is no longer available", status: 409 };
    }
    this.forgetSettledReceipt(payload, messageId);
    return { claimed: true, state: "undone", action: payload.operation.action };
  }
}

type ParsedCardPayload =
  | { success: true; data: AutomationRequestCardData }
  | { success: false; error: z.ZodError };

/** A webhook card parses against the webhook schema; anything else is a routine card. */
function parseCardPayload(raw: unknown): ParsedCardPayload {
  if(raw && typeof raw==='object') { const {id:_queueId,...payload}=raw as Record<string,unknown>;raw=payload; }
  if ((raw as { kind?: unknown } | null)?.kind === "webhook") {
    const parsed = webhookRequestCardDataSchema.safeParse(raw);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: parsed.error };
  }
  const parsed = routineRequestCardDataSchema.safeParse(raw);
  return parsed.success ? { success: true, data: parsed.data } : { success: false, error: parsed.error };
}
