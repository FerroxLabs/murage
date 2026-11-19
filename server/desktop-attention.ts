// SPDX-License-Identifier: AGPL-3.0-or-later
// Answering from outside the app (NOTIFY-EVERYWHERE-1019 section 5.1, slice S1): what an outside surface may show of a
// card, whether the card may be answered there, and the pure parts of the one synchronous outside answer path
// (`answerOutside` in server/index.ts). Everything here is read-only and has no await.
import { envelopeValid, fitsEnvelope, OUTSIDE_ENVELOPES, OUTSIDE_SURFACES, type OutsideSurface } from "../shared/outside-limits.mjs";
import type { Message } from "./store.ts";
import type { ApprovalRecordView } from "./decision/types.ts";
import { looksDestructive, looksSensitive } from "./auto-approve.ts";
import { trayQuickAnswer } from "./tray-summary.ts";

type Card = NonNullable<Message["card"]>;
export type { OutsideSurface };
export type OutsideOkMap = Record<OutsideSurface, boolean>;
export const OUTSIDE_REPLY_MAX = 2000;
const HEX64 = /^[0-9a-f]{64}$/;

/** The OUTSIDE DISPLAY: bot name, what it wants (the card's title) and the FULL executable detail (`card.subtitle`, a permission
 *  card's whole tool input), never the one-line summary alone. Null when any part is missing. */
export function outsideDisplay(card: Card | undefined, botName: string | undefined): { botName: string; title: string; willRun: string } | null {
  if (!card) return null;
  const title = typeof card.title === "string" ? card.title : "";
  const willRun = typeof card.subtitle === "string" ? card.subtitle : "";
  if (!botName?.trim() || !title.trim() || !willRun.trim()) return null;
  return { botName, title, willRun };
}

/** Quick (trayQuickAnswer) AND the full detail fits that surface's proven rendering envelope. */
export function outsideOk(card: Card | undefined, context: { stopHit?: boolean; botName?: string }, surface: OutsideSurface): boolean {
  if (!OUTSIDE_SURFACES.includes(surface)) return false;
  if (!trayQuickAnswer(card, { stopHit: context.stopHit })) return false;
  const display = outsideDisplay(card, context.botName);
  if (!display) return false;
  // trayQuickAnswer judged the one-line summary; the outside surface shows the FULL detail, so that is judged too
  const shown = `${card!.tool}\n${display.willRun}`;
  if (looksSensitive(shown) || looksDestructive(shown)) return false;
  const envelope = OUTSIDE_ENVELOPES[surface];
  if (!envelopeValid(surface, envelope)) return false;
  return fitsEnvelope(display.willRun, display.title, display.botName, envelope);
}

/** The per-surface map every attention read returns, never one boolean. */
export function outsideOkMap(card: Card | undefined, context: { stopHit?: boolean; botName?: string }): OutsideOkMap {
  return Object.fromEntries(OUTSIDE_SURFACES.map(surface => [surface, outsideOk(card, context, surface)])) as OutsideOkMap;
}
/** With previews off, nothing can be answered outside: every entry false. */
export function closedOutsideMap(): OutsideOkMap {
  return Object.fromEntries(OUTSIDE_SURFACES.map(surface => [surface, false])) as OutsideOkMap;
}

/** The text a Reply may carry: control characters except newline stripped, trimmed, 1..2000 characters. Null when it is not usable. */
export function cleanReply(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "").trim();
  return text.length >= 1 && text.length <= OUTSIDE_REPLY_MAX ? text : null;
}

export type OutsideBody =
  | { ok: true; requestId: string; behavior: "allow" | "deny"; message?: string; digest: string; surface: OutsideSurface; binding: OutsideBinding }
  | { ok: false; status: 400; code: "bad_outside_body" };
const refused = (): OutsideBody => ({ ok: false, status: 400, code: "bad_outside_body" });
const BINDING_FIELDS = ["approvalId", "requestRef", "actionHash"] as const;
const bindingPart = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;

