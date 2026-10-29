// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The email card (BOT-EMAIL-MURAGE-109 4, 9.3), the bot's outcome row (4.6), the owner's activity rows (3.5) and the email notifications
// (section 6). A card is only a view of its `email_sends` row: kind `email-send`, requestId `email-<send_id>`, built here from the frozen
// record (never from the bot's words). It is never an engine request: no adapter, no askMessageByRequest, no grant. The thread itself is
// reached through an injected host, so this file never imports the store or index.ts.
import type { EmailStore, SendRow, SendState } from "./email-store.ts";
import { partsDraft, type AnswerResult, type EmailOutcomeEvent, type EmailSendService } from "./send-service.ts";
import { emailRef, type EmailDraft } from "./canonical.ts";
import { activityLine, checkLine, EMAIL_CARD_COPY, EMAIL_TRUST_COPY, type EmailCardAction, type EmailCardPayload, type EmailCardPhase, type EmailTrustOfferPayload } from "../../shared/email-copy.ts";
import { sha256Hex } from "./canonical.ts";
export type { EmailCardAction, EmailCardPayload, EmailCardPhase };
import { emailRefOf, type EmailOutcomeCode, type EmailRef } from "../murage-status.ts";

export const EMAIL_CARD_PREFIX = "email-";
export const EMAIL_CARD_KIND = "email-send";
export const EMAIL_CARD_TOOL = "email_send";
/** Cards unanswered this long roll into one digest notification (3.5). */
export const EMAIL_DIGEST_AFTER_MS = 4 * 3_600_000;

/** States a card offers buttons for (9.3 `open`). */
const OPEN: ReadonlySet<SendState> = new Set(["awaiting_owner", "held", "approved_unsent", "unknown_expired"]);
/** States after the owner answered and before the row ends (9.3 `answered`). */
const ANSWERED: ReadonlySet<SendState> = new Set(["dispatching", "approving", "unknown", "withdraw_pending"]);

export interface EmailCardFields {
  kind: typeof EMAIL_CARD_KIND; tool: typeof EMAIL_CARD_TOOL; requestId: string; title: string; subtitle: string; pushBody: string;
  options: string[]; answered?: "allow" | "deny" | "unavailable"; emailSend: EmailCardPayload;
}

export interface EmailCardHost {
  botName(botId: string): string;
  threadExists(threadId: string): boolean;
  /** The card message on the thread, through the card index. */
  card(threadId: string, requestId: string): { messageId: string; dismissed?: boolean; emailSend?: unknown; emailTrustOffer?: unknown } | null;
  /** Appends the card as a Murage row; the host raises the normal approval notification for it. */
  appendCard(threadId: string, botId: string, card: EmailCardFields | EmailTrustCardFields): string;
  patchCard(threadId: string, messageId: string, card: EmailCardFields | EmailTrustCardFields): void;
  /** The bot-visible `email_outcome` status row (4.6). */
  outcome(threadId: string, data: { ref: EmailRef; outcome: EmailOutcomeCode }): void;
  /** An owner-only Murage-voice activity row (3.5), never in BOT_VISIBLE_STATUS. */
  activity(threadId: string, line: string, ok: boolean): void;
  notify(kind: "email-status" | "email-digest", botId: string, threadId: string, body: string): void;
}

export interface EmailCardsOptions {
  store: EmailStore; send: EmailSendService; host: EmailCardHost; now?: () => number;
  /** Adds an exact address to the bot's trusted list at Flux (#17, rule allow) with the email:owner token. */
  addTrusted?: (botId: string, address: string) => Promise<{ ok: boolean; code?: string }>;
}

