import { z } from "zod";
import { isCredentialTargetId } from "../shared/credential-request.ts";
import type { Message } from "./store.ts";

// Pure recovery schemas. Do not import runtime managers or normalize historic
// records: these checks either accept the original object or refuse it.
export const INSTALLATION_MESSAGE_KINDS = ["text", "options", "activity", "screen", "connector", "secret", "routine.run", "goal.run"] as const satisfies readonly Message["kind"][];
const text = z.string();
const number = z.number().finite();
const boolean = z.boolean();
const strings = z.array(text);
const runStatus = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "missed"]);
const goalStatus = z.enum(["completed", "needs-input", "blocked", "limit-reached", "paused", "stopped", "failed"]);
const schedule = z.union([
  z.object({ type: z.literal("once"), at: number }).passthrough(),
  z.object({ type: z.literal("daily"), time: text, weekdays: z.array(number.int().min(0).max(6)) }).passthrough(),
  z.object({ type: z.literal("interval"), everyMinutes: number, anchorAt: number.optional() }).passthrough(),
]);
const definition = z.object({ name: text, instructions: text, schedule, runOn: z.enum(["ember", "cloud"]), durationMinutes: number, timeoutMinutes: number.optional() }).passthrough();
const manage = { routineId: text, expectedUpdatedAt: number };
const operation = z.union([
  z.object({ action: z.literal("create"), routine: definition, forBot: z.object({ botId: text, name: text }).passthrough().optional() }).passthrough(),
  z.object({ action: z.literal("update"), ...manage, changes: definition.partial().extend({ timeoutMinutes: number.nullable().optional() }) }).passthrough(),
  z.object({ action: z.enum(["pause", "resume", "run_now", "delete"]), ...manage }).passthrough(),
]);
const routineRequest = z.object({ version: z.literal(1), requestId: text, botId: text, threadId: text, createdAt: number, operation, appliedAt: number.optional(), resultId: text.optional() }).passthrough();
const skillRequest = z.object({ version: z.literal(1), requestId: text, botId: text, threadId: text, stagedId: text, action: z.enum(["create", "update"]), name: text, gist: text, source: text.optional(), preview: text.optional(), sha256: text.optional(), warnings: strings, createdAt: number }).passthrough();
const candidate = z.object({ slug: text, name: text, skillNames: strings }).passthrough();
const intake = z.object({ step: z.enum(["open", "narrow", "confirm"]), outcome: z.enum(["profile", "general"]).optional(), candidate: candidate.optional(), choices: z.array(candidate).optional(), asked: z.union([z.literal(1), z.literal(2)]) }).passthrough();
const card = z.object({
  title: text, options: strings,
  // Older stored approval cards omit subtitle. Recovery never invents one.
  subtitle: text.optional(), answered: text.optional(), dismissed: boolean.optional(), requestId: text.optional(),
  tool: text.optional(), held: text.optional(), allowKey: text.optional(), approvalScope: z.literal("local-computer").optional(),
  routineRequest: routineRequest.optional(), routineProposalDigest: text.optional(), skillRequest: skillRequest.optional(), intake: intake.optional(),
}).passthrough();
const connector = z.object({ slug: text, alias: text.optional(), label: text, description: text, status: z.enum(["required", "authorizing", "connected", "failed"]), resumeKey: text, error: text.optional(), dismissed: boolean.optional(), resumed: boolean.optional() }).passthrough();
const secret = z.object({ target: z.custom<string>(isCredentialTargetId), label: text, description: text, placeholder: text, helpUrl: text, requestKey: text, provided: boolean.optional(), dismissed: boolean.optional(), resumed: boolean.optional(), error: text.optional() }).passthrough();
// Sparse historic terminal receipts are supported. Supplied provenance fields
// must have their declared types; they need not be invented during recovery.
const routineRun = z.object({ status: runStatus, runId: text.optional(), routineId: text.optional(), routineName: text.optional(), goalStatus: goalStatus.optional(), executionThreadId: text.optional(), summary: text.optional(), error: text.optional() }).passthrough();
const goalRun = z.object({ status: z.union([z.literal("working"), goalStatus]), runId: text.optional(), goal: text.optional(), coordinatorBotId: text.optional(), coordinatorName: text.optional(), turnCount: number.optional(), maxTurns: number.optional(), detail: text.optional(), startedAt: number.optional(), finishedAt: number.optional() }).passthrough();
const payloads = z.object({
  kind: z.enum(INSTALLATION_MESSAGE_KINDS), text: text.optional(), png: text.optional(), mime: text.optional(),
  card: card.optional(), connector: connector.optional(), secret: secret.optional(), routineRun: routineRun.optional(), goalRun: goalRun.optional(),
  tool: z.object({ name: text, ok: boolean.optional(), spoken: text.optional(), setup: boolean.optional() }).passthrough().optional(),
  attachments: z.array(z.object({ kind: z.literal("image"), path: text, mime: text }).passthrough()).optional(),
}).passthrough();

export function validInstallationMessagePayload(value: unknown): boolean {
  return payloads.safeParse(value).success;
}