/** Step 2: the shape. Behavior allow or deny only (Reply is deny with a message); allowForTask, skip, answer, undo and any other
 *  field are refused. The three binding values (which registered approval, which request, which action) are REQUIRED: an answer
 *  that does not name the exact card it was shown is not an outside answer. */
export function parseOutsideBody(body: Record<string, unknown>): OutsideBody {
  const keys = Object.keys(body);
  if (keys.some(key => !["requestId", "behavior", "outside", "message", ...BINDING_FIELDS].includes(key))) return refused();
  if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 200) return refused();
  if (body.behavior !== "allow" && body.behavior !== "deny") return refused();
  if (!BINDING_FIELDS.every(field => bindingPart(body[field]))) return refused();
  const binding: OutsideBinding = { approvalId: body.approvalId as string, requestRef: body.requestRef as string, actionHash: body.actionHash as string };
  const outside = body.outside;
  if (!outside || typeof outside !== "object" || Array.isArray(outside)) return refused();
  const parts = outside as Record<string, unknown>;
  if (Object.keys(parts).some(key => key !== "digest" && key !== "surface")) return refused();
  if (typeof parts.digest !== "string" || !HEX64.test(parts.digest)) return refused();
  if (typeof parts.surface !== "string" || !(OUTSIDE_SURFACES as readonly string[]).includes(parts.surface)) return refused();
  let message: string | undefined;
  if ("message" in body) {
    if (body.behavior !== "deny") return refused();
    const cleaned = cleanReply(body.message);
    if (cleaned === null) return refused();
    message = cleaned;
  }
  return { ok: true, requestId: body.requestId, behavior: body.behavior, ...(message !== undefined ? { message } : {}), digest: parts.digest, surface: parts.surface as OutsideSurface, binding };
}

/** Which registered approval an outside answer is for: the durable approval, the request it registered and the action it hashed. */
export interface OutsideBinding { approvalId: string; requestRef: string; actionHash: string }
export type OutsideBindingRecord = Pick<ApprovalRecordView, "ref" | "threadId" | "chatMessageId" | "requestId" | "state" | "why" | "actionHash" | "level" | "evidence" | "action" | "actor">;
export type OutsideBindingRefusal = "binding_unregistered" | "binding_stale" | "binding_not_open" | "binding_not_owner" | "binding_evidence" | "binding_no_limits";
export type OutsideBindingResult = { ok: true; binding: OutsideBinding } | { ok: false; code: OutsideBindingRefusal };
const BELOW_NO_LIMITS: readonly string[] = ["ask", "auto", "full"];

/** The ONE test of whether a card may be answered from outside the app, used both when the attention reads describe a card and,
 *  synchronously, when an outside answer arrives. Only an open card the owner's own typed turn raised, registered for exactly this
 *  stored message and action, with no deny or wipe evidence, at a level below No limits. Everything else is Open only. Each
 *  refusal is named, in a fixed order, so a replay, a stale card and another user's request fail on their own check. */
export function outsideBinding(input: { threadId: string; messageId: string | undefined; card: Card | undefined; registered: OutsideBindingRecord | undefined; noLimitsNow: boolean }): OutsideBindingResult {
  const { card, registered } = input;
  const held = card as (Card & Partial<OutsideBinding>) | undefined;
  if (!registered || !held || !input.messageId || !bindingPart(held.approvalId) || !bindingPart(held.requestRef) || !bindingPart(held.actionHash)) return { ok: false, code: "binding_unregistered" };
  if (registered.ref?.approvalId !== held.approvalId || registered.requestId !== held.requestRef || registered.actionHash !== held.actionHash
    || registered.threadId !== input.threadId || registered.chatMessageId !== input.messageId || registered.action?.requestId !== held.requestId) return { ok: false, code: "binding_stale" };
  if (registered.state !== "open") return { ok: false, code: "binding_not_open" };
  if (registered.actor !== "owner") return { ok: false, code: "binding_not_owner" };
  if (registered.why !== "base" || !Array.isArray(registered.evidence) || registered.evidence.length > 0) return { ok: false, code: "binding_evidence" };
  // Both the level the request was registered at and the level in force NOW: a card raised before No limits was turned on is not
  // answerable outside once it is on, even before the decision record has caught up with the change.
  if (!BELOW_NO_LIMITS.includes(registered.level) || input.noLimitsNow !== false) return { ok: false, code: "binding_no_limits" };
  return { ok: true, binding: { approvalId: held.approvalId, requestRef: held.requestRef, actionHash: held.actionHash } };
}