export const EMAIL_TRUST_CARD_KIND = "email-trust-offer";
export const EMAIL_TRUST_CARD_TOOL = "email_trust_offer";
export const EMAIL_TRUST_PREFIX = "email-trust-";
/** "Not now" keeps a new offer for the same address away this long (3.5). */
export const TRUST_OFFER_BLOCK_MS = 30 * 86_400_000;
export interface EmailTrustCardFields {
  kind: typeof EMAIL_TRUST_CARD_KIND; tool: typeof EMAIL_TRUST_CARD_TOOL; requestId: string; title: string; subtitle: string; pushBody: string;
  options: string[]; answered?: "allow" | "deny"; emailTrustOffer: EmailTrustOfferPayload;
}
export const isTrustRequestId = (requestId: string | null | undefined): boolean => typeof requestId === "string" && requestId.startsWith(EMAIL_TRUST_PREFIX) && requestId.length > EMAIL_TRUST_PREFIX.length;
export const trustRequestId = (botId: string, address: string, offeredAt: number): string => `${EMAIL_TRUST_PREFIX}${sha256Hex(`${botId}\n${address}\n${offeredAt}`).slice(0, 24)}`;

/** The proposal card (3.5, the routine-card pattern): built from Murage's own record; the bot's reason is never on it. */
export function trustCardView(botName: string, offer: EmailTrustOfferPayload): EmailTrustCardFields {
  const open = offer.phase === "open";
  return {
    kind: EMAIL_TRUST_CARD_KIND, tool: EMAIL_TRUST_CARD_TOOL, requestId: trustRequestId(offer.botId, offer.address, offer.offeredAt),
    title: EMAIL_TRUST_COPY.title(botName, offer.address),
    subtitle: offer.phase === "added" ? EMAIL_TRUST_COPY.added(offer.address) : offer.phase === "declined" ? EMAIL_TRUST_COPY.declined(offer.address) : offer.address,
    pushBody: EMAIL_TRUST_COPY.pushBody(botName),
    options: open ? [EMAIL_TRUST_COPY.add(offer.address), EMAIL_TRUST_COPY.notNow] : [],
    ...(offer.phase === "added" ? { answered: "allow" as const } : offer.phase === "declined" ? { answered: "deny" as const } : {}),
    emailTrustOffer: offer,
  };
}

export const isEmailRequestId = (requestId: string | null | undefined): boolean => typeof requestId === "string" && requestId.startsWith(EMAIL_CARD_PREFIX) && requestId.length > EMAIL_CARD_PREFIX.length;
export const emailRequestId = (sendId: string): string => `${EMAIL_CARD_PREFIX}${sendId}`;
const sendIdOf = (requestId: string): string => requestId.slice(EMAIL_CARD_PREFIX.length);

