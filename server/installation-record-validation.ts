import { z } from "zod";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";

// Pure data schemas: importing recovery must not initialize runtime managers,
// provider configuration, queues or schedules. Unknown metadata is preserved.
const id = z.string().regex(/^[\w-]{1,160}$/);
const time = z.number().finite().nonnegative();
const text = z.string();
const runOn = z.enum(["ember", "cloud"]);
const target = z.enum(["bot", "room-goal"]);
const once = z.object({ type: z.literal("once"), at: z.number().finite() }).passthrough();
const daily = z.object({ type: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).passthrough();
const interval = z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(1440), anchorAt: time.max(8_640_000_000_000_000) }).passthrough();
const schedule = z.union([once, daily, interval]);
const attachment = z.object({ id: text.min(1).max(200), name: text.min(1).max(255), path: text.min(1).max(4096), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), kind: z.enum(["file", "image"]) }).passthrough();
const routine = z.object({ id, name: text, prompt: text, botId: id, target: target.optional(), groupId: id.optional(), runOn: runOn.optional(), enabled: z.boolean(), schedule, durationMinutes: z.number().finite(), timeoutMinutes: z.number().finite().positive().optional(), attachments: z.array(attachment).optional(), sourceThreadId: id.optional(), nextRunAt: time.nullable(), createdAt: time, updatedAt: time }).passthrough();
const run = z.object({ id, routineId: id, routineName: text, botId: id, target: target.optional(), groupId: id.optional(), runOn: runOn.optional(), scheduledFor: z.number().finite(), status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "missed"]), manual: z.boolean(), createdAt: time, startedAt: time.optional(), finishedAt: time.optional(), sourceThreadId: id.optional(), threadId: id.optional(), triggerSource: z.enum(["schedule", "manual", "webhook"]).optional(), attachments: z.array(attachment).optional() }).passthrough();
const confirmation = z.object({ requestId: id, messageId: id, botId: id, threadId: id, action: z.enum(["create", "update", "pause", "resume", "run_now", "delete"]), fingerprintVersion: z.literal(1), fingerprint: text.regex(/^[a-f0-9]{64}$/), resultId: id, appliedAt: time }).passthrough();
const routineFile = z.object({ version: z.literal(1), routines: z.array(routine), runs: z.array(run), routineRequestReceipts: z.array(confirmation).optional() }).passthrough();
const calendarFile = z.object({ version: z.literal(1), calls: z.array(z.object({ id, name: text, description: text, botIds: z.array(id).min(1).max(100), schedule: z.union([once, daily]), durationMinutes: z.number().int().min(5).max(240), attachments: z.array(attachment).max(50), roomId: id.optional(), nextRunAt: time.nullable().optional(), createdAt: time, updatedAt: time }).passthrough()) }).passthrough();
const webhookFile = z.object({ version: z.literal(1), webhooks: z.array(z.object({ id, endpointId: id, name: text, prompt: text, botId: id, runOn, enabled: z.boolean(), createdAt: time, updatedAt: time, deliveryCount: z.number().int().nonnegative(), secretHash: text.regex(/^[a-f0-9]{64}$/).optional(), verificationPending: z.boolean().optional() }).passthrough()), deliveries: z.array(z.object({ key: text.min(1), runId: id, at: time }).passthrough()), attempts: z.array(z.object({ id, webhookId: id, receivedAt: time, outcome: z.enum(["accepted", "captured", "duplicate", "ignored", "rejected"]), statusCode: z.number().int().min(100).max(599), runId: id.optional() }).passthrough()).optional() }).passthrough();
const delegationReceipts = z.array(z.object({ id, sourceThreadId: id, toBotId: id, toBotName: text, status: z.enum(["done", "failed", "denied", "busy_gave_up", "dropped", "error"]), result: text.optional(), finishedAt: time }).passthrough());

function fail(): never { throw new InstallationSnapshotError("INVALID_INSTALLATION_RECORDS"); }
function unique(records: Array<Record<string, unknown>> | undefined, field: string) {
  const seen = new Set<unknown>();
  for (const value of records ?? []) {
    if (seen.has(value[field])) fail();
    seen.add(value[field]);
  }
}

/** Validate, never normalize/filter/drop terminal evidence. A receipt may
 * legitimately outlive its bot, routine, transcript or run, so missing live
 * targets are not grounds for discarding historical receipts. */
function validateRecords(path: string, value: unknown): void {
  if (path === "routines.json") {
    const parsed = routineFile.safeParse(value); if (!parsed.success) fail();
    unique(parsed.data.routines, "id"); unique(parsed.data.runs, "id"); unique(parsed.data.routineRequestReceipts, "requestId");
  } else if (path === "calendar-calls.json") {
    const parsed = calendarFile.safeParse(value); if (!parsed.success) fail();
    unique(parsed.data.calls, "id");
    for (const call of parsed.data.calls) if (new Set(call.botIds).size !== call.botIds.length) fail();
  } else if (path === "webhooks.json") {
    const parsed = webhookFile.safeParse(value); if (!parsed.success) fail();
    unique(parsed.data.webhooks, "id"); unique(parsed.data.webhooks, "endpointId"); unique(parsed.data.deliveries, "key"); unique(parsed.data.attempts, "id");
  } else if (path === "delegation-receipts.json") {
    const parsed = delegationReceipts.safeParse(value); if (!parsed.success) fail();
    unique(parsed.data, "id");
  }
}

export function assertInstallationRecords(path: string, value: unknown): void {
  try { validateRecords(path, value); }
  catch (error) {
    if (error instanceof InstallationSnapshotError) throw Object.assign(error, { component: path });
    throw error;
  }
}