export type OutsideBindingVerdict = { ok: true } | { ok: false; status: 409; code: OutsideBindingRefusal | "binding_changed" };
/** Step 4b: the live approval must still pass `outsideBinding`, and the three posted values must be exactly its values. */
export function judgeOutsideBinding(live: OutsideBindingResult, asked: OutsideBinding): OutsideBindingVerdict {
  if (!live.ok) return { ok: false, status: 409, code: live.code };
  if (asked.approvalId !== live.binding.approvalId || asked.requestRef !== live.binding.requestRef || asked.actionHash !== live.binding.actionHash) return { ok: false, status: 409, code: "binding_changed" };
  return { ok: true };
}

export type OutsideCardVerdict = { ok: true } | { ok: false; status: 409; code: "card_changed" | "outside_refused" };
/** Step 4: the live card must be open, ordinary, digest-equal and outsideOk for exactly the token's surface. `special` is true when
 *  any special-card probe matches (limit, email, venue, question, skill, routine, peer, extension, host consent). */
export function judgeOutsideCard(input: { card: Card | undefined; special: boolean; digestNow: string | null; digestAsked: string; stopHit: boolean; botName?: string; surface: OutsideSurface }): OutsideCardVerdict {
  const { card } = input;
  if (!card || !card.requestId || card.answered || card.dismissed || card.expired) return { ok: false, status: 409, code: "card_changed" };
  if (input.special) return { ok: false, status: 409, code: "outside_refused" };
  if (!input.digestNow || input.digestNow !== input.digestAsked) return { ok: false, status: 409, code: "card_changed" };
  if (!outsideOk(card, { stopHit: input.stopHit, botName: input.botName }, input.surface)) return { ok: false, status: 409, code: "outside_refused" };
  return { ok: true };
}

/** What quiet hours dropped (NOTIFY-EVERYWHERE-1019 4.2 rule 2 and 5.1): in memory, per process, at most 100, oldest out first. It is filled only
 *  when quiet hours were the ONLY reason a frame was dropped, after the per-bot mute and the category filters, so a muted bot or a switched-off
 *  category never reappears in a "things waited" summary. The router reads it and acks it; nothing persists. */
export interface HeldEntry { kind: string; botId: string; threadId: string; messageId?: string; requestId?: string; deliveryId?: string; at: number }
export class HeldDuringQuiet {
  private entries: HeldEntry[] = [];
  private readonly max: number;
  constructor(max = 100) { this.max = max; }
  add(entry: HeldEntry): void {
    this.entries.push({ kind: entry.kind, botId: entry.botId, threadId: entry.threadId, at: entry.at,
      ...(entry.messageId ? { messageId: entry.messageId } : {}), ...(entry.requestId ? { requestId: entry.requestId } : {}), ...(entry.deliveryId ? { deliveryId: entry.deliveryId } : {}) });
    while (this.entries.length > this.max) this.entries.shift();
  }
  list(): HeldEntry[] { return this.entries.map(entry => ({ ...entry })); }
  /** Clear what the router has taken: everything at or before `upTo` (epoch ms), or everything when omitted. */
  ack(upTo?: number): void { this.entries = typeof upTo === "number" ? this.entries.filter(entry => entry.at > upTo) : []; }
  get size(): number { return this.entries.length; }
}