function size(bytes: number): string { return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`; }

/** The card's words and buttons for a row: built from the frozen record and the store's trust table only. */
export function emailCardView(row: SendRow, input: { botName: string; text: string; restored?: boolean; approved: (address: string) => boolean; note?: string; siblingRequestId?: string }): EmailCardFields {
  const bot = input.botName;
  const recipients = row.kind === "reply" && row.summary.replySource ? [row.summary.replySource.from.toLowerCase(), ...row.summary.cc] : [...row.summary.to, ...row.summary.cc];
  const fresh = recipients.filter(address => !input.approved(address));
  const known = recipients.filter(address => input.approved(address));
  const phase: EmailCardPhase = OPEN.has(row.state) ? "open" : ANSWERED.has(row.state) ? "answered" : "settled";
  const ref = emailRef(row.sendId);
  let title: string;
  let note = input.note;
  let actions: EmailCardAction[] = [];
  if (row.state === "approved_unsent") { title = EMAIL_CARD_COPY.approvedUnsent(checkLine(row.code)); actions = ["retry", "dont_send"]; }
  else if (row.state === "unknown_expired") { title = EMAIL_CARD_COPY.unknownExpired; actions = ["send", "dont_send"]; }
  else if (fresh.length && row.kind === "reply" && row.summary.replySource) title = `New contact: ${fresh[0]} hasn't emailed you before. Send this reply?`;
  else if (fresh.length) title = `New contact: ${bot} wants to email ${fresh.join(", ")} for the first time.`;
  else title = row.kind === "reply" ? `${bot} wants to send this reply.` : `${bot} wants to send this email.`;
  if (OPEN.has(row.state) && row.state !== "approved_unsent" && row.state !== "unknown_expired") actions = ["send", "edit", "dont_send"];
  // a restored row whose payload was not carried (section 7): Don't send only
  if (input.restored && OPEN.has(row.state)) { actions = ["dont_send"]; note = EMAIL_CARD_COPY.restoredWaiting; }
  if (row.state === "withdraw_pending" || (row.state === "withdrawn" && row.code === "stopped")) note = EMAIL_CARD_COPY.stopped;
  else if (row.state === "withdrawn" && row.code === "edited") note = EMAIL_CARD_COPY.edited;
  else if (row.state === "withdrawn" && row.code === "owner_resent") note = EMAIL_CARD_COPY.resent;
  else if (row.state === "withdrawn") note = EMAIL_CARD_COPY.withdrawn;
  else if (row.state === "expired") note = EMAIL_CARD_COPY.expired(bot);
  else if (row.state === "declined") note = EMAIL_CARD_COPY.declined;
  else if (row.state === "sent") note = EMAIL_CARD_COPY.sent;
  else if (row.state === "refused") note = EMAIL_CARD_COPY.refused;
  else if (row.state === "dispatching" || row.state === "approving" || row.state === "unknown") note = EMAIL_CARD_COPY.sending;
  const lines: string[] = [];
  if (row.kind === "reply" && row.summary.replySource) lines.push(`Reply to: ${row.summary.replySource.from}`); else lines.push(`To: ${row.summary.to.join(", ")}`);
  if (row.summary.cc.length) lines.push(`Cc: ${row.summary.cc.join(", ")}`);
  lines.push(`Subject: ${row.summary.subject}`);
  if (fresh.length) lines.push(`New: ${fresh.join(", ")}`);
  if (known.length) lines.push(`Already allowed: ${known.join(", ")}`);
  lines.push("", input.text);
  if (row.summary.attachments.length) {
    lines.push("", "Attachments:");
    for (const file of row.summary.attachments) lines.push(`${file.name} (${size(file.size)}, SHA-256 ${file.sha256})`);
  }
  const options = actions.map(action => action === "send" ? EMAIL_CARD_COPY.send : action === "edit" ? EMAIL_CARD_COPY.edit : action === "retry" ? EMAIL_CARD_COPY.retry : EMAIL_CARD_COPY.dontSend);
  const draft = { to: row.summary.to, cc: row.summary.cc, subject: row.summary.subject, text: input.text };
  const answered = phase === "settled" ? (row.state === "sent" ? "allow" : row.state === "declined" ? "deny" : "unavailable") : undefined;
  return {
    kind: EMAIL_CARD_KIND, tool: EMAIL_CARD_TOOL, requestId: emailRequestId(row.sendId), title, subtitle: lines.join("\n"),
    pushBody: fresh.length ? `${bot} wants to email someone new` : `${bot} wants to send an email`,
    options, ...(answered ? { answered } : {}),
    emailSend: {
      sendId: row.sendId, revision: row.revision, payloadHash: row.payloadHash, heldIds: [...row.heldIds].sort(), state: row.state, phase, ref, botId: row.botId,
      ...(note ? { note } : {}), ...(input.siblingRequestId && phase === "open" ? { siblingRequestId: input.siblingRequestId } : {}), actions, draft,
      links: { manage: EMAIL_CARD_COPY.manage(bot), ...(row.state === "unknown_expired" ? { checkSent: EMAIL_CARD_COPY.checkSent } : {}) },
    },
  };
}

export type ResolveResult = { status: number; body: { ok: boolean; outcome?: string; card?: EmailCardFields | null; error?: string; replacedBy?: string } };

export class EmailCards {
  private readonly options: EmailCardsOptions;
  private readonly now: () => number;
  /** Notes that live with a card until its row moves (a sibling wait, a refresh). */
  private readonly notes = new Map<string, { revision: number; note: string; siblingRequestId?: string }>();
  constructor(options: EmailCardsOptions) { this.options = options; this.now = options.now ?? Date.now; }
  private get store() { return this.options.store; }
  private get host() { return this.options.host; }

  /** The frozen draft, or null when the payload is gone (a restore drops payloads, section 7). */
  private draft(row: SendRow): EmailDraft | null {
    try { return partsDraft(row.kind, this.store.getPayload(row.sendId)); } catch { return null; }
  }

