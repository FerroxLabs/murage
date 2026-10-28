// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The send state machine (design 3.3, 3.4, 4.4, 4.5, 9.1 and the rev 2.2 build fixes M2, M3, L1, L3). Pure over the store and the Flux
// client, with the clock injected. Every transition is one compare-and-set on the row's revision; a writer that lost the race reads the
// row again and reports what it now is.
//
//   prepared ─receipt needed─> awaiting_owner ─Send─> dispatching ;  prepared ─no receipt needed─> dispatching
//   dispatching ─200─> sent ; ─202 + receipt + exact held ids─> approving ; ─202─> held
//   dispatching ─definite refusal─> refused(code) [before an owner Send] | approved_unsent(code) [after one] ; ─uncertain─> unknown
//   held ─Send, exact held ids─> approving ─sends[] sent─> sent | ─not sent─> approved_unsent(check) | ─no answer─> unknown
//   approved_unsent ─Retry─> approving (#32) | dispatching (Murage-held, the SAME Idempotency-Key: Flux stores only 2xx answers, r2.5)
//   awaiting_owner | held | approved_unsent ─Don't send─> declined ;  ─Edit─> withdraw_pending ─> withdrawn(edited) + a new awaiting_owner row
//   prepared | awaiting_owner | held ─Stop─> withdraw_pending ─#23 ok or 404─> withdrawn(stopped)
//   dispatching | unknown ─Stop─> same state + stop_requested (the answer or the read-only reconcile decides; never reissued)
//   unknown ─read-only reconcile at 1 m, 5 m, 30 m, 2 h─> sent | held | approved_unsent | unknown_expired (at the 2 h read)
//   held | awaiting_owner ─72 h─> expired ;  any open ─Remove, bot deleted, account off─> withdrawn(reason)
import { Buffer } from "node:buffer";
import { emailRef, normalizeAddresses, payloadHash, sendIdempotencyKey, sha256Hex, uuidv7, type EmailDraft } from "./canonical.ts";
import type { CredentialRef, FluxEmailClient, FluxOutcome, HeldMessage, SendBody } from "./flux-email-client.ts";
import { InboxLocks } from "./inbox-lock.ts";
import { decideSend, type WhyCode } from "./send-policy.ts";
import { OPEN_SEND_STATES, TERMINAL_SEND_STATES, type EmailStore, type OwnerReceipt, type PayloadPart, type ReplySource, type SendRow, type SendState, type SendSummary } from "./email-store.ts";

export const HOLD_LIFETIME_MS = 72 * 3_600_000;
export const SENT_DUPLICATE_WINDOW_MS = 24 * 3_600_000;
/** The read-only reconcile of an uncertain send: reads at 1 min, 5 min, 30 min and 2 h after it became uncertain (gaps between reads). */
export const RECONCILE_GAPS_MS = [60_000, 240_000, 1_500_000, 5_400_000] as const;
export const WITHDRAW_RETRY_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

export type EmailOutcome = "sent" | "declined" | "not_sent" | "unknown" | "expired" | "withdrawn";
/** What the later phases turn into an `email_outcome` status row on the originating thread (4.6). No address, subject or text. */
export interface EmailOutcomeEvent { sendId: string; botId: string; threadId: string; ref: string; outcome: EmailOutcome; state: SendState; code: string | null }

export type SendClient = Pick<FluxEmailClient, "send" | "reply" | "getApproval" | "listApprovals" | "approve" | "withdrawHeld" | "retryHeld" | "listMessages">;

export interface SendServiceOptions {
  store: EmailStore;
  client: SendClient;
  installId: string;
  now?: () => number;
  newId?: () => string;
  /** Every refusal code, so the capability probe can re-read on email_not_enabled / capability_unavailable. */
  /** A Flux refusal; `botId` and the error's fields come with refusals of a send, for the binding mirror (billing #518). */
  onRefusal?: (code: string, botId?: string, fields?: Record<string, unknown>) => void;
  /** Every terminal ending (and unknown_expired). */
  onOutcome?: (event: EmailOutcomeEvent) => void;
  /** Every row change (the card is a view of the row). */
  onChange?: (row: SendRow) => void;
  locks?: InboxLocks;
}

export interface SubmitInput { botId: string; generation: number; threadId: string; draft: EmailDraft; replySource?: ReplySource | null }
export type SubmitResult =
  | { status: "no_inbox" }
  | { status: "duplicate"; row: SendRow }
  | { status: "existing"; row: SendRow }
  | { status: "accepted"; row: SendRow };

export type AnswerResult =
  | { status: "done"; row: SendRow }
  | { status: "stale"; row: SendRow | null }
  | { status: "refresh"; row: SendRow; reason: "unknown_held" | "content_mismatch" | "scope_mismatch" | "moved" }
  | { status: "waiting_sibling"; row: SendRow; siblingSendId: string }
  | { status: "retry_later"; row: SendRow };

const OWNER: CredentialRef = { kind: "owner" };
const outcomeOf = (state: SendState): EmailOutcome | null =>
  state === "sent" ? "sent" : state === "declined" ? "declined" : state === "refused" ? "not_sent" : state === "expired" ? "expired" : state === "withdrawn" ? "withdrawn" : state === "unknown_expired" ? "unknown" : null;

