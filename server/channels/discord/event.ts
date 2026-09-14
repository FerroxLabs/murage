import { z } from "zod";

export const discordId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const discordBindingSchema = z.object({
  connectionId: z.string().uuid(), applicationId: discordId, botUserId: discordId,
  ownerUserId: discordId, dmId: discordId, chiefBotId: z.string().min(1).max(180),
}).strict();
export type DiscordBinding = z.infer<typeof discordBindingSchema>;
export type DiscordIdentity = Pick<DiscordBinding, "applicationId" | "botUserId" | "ownerUserId">;
const eventSchema = z.object({ applicationId: discordId, botUserId: discordId, id: discordId,
  dmId: discordId, channelType: z.literal(1), authorId: discordId, authorBot: z.literal(false),
  guildId: z.null(), webhookId: z.null(), type: z.literal(0), content: z.string().min(1).max(5000),
  occurredAt: z.number().finite(), attachments: z.literal(0), components: z.literal(0), forwarded: z.literal(false),
});
export function normalizeDiscordMessage(raw: unknown, identity: DiscordIdentity) {
  const result = eventSchema.safeParse(raw);
  if (!result.success) return null;
  const e = result.data;
  if (e.applicationId !== identity.applicationId || e.botUserId !== identity.botUserId || e.authorId !== identity.ownerUserId || e.authorId === identity.botUserId) return null;
  return { deliveryId: `discord:${e.applicationId}:${e.dmId}:${e.id}`, dmId: e.dmId, text: e.content, occurredAt: e.occurredAt };
}
export function discordPrompt(text: string): { prompt: string; response?: string } {
  if (/^\/(?:approve|deny|allow|reject|pair)(?:\s|$)/i.test(text) || /^(?:approve|deny|allow|reject|yes|no)$/i.test(text.trim()))
    return { prompt: "", response: "Review approvals in Murage. Discord messages cannot approve actions." };
  return { prompt: `[UNTRUSTED DISCORD CHANNEL MESSAGE]\n${text}\n[/UNTRUSTED DISCORD CHANNEL MESSAGE]` };
}