  view(row: SendRow): EmailCardFields {
    const kept = this.notes.get(row.sendId);
    const fresh = kept && kept.revision === row.revision ? kept : undefined;
    const draft = this.draft(row);
    return emailCardView(row, { botName: this.host.botName(row.botId), text: draft?.text ?? "", restored: !draft, approved: address => this.store.isApproved(row.botId, address), note: fresh?.note, siblingRequestId: fresh?.siblingRequestId });
  }

  /** The send service's onChange: the card follows its row (9.3). A row reaching an open state gets its card; any other row only updates
   * a card it already has. A card whose thread is gone is a Don't send (Fable M3). */
  sync(row: SendRow): void {
    const requestId = emailRequestId(row.sendId);
    const existing = this.host.card(row.threadId, requestId);
    if (!existing) {
      if (!OPEN.has(row.state)) return;
      if (!this.host.threadExists(row.threadId)) { void this.options.send.dontSend(row.sendId, row.revision).catch(() => undefined); return; }
      this.host.appendCard(row.threadId, row.botId, this.view(row));
      this.statusNotice(row);
      return;
    }
    // a dismissed card is the owner's Don't send (4.5)
    if (existing.dismissed && OPEN.has(row.state)) { void this.options.send.dontSend(row.sendId, row.revision).catch(() => undefined); return; }
    this.host.patchCard(row.threadId, existing.messageId, this.view(row));
    this.statusNotice(row);
  }

  /** The send service's onOutcome: the bot hears `email_outcome` on the thread that made it, the owner reads the activity line. */
  outcome(event: EmailOutcomeEvent): void {
    const ref = emailRefOf(event.ref);
    if (ref && this.host.threadExists(event.threadId)) this.host.outcome(event.threadId, { ref, outcome: event.outcome });
    const row = this.store.getSend(event.sendId);
    if (!row || !this.host.threadExists(row.threadId)) return;
    const address = row.kind === "reply" && row.summary.replySource ? row.summary.replySource.from : row.summary.to[0];
    const line = activityLine(row.state, row.why, row.code, address);
    if (line) this.host.activity(row.threadId, line, row.state === "sent");
  }

  /** The answer route (4.2): claims `email-` ids before any adapter. Re-reads the row; a second click returns the final state (F5). */
  async resolve(requestId: string, action: EmailCardAction, input: { revision?: number; device?: string; draft?: Partial<EmailDraft> } = {}): Promise<ResolveResult> {
    const sendId = sendIdOf(requestId);
    const row = this.store.getSend(sendId);
    if (!row) return { status: 404, body: { ok: false, error: "This email is no longer waiting.", card: null } };
    const revision = typeof input.revision === "number" ? input.revision : row.revision;
    const final = (outcome: string, current: SendRow | null = this.store.getSend(sendId)): ResolveResult => {
      if (current) this.sync(current);
      return { status: 200, body: { ok: true, outcome, card: current ? this.view(current) : null } };
    };
    if (!OPEN.has(row.state) || revision !== row.revision) return final(OPEN.has(row.state) ? "changed" : "settled", row);
    let result: AnswerResult | { status: "done"; row: SendRow; replaced: SendRow } | { status: "stale"; row: SendRow | null };
    switch (action) {
      case "send": if (row.state === "approved_unsent" || !this.draft(row)) return final("not_offered", row); result = await this.options.send.ownerSend(sendId, revision, input.device ?? "desktop"); break;
      case "retry": if (row.state !== "approved_unsent") return final("not_offered", row); result = await this.options.send.ownerSend(sendId, revision, input.device ?? "desktop"); break;
      case "dont_send": result = await this.options.send.dontSend(sendId, revision); break;
      case "edit": {
        if (!(row.state === "awaiting_owner" || row.state === "held") || !input.draft || typeof input.draft.text !== "string") return final("not_offered", row);
        const frozen = this.draft(row);
        if (!frozen) return final("not_offered", row);
        const draft: EmailDraft = { ...frozen, text: input.draft.text.slice(0, 200_000), ...(typeof input.draft.subject === "string" && row.kind === "send" ? { subject: input.draft.subject.slice(0, 998) } : {}) };
        const edited = await this.options.send.edit(sendId, revision, draft);
        if (edited.status === "done") {
          this.sync(edited.replaced);
          this.sync(edited.row);
          return { status: 200, body: { ok: true, outcome: "edited", card: this.view(this.store.getSend(sendId) ?? edited.replaced), replacedBy: emailRequestId(edited.row.sendId) } };
        }
        result = edited;
        break;
      }
    }
    const current = this.store.getSend(sendId);
    if (result.status === "waiting_sibling" && current) {
      const sibling = this.store.getSend(result.siblingSendId);
      const address = sibling ? (sibling.summary.to[0] ?? sibling.summary.replySource?.from ?? "") : "";
      this.notes.set(sendId, { revision: current.revision, note: EMAIL_CARD_COPY.sibling(this.host.botName(current.botId), address), siblingRequestId: emailRequestId(result.siblingSendId) });
      return final("waiting_sibling", current);
    }
    if (result.status === "refresh" && current) { this.notes.set(sendId, { revision: current.revision, note: EMAIL_CARD_COPY.refreshed }); return final("refresh", current); }
    if (result.status === "retry_later") return final("retry_later", current);
    return final(result.status === "stale" ? "changed" : "done", current);
  }