export function draftParts(draft: EmailDraft): PayloadPart[] {
  const body = new TextEncoder().encode(JSON.stringify({ subject: draft.subject, text: draft.text, to: normalizeAddresses(draft.to), cc: normalizeAddresses(draft.cc), replyTo: draft.replyTo }));
  return [
    { part: 0, name: null, contentType: "application/json", size: body.byteLength, sha256: sha256Hex(body), data: body },
    ...draft.attachments.map((file, index) => ({ part: index + 1, name: file.name, contentType: file.contentType, size: file.bytes.byteLength, sha256: sha256Hex(file.bytes), data: file.bytes })),
  ];
}
export function partsDraft(kind: "send" | "reply", parts: PayloadPart[]): EmailDraft {
  const body = parts.find(part => part.part === 0);
  if (!body) throw new Error("EMAIL_PAYLOAD_MISSING");
  const parsed = JSON.parse(new TextDecoder().decode(body.data)) as { subject: string; text: string; to: string[]; cc: string[]; replyTo: string | null };
  return { kind, subject: parsed.subject, text: parsed.text, to: parsed.to, cc: parsed.cc, replyTo: parsed.replyTo, attachments: parts.filter(part => part.part > 0).map(part => ({ name: part.name ?? "", contentType: part.contentType ?? "application/octet-stream", bytes: part.data })) };
}

