// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The handlers of the five bot email tools (BOT-EMAIL-MURAGE-109 3.1, 3.3, 3.4, 5.3, 6). Each runs only after admission.ts authorised the
// call against the turn's generation-bound record; identity (bot, thread, generation) comes from that record, never from the body.
//   email_list, email_read: Flux #11, #12, #15 with the bot's own email:bot key. Every sender-written field is fenced on its own (fence.ts),
//     Murage-authored fields stay outside, one rule sentence per result, every result bounded to 20,000 characters.
//   email_send, email_reply: the canonical payload goes to the send service (3.4), which applies the bot's email setting (3.3) and holds
//     what it does not clear on Murage's own card. The tool answers one status line at once; a held email answers the waiting line.
//   email_trust_offer: refuses any address that is not eligible (3.5) and records the offer for the owner's proposal card.
// Nothing here reaches Flux for a refusal decided locally (arguments, binding state, attachments, reply-all).
import { isFilteredMail, isHeldForOwner } from "./inbound.ts";
import type { EmailStore, SendRow, BindingRow } from "./email-store.ts";
import type { EmailSendService } from "./send-service.ts";
import type { FluxEmailClient, FluxOutcome } from "./flux-email-client.ts";
import { emailRef, type EmailDraft } from "./canonical.ts";
import { EMAIL_RULE, bodyParts, bounded, EMAIL_RESULT_CAP, fenceEmail, htmlToText, scanWords, token } from "./fence.ts";
import { readEmailAttachments } from "./attachments.ts";
import { EMAIL_UNAVAILABLE } from "./admission.ts";
import { emailGeneration, type EmailTurnRecord } from "./email-turns.ts";
import { EMAIL_TOOLS, type EmailToolName } from "../drivers/email-tool-schemas.ts";
import type { BotRecord } from "../store.ts";

/** The tool lines (3.1, 3.4, 6). Murage's own words: no em dashes, no prices. */
export const EMAIL_LINES = {
  replyAll: "Reply-all is not available yet; reply to the sender, and add others with cc so the owner can approve them.",
  duplicate: "An identical email already went out (or is still being checked). Change it if you mean to send again.",
  waiting: "This email is waiting for the owner. You will see the outcome later; carry on.",
  paused: "Your email is paused. Tell the owner; do not try another way to reach this person.",
  billingHold: "Sending is on hold for this account.",
  closing: "This email address is closing, so sending is off. Tell the owner; do not try another way to reach this person.",
  dailyCap: "You have sent today's emails. You can send more after midnight UTC.",
  accountCap: "Your bots have sent today's emails together. You can send more after midnight UTC.",
  blocked: "This person asked not to be emailed, or is blocked. Do not try to reach them another way.",
  tooManyHeld: "Several emails are already waiting for the owner. Wait for those first.",
  tooLarge: "That attachment is too large.",
  typeBlocked: "That attachment is of a type email cannot carry.",
  badAddress: "Check the address.",
  tooManyRecipients: "At most 10 people per email.",
  rateLimit: "Too many emails at once; wait a few minutes.",
  resting: "Your email is resting for the month, as the owner set. Tell the owner if something cannot wait.",
  capacity: "Email is resting for a short while. Try again later; nothing is lost.",
  couldNotSend: "Email could not send this time.",
  couldNotRead: "Email could not be read this time; try again shortly.",
  notFound: "That email was not found in your inbox.",
  heldForOwner: "This email is held for the owner to check first; its text is not available to you.",
  heldNoReply: "This email is held for the owner to check first; you cannot reply to it yet.",
  outboundReply: "You can only reply to an email you received.",
  noSender: "That email has no address to reply to.",
  oneTarget: "Give message_id or thread_id, one of them.",
  offerNotEligible: "Only an address the owner has emailed 3 times in 30 days, with no complaint or bounce, can be offered, and not one already trusted or turned down lately.",
  offered: "Offered to the owner. They decide; you do not need to ask again.",
  alreadyOffered: "This address is already offered to the owner.",
  noMatch: "No emails match.",
} as const;