  /** Whether the card's Send is a Retry now (approved_unsent): a plain allow from a phone or the Inbox answers what the card offers. */
  retryOffered(requestId: string): boolean { return this.store.getSend(sendIdOf(requestId))?.state === "approved_unsent"; }

  /** Boot (9.3): every card is rebuilt from its row, so a withdrawn or declined send never shows its buttons again. */
  rebuild(): void {
    for (const row of this.store.sendsInStates(["awaiting_owner", "held", "approved_unsent", "unknown_expired", "dispatching", "approving", "unknown", "withdraw_pending"])) {
      try { this.sync(row); } catch { /* one card never stops the rest */ }
    }
  }

  /** Every tick: a dismissed card or a deleted thread is a Don't send (4.5, Fable M3). Reads only; writes only for those rows. */
  async sweep(): Promise<void> {
    for (const row of this.store.sendsInStates([...OPEN])) {
      const gone = !this.host.threadExists(row.threadId);
      const card = gone ? null : this.host.card(row.threadId, emailRequestId(row.sendId));
      if (gone || card?.dismissed) await this.options.send.dontSend(row.sendId, row.revision).catch(() => undefined);
    }
  }

  /** Thread deleted (4.5): every open card on it is a Don't send. */
  async threadDeleted(threadId: string): Promise<void> {
    for (const row of this.store.sendsInStates([...OPEN])) if (row.threadId === threadId) await this.options.send.dontSend(row.sendId, row.revision).catch(() => undefined);
  }

  // ---- earned trust (3.5) ----

  /** Every unanswered offer of the bot gets its proposal card on the thread the offer came from (once). */
  syncTrustOffers(botId: string): number {
    let made = 0;
    for (const offer of this.store.pendingTrustOffers(botId)) {
      if (!offer.threadId || !this.host.threadExists(offer.threadId)) continue;
      const requestId = trustRequestId(botId, offer.address, offer.offeredAt);
      if (this.host.card(offer.threadId, requestId)) continue;
      this.host.appendCard(offer.threadId, botId, trustCardView(this.host.botName(botId), { botId, address: offer.address, offeredAt: offer.offeredAt, phase: "open" }));
      made++;
    }
    return made;
  }

