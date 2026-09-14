import { z } from "zod";

export const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,79}$/);
export const slackBindingSchema = z.object({
  connectionId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9-]+$/),
  teamId: slackId, appId: slackId, botUserId: slackId, botId: slackId,
  ownerUserId: slackId, dmId: z.string().regex(/^D[A-Z0-9]{1,79}$/),
  chiefBotId: z.string().min(1).max(180),
}).strict();
export type SlackBinding = z.infer<typeof slackBindingSchema>;
export type SlackIdentity = Pick<SlackBinding, "teamId" | "appId" | "botUserId" | "botId" | "ownerUserId">;
export interface SlackMessage { deliveryId: string; text: string; dmId: string; occurredAt: number }
const envelope = z.object({ type: z.literal("events_api"), body: z.object({
  type: z.literal("event_callback"), team_id: slackId, api_app_id: slackId,
  event_id: z.string().regex(/^Ev[A-Za-z0-9_-]{1,100}$/), event_time: z.number().finite().nonnegative(),
  authorizations: z.array(z.object({ team_id: slackId, user_id: slackId, is_bot: z.boolean() })).max(20),
  event: z.object({ type: z.literal("message"), channel_type: z.literal("im"),
    channel: z.string().regex(/^D[A-Z0-9]{1,79}$/), user: slackId, text: z.string().min(1).max(5000),
    subtype: z.unknown().optional(), bot_id: z.unknown().optional(),
    files: z.unknown().optional(), is_ext_shared_channel: z.unknown().optional(),
  }), is_ext_shared_channel: z.boolean().optional(),
}) });

/** Authenticated transport is not permission to execute every event it receives. */
export function normalizeSlackMessage(raw: unknown, identity: SlackIdentity): SlackMessage | null {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return null;
  const { body } = parsed.data, e = body.event;
  if (body.team_id !== identity.teamId || body.api_app_id !== identity.appId ||
      !body.authorizations.some(a => a.team_id === identity.teamId && a.user_id === identity.botUserId && a.is_bot) ||
      e.user !== identity.ownerUserId || e.user === identity.botUserId || e.subtype !== undefined ||
      e.bot_id !== undefined || e.files !== undefined || e.is_ext_shared_channel === true || body.is_ext_shared_channel) return null;
  return { deliveryId: `slack:${body.team_id}:${body.api_app_id}:${body.event_id}`, text: e.text,
    dmId: e.channel, occurredAt: body.event_time * 1000 };
}

export function slackPrompt(text: string): { prompt: string; response?: string } {
  if (/^\/(?:approve|deny|allow|reject|pair)(?:\s|$)/i.test(text) || /^(?:approve|deny|allow|reject|yes|no)$/i.test(text.trim()))
    return { prompt: "", response: "Review approvals in Murage. Slack messages cannot approve actions." };
  return { prompt: `[UNTRUSTED SLACK CHANNEL MESSAGE]\n${text}\n[/UNTRUSTED SLACK CHANNEL MESSAGE]` };
}