/** A Flux code (6) to the bot's line. Unknown codes get the plain line; the caller logs the code. */
export function codeLine(code: string | null | undefined): string {
  switch (code) {
    case "daily_send_cap_reached": return EMAIL_LINES.dailyCap;
    case "account_send_cap_reached": return EMAIL_LINES.accountCap;
    case "bot_paused": case "bot_pause_requires_support": case "account_email_paused": case "paused": return EMAIL_LINES.paused;
    case "billing_hold": case "premium_locked": case "credit_unresolved": return EMAIL_LINES.billingHold;
    case "inbox_closing": return EMAIL_LINES.closing;
    case "recipient_blocked": case "recipient_cooldown": return EMAIL_LINES.blocked;
    case "too_many_held": return EMAIL_LINES.tooManyHeld;
    case "payload_too_large": return EMAIL_LINES.tooLarge;
    case "attachment_type_blocked": return EMAIL_LINES.typeBlocked;
    case "invalid_recipient": return EMAIL_LINES.badAddress;
    case "too_many_recipients": return EMAIL_LINES.tooManyRecipients;
    case "rate_limit_error": case "first_contact_limit_reached": return EMAIL_LINES.rateLimit;
    case "key_budget_reached": return EMAIL_LINES.resting;
    case "capability_unavailable": return EMAIL_LINES.capacity;
    case "email_not_enabled": case "account_off": case "inbox_not_found": case "inbox_pending_owner": return EMAIL_UNAVAILABLE;
    case "message_not_found": case "thread_not_found": return EMAIL_LINES.notFound;
    default: return EMAIL_LINES.couldNotSend;
  }
}

/** The one status line a send or reply answers (4.2), with Murage's reference. Never an address, subject or text. */
export function sendLine(row: SendRow): string {
  const ref = emailRef(row.sendId);
  switch (row.state) {
    case "sent": return `Sent (${ref}).`;
    case "prepared": case "awaiting_owner": case "held": return `${EMAIL_LINES.waiting} Reference ${ref}.`;
    case "dispatching": case "approving": return `Sending (${ref}). You will see the outcome later; carry on.`;
    case "unknown": case "unknown_expired": return `Murage is checking whether this email went out (${ref}). You will see the outcome later; do not send it again.`;
    case "approved_unsent": return `The owner said Send and it has not gone out yet (${ref}). You will see the outcome later.`;
    case "refused": return `${codeLine(row.code)} Not sent (${ref}).`;
    case "declined": return `The owner chose not to send this email (${ref}).`;
    case "withdraw_pending": case "withdrawn": return `This email was withdrawn and not sent (${ref}).`;
    case "expired": return `This email ran out waiting for the owner and was not sent (${ref}).`;
  }
}

export type EmailToolResult = { text: string; isError?: true };
const fail = (text: string): EmailToolResult => ({ text, isError: true });
const ok = (text: string): EmailToolResult => ({ text });

export interface EmailToolDeps {
  store: EmailStore;
  send: EmailSendService;
  client: Pick<FluxEmailClient, "listMessages" | "getMessage" | "getThread">;
  /** selectFileWorkspace(DATA_DIR, store, botId, threadId)?.root */
  workspaceRoot(botId: string, threadId: string): string | undefined;
  bot(botId: string): BotRecord | undefined;
  now?: () => number;
  /** Every Flux refusal code (the capability probe re-reads on the launch-switch codes). */
  onRefusal?(code: string): void;
  /** A code with no line of its own, for the log (never a body). */
  onUnknownCode?(code: string): void;
}

const ADDR_SPEC = /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
/** An exact, bare addr-spec (no display name), lower-cased; null when it is anything else. */
export function addrSpec(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const angle = /<([^<>]+)>\s*$/.exec(text);
  if (angle) text = angle[1]!.trim();
  return text.length <= 254 && ADDR_SPEC.test(text) ? text.toLowerCase() : null;
}