export class EmailSendService {
  readonly locks: InboxLocks;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly options: SendServiceOptions;
  constructor(options: SendServiceOptions) {
    this.options = options;
    this.locks = options.locks ?? new InboxLocks();
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => uuidv7(this.now()));
  }
  private get store() { return this.options.store; }
  private get client() { return this.options.client; }

  // ---- transitions -----------------------------------------------------------------------------------------------------------

  /** One CAS; on success the change and any ending are reported. Null when the row had moved on. */
  private move(row: SendRow, patch: Partial<SendRow>): SendRow | null {
    const next = this.store.casSend(row.sendId, row.revision, patch, this.now());
    if (!next) return null;
    try { this.options.onChange?.(next); } catch { /* a view never decides a transition */ }
    const outcome = next.state !== row.state ? outcomeOf(next.state) : null;
    if (outcome) {
      try { this.options.onOutcome?.({ sendId: next.sendId, botId: next.botId, threadId: next.threadId, ref: emailRef(next.sendId), outcome, state: next.state, code: next.code }); } catch { /* as above */ }
    }
    return next;
  }
  private settle(row: SendRow, state: SendState, patch: Partial<SendRow> = {}): SendRow | null {
    return this.move(row, { state, dueAt: null, ...(TERMINAL_SEND_STATES.has(state) ? { settledAt: this.now() } : {}), ...patch });
  }
  private fresh(sendId: string): SendRow { const row = this.store.getSend(sendId); if (!row) throw new Error("EMAIL_SEND_MISSING"); return row; }

  private sent(row: SendRow, messageId: string | null, code: string | null = null): SendRow | null {
    const next = this.settle(row, "sent", { messageId, code });
    if (next?.ownerSent) this.store.tx(() => { for (const address of [...next.summary.to, ...next.summary.cc]) this.store.noteOwnerSent(next.botId, address, this.now()); });
    return next;
  }
  private uncertain(row: SendRow, patch: Partial<SendRow> = {}): SendRow | null {
    return this.move(row, { state: "unknown", reconcileStep: 0, dueAt: this.now() + RECONCILE_GAPS_MS[0], ...patch });
  }
  private refusal(code: string, botId?: string, fields?: Record<string, unknown>): void { try { this.options.onRefusal?.(code, botId, fields); } catch { /* the probe never decides a send */ } }

  // ---- 3.4: the handler entry --------------------------------------------------------------------------------------------------

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const binding = this.store.getBinding(input.botId);
    if (!binding || binding.state !== "active" || !binding.inboxId) return { status: "no_inbox" };
    const hash = payloadHash(input.draft);
    const now = this.now();
    const prepared = this.store.tx((): SubmitResult => {
      const rows = this.store.sendsByHash(input.botId, hash);
      // rule 2: an engine retry in the same turn gets the row it already made
      const same = rows.find(row => row.generation === input.generation);
      if (same) return { status: "existing", row: same };
      // rule 3: the same email from another turn while the first is open, uncertain or sent in the last 24 h
      const blocking = rows.find(row => (["prepared", "dispatching", "awaiting_owner", "held", "approving", "approved_unsent", "unknown"] as SendState[]).includes(row.state)
        || (row.state === "unknown_expired" && row.code !== "owner_resent" && row.code !== "owner_declined")
        || (row.state === "sent" && (row.settledAt ?? row.updatedAt) > now - SENT_DUPLICATE_WINDOW_MS));
      if (blocking) return { status: "duplicate", row: blocking };
      const row = this.newRow(input, binding.inboxId!, hash, null);
      this.store.insertSend(row);
      this.store.putPayload(row.sendId, draftParts(input.draft));
      return { status: "accepted", row };
    });
    if (prepared.status !== "accepted") return prepared;
    return { status: "accepted", row: await this.decide(prepared.row) };
  }

  private newRow(input: SubmitInput, inboxId: string, hash: string, replaces: string | null): SendRow {
    const now = this.now();
    const summary: SendSummary = {
      to: normalizeAddresses(input.draft.to), cc: normalizeAddresses(input.draft.cc), subject: input.draft.subject, textLength: input.draft.text.length,
      attachments: input.draft.attachments.map(file => ({ name: file.name, contentType: file.contentType, size: file.bytes.byteLength, sha256: sha256Hex(file.bytes) })),
      replySource: input.replySource ?? null,
    };
    return {
      sendId: this.newId(), botId: input.botId, generation: input.generation, threadId: input.threadId, inboxId, kind: input.draft.kind, replyMessageId: input.draft.replyTo,
      payloadHash: hash, summary, idemSuffix: 1, state: "prepared", code: null, why: null, stopRequested: false, ownerSent: false, replaces, receipt: null,
      revision: 1, attempts: [], heldIds: [], approvalId: null, messageId: null, reconcileStep: 0, dueAt: null, createdAt: now, updatedAt: now,
      dispatchedAt: null, settledAt: null, deliveryNote: null,
    };
  }

  /** 3.3 on a `prepared` row (at entry and again at boot): awaiting_owner, or dispatching then the call. */
  private async decide(row: SendRow): Promise<SendRow> {
    const binding = this.store.getBinding(row.botId);
    const decision = decideSend({
      policy: binding?.policy ?? "ask", kind: row.kind, to: row.summary.to, cc: row.summary.cc, subject: row.summary.subject,
      text: this.textOf(row), attachmentCount: row.summary.attachments.length, replySource: row.summary.replySource,
      isApproved: address => this.store.isApproved(row.botId, address),
    });
    if (decision.needsOwner) return this.move(row, { state: "awaiting_owner", why: decision.why }) ?? this.fresh(row.sendId);
    const dispatching = this.move(row, { state: "dispatching", why: decision.why, dispatchedAt: this.now() });
    if (!dispatching) return this.fresh(row.sendId);
    return this.dispatch(dispatching);
  }

  private textOf(row: SendRow): string { return partsDraft(row.kind, this.store.getPayload(row.sendId)).text; }

  /** The Flux call of a `dispatching` row (the CAS into dispatching is already committed). */
  private async dispatch(row: SendRow): Promise<SendRow> {
    const draft = partsDraft(row.kind, this.store.getPayload(row.sendId));
    const idem = sendIdempotencyKey(this.options.installId, row.sendId, row.idemSuffix);
    const attachments = draft.attachments.map(file => ({ filename: file.name, content_type: file.contentType, content: Buffer.from(file.bytes).toString("base64") }));
    const outcome: FluxOutcome<SendBody> = await this.locks.shared(row.inboxId, () => row.kind === "reply" && row.replyMessageId
      ? this.client.reply(row.botId, row.inboxId, row.replyMessageId, { text: draft.text, cc: draft.cc, attachments, reply_all: false, client_reference: row.sendId }, idem)
      : this.client.send(row.botId, row.inboxId, { to: draft.to, cc: draft.cc, subject: draft.subject, text: draft.text, attachments, client_reference: row.sendId }, idem));
    let current = this.fresh(row.sendId);
    const attempt = { suffix: row.idemSuffix, keyId: outcome.keyId ?? null, at: this.now(), route: row.kind === "reply" ? "#10" : "#9" };
    if (current.state !== "dispatching") return current; // moved on (Remove, account off): the answer has no row to land on
    const withAttempt = this.move(current, { attempts: [...current.attempts, attempt] });
    if (!withAttempt) return this.fresh(row.sendId);
    current = withAttempt;
    return this.landSend(current, outcome);
  }

  /** Where a #9/#10 answer lands. */
  private async landSend(row: SendRow, outcome: FluxOutcome<SendBody>): Promise<SendRow> {
    switch (outcome.kind) {
      case "ok": {
        if (outcome.body.status === "sent" || outcome.body.message_id) return this.sent(row, outcome.body.message_id ?? null) ?? this.fresh(row.sendId);
        return this.uncertain(row) ?? this.fresh(row.sendId);
      }
      case "held": {
        const heldId = outcome.body.held_id ?? null;
        const approvalId = outcome.body.approval?.id ?? null;
        if (!heldId || !approvalId) return this.uncertain(row) ?? this.fresh(row.sendId);
        if (row.stopRequested) {
          const pending = this.move(row, { state: "withdraw_pending", code: "stopped", heldIds: [heldId], approvalId });
          return pending ? this.withdraw(pending) : this.fresh(row.sendId);
        }
        const held = this.move(row, { state: "held", heldIds: [heldId], approvalId });
        if (!held) return this.fresh(row.sendId);
        // one card per email: an owner Send already given approves this exact hold at once (4.4)
        if (held.receipt && !held.receipt.used) return (await this.approve(held)).row ?? this.fresh(row.sendId);
        return held;
      }
      case "refused": {
        this.refusal(outcome.code, row.botId, outcome.error?.fields);
        return this.settle(row, row.ownerSent ? "approved_unsent" : "refused", { code: outcome.code }) ?? this.fresh(row.sendId);
      }
      case "uncertain": return this.uncertain(row, { code: outcome.reason }) ?? this.fresh(row.sendId);
    }
  }

  // ---- owner answers -----------------------------------------------------------------------------------------------------------

  /** The owner pressed Send on the card that showed `revision`. A second click (or the other device) sees the row as it now is (F5). */
  async ownerSend(sendId: string, revision: number, device = "desktop"): Promise<AnswerResult> {
    const row = this.store.getSend(sendId);
    if (!row) return { status: "stale", row: null };
    if (row.revision !== revision) return { status: "stale", row };
    const receipt: OwnerReceipt = { sendId, payloadHash: row.payloadHash, revision, at: this.now(), device, used: false };
    switch (row.state) {
      case "awaiting_owner": {
        // the receipt stays unused until a hold consumes it: a 202 for this dispatch is approved at once with it (one card per email)
        const next = this.move(row, { state: "dispatching", ownerSent: true, receipt, why: "owner_send", dispatchedAt: this.now() });
        if (!next) return { status: "stale", row: this.store.getSend(sendId) };
        this.trustRecipients(next);
        return { status: "done", row: await this.dispatch(next) };
      }
      case "held": {
        const next = this.move(row, { ownerSent: true, receipt, why: "owner_send" });
        if (!next) return { status: "stale", row: this.store.getSend(sendId) };
        this.trustRecipients(next);
        return this.approve(next);
      }
      case "approved_unsent": return this.retry(row);
      case "unknown_expired": return this.resend(row);
      default: return { status: "done", row };
    }
  }

  /** Approving trusts that exact address (3.3); never a domain. */
  private trustRecipients(row: SendRow): void {
    const addresses = row.kind === "reply" && row.summary.replySource ? [row.summary.replySource.from.toLowerCase(), ...row.summary.cc] : [...row.summary.to, ...row.summary.cc];
    this.store.tx(() => { for (const address of addresses) if (!this.store.isApproved(row.botId, address)) this.store.addTrusted(row.botId, address, "allow", "approval", this.now()); });
  }

  /** 4.4, Flux-held: the exact held-id check against #20's frozen text and attachment hashes, then #21 naming exactly those holds. */
  async approve(row: SendRow): Promise<AnswerResult> {
    if (!row.approvalId) return { status: "refresh", row, reason: "moved" };
    return this.locks.exclusive(row.inboxId, async (): Promise<AnswerResult> => {
      const detail = await this.client.getApproval(OWNER, row.approvalId!);
      let current = this.fresh(row.sendId);
      if (current.state !== "held") return { status: "done", row: current };
      if (detail.kind === "refused" && detail.status === 404) return { status: "done", row: this.uncertain(current) ?? this.fresh(row.sendId) };
      if (detail.kind !== "ok") { if (detail.kind === "refused") this.refusal(detail.code); return { status: "retry_later", row: current }; }
      const approving: SendRow[] = [];
      for (const held of detail.body.held ?? []) {
        const local = this.store.sendForHeld(held.id, held.client_reference);
        if (!local) return { status: "refresh", row: current, reason: "unknown_held" };
        if (local.state === "declined" || local.state === "withdrawn" || local.state === "withdraw_pending" || local.state === "expired") {
          const gone = await this.client.withdrawHeld(OWNER, held.id);
          if (!(gone.kind === "ok" || (gone.kind === "refused" && gone.status === 404))) return { status: "refresh", row: current, reason: "moved" };
          continue;
        }
        if (local.state !== "held") return { status: "refresh", row: current, reason: "moved" };
        if (!local.ownerSent) return { status: "waiting_sibling", row: current, siblingSendId: local.sendId };
        if (!this.matchesFrozen(local, held)) return { status: "refresh", row: current, reason: "content_mismatch" };
        approving.push(local);
      }
      if (!approving.some(local => local.sendId === current.sendId)) return { status: "refresh", row: current, reason: "unknown_held" };
      // one CAS per row into approving; any that moved stops the approve before the call
      const moved: SendRow[] = [];
      for (const local of approving) {
        const next = this.move(local, { state: "approving", receipt: local.receipt ? { ...local.receipt, used: true } : null });
        if (!next) { for (const undo of moved) this.move(undo, { state: "held" }); return { status: "refresh", row: this.fresh(row.sendId), reason: "moved" }; }
        moved.push(next);
      }
      const heldIds = moved.flatMap(local => local.heldIds);
      const answer = await this.client.approve(row.approvalId!, heldIds);
      if (answer.kind === "ok") {
        for (const local of moved) {
          const fresh = this.fresh(local.sendId);
          if (fresh.state !== "approving") continue;
          const entry = (answer.body.sends ?? []).find(send => fresh.heldIds.includes(send.held_id));
          if (!entry) this.uncertain(fresh);
          else if (entry.status === "sent") this.sent(fresh, entry.message_id ?? null);
          else this.move(fresh, { state: "approved_unsent", code: entry.check ?? entry.status });
        }
      } else if (answer.kind === "refused" && answer.code === "approval_scope_mismatch") {
        for (const local of moved) { const fresh = this.fresh(local.sendId); if (fresh.state === "approving") this.move(fresh, { state: "held" }); }
        return { status: "refresh", row: this.fresh(row.sendId), reason: "scope_mismatch" };
      } else if (answer.kind === "refused" && answer.code !== "approval_not_pending") {
        this.refusal(answer.code);
        for (const local of moved) { const fresh = this.fresh(local.sendId); if (fresh.state === "approving") this.move(fresh, { state: "held", code: answer.code }); }
        return { status: "retry_later", row: this.fresh(row.sendId) };
      } else {
        // no answer, or approval_not_pending (F7): read-only reconcile of #20 and the delivery events, never a second approve
        for (const local of moved) { const fresh = this.fresh(local.sendId); if (fresh.state === "approving") this.uncertain(fresh); }
      }
      current = this.fresh(row.sendId);
      return { status: "done", row: current };
    });
  }

  /** The frozen hold is exactly the row's frozen payload: recipients, subject, text and the attachment SHA-256 list. */
  private matchesFrozen(row: SendRow, held: HeldMessage): boolean {
    const draft = partsDraft(row.kind, this.store.getPayload(row.sendId));
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
    if ((held.text ?? "") !== draft.text) return false;
    if (row.kind === "send") {
      if ((held.subject ?? "") !== draft.subject) return false;
      if (!same(normalizeAddresses(held.to ?? []), normalizeAddresses(draft.to))) return false;
    }
    if (!same(normalizeAddresses(held.cc ?? []), normalizeAddresses(draft.cc))) return false;
    return same((held.attachments ?? []).map(file => file.sha256), row.summary.attachments.map(file => file.sha256));
  }

  /** approved_unsent: Retry. A Flux hold that failed a check is retried with #32 under its approval; a Murage-held send refused after Send
   * goes out again with the SAME Idempotency-Key (r2.5: Flux stores only 2xx answers, so a refusal such as 503 capability_unavailable left
   * nothing under it; a new key on retry is never minted). #32 keeps its key until Flux answered one 2xx (send_failed is stored for 24 h,
   * so only then does the next owner Retry need the next key). */
  async retry(row: SendRow): Promise<AnswerResult> {
    if (row.state !== "approved_unsent") return { status: "done", row };
    if (row.heldIds.length > 0 && row.approvalId) {
      const approving = this.move(row, { state: "approving" });
      if (!approving) return { status: "stale", row: this.store.getSend(row.sendId) };
      const attempt = approving.attempts.filter(item => item.route === "#32" && item.answered).length + 1;
      const answer = await this.client.retryHeld(approving.heldIds[0], `${sendIdempotencyKey(this.options.installId, row.sendId, row.idemSuffix)}:held:${attempt}`);
      const fresh = this.fresh(row.sendId);
      if (fresh.state !== "approving") return { status: "done", row: fresh };
      const recorded = this.move(fresh, { attempts: [...fresh.attempts, { suffix: row.idemSuffix, keyId: answer.keyId ?? null, at: this.now(), route: "#32", ...(answer.kind === "ok" ? { answered: true } : {}) }] }) ?? this.fresh(row.sendId);
      if (answer.kind === "ok" && answer.body.status === "sent") return { status: "done", row: this.sent(recorded, answer.body.message_id ?? null) ?? this.fresh(row.sendId) };
      if (answer.kind === "ok") return { status: "done", row: this.move(recorded, { state: "approved_unsent", code: answer.body.check ?? answer.body.status ?? "send_failed" }) ?? this.fresh(row.sendId) };
      // a repeat after a lost answer (Flux #516): the hold is not retryable any more, so read it (#20) and land where it is; never a refusal
      if (answer.kind === "refused" && answer.code === "held_not_retryable") return { status: "done", row: await this.rereadHold(recorded) };
      if (answer.kind === "refused") { this.refusal(answer.code); return { status: "done", row: this.move(recorded, { state: "approved_unsent", code: answer.code }) ?? this.fresh(row.sendId) }; }
      return { status: "done", row: this.uncertain(recorded) ?? this.fresh(row.sendId) };
    }
    const next = this.move(row, { state: "dispatching", code: null, dispatchedAt: this.now() });
    if (!next) return { status: "stale", row: this.store.getSend(row.sendId) };
    return { status: "done", row: await this.dispatch(next) };
  }

  /** #32 409 held_not_retryable: #20 says where the hold is. sent -> sent; send_failed -> approved_unsent(check); anything else (sending,
   * unreadable) -> approving, settled by the delivery events or the read-only reconcile. */
  private async rereadHold(row: SendRow): Promise<SendRow> {
    const heldId = row.heldIds[0];
    const detail = row.approvalId ? await this.client.getApproval(OWNER, row.approvalId) : null;
    const held = detail?.kind === "ok" ? (detail.body.held ?? []).find(item => item.id === heldId) : undefined;
    const current = this.fresh(row.sendId);
    if (current.state !== "approving") return current;
    if (held?.state === "sent") return this.sent(current, null) ?? this.fresh(row.sendId);
    if (held?.state === "send_failed") return this.move(current, { state: "approved_unsent", code: held.check ?? "send_failed", dueAt: null }) ?? this.fresh(row.sendId);
    return this.move(current, { reconcileStep: 0, dueAt: this.now() + RECONCILE_GAPS_MS[0] }) ?? this.fresh(row.sendId);
  }

  /** unknown_expired: the owner's Send is a new send_id (L3: the replacing row is exempt from the identical-payload refusal). The choice is
   * made once (design 4.4: unknown_expired is terminal once the owner chooses; Astra r1 High): in one transaction the original row ends
   * withdrawn(owner_resent), so its card settles and offers no second Send, and a replacement is made only while none exists for it, so a
   * click racing the first, a second device or a stale card can never mint another send_id and Idempotency-Key for the same email. */
  private async resend(row: SendRow): Promise<AnswerResult> {
    const parts = this.store.getPayload(row.sendId);
    const draft = partsDraft(row.kind, parts);
    const made = this.store.tx((): { old: SendRow; next: SendRow } | null => {
      if (this.store.sendReplacing(row.sendId)) return null;
      const old = this.store.casSend(row.sendId, row.revision, { state: "withdrawn", code: "owner_resent", dueAt: null, settledAt: this.now() }, this.now());
      if (!old) return null;
      const fresh = this.newRow({ botId: row.botId, generation: row.generation, threadId: row.threadId, draft, replySource: row.summary.replySource }, row.inboxId, row.payloadHash, row.sendId);
      const receipt: OwnerReceipt = { sendId: fresh.sendId, payloadHash: fresh.payloadHash, revision: 1, at: this.now(), device: "desktop", used: false };
      const next: SendRow = { ...fresh, state: "dispatching", ownerSent: true, receipt, why: "owner_send", dispatchedAt: this.now() };
      this.store.insertSend(next);
      this.store.putPayload(next.sendId, parts);
      return { old, next };
    });
    if (!made) return { status: "stale", row: this.store.getSend(row.sendId) };
    // the original card settles now; no outcome is reported for it (the bot hears the replacement's)
    try { this.options.onChange?.(made.old); } catch { /* views only */ }
    return { status: "done", row: await this.dispatch(made.next) };
  }

  /** Don't send (also a dismissed card or a deleted thread, Fable M3). */
  async dontSend(sendId: string, revision: number): Promise<AnswerResult> {
    const row = this.store.getSend(sendId);
    if (!row) return { status: "stale", row: null };
    if (row.revision !== revision) return { status: "stale", row };
    if (row.state === "awaiting_owner" || row.state === "prepared") return { status: "done", row: this.settle(row, "declined") ?? this.fresh(sendId) };
    if (row.state === "held" || row.state === "approved_unsent") {
      const pending = this.move(row, { state: "withdraw_pending", code: "declined", dueAt: null });
      return { status: "done", row: pending ? await this.withdraw(pending) : this.fresh(sendId) };
    }
    if (row.state === "unknown_expired") return { status: "done", row: (row.stopRequested ? this.settle(row, "withdrawn", { code: "stopped" }) : this.settle(row, "declined", { code: "owner_declined" })) ?? this.fresh(sendId) };
    return { status: "done", row };
  }

  /** Edit (M2): never mutates a row. A new row (fresh send_id, hash and key, `replaces`) waits for its own Send; the old one is withdrawn. */
  async edit(sendId: string, revision: number, draft: EmailDraft): Promise<{ status: "done"; row: SendRow; replaced: SendRow } | { status: "stale"; row: SendRow | null }> {
    const row = this.store.getSend(sendId);
    if (!row || row.revision !== revision || !(["awaiting_owner", "held", "approved_unsent"] as SendState[]).includes(row.state)) return { status: "stale", row };
    const made = this.store.tx(() => {
      const old = this.store.casSend(row.sendId, row.revision, { state: "withdraw_pending", code: "edited", receipt: null, dueAt: null }, this.now());
      if (!old) return null;
      const fresh: SendRow = { ...this.newRow({ botId: row.botId, generation: row.generation, threadId: row.threadId, draft, replySource: row.summary.replySource }, row.inboxId, payloadHash(draft), row.sendId), state: "awaiting_owner", why: row.why };
      this.store.insertSend(fresh);
      this.store.putPayload(fresh.sendId, draftParts(draft));
      return { old, fresh };
    });
    if (!made) return { status: "stale", row: this.store.getSend(sendId) };
    try { this.options.onChange?.(made.old); this.options.onChange?.(made.fresh); } catch { /* views only */ }
    const replaced = await this.withdraw(made.old);
    return { status: "done", row: made.fresh, replaced };
  }

  // ---- Stop, withdrawal, expiry, removal (4.5) ---------------------------------------------------------------------------------

  /** Stop on the turn that made them: open rows of that generation are withdrawn; in-flight and uncertain rows gain stop_requested. */
  async stop(botId: string, generation: number): Promise<SendRow[]> {
    const pending = this.store.tx(() => {
      const out: SendRow[] = [];
      for (const row of this.store.sendsOfGeneration(botId, generation)) {
        if (row.state === "prepared" || row.state === "awaiting_owner" || row.state === "held") {
          const next = this.store.casSend(row.sendId, row.revision, { state: "withdraw_pending", code: "stopped", receipt: null, dueAt: null }, this.now());
          if (next) out.push(next);
        } else if ((row.state === "dispatching" || row.state === "unknown" || row.state === "unknown_expired") && !row.stopRequested) {
          this.store.casSend(row.sendId, row.revision, { stopRequested: true }, this.now());
        }
      }
      return out;
    });
    const done: SendRow[] = [];
    for (const row of pending) { try { this.options.onChange?.(row); } catch { /* views only */ } done.push(await this.withdraw(row)); }
    return done;
  }

  /** withdraw_pending: #23 for each Flux hold (204 or 404 = gone), then withdrawn(reason) or declined. 409 held_not_withdrawable (L1): the
   * hold is already sending or sent because an approve raced; read #20 and end as approving or sent, never retry for ever. */
  async withdraw(row: SendRow): Promise<SendRow> {
    if (row.state !== "withdraw_pending") return row;
    for (const heldId of row.heldIds) {
      const answer = await this.client.withdrawHeld({ kind: "bot", botId: row.botId }, heldId);
      if (answer.kind === "ok" || (answer.kind === "refused" && (answer.status === 404 || answer.code === "held_not_found"))) continue;
      const current = this.fresh(row.sendId);
      if (current.state !== "withdraw_pending") return current;
      if (answer.kind === "refused" && answer.code === "held_not_withdrawable") {
        const hold = row.approvalId ? await this.client.getApproval(OWNER, row.approvalId) : null;
        const state = hold?.kind === "ok" ? hold.body.held?.find(held => held.id === heldId)?.state : undefined;
        const latest = this.fresh(row.sendId);
        if (latest.state !== "withdraw_pending") return latest;
        if (state === "sent") return this.sent(latest, null) ?? this.fresh(row.sendId);
        // sending, or unreadable: approving, settled by the delivery events or the read-only reconcile
        return this.move(latest, { state: "approving", reconcileStep: 0, dueAt: this.now() + RECONCILE_GAPS_MS[0] }) ?? this.fresh(row.sendId);
      }
      const tries = current.reconcileStep;
      return this.move(current, { reconcileStep: tries + 1, dueAt: this.now() + WITHDRAW_RETRY_MS[Math.min(tries, WITHDRAW_RETRY_MS.length - 1)] }) ?? this.fresh(row.sendId);
    }
    const current = this.fresh(row.sendId);
    if (current.state !== "withdraw_pending") return current;
    return (current.code === "declined" ? this.settle(current, "declined") : this.settle(current, "withdrawn", { code: current.code ?? "stopped" })) ?? this.fresh(row.sendId);
  }

  /** 72 h: Flux expires the hold; a Murage-held card waits the same 72 h. */
  expire(): SendRow[] {
    const cutoff = this.now() - HOLD_LIFETIME_MS;
    const out: SendRow[] = [];
    for (const row of this.store.sendsInStates(["held", "awaiting_owner"])) if (row.createdAt <= cutoff) { const next = this.settle(row, "expired"); if (next) out.push(next); }
    return out;
  }

  /** Remove, bot deleted, or account off: every open row ends withdrawn(reason) (Flux cancels the approvals and discards the holds). */
  withdrawAllForBot(botId: string, reason: "inbox_removed" | "bot_deleted" | "account_off"): SendRow[] {
    const out: SendRow[] = [];
    for (const row of this.store.sendsOfBot(botId, OPEN_SEND_STATES)) { const next = this.settle(row, "withdrawn", { code: reason }); if (next) out.push(next); }
    return out;
  }

  // ---- uncertain sends: read-only reconcile (9.1) ------------------------------------------------------------------------------

  /** Reads #11 by client_reference, the pending approvals (#19, #20) and the delivery events; never sends, never approves. */
  async reconcile(row: SendRow): Promise<SendRow> {
    if (row.state !== "unknown" && row.state !== "approving") return row;
    let readable = true;
    const messages = await this.client.listMessages({ kind: "bot", botId: row.botId }, row.inboxId, { client_reference: row.sendId, direction: "outbound" });
    if (messages.kind === "ok") {
      const found = messages.body.data.find(message => message.client_reference === row.sendId) ?? messages.body.data[0];
      if (found) return this.sent(this.fresh(row.sendId), found.id) ?? this.fresh(row.sendId);
    } else readable = false;
    const fromEvents = this.fromEvents(this.fresh(row.sendId));
    if (fromEvents) return fromEvents;
    if (row.state === "unknown") {
      const pending = await this.client.listApprovals(OWNER, { state: "pending", inbox_id: row.inboxId });
      if (pending.kind === "ok") {
        for (const approval of pending.body.data) {
          const detail = await this.client.getApproval(OWNER, approval.id);
          if (detail.kind !== "ok") { readable = false; continue; }
          const held = (detail.body.held ?? []).find(item => item.client_reference === row.sendId);
          if (!held) continue;
          const current = this.fresh(row.sendId);
          if (current.state !== "unknown") return current;
          if (held.state === "send_failed") return this.move(current, { state: "approved_unsent", heldIds: [held.id], approvalId: approval.id, code: "send_failed", dueAt: null }) ?? this.fresh(row.sendId);
          if (current.stopRequested) { const pendingRow = this.move(current, { state: "withdraw_pending", code: "stopped", heldIds: [held.id], approvalId: approval.id }); return pendingRow ? this.withdraw(pendingRow) : this.fresh(row.sendId); }
          return this.move(current, { state: "held", heldIds: [held.id], approvalId: approval.id, dueAt: null, code: null }) ?? this.fresh(row.sendId);
        }
      } else readable = false;
    }
    const current = this.fresh(row.sendId);
    if (current.state !== row.state) return current;
    const step = current.reconcileStep + 1;
    if (step >= RECONCILE_GAPS_MS.length && readable) {
      // nothing found by the 2 h read: the owner decides (Send = a new send_id, Don't send); a stopped row ends withdrawn(stopped)
      return (current.stopRequested ? this.settle(current, "withdrawn", { code: "stopped" }) : this.settle(current, "unknown_expired")) ?? this.fresh(row.sendId);
    }
    const gap = step >= RECONCILE_GAPS_MS.length ? 300_000 : RECONCILE_GAPS_MS[step];
    return this.move(current, { reconcileStep: Math.min(step, RECONCILE_GAPS_MS.length - 1), dueAt: this.now() + gap }) ?? this.fresh(row.sendId);
  }

  private fromEvents(row: SendRow): SendRow | null {
    for (const event of this.store.eventsFor(row.sendId)) {
      if (event.type === "email.message.sent") return this.sent(row, typeof event.data.message_id === "string" ? event.data.message_id : null) ?? this.fresh(row.sendId);
      if (event.type === "email.held.send_failed") return this.move(row, { state: "approved_unsent", code: typeof event.data.check === "string" ? event.data.check : "send_failed", heldIds: event.heldId ? [event.heldId] : row.heldIds, dueAt: null }) ?? this.fresh(row.sendId);
    }
    return null;
  }

  // ---- events, timers, boot ----------------------------------------------------------------------------------------------------

  /** One event from #28 (deduplicated by eev_ id). */
  applyEvent(event: { id: string; type: string; inbox_id?: string; bot_id?: string; created?: string; data?: Record<string, unknown> }): SendRow | null {
    const data = event.data ?? {};
    const clientReference = typeof data.client_reference === "string" ? data.client_reference : null;
    const heldId = typeof data.held_id === "string" ? data.held_id : null;
    const fresh = this.store.recordEvent({ eventId: event.id, type: event.type, inboxId: event.inbox_id ?? null, botId: event.bot_id ?? null, clientReference, heldId, created: event.created ?? null, data }, this.now());
    if (!fresh) return null;
    const row = heldId || clientReference ? this.store.sendForHeld(heldId ?? "", clientReference) : null;
    if (!row) return null;
    switch (event.type) {
      case "email.message.sent":
        return (["unknown", "approving", "dispatching", "withdraw_pending"] as SendState[]).includes(row.state) ? this.sent(row, typeof data.message_id === "string" ? data.message_id : null) : row;
      case "email.held.send_failed":
        return (["approving", "held", "unknown"] as SendState[]).includes(row.state)
          ? this.move(row, { state: "approved_unsent", code: typeof data.check === "string" ? data.check : "send_failed", heldIds: heldId ? [heldId] : row.heldIds, dueAt: null })
          : row;
      case "email.approval.resolved": {
        const state = typeof data.state === "string" ? data.state : "";
        if (row.state === "held" && state === "expired") return this.settle(row, "expired");
        if (row.state === "held" && state === "cancelled") return this.settle(row, "withdrawn", { code: "cancelled" });
        return row;
      }
      case "email.message.bounced": case "email.message.complained": case "email.message.rejected": {
        const recipient = typeof data.recipient === "string" ? data.recipient.toLowerCase() : null;
        const kind = event.type.slice("email.message.".length);
        if (recipient) this.store.noteComplaintOrBounce(row.botId, recipient, this.now());
        const note = [row.deliveryNote, `${kind}${recipient ? `:${recipient}` : ""}`].filter(Boolean).join(";");
        const next = this.move(row, { deliveryNote: note });
        // every recipient bounced: the bot hears not_sent (a delivery note, not a send state)
        const bounced = new Set(note.split(";").filter(item => item.startsWith("bounced:") || item.startsWith("rejected")).map(item => item.split(":")[1] ?? "*"));
        const recipients = [...row.summary.to, ...row.summary.cc];
        if (next && next.state === "sent" && (bounced.has("*") || (recipients.length > 0 && recipients.every(address => bounced.has(address))))) {
          try { this.options.onOutcome?.({ sendId: next.sendId, botId: next.botId, threadId: next.threadId, ref: emailRef(next.sendId), outcome: "not_sent", state: next.state, code: kind }); } catch { /* as above */ }
        }
        return next;
      }
      default: return row;
    }
  }

  /** F24, after an expired event cursor: rows still `held` whose approval left Flux's pending list (#19) are read again (#20): expired and
   *  cancelled settle, a sent hold settles sent, anything else goes to the read-only reconcile. Uncertain rows are reconciled now. Never
   *  sends, never approves. */
  async afterEventGap(pendingApprovalIds: ReadonlySet<string>): Promise<void> {
    for (const row of this.store.sendsInStates(["held", "unknown", "approving"])) {
      const current = this.fresh(row.sendId);
      if (current.state === "unknown" || current.state === "approving") { await this.reconcile(current); continue; }
      if (current.state !== "held" || !current.approvalId || pendingApprovalIds.has(current.approvalId)) continue;
      const detail = await this.client.getApproval(OWNER, current.approvalId);
      if (detail.kind !== "ok") continue;
      const latest = this.fresh(row.sendId);
      if (latest.state !== "held") continue;
      const held = (detail.body.held ?? []).find(item => item.client_reference === latest.sendId || latest.heldIds.includes(item.id));
      const state = held?.state ?? detail.body.state ?? "";
      if (state === "expired") this.settle(latest, "expired");
      else if (state === "cancelled" || state === "withdrawn") this.settle(latest, "withdrawn", { code: "cancelled" });
      else if (state === "sent") { const messageId = (held as { message_id?: unknown } | undefined)?.message_id; this.sent(latest, typeof messageId === "string" ? messageId : null); }
      else if (state === "send_failed") this.move(latest, { state: "approved_unsent", code: "send_failed", dueAt: null });
      else this.move(latest, { state: "approving", reconcileStep: 0, dueAt: this.now() });
    }
  }

  /** Runs what is due: reconciles, withdrawal retries, the 72 h expiry. */
  async tick(): Promise<void> {
    for (const row of this.store.dueSends(this.now())) {
      const current = this.fresh(row.sendId);
      if (current.state === "unknown" || current.state === "approving") await this.reconcile(current);
      else if (current.state === "withdraw_pending") await this.withdraw(current);
    }
    this.expire();
  }

  /** Boot (before the event reader): `prepared` is re-decided by 3.3 (M3); `dispatching` and `approving` with no recorded answer become
   * `unknown` and are reconciled read-only; `withdraw_pending` is retried. Nothing is reissued under an old identity. */
  async recover(): Promise<void> {
    for (const row of this.store.sendsInStates(["prepared", "dispatching", "approving", "withdraw_pending"])) {
      if (row.state === "prepared") await this.decide(row);
      else if (row.state === "withdraw_pending") await this.withdraw(row);
      else if (row.dueAt === null) this.uncertain(row);
    }
    // read-only reconcile timers resume from their stored due times; whatever fell due while the app was closed runs now, and the 72 h expiry
    await this.tick();
  }

  /** Boot, after recover (9.3, F4): every pending Flux approval of a bound inbox is matched to a local row by client_reference. A hold with
   * no local row (a restore that carried no row, a lost data folder) is adopted as a `held` row with no payload on the bot's main thread:
   * its card says "This email was waiting before the restore" and offers Don't send only. Nothing is ever approved from here. */
  async adoptHolds(threadOf: (botId: string) => string | undefined): Promise<SendRow[]> {
    const adopted: SendRow[] = [];
    const pending = await this.client.listApprovals(OWNER, { state: "pending" });
    if (pending.kind !== "ok") return adopted;
    for (const approval of pending.body.data) {
      const binding = approval.inbox_id ? this.store.bindingByInbox(approval.inbox_id) : null;
      const threadId = binding ? threadOf(binding.botId) : undefined;
      if (!binding || !threadId) continue;
      const detail = await this.client.getApproval(OWNER, approval.id);
      if (detail.kind !== "ok") continue;
      for (const held of detail.body.held ?? []) {
        if (held.state && held.state !== "pending" && held.state !== "held") continue;
        const ref = typeof held.client_reference === "string" ? held.client_reference : null;
        if (ref && this.store.getSend(ref)) continue;
        if (this.store.sendsInStates(OPEN_SEND_STATES).some(row => row.heldIds.includes(held.id))) continue;
        const now = this.now();
        const row: SendRow = {
          sendId: ref && /^[\w-]{1,80}$/.test(ref) ? ref : uuidv7(now), botId: binding.botId, generation: 0, threadId, inboxId: binding.inboxId!, kind: "send", replyMessageId: null,
          payloadHash: typeof held.content_sha256 === "string" ? held.content_sha256 : "", idemSuffix: 0, state: "held", code: null, why: "adopted",
          summary: { to: [...(held.to ?? [])], cc: [...(held.cc ?? [])], subject: String(held.subject ?? "").slice(0, 300), textLength: typeof held.text === "string" ? held.text.length : 0, attachments: (held.attachments ?? []).map(item => ({ name: item.filename, contentType: item.content_type ?? "application/octet-stream", size: item.size ?? 0, sha256: item.sha256 })), replySource: null },
          stopRequested: false, ownerSent: false, replaces: null, receipt: null, revision: 1, attempts: [], heldIds: [held.id], approvalId: approval.id, messageId: null,
          reconcileStep: 0, dueAt: null, createdAt: now, updatedAt: now, dispatchedAt: null, settledAt: null, deliveryNote: null,
        };
        this.store.insertSend(row);
        adopted.push(row);
        try { this.options.onChange?.(row); } catch { /* the card is rebuilt from the row */ }
      }
    }
    return adopted;
  }

  /** Whether a key rotation may run for this bot (2.3): no row dispatching or uncertain. */
  canRotate(botId: string): boolean { return this.store.sendsOfBot(botId, ["dispatching", "unknown", "approving"]).length === 0; }
}

export type { WhyCode };
