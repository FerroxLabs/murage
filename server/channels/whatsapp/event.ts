// Copyright 2026 Ferrox Labs
// Shape follows server/channels/slack/event.ts; the prompt boundary is core/wrap.ts (design 5.7).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The backend-neutral envelope, normalised. The bridge has already validated the wire shape; this zod pass is
// the service's own gate, so a Cloud API backend (W9) goes through the same door. Pure.
import { z } from "zod";
import { deliveryIdFor } from "./core/echo.ts";
import { jidKind, stripDevice } from "./core/lid.ts";
import type { InboundCandidate } from "./core/access.ts";
import { wrapUntrusted } from "./core/wrap.ts";

const jid = z.string().min(3).max(200).regex(/^[^\x00-\x1f\x7f\s]+$/);
export const whatsappBindingSchema = z.object({
  connectionId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9-]+$/),
  /** The linked number: the only owner (design 5.1). */
  linkedPn: jid,
  linkedLid: jid.optional(),
  chiefBotId: z.string().min(1).max(180),
}).strict();
export type WhatsAppBinding = z.infer<typeof whatsappBindingSchema>;

const mediaSchema = z.object({
  kind: z.enum(["image", "audio", "video", "document", "sticker", "location", "contact"]),
  mime: z.string().max(200).optional(), bytes: z.number().int().nonnegative().optional(), name: z.string().max(400).optional(),
  seconds: z.number().nonnegative().optional(), ptt: z.boolean().optional(), path: z.string().max(1000).optional(), caption: z.string().max(5000).optional(),
}).strict();
const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/),
  chatJid: jid, chatJidAlt: jid.optional(), fromMe: z.boolean(), timestampMs: z.number().finite().nonnegative(),
  upsertType: z.enum(["notify", "append"]), pushName: z.string().max(400).optional(),
  participant: jid.optional(), participantAlt: jid.optional(), text: z.string().max(65_536).optional(),
  mentionedJids: z.array(jid).max(200),
  quoted: z.object({ id: z.string().min(1).max(200), participant: jid.optional(), text: z.string().max(5000).optional(), outbound: z.boolean().optional() }).strict().optional(),
  media: mediaSchema.optional(),
}).strict();

export type WhatsAppMedia = z.infer<typeof mediaSchema>;
/** What `service.ts` works with. Provenance stays here and on the ledger record, never in the prompt. */
export interface WhatsAppMessage {
  deliveryId: string;
  messageId: string;
  chatJid: string;
  chatKind: "dm" | "group";
  fromMe: boolean;
  occurredAt: number;
  upsertType: "notify" | "append";
  pushName?: string;
  participant?: string;
  text: string;
  mentionedJids: string[];
  quoted?: { id: string; participant?: string; text?: string; outbound?: boolean };
  media?: WhatsAppMedia;
  candidate: InboundCandidate;
}

/** Cap on the sender's text inside the stored prompt (the receipt ledger holds 6000 characters per prompt). */
export const PROMPT_BODY_CAP = 3500;
/** A voice note's transcript and the text beside it share the same ledger limit. */
export const VOICE_TRANSCRIPT_CAP = 2000;
const VOICE_BODY_CAP = 1500;

/** Placeholder line for a message that is only a file; the file name travels in its own wrapper field. */
export function mediaPlaceholder(m: WhatsAppMedia): string {
  const size = m.bytes !== undefined ? `, ${m.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(m.bytes / 1024))} KB` : `${(m.bytes / (1024 * 1024)).toFixed(1)} MB`}` : "";
  return `[${m.kind}${size}]`;
}

/** Returns null for anything the service must silently drop at the door (malformed, no content, a status or broadcast chat). */
export function normalizeWhatsAppMessage(raw: unknown): WhatsAppMessage | null {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const chat = stripDevice(e.chatJid);
  const kind = jidKind(chat);
  if (kind !== "pn" && kind !== "lid" && kind !== "group") return null;
  const deliveryId = deliveryIdFor(chat, e.messageId, e.chatJidAlt);
  if (!deliveryId) return null;
  const body = e.text?.trim() ?? "";
  if (!body && !e.media) return null;
  const candidate: InboundCandidate = {
    id: e.messageId, chatJid: chat, ...(e.chatJidAlt ? { chatJidAlt: e.chatJidAlt } : {}), fromMe: e.fromMe, timestampMs: e.timestampMs,
    upsertType: e.upsertType, ...(e.pushName ? { pushName: e.pushName } : {}),
    ...(e.participant ? { participant: e.participant } : {}), ...(e.participantAlt ? { participantAlt: e.participantAlt } : {}),
    mentionedJids: e.mentionedJids, ...(e.quoted ? { quotedMessageId: e.quoted.id } : {}),
    ...(e.quoted?.participant ? { quotedParticipant: e.quoted.participant } : {}), ...(body ? { text: body } : {}),
  };
  return {
    deliveryId, messageId: e.messageId, chatJid: chat, chatKind: kind === "group" ? "group" : "dm", fromMe: e.fromMe, occurredAt: e.timestampMs,
    upsertType: e.upsertType, ...(e.pushName ? { pushName: e.pushName } : {}), ...(e.participant ? { participant: e.participant } : {}),
    text: body, mentionedJids: e.mentionedJids, ...(e.quoted ? { quoted: e.quoted } : {}), ...(e.media ? { media: e.media } : {}), candidate,
  };
}

export const APPROVAL_REFUSAL = "Review approvals in Murage. WhatsApp messages cannot approve actions.";

/** Chat text can never approve, deny, allow or pair anything (Slack event.ts and Telegram use the same rule). */
export function isApprovalText(value: string): boolean {
  return /^\/(?:approve|deny|allow|reject|pair)(?:\s|$)/i.test(value) || /^(?:approve|deny|allow|reject|yes|no)$/i.test(value.trim());
}

/** The stored prompt, or a fixed refusal. Sender name, group title, quote and file name are labelled fields; the body is never trusted. */
export function whatsappPrompt(message: Pick<WhatsAppMessage, "text" | "pushName" | "quoted" | "media" | "chatKind">, options: { groupTitle?: string; voiceTranscript?: string } = {}): { prompt: string; response?: string } {
  const body = message.text.trim();
  if (body && isApprovalText(body)) return { prompt: "", response: APPROVAL_REFUSAL };
  const m = message.media;
  const voice = options.voiceTranscript?.trim() ? options.voiceTranscript.trim().slice(0, VOICE_TRANSCRIPT_CAP) : undefined;
  // With a transcript the body gets a smaller share so the whole prompt stays inside the receipt ledger's 6000 characters.
  const text = body ? body.slice(0, voice ? VOICE_BODY_CAP : PROMPT_BODY_CAP) : m && !voice ? mediaPlaceholder(m) : "";
  return { prompt: wrapUntrusted("WHATSAPP", {
    body: m && body && !voice ? `${text}\n${mediaPlaceholder(m)}` : text,
    ...(voice ? { voiceTranscript: voice } : {}),
    ...(message.pushName ? { senderName: message.pushName } : {}),
    ...(options.groupTitle && message.chatKind === "group" ? { groupTitle: options.groupTitle } : {}),
    ...(message.quoted?.text ? { quotedText: message.quoted.text } : {}),
    ...(m?.name ? { filename: m.name } : {}),
    ...(m?.caption ? { caption: m.caption } : {}),
  }) };
}
