import { z } from "zod";
import { isCredentialTargetId, isMcpCredentialId } from "../shared/credential-request.ts";
import type { Message, OptionCardData } from "./store.ts";
import type { RoutineRunCardData } from "../shared/routine-run.ts";
import type { WebhookRequestOperation } from "../shared/routine-request.ts";

// Pure recovery schemas. Do not import runtime managers or normalize historic
// records: these checks either accept the original object or refuse it.
export const INSTALLATION_MESSAGE_KINDS = ["text", "options", "activity", "screen", "connector", "mcpSignIn", "secret", "routine.run", "goal.run"] as const satisfies readonly Message["kind"][];
// Every card kind a shipped feature writes (OptionCardData.kind). A kind missing here refused
// the whole backup of any installation holding one such card (mcpEnable, 1.0.4 to 1.0.8).
export const INSTALLATION_CARD_KINDS = ["publish", "mcpEnable", "email-send", "email-trust-offer"] as const satisfies readonly NonNullable<OptionCardData["kind"]>[];
// Compile-time completeness (INSTALLATION_KINDS_COMPLETE below): a kind or status added to a stored shape without a recovery schema fails the typecheck.
type Uncovered<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : { uncovered: Exclude<All, Listed> };
const text = z.string();
const number = z.number().finite();
const boolean = z.boolean();
const strings = z.array(text);
// "needs-you": a routine run whose limit came while a card waited on the owner (shared/routine-run.ts).
const RUN_STATUSES = ["queued", "running", "waiting", "needs-you", "completed", "failed", "cancelled", "missed"] as const satisfies readonly RoutineRunCardData["status"][];
const runStatus = z.enum(RUN_STATUSES);
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
const routineRequestCard = z.object({ version: z.literal(1), requestId: text, botId: text, threadId: text, createdAt: number, operation, appliedAt: number.optional(), resultId: text.optional() }).passthrough();
// A webhook proposed from chat (shared/routine-request.ts WebhookRequestCardData) rides the same routineRequest member.
const manageWebhook = { webhookId: text, expectedUpdatedAt: number };
const WEBHOOK_ACTIONS = ["create", "update", "pause", "resume", "delete"] as const satisfies readonly WebhookRequestOperation["action"][];
const webhookOperation = z.union([
  z.object({ action: z.literal("create"), webhook: z.object({ id: text, name: text, prompt: text, eventTypes: strings.optional() }).passthrough() }).passthrough(),
  z.object({ action: z.literal("update"), ...manageWebhook, changes: z.object({ name: text.optional(), prompt: text.optional(), eventTypes: strings.optional() }).passthrough() }).passthrough(),
  z.object({ action: z.enum(["pause", "resume", "delete"]), ...manageWebhook }).passthrough(),
]);
const webhookRequestCard = z.object({ version: z.literal(1), kind: z.literal("webhook"), requestId: text, botId: text, threadId: text, createdAt: number, operation: webhookOperation, appliedAt: number.optional(), resultId: text.optional() }).passthrough();
const routineRequest = z.union([routineRequestCard, webhookRequestCard]);
const skillRequest = z.object({ version: z.literal(1), requestId: text, botId: text, threadId: text, stagedId: text, action: z.enum(["create", "update"]), name: text, gist: text, source: text.optional(), preview: text.optional(), sha256: text.optional(), warnings: strings, createdAt: number }).passthrough();
const candidate = z.object({ slug: text, name: text, skillNames: strings }).passthrough();
const intake = z.object({ step: z.enum(["open", "narrow", "confirm"]), outcome: z.enum(["profile", "general"]).optional(), candidate: candidate.optional(), choices: z.array(candidate).optional(), asked: z.union([z.literal(1), z.literal(2)]) }).passthrough();
const setupCard = z.object({ step: text, variant: text, key: text, settled: boolean.optional() }).passthrough();
// A publish approval card (shared/publish-card.ts): a restore keeps it, progress included, or refuses it.
const publishCard = z.object({
  action: z.enum(["publish", "update", "take-down", "connect"]), host: z.literal("netlify"), url: text,
  connect: z.object({ state: z.enum(["needed", "connected"]) }).passthrough().optional(),
  siteName: text.optional(), siteId: text.optional(), deployId: text.optional(),
  files: z.array(z.object({ path: text, size: number }).passthrough()).optional(), totalBytes: number.optional(), skipped: strings.optional(),
  progress: z.object({ step: z.enum(["uploading", "checking", "live", "taken-down", "failed"]), fileCount: number.optional(), failure: z.enum(["reconnect", "wait", "too-big", "name-taken", "not-live", "other"]).optional() }).passthrough().optional(),
}).passthrough();
// A "Turn on <name>?" card (server/mcp-bot-cards.ts McpEnableCardData), field for field.
const mcpEnableCard = z.object({
  name: text, rev: text, botId: text, bot: text, kind: z.enum(["stdio", "remote"]),
  command: text.optional(), args: strings.optional(), url: text.optional(), transport: z.enum(["http", "sse"]).optional(),
  pendingKeys: strings, enabled: boolean.optional(), error: text.optional(),
}).strict();
const card = z.object({
  title: text, options: strings,
  // bot email cards (server/email/cards.ts): a backup carries them, mail text stripped (sanitizeStagedEmail); a restore rebuilds them
  kind: z.enum(INSTALLATION_CARD_KINDS).optional(), publish: publishCard.optional(), mcpEnable: mcpEnableCard.optional(),
  // Older stored approval cards omit subtitle. Recovery never invents one.
  subtitle: text.optional(), answered: text.optional(), dismissed: boolean.optional(), requestId: text.optional(),
  tool: text.optional(), held: text.optional(), allowKey: text.optional(), approvalScope: z.literal("local-computer").optional(),
  routineRequest: routineRequest.optional(), routineProposalDigest: text.optional(), skillRequest: skillRequest.optional(), intake: intake.optional(),
  // A guided first run survives a restore intact, so the transcript still
  // reads as the conversation it was rather than as a row of blank cards.
  setup: setupCard.optional(),
}).passthrough();
const connector = z.object({ slug: text, alias: text.optional(), label: text, description: text, status: z.enum(["required", "authorizing", "connected", "failed"]), resumeKey: text, error: text.optional(), dismissed: boolean.optional(), resumed: boolean.optional() }).passthrough();
const mcpSignIn = z.object({ name: text, host: text, bot: text, reason: z.enum(["sign-in-ended", "needs-more-access"]), status: z.enum(["required", "signed-in"]), resumeKey: text, title: text, body: text, phone: text, error: text.optional(), dismissed: boolean.optional(), resumed: boolean.optional() }).passthrough();
const secret = z.object({ target: z.custom<string>((value) => isCredentialTargetId(value) || isMcpCredentialId(value)), label: text, description: text, placeholder: text, helpUrl: text, requestKey: text, provided: boolean.optional(), dismissed: boolean.optional(), resumed: boolean.optional(), error: text.optional() }).passthrough();
// Sparse historic terminal receipts are supported. Supplied provenance fields
// must have their declared types; they need not be invented during recovery.
const routineRun = z.object({ status: runStatus, runId: text.optional(), routineId: text.optional(), routineName: text.optional(), goalStatus: goalStatus.optional(), executionThreadId: text.optional(), summary: text.optional(), error: text.optional() }).passthrough();
const goalRun = z.object({ status: z.union([z.literal("working"), goalStatus]), runId: text.optional(), goal: text.optional(), coordinatorBotId: text.optional(), coordinatorName: text.optional(), turnCount: number.optional(), maxTurns: number.optional(), detail: text.optional(), startedAt: number.optional(), finishedAt: number.optional() }).passthrough();
const payloads = z.object({
  kind: z.enum(INSTALLATION_MESSAGE_KINDS), text: text.optional(), png: text.optional(), mime: text.optional(),
  card: card.optional(), connector: connector.optional(), mcpSignIn: mcpSignIn.optional(), secret: secret.optional(), routineRun: routineRun.optional(), goalRun: goalRun.optional(),
  tool: z.object({ name: text, ok: boolean.optional(), spoken: text.optional(), setup: boolean.optional() }).passthrough().optional(),
  attachments: z.array(z.object({ kind: z.literal("image"), path: text, mime: text }).passthrough()).optional(),
}).passthrough();

export const INSTALLATION_KINDS_COMPLETE: [
  Uncovered<Message["kind"], typeof INSTALLATION_MESSAGE_KINDS[number]>,
  Uncovered<NonNullable<OptionCardData["kind"]>, typeof INSTALLATION_CARD_KINDS[number]>,
  Uncovered<RoutineRunCardData["status"], typeof RUN_STATUSES[number]>,
  Uncovered<WebhookRequestOperation["action"], typeof WEBHOOK_ACTIONS[number]>,
] = [true, true, true, true];

export function validInstallationMessagePayload(value: unknown): boolean {
  return payloads.safeParse(value).success;
}