const KEYS: Record<EmailToolName, ReadonlySet<string>> = Object.fromEntries(EMAIL_TOOLS.map(tool => [tool.name, new Set(Object.keys(tool.inputSchema.properties))])) as unknown as Record<EmailToolName, ReadonlySet<string>>;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown, max: number): string | null => typeof value === "string" && value.length <= max ? value : null;
const optInt = (value: unknown, min: number, max: number, fallback: number): number | null => {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Arguments: an object of the tool's declared keys only. A bcc, an html body or an attachment URL is refused, never dropped. */
function argumentRefusal(tool: EmailToolName, args: unknown): string | null {
  if (!isRecord(args)) return `${tool} takes ${[...KEYS[tool]].join(", ")}.`;
  const extra = Object.keys(args).filter(key => !KEYS[tool].has(key));
  if (extra.length) return `${tool} takes only ${[...KEYS[tool]].join(", ")}. No bcc, no HTML and no attachment by URL.`;
  return null;
}

function addresses(value: unknown, max: number, required: boolean): string[] | string {
  if (value === undefined || value === null) return required ? EMAIL_LINES.badAddress : [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || (required && !list.length)) return EMAIL_LINES.badAddress;
  if (list.length > max) return EMAIL_LINES.tooManyRecipients;
  const out: string[] = [];
  for (const item of list) {
    const address = addrSpec(item);
    if (!address || typeof item !== "string" || item.trim().toLowerCase() !== address) return EMAIL_LINES.badAddress;
    out.push(address);
  }
  return out;
}

/** The lines of the binding's own state that refuse a send before any Flux call (6). */
function sendStateRefusal(binding: BindingRow | null): string | null {
  if (!binding?.inboxId) return EMAIL_UNAVAILABLE;
  if (binding.state === "paused") return EMAIL_LINES.paused;
  if (binding.state === "billing_hold" || binding.state === "grace") return EMAIL_LINES.billingHold;
  if (binding.state === "closing") return EMAIL_LINES.closing;
  if (binding.state !== "active") return EMAIL_UNAVAILABLE;
  return null;
}

const THREAD_PAGE = 5;
const THREAD_MESSAGE_CHARS = 2_500;
const PREVIEW_CHARS = 300;

type Message = Record<string, unknown>;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export class EmailTools {
  private readonly now: () => number;
  private readonly deps: EmailToolDeps;
  constructor(deps: EmailToolDeps) { this.deps = deps; this.now = deps.now ?? Date.now; }

  async handle(tool: EmailToolName, record: EmailTurnRecord, generation: string, args: unknown): Promise<EmailToolResult> {
    const refusal = argumentRefusal(tool, args);
    if (refusal) return fail(refusal);
    const body = args as Record<string, unknown>;
    switch (tool) {
      case "email_list": return this.list(record, body);
      case "email_read": return this.read(record, body);
      case "email_send": return this.sendNew(record, generation, body);
      case "email_reply": return this.reply(record, generation, body);
      case "email_trust_offer": return this.trustOffer(record, body);
    }
  }

  private failure(outcome: Exclude<FluxOutcome<unknown>, { kind: "ok" } | { kind: "held" }>, reading: boolean): EmailToolResult {
    if (outcome.kind !== "refused") return fail(reading ? EMAIL_LINES.couldNotRead : EMAIL_LINES.couldNotSend);
    try { this.deps.onRefusal?.(outcome.code); } catch { /* the probe never decides a read */ }
    const line = codeLine(outcome.code);
    if (line === EMAIL_LINES.couldNotSend) {
      try { this.deps.onUnknownCode?.(outcome.code); } catch { /* logging only */ }
      return fail(reading ? EMAIL_LINES.couldNotRead : line);
    }
    return fail(line);
  }

  /** The inbox the bot reads (active, paused or billing_hold; 3.1). */
  private readInbox(botId: string): string | null {
    const binding = this.deps.store.getBinding(botId);
    return binding?.inboxId && (binding.state === "active" || binding.state === "paused" || binding.state === "billing_hold" || binding.state === "grace") ? binding.inboxId : null;
  }

  /** One message's envelope: Murage's own facts outside, every sender-written field in its own fence. */
  private envelope(message: Message, botId: string): string[] {
    const from = addrSpec(message.from) ?? (typeof message.from === "string" ? message.from : "");
    const fence = (value: unknown) => fenceEmail(value, from);
    const scan = isRecord(message.injection_scan) ? message.injection_scan : {};
    const direction = message.direction === "inbound" || message.direction === "outbound" ? message.direction : "unknown direction";
    const time = token(message.received_at ?? message.sent_at ?? message.created_at, 40);
    const head = [
      `Email ${token(message.id) || "(no id)"}`,
      message.thread_id ? `thread ${token(message.thread_id)}` : "",
      direction,
      time ? `at ${time}` : "",
      typeof message.sender_authenticated === "boolean" ? `sender authenticated: ${message.sender_authenticated ? "yes" : "no"}` : "",
      `scan: ${scanWords(scan)}`,
      message.held_for_owner === true ? "held for the owner" : "",
    ].filter(Boolean).join(", ");
    const lines = [head];
    if (message.from !== undefined && message.from !== null) lines.push(`From: ${fence(message.from)}`);
    const to = list(message.to).filter(item => typeof item === "string");
    if (to.length) lines.push(`To: ${fence(to.join(", "))}`);
    const cc = list(message.cc).filter(item => typeof item === "string");
    if (cc.length) lines.push(`Cc: ${fence(cc.join(", "))}`);
    // 5.2: mail held for the owner reaches the bot as its envelope only (who, when, the verdicts), never its subject, preview or files
    if (isHeldForOwner(message)) return lines;
    if (typeof message.subject === "string") lines.push(`Subject: ${fence(message.subject)}`);
    if (typeof message.preview === "string" && message.preview) lines.push(`Preview: ${fence(message.preview.slice(0, PREVIEW_CHARS))}`);
    for (const item of list(message.attachments)) {
      if (!isRecord(item)) continue;
      const size = typeof item.size === "number" && Number.isFinite(item.size) ? `, ${Math.max(0, Math.trunc(item.size))} bytes` : "";
      lines.push(`Attachment (the owner downloads it in the Email panel)${size}: ${fence(item.filename ?? "")}`);
    }
    if (typeof scan.reason === "string" && scan.reason) lines.push(`Scan reason: ${fence(scan.reason)}`);
    // an outbound email Murage sent carries its own reference and state (4.6)
    const reference = token(message.client_reference, 64);
    if (direction === "outbound" && reference) {
      const row = this.deps.store.getSend(reference);
      if (row && row.botId === botId) lines.push(`Murage reference ${emailRef(row.sendId)}, Murage state ${row.state}`);
    }
    return lines;
  }

  private async list(record: EmailTurnRecord, args: Record<string, unknown>): Promise<EmailToolResult> {
    const inboxId = this.readInbox(record.botId);
    if (!inboxId) return fail(EMAIL_UNAVAILABLE);
    const limit = optInt(args.limit, 1, 25, 10);
    if (limit === null) return fail("limit is 1 to 25.");
    const direction = args.direction === undefined ? undefined : args.direction === "inbound" || args.direction === "outbound" ? args.direction : null;
    if (direction === null) return fail("direction is inbound or outbound.");
    const since = args.since === undefined ? undefined : token(args.since, 40) || null;
    if (since === null) return fail("since is an ISO time.");
    const threadId = args.thread_id === undefined ? undefined : token(args.thread_id) || null;
    if (threadId === null) return fail("thread_id is an id from email_list.");
    const outcome = await this.deps.client.listMessages({ kind: "bot", botId: record.botId }, inboxId, { direction, since, thread_id: threadId, limit });
    if (outcome.kind !== "ok") return outcome.kind === "held" ? fail(EMAIL_LINES.couldNotRead) : this.failure(outcome, true);
    // 5.2: spam, blocked and unauthenticated mail is hidden from the bot (the owner sees it under Filtered)
    const messages = list((outcome.body as { data?: unknown }).data).filter(isRecord).filter(message => !isFilteredMail(message));
    const lines: string[] = [EMAIL_RULE];
    // the emails Murage holds for the owner never reached Flux: they are listed from Murage's own record, with no text
    if (direction !== "inbound" && !threadId) {
      for (const row of this.deps.store.sendsOfBot(record.botId, ["prepared", "awaiting_owner"])) {
        lines.push(`Murage reference ${emailRef(row.sendId)}, Murage state ${row.state}, ${row.kind}, ${row.summary.to.length + row.summary.cc.length} recipient(s), not yet sent to Flux`);
      }
    }
    if (!messages.length) lines.push(EMAIL_LINES.noMatch);
    let shown = 0;
    for (const message of messages) {
      const next = [...lines, "", ...this.envelope(message, record.botId)];
      // leave room for the "more emails" line; never a partial envelope
      if (next.filter(line => line !== "").join("\n").length > EMAIL_RESULT_CAP - 200) break;
      lines.splice(0, lines.length, ...next);
      shown++;
    }
    if (shown < messages.length) lines.push("", `More emails match than fit here (${shown} shown): call email_list with a smaller limit, a thread_id or a later since.`);
    return ok(bounded(lines));
  }

  private async read(record: EmailTurnRecord, args: Record<string, unknown>): Promise<EmailToolResult> {
    const inboxId = this.readInbox(record.botId);
    if (!inboxId) return fail(EMAIL_UNAVAILABLE);
    const messageId = args.message_id === undefined ? undefined : token(args.message_id);
    const threadId = args.thread_id === undefined ? undefined : token(args.thread_id);
    if ((messageId === undefined) === (threadId === undefined) || messageId === "" || threadId === "") return fail(EMAIL_LINES.oneTarget);
    const part = optInt(args.part, 1, 1000, 1);
    if (part === null) return fail("part is a number from 1.");
    const bot = { kind: "bot" as const, botId: record.botId };
    if (messageId !== undefined) {
      const outcome = await this.deps.client.getMessage(bot, inboxId, messageId);
      if (outcome.kind !== "ok") return outcome.kind === "held" ? fail(EMAIL_LINES.couldNotRead) : this.failure(outcome, true);
      const message = outcome.body as Message;
      if (isFilteredMail(message)) return fail(EMAIL_LINES.noMatch);
      const lines = [EMAIL_RULE, ...this.envelope(message, record.botId)];
      if (message.held_for_owner === true) return ok(bounded([...lines, EMAIL_LINES.heldForOwner]));
      const from = addrSpec(message.from) ?? "";
      const parts = bodyParts(messageText(message));
      if (part > parts.length) return fail(`That part does not exist; this email has ${parts.length} part${parts.length === 1 ? "" : "s"}.`);
      lines.push(parts.length > 1 ? `Text, part ${part} of ${parts.length}:` : "Text:", fenceEmail(parts[part - 1], from));
      if (part < parts.length) lines.push(`This email continues: call email_read with message_id ${messageId} and part ${part + 1}.`);
      return ok(bounded(lines));
    }
    const outcome = await this.deps.client.getThread(bot, inboxId, threadId!);
    if (outcome.kind !== "ok") return outcome.kind === "held" ? fail(EMAIL_LINES.couldNotRead) : this.failure(outcome, true);
    const thread = outcome.body as Message;
    const messages = list(thread.messages).filter(isRecord).filter(message => !isFilteredMail(message));
    const pages = Math.max(1, Math.ceil(messages.length / THREAD_PAGE));
    if (part > pages) return fail(`That part does not exist; this thread has ${pages} part${pages === 1 ? "" : "s"}.`);
    const firstFrom = addrSpec(messages[0]?.from) ?? "";
    const lines = [EMAIL_RULE, `Thread ${threadId}: ${messages.length} email${messages.length === 1 ? "" : "s"}${pages > 1 ? `, part ${part} of ${pages}` : ""}.`];
    if (typeof thread.subject === "string") lines.push(`Thread subject: ${fenceEmail(thread.subject, firstFrom)}`);
    const participants = list(thread.participants).filter(item => typeof item === "string");
    if (participants.length) lines.push(`Participants: ${fenceEmail(participants.join(", "), firstFrom)}`);
    for (const message of messages.slice((part - 1) * THREAD_PAGE, part * THREAD_PAGE)) {
      lines.push("", ...this.envelope(message, record.botId));
      if (message.held_for_owner === true) { lines.push(EMAIL_LINES.heldForOwner); continue; }
      const text = messageText(message);
      const cut = text.length > THREAD_MESSAGE_CHARS ? bodyParts(text, THREAD_MESSAGE_CHARS)[0]! : text;
      lines.push("Text:", fenceEmail(cut, addrSpec(message.from) ?? ""));
      if (cut.length < text.length) lines.push(`This email continues: call email_read with message_id ${token(message.id)}.`);
    }
    if (part < pages) lines.push("", `This thread continues: call email_read with thread_id ${threadId} and part ${part + 1}.`);
    return ok(bounded(lines));
  }

  private attachments(record: EmailTurnRecord, paths: unknown) {
    return readEmailAttachments({ root: this.deps.workspaceRoot(record.botId, record.threadId), bot: this.deps.bot(record.botId), threadId: record.threadId, paths });
  }

  private async submit(record: EmailTurnRecord, generation: string, draft: EmailDraft, replySource: Parameters<EmailSendService["submit"]>[0]["replySource"] = null): Promise<EmailToolResult> {
    const result = await this.deps.send.submit({ botId: record.botId, generation: emailGeneration(generation), threadId: record.threadId, draft, replySource });
    if (result.status === "no_inbox") return fail(sendStateRefusal(this.deps.store.getBinding(record.botId)) ?? EMAIL_UNAVAILABLE);
    if (result.status === "duplicate") return fail(EMAIL_LINES.duplicate);
    if (result.row.state === "refused" && result.row.code) {
      try { if (codeLine(result.row.code) === EMAIL_LINES.couldNotSend) this.deps.onUnknownCode?.(result.row.code); } catch { /* logging only */ }
    }
    const line = sendLine(result.row);
    return result.row.state === "refused" ? fail(line) : ok(line);
  }

  private async sendNew(record: EmailTurnRecord, generation: string, args: Record<string, unknown>): Promise<EmailToolResult> {
    const to = addresses(args.to, 10, true);
    if (typeof to === "string") return fail(to);
    const cc = addresses(args.cc, 10, false);
    if (typeof cc === "string") return fail(cc);
    if (to.length + cc.length > 10) return fail(EMAIL_LINES.tooManyRecipients);
    const subject = str(args.subject, 300);
    if (!subject?.trim() || /[\r\n\0]/.test(subject)) return fail("subject is one line of at most 300 characters.");
    const text = str(args.text, 100_000);
    if (!text?.trim()) return fail("text is the plain-text body.");
    const state = sendStateRefusal(this.deps.store.getBinding(record.botId));
    if (state) return fail(state);
    const files = this.attachments(record, args.attachments);
    if (!files.ok) return fail(files.line);
    return this.submit(record, generation, { kind: "send", to, cc, subject, text, attachments: files.files, replyTo: null });
  }

  private async reply(record: EmailTurnRecord, generation: string, args: Record<string, unknown>): Promise<EmailToolResult> {
    if (args.reply_all !== undefined && args.reply_all !== false) return fail(EMAIL_LINES.replyAll);
    const messageId = token(args.message_id);
    if (!messageId || messageId !== args.message_id) return fail("message_id is an email id from email_list.");
    const cc = addresses(args.cc, 9, false);
    if (typeof cc === "string") return fail(cc);
    const text = str(args.text, 100_000);
    if (!text?.trim()) return fail("text is the plain-text body.");
    const binding = this.deps.store.getBinding(record.botId);
    const state = sendStateRefusal(binding);
    if (state) return fail(state);
    const files = this.attachments(record, args.attachments);
    if (!files.ok) return fail(files.line);
    // what the reply answers, read with the bot's own key (3.3 judges the source; the only recipient is its stored From)
    const outcome = await this.deps.client.getMessage({ kind: "bot", botId: record.botId }, binding!.inboxId!, messageId);
    if (outcome.kind !== "ok") return outcome.kind === "held" ? fail(EMAIL_LINES.couldNotSend) : this.failure(outcome, false);
    const message = outcome.body as Message;
    if (message.direction === "outbound") return fail(EMAIL_LINES.outboundReply);
    if (isFilteredMail(message)) return fail(EMAIL_LINES.noMatch);
    if (message.held_for_owner === true) return fail(EMAIL_LINES.heldNoReply);
    const from = addrSpec(message.from);
    if (!from) return fail(EMAIL_LINES.noSender);
    const scan = isRecord(message.injection_scan) ? message.injection_scan : {};
    const subject = typeof message.subject === "string" ? (/^re:/i.test(message.subject.trim()) ? message.subject.trim() : `Re: ${message.subject.trim()}`).replace(/[\r\n\0]/g, " ").slice(0, 300) : "";
    return this.submit(record, generation, { kind: "reply", to: [from], cc, subject, text, attachments: files.files, replyTo: messageId }, {
      from,
      senderAuthenticated: message.sender_authenticated === true,
      scanStatus: typeof scan.status === "string" ? scan.status : "unknown",
      scanVerdict: typeof scan.verdict === "string" ? scan.verdict : null,
      listMail: message.list_mail === true || (typeof message.list_unsubscribe === "string" && message.list_unsubscribe !== ""),
    });
  }

  private trustOffer(record: EmailTurnRecord, args: Record<string, unknown>): EmailToolResult {
    const address = addrSpec(args.address);
    if (!address || typeof args.address !== "string" || args.address.trim().toLowerCase() !== address) return fail(EMAIL_LINES.badAddress);
    const reason = str(args.reason, 500);
    if (!reason?.trim()) return fail("reason is one line on why, for the owner.");
    if (!this.readInbox(record.botId)) return fail(EMAIL_UNAVAILABLE);
    const now = this.now();
    if (this.deps.store.pendingTrustOffers(record.botId).some(offer => offer.address === address)) return ok(EMAIL_LINES.alreadyOffered);
    if (!this.deps.store.trustOfferEligible(record.botId, address, now)) return fail(EMAIL_LINES.offerNotEligible);
    this.deps.store.recordTrustOffer(record.botId, address, record.threadId, reason.replace(/[\r\n\0]+/g, " ").trim(), now);
    return ok(EMAIL_LINES.offered);
  }
}

/** Text only: an HTML-only body is reduced to text here (5.3 step 1). */
function messageText(message: Message): string {
  if (typeof message.text === "string" && message.text) return message.text;
  if (typeof message.html === "string" && message.html) return htmlToText(message.html);
  return "";
}
