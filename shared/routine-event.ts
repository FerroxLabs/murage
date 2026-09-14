import { z } from "zod";

const id = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const channelOriginSchema = z.object({ platform: z.enum(["slack", "discord"]), connectionId: id }).strict();
export type ChannelOrigin = z.infer<typeof channelOriginSchema>;
const common = { version: z.literal(1), id, definitionId: id, receivedAt: z.number().finite().nonnegative(), budgetId: id };
const routineEventSchema = z.discriminatedUnion("source", [
  z.object({ ...common, source: z.literal("schedule"), origin: z.object({ kind: z.literal("local-schedule") }).strict() }).strict(),
  z.object({ ...common, source: z.literal("manual"), origin: z.object({ kind: z.literal("local-manual") }).strict() }).strict(),
  z.object({ ...common, source: z.literal("webhook"), origin: z.object({ kind: z.literal("external-webhook"), webhookId: id }).strict() }).strict(),
  z.object({ ...common, source: z.literal("channel"), origin: z.object({ kind: z.literal("channel"), channel: z.enum(["telegram", "slack", "discord"]), connectionId: id }).strict() }).strict(),
]);
export type RoutineEvent = z.infer<typeof routineEventSchema>;
export function parseRoutineEvent(value: unknown): RoutineEvent | null {
  const parsed = routineEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function createRoutineEvent(input: { runId: string; definitionId: string; receivedAt: number; source: RoutineEvent["source"]; webhookId?: string; telegramConnectionId?: string; channelOrigin?: ChannelOrigin }): RoutineEvent {
  if (input.channelOrigin && input.telegramConnectionId) throw new Error("Conflicting channel origins");
  return routineEventSchema.parse({ version: 1, id: input.runId, definitionId: input.definitionId, receivedAt: input.receivedAt,
    budgetId: input.runId, source: input.source, origin: input.source === "channel" ? { kind: "channel", channel: input.channelOrigin?.platform ?? "telegram", connectionId: input.channelOrigin?.connectionId ?? input.telegramConnectionId }
      : input.source === "webhook" ? { kind: "external-webhook", webhookId: input.webhookId }
      : { kind: input.source === "manual" ? "local-manual" : "local-schedule" } });
}
/** Derive provenance exclusively from manager-owned run fields. A persisted
 * envelope is descriptive metadata, never authority to promote an event.
 * budgetId identifies the run's allocation; this is not limit enforcement. */
export function routineEventForRun(run: { id: string; routineId: string; createdAt: number; scheduledFor: number; triggerSource?: RoutineEvent["source"]; manual: boolean; webhookId?: string; telegramConnectionId?: string; channelOrigin?: ChannelOrigin; event?: unknown }): RoutineEvent | undefined {
  if (run.channelOrigin !== undefined && (!channelOriginSchema.safeParse(run.channelOrigin).success || run.telegramConnectionId)) return undefined;
  const source = run.telegramConnectionId || run.channelOrigin ? "channel" : run.triggerSource === "webhook" || run.webhookId ? "webhook"
    : run.triggerSource === "manual" || (!run.triggerSource && run.manual) ? "manual" : "schedule";
  const expected = parseRoutineEvent({ version: 1, id: run.id, definitionId: run.routineId,
    receivedAt: source === "webhook" || source === "channel" ? run.scheduledFor : run.createdAt, budgetId: run.id, source,
    origin: source === "channel" ? { kind: "channel", channel: run.channelOrigin?.platform ?? "telegram", connectionId: run.channelOrigin?.connectionId ?? run.telegramConnectionId }
      : source === "webhook" ? { kind: "external-webhook", webhookId: run.webhookId ?? run.routineId }
      : { kind: source === "manual" ? "local-manual" : "local-schedule" } });
  if (!expected) return undefined; // Malformed legacy identities do not gain provenance.
  const saved = parseRoutineEvent(run.event);
  return saved && JSON.stringify(saved) === JSON.stringify(expected) ? saved : expected;
}