  /** "Add [address]" (exact address, source earned) or "Not now" (no new offer for 30 days). A second click returns the settled card. */
  async resolveTrust(threadId: string, requestId: string, action: "add" | "not_now"): Promise<ResolveResult> {
    const kept = this.host.card(threadId, requestId);
    const offer = kept?.emailTrustOffer as EmailTrustOfferPayload | undefined;
    if (!kept || !offer || typeof offer.address !== "string" || typeof offer.botId !== "string") return { status: 404, body: { ok: false, error: "This suggestion is no longer waiting.", card: null } };
    const botName = this.host.botName(offer.botId);
    if (offer.phase !== "open") return { status: 200, body: { ok: true, outcome: "settled", card: trustCardView(botName, offer) as unknown as EmailCardFields } };
    // the offer must still be the one Murage recorded; a cleared offer settles the card as it is
    const pending = this.store.pendingTrustOffers(offer.botId).some(item => item.address === offer.address && item.offeredAt === offer.offeredAt);
    let phase: EmailTrustOfferPayload["phase"];
    if (action === "add") {
      if (!pending && !this.store.isApproved(offer.botId, offer.address)) return { status: 409, body: { ok: false, error: "This suggestion is no longer waiting.", card: null } };
      if (!this.store.isApproved(offer.botId, offer.address)) {
        const added = this.options.addTrusted ? await this.options.addTrusted(offer.botId, offer.address) : { ok: false, code: "unavailable" };
        if (!added.ok) return { status: 502, body: { ok: false, error: EMAIL_TRUST_COPY.failed, outcome: added.code } };
      }
      this.store.tx(() => { this.store.addTrusted(offer.botId, offer.address, "allow", "earned", this.now()); this.store.clearTrustOffer(offer.botId, offer.address); });
      phase = "added";
    } else {
      this.store.tx(() => { this.store.blockTrustOffer(offer.botId, offer.address, this.now() + TRUST_OFFER_BLOCK_MS); this.store.clearTrustOffer(offer.botId, offer.address); });
      phase = "declined";
    }
    const card = trustCardView(botName, { ...offer, phase });
    this.host.patchCard(threadId, kept.messageId, card);
    return { status: 200, body: { ok: true, outcome: phase, card: card as unknown as EmailCardFields } };
  }

  /** `email-status` (section 6): approved_unsent and unknown, deduplicated per inbox per state change. */
  private statusNotice(row: SendRow): void {
    const kind = row.state === "approved_unsent" ? "approved_unsent" : row.state === "unknown" || row.state === "unknown_expired" ? "unknown" : null;
    if (!kind) return;
    this.noticeOnce(row.inboxId, `send:${row.sendId}:${kind}`, row.botId, row.threadId, kind === "approved_unsent"
      ? `${this.host.botName(row.botId)}: an email you sent has not gone out yet.`
      : `${this.host.botName(row.botId)}: Murage is checking whether an email went out.`);
  }

  /** Binding changes (paused, billing_hold): one `email-status` per inbox per state change. */
  bindingNotice(botId: string, threadId: string, inboxId: string | null, state: string): void {
    if (!inboxId || !(state === "paused" || state === "billing_hold" || state === "grace" || state === "closing")) { if (inboxId) this.store.setCursor(`status:${inboxId}:binding`, state, this.now()); return; }
    this.noticeOnce(inboxId, `binding:${state}`, botId, threadId, state === "paused" ? `${this.host.botName(botId)}: email paused.` : state === "closing" ? `${this.host.botName(botId)}: email is closing.` : `${this.host.botName(botId)}: email on hold.`, "binding");
  }

  private noticeOnce(inboxId: string, key: string, botId: string, threadId: string, body: string, slot = "send"): void {
    const scope = `status:${inboxId}:${slot}`;
    if (this.store.getCursor(scope) === key) return;
    this.store.setCursor(scope, key, this.now());
    this.host.notify("email-status", botId, threadId, body);
  }

  /** The 4 h digest (3.5): cards open longer than 4 h roll into one notification per bot; each card is counted once. */
  digest(): number {
    const cutoff = this.now() - EMAIL_DIGEST_AFTER_MS;
    const byBot = new Map<string, SendRow[]>();
    for (const row of this.store.sendsInStates(["awaiting_owner", "held"])) if (row.createdAt <= cutoff) byBot.set(row.botId, [...(byBot.get(row.botId) ?? []), row]);
    let sent = 0;
    for (const [botId, rows] of byBot) {
      const scope = `digest:${botId}`;
      const seen = new Set((this.store.getCursor(scope) ?? "").split(",").filter(Boolean));
      const fresh = rows.filter(row => !seen.has(row.sendId));
      if (!fresh.length) continue;
      this.store.setCursor(scope, rows.map(row => row.sendId).join(","), this.now());
      this.host.notify("email-digest", botId, rows[0].threadId, `${rows.length} ${rows.length === 1 ? "email is" : "emails are"} waiting for you from ${this.host.botName(botId)}.`);
      sent++;
    }
    return sent;
  }
}
