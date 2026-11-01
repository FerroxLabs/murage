// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Flux bot email client (BOT-EMAIL-MURAGE-109 rev 2.2, contract BOT-EMAIL-FLUX-CONTRACT r2.5 and BOT-EMAIL-ACTIVATION-BILLING #33-#35).
// Everything is injected: fetch, the two base URLs (the API host for /v1/email, the app host for /api/desktop/bot-keys) and a credential
// provider. This file never reads fluxKey() or config.flux: the email:bot keys and the email:owner token come only from the provider, which
// reads the email secret store (email-secrets.ts).
//
// Every answer is mapped to one typed outcome:
//   ok         2xx other than 202
//   held       202 (a held send; also #7's 202 closing, which the caller reads from the body)
//   refused    a definite refusal: a flat error body (contract 3) other than the two uncertain codes, or a 4xx with no body. Email never
//              answers 502 settlement_unavailable (r2.5): a send the provider took is a 200; a failure before the send is 503
//              capability_unavailable, which nothing stored, so the caller retries it with the SAME Idempotency-Key
//   uncertain  no answer, a reset, a timeout, a 5xx without a body, 409 idempotency_in_progress, 409 idempotency_mismatch, an unreadable 2xx
// An uncertain outcome is never replayed by the caller: nothing proves that nothing went out (3.4, Astra R3).

export type CredentialKind = "account" | "owner" | "bot";
export interface FluxCredential { token: string; /** the Flux key id, recorded per attempt; never the secret */ keyId: string }
export interface EmailCredentialProvider {
  /** Any valid Flux key of the saved account (capabilities only). */
  account(): FluxCredential | null;
  /** The email:owner desktop token. */
  owner(): FluxCredential | null;
  /** The bot's own email:bot key. */
  bot(botId: string): FluxCredential | null;
}
export type CredentialRef = { kind: "account" } | { kind: "owner" } | { kind: "bot"; botId: string } | { kind: "candidate"; credential: FluxCredential };

export interface FluxErrorBody { error: string; message: string; fields: Record<string, unknown> }

export type FluxOutcome<T = Record<string, unknown>> =
  | { kind: "ok"; status: number; body: T; keyId: string; costUsd?: string }
  | { kind: "held"; status: 202; body: T; keyId: string }
  | { kind: "refused"; status: number; code: string; message: string; error: FluxErrorBody; keyId: string }
  | { kind: "uncertain"; status?: number; reason: "network" | "timeout" | "server" | "idempotency_in_progress" | "idempotency_mismatch" | "bad_body" | "no_credential"; keyId?: string };

/** Codes that are a flat error body yet prove nothing about whether a send went out (3.4, Astra follow-up). */
export const UNCERTAIN_CODES: ReadonlySet<string> = new Set(["idempotency_in_progress", "idempotency_mismatch"]);

export interface FluxEmailClientOptions {
  fetch: typeof fetch;
  /** https://api.fluxrouter.ai */
  apiBase: string;
  /** https://fluxrouter.ai (bot-keys) */
  appBase: string;
  credentials: EmailCredentialProvider;
  timeoutMs?: number;
  /** Section 8 credential health (key-health.ts): sees every answer on a credential; never decides the outcome. */
  observe?: (ref: CredentialRef, outcome: FluxOutcome<unknown>) => void;
  /** Section 8 outage backoff: an answer to give instead of calling Flux while that credential waits (null = call). */
  gate?: (ref: CredentialRef) => FluxOutcome<never> | null;
}

/** Contract 3 bodies are flat ({ error: "<code>", message }); an older shape nests { error: { code | type, message } }. Both are read. */
export function parseFluxError(raw: unknown): FluxErrorBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { error, message, ...rest } = record;
  if (typeof error === "string" && error) return { error, message: typeof message === "string" ? message : "", fields: rest };
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const nested = error as Record<string, unknown>;
    const code = typeof nested.code === "string" && nested.code ? nested.code : typeof nested.type === "string" && nested.type ? nested.type : null;
    if (!code) return null;
    const { code: _code, type: _type, message: nestedMessage, ...nestedRest } = nested;
    void _code; void _type;
    return { error: code, message: typeof nestedMessage === "string" ? nestedMessage : typeof message === "string" ? message : "", fields: { ...rest, ...nestedRest } };
  }
  return null;
}

/** Maps one HTTP answer to an outcome. Exported for the tests and for callers that read a body themselves. */
export function classifyResponse<T>(status: number, body: unknown, keyId: string, costHeader?: string | null): FluxOutcome<T> {
  if (status >= 200 && status < 300) {
    if (status === 204) return { kind: "ok", status, body: {} as T, keyId };
    if (body === undefined || body === null || typeof body !== "object") return { kind: "uncertain", status, reason: "bad_body", keyId };
    if (status === 202) return { kind: "held", status: 202, body: body as T, keyId };
    return { kind: "ok", status, body: body as T, keyId, ...(costHeader ? { costUsd: costHeader } : {}) };
  }
  const error = parseFluxError(body);
  if (error && UNCERTAIN_CODES.has(error.error)) return { kind: "uncertain", status, reason: error.error as "idempotency_in_progress" | "idempotency_mismatch", keyId };
  if (error) return { kind: "refused", status, code: error.error, message: error.message, error, keyId };
  if (status >= 500) return { kind: "uncertain", status, reason: "server", keyId };
  const code = `http_${status}`;
  return { kind: "refused", status, code, message: "", error: { error: code, message: "", fields: {} }, keyId };
}

// ---- bodies ----------------------------------------------------------------------------------------------------------------

export interface Capabilities {
  object?: string;
  enabled?: boolean;
  available?: boolean;
  eligible?: boolean;
  reason?: string | null;
  account_state?: string;
  domain?: string;
  terms_version?: string;
  price?: Record<string, unknown> & { display_note?: string; display_surfaces?: string[] };
  limits?: Record<string, number | null>;
  features?: Record<string, boolean>;
  [field: string]: unknown;
}
export interface InboxBody { object?: string; id: string; bot_id?: string; address?: string; display_name?: string; state?: string; send_policy?: "ask" | "auto"; [field: string]: unknown }
export interface ApprovalSummary { id: string; inbox_id?: string; state?: string; reason?: string; held_ids?: string[]; recipients?: string[]; expires_at?: string; [field: string]: unknown }
export interface HeldMessage {
  id: string; state?: string; client_reference?: string | null; to?: string[]; cc?: string[]; subject?: string; text?: string | null; html?: string | null;
  attachments?: Array<{ filename: string; content_type?: string; size?: number; sha256: string }>; content_sha256?: string; created_by_key_id?: string; last_error?: unknown; check?: string;
}
export interface ApprovalDetail extends ApprovalSummary { held?: HeldMessage[] }
export interface SendBody { object?: string; status?: string; message_id?: string; thread_id?: string; held_id?: string; client_reference?: string; approval?: ApprovalSummary; cost_usd?: string; check?: string; [field: string]: unknown }
export interface ApproveBody { id?: string; state?: string; sends?: Array<{ held_id: string; status: string; message_id?: string; check?: string; client_reference?: string | null; cost_usd?: string }>; [field: string]: unknown }
export interface ListBody<T> { object?: string; data: T[]; next_cursor?: string | null }
export interface EmailEvent { id: string; type: string; created?: string; inbox_id?: string; bot_id?: string; cursor?: string; data?: Record<string, unknown> }
export interface MessageSummary { id: string; direction?: string; client_reference?: string | null; thread_id?: string; [field: string]: unknown }
export interface BotKeyBody { key: string; key_id: string; label?: string; [field: string]: unknown }

/** POST/DELETE /api/desktop/bot-keys answer 404 with no body while Flux's FLUX_BOT_KEYS_ENABLED is off (r2.5): bot email is dark, which is
 *  not a failure of this bot. A real missing key is a 404 with a body (key_not_found). */
export function botKeysDark(outcome: { kind: string; status?: number; code?: string }): boolean {
  return outcome.kind === "refused" && outcome.status === 404 && outcome.code === "http_404";
}

export interface OutboundAttachment { filename: string; content_type: string; content: string }
export interface SendRequest { to: string[]; cc: string[]; subject: string; text: string; attachments: OutboundAttachment[]; client_reference: string }
export interface ReplyRequest { text: string; cc: string[]; attachments: OutboundAttachment[]; reply_all: false; client_reference: string }

export class FluxEmailClient {
  private readonly timeoutMs: number;
  private readonly options: FluxEmailClientOptions;
  constructor(options: FluxEmailClientOptions) { this.options = options; this.timeoutMs = options.timeoutMs ?? 30_000; }

  private credential(ref: CredentialRef): FluxCredential | null {
    const { credentials } = this.options;
    // candidate: a freshly minted email key checked against #5 before it is saved (rotation, 2.3)
    return ref.kind === "account" ? credentials.account() : ref.kind === "owner" ? credentials.owner() : ref.kind === "candidate" ? ref.credential : credentials.bot(ref.botId);
  }

  async request<T>(ref: CredentialRef, method: string, path: string, init: { body?: unknown; idempotencyKey?: string; host?: "api" | "app"; query?: Record<string, string | number | undefined>; timeoutMs?: number } = {}): Promise<FluxOutcome<T>> {
    const credential = this.credential(ref);
    if (!credential) return { kind: "uncertain", reason: "no_credential" };
    const waiting = this.options.gate?.(ref);
    if (waiting) return waiting;
    const outcome = await this.exchange<T>(credential, method, path, init);
    try { this.options.observe?.(ref, outcome as FluxOutcome<unknown>); } catch { /* health never decides an answer */ }
    return outcome;
  }

  private async exchange<T>(credential: FluxCredential, method: string, path: string, init: { body?: unknown; idempotencyKey?: string; host?: "api" | "app"; query?: Record<string, string | number | undefined>; timeoutMs?: number }): Promise<FluxOutcome<T>> {
    const base = (init.host === "app" ? this.options.appBase : this.options.apiBase).replace(/\/+$/, "");
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = { authorization: `Bearer ${credential.token}`, accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, init.timeoutMs ?? this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const response = await this.options.fetch(url.toString(), { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal, redirect: "error" });
      let text = "";
      try { text = await response.text(); } catch { return { kind: "uncertain", status: response.status, reason: timedOut ? "timeout" : "network", keyId: credential.keyId }; }
      let body: unknown = undefined;
      if (text) { try { body = JSON.parse(text); } catch { body = undefined; } }
      return classifyResponse<T>(response.status, body, credential.keyId, response.headers.get("x-flux-cost-usd"));
    } catch {
      return { kind: "uncertain", reason: timedOut ? "timeout" : "network", keyId: credential.keyId };
    } finally { clearTimeout(timer); }
  }

  // #31 / #33
  capabilities() { return this.request<Capabilities>({ kind: "account" }, "GET", "/v1/email/capabilities"); }
  // #34, #35
  enable(acceptTermsVersion: string) { return this.request<Record<string, unknown>>({ kind: "owner" }, "POST", "/v1/email/enable", { body: { accept_terms_version: acceptTermsVersion } }); }
  /** #1 settings (owner): the account counters (account_sends_today, account_sends_per_day) for the account line. */
  getSettings() { return this.request<{ limits?: Record<string, unknown>; account_state?: string }>({ kind: "owner" }, "GET", "/v1/email/settings"); }
  disable(acknowledge: string) { return this.request<Record<string, unknown>>({ kind: "owner" }, "POST", "/v1/email/disable", { body: { acknowledge } }); }
  // bot-keys (contract r2.4/r2.5, 1.2): an email:bot key per bot {bot_id, scopes, bot_monthly_spend_limit_usd}, Idempotency-Key kept 24 h by
  // Flux (ask 9). The bot's monthly budget is the one number Flux stamps on every key of the bot; no per-key budget, no label (Flux names it).
  mintBotKey(input: { botId: string; botMonthlySpendLimitUsd?: number }, idempotencyKey: string) {
    return this.request<BotKeyBody>({ kind: "owner" }, "POST", "/api/desktop/bot-keys", {
      host: "app", idempotencyKey,
      body: { bot_id: input.botId, scopes: ["email:bot"], ...(input.botMonthlySpendLimitUsd !== undefined ? { bot_monthly_spend_limit_usd: input.botMonthlySpendLimitUsd } : {}) },
    });
  }
  revokeBotKey(keyId: string) { return this.request<Record<string, unknown>>({ kind: "owner" }, "DELETE", `/api/desktop/bot-keys/${encodeURIComponent(keyId)}`, { host: "app" }); }
  // #3 to #7. #3 is owner-only in v1 (r2.5) and names the bot with bot_id (there is no bot_key_id): 404 bot_not_found, 409 inbox_exists
  // (carries inbox_id), and a bot key would get 403 owner_required, so only the owner token ever calls it.
  createInbox(input: { botId: string; username?: string; displayName?: string }, idempotencyKey: string) {
    return this.request<InboxBody>({ kind: "owner" }, "POST", "/v1/email/inboxes", { idempotencyKey, body: { bot_id: input.botId, ...(input.username ? { username: input.username } : {}), ...(input.displayName ? { display_name: input.displayName } : {}) } });
  }
  listInboxes(ref: CredentialRef = { kind: "owner" }) { return this.request<ListBody<InboxBody>>(ref, "GET", "/v1/email/inboxes"); }
  getInbox(ref: CredentialRef, inboxId: string) { return this.request<InboxBody>(ref, "GET", `/v1/email/inboxes/${encodeURIComponent(inboxId)}`); }
  patchInbox(inboxId: string, patch: Record<string, unknown>) { return this.request<InboxBody>({ kind: "owner" }, "PATCH", `/v1/email/inboxes/${encodeURIComponent(inboxId)}`, { body: patch }); }
  /** The per-inbox policy write (#6 send_policy, email:owner only). */
  setSendPolicy(inboxId: string, policy: "ask" | "auto") { return this.patchInbox(inboxId, { send_policy: policy }); }
  /** #8: `acknowledge` must equal the pause reason exactly (the owner read why). */
  resumeInbox(inboxId: string, acknowledge: string) { return this.request<InboxBody>({ kind: "owner" }, "POST", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/resume`, { body: { acknowledge } }); }
  /** #7 (r2.5): 202 state "closing" (closing_until): 30 days with no sends, restorable, then deleted and #5 answers 404. */
  deleteInbox(inboxId: string) { return this.request<InboxBody>({ kind: "owner" }, "DELETE", `/v1/email/inboxes/${encodeURIComponent(inboxId)}`); }
  /** Activation #37 Keep address: a closing inbox comes back with the same address (`bot_id` must be its bound bot). */
  restoreInbox(inboxId: string, botId: string) { return this.request<InboxBody>({ kind: "owner" }, "POST", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/restore`, { body: { bot_id: botId } }); }
  // #9, #10: Idempotency-Key required, client_reference = send_id (ask 7)
  send(botId: string, inboxId: string, body: SendRequest, idempotencyKey: string) {
    return this.request<SendBody>({ kind: "bot", botId }, "POST", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/messages`, { idempotencyKey, body: { ...body, html: null, on_new_recipient: "hold" } });
  }
  reply(botId: string, inboxId: string, messageId: string, body: ReplyRequest, idempotencyKey: string) {
    return this.request<SendBody>({ kind: "bot", botId }, "POST", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply`, { idempotencyKey, body: { ...body, html: null } });
  }
  // #11, #12, #14, #15
  listMessages(ref: CredentialRef, inboxId: string, query: { client_reference?: string; direction?: "inbound" | "outbound"; thread_id?: string; since?: string; limit?: number; cursor?: string } = {}) {
    return this.request<ListBody<MessageSummary>>(ref, "GET", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/messages`, { query });
  }
  getMessage(ref: CredentialRef, inboxId: string, messageId: string) { return this.request<Record<string, unknown>>(ref, "GET", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`); }
  listThreads(ref: CredentialRef, inboxId: string, query: { limit?: number; cursor?: string } = {}) { return this.request<ListBody<Record<string, unknown>>>(ref, "GET", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/threads`, { query }); }
  getThread(ref: CredentialRef, inboxId: string, threadId: string) { return this.request<Record<string, unknown>>(ref, "GET", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}`); }
  // #16 to #18
  listRecipients(ref: CredentialRef, inboxId: string) { return this.request<ListBody<Record<string, unknown>>>(ref, "GET", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/recipients`); }
  addRecipient(inboxId: string, entry: string, rule: "allow" | "block") { return this.request<Record<string, unknown>>({ kind: "owner" }, "POST", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/recipients`, { body: { entry, rule } }); }
  removeRecipient(inboxId: string, entry: string) { return this.request<Record<string, unknown>>({ kind: "owner" }, "DELETE", `/v1/email/inboxes/${encodeURIComponent(inboxId)}/recipients/${encodeURIComponent(entry)}`); }
  // #19 to #21, #23, #32
  listApprovals(ref: CredentialRef, query: { state?: string; inbox_id?: string } = { state: "pending" }) { return this.request<ListBody<ApprovalSummary>>(ref, "GET", "/v1/email/approvals", { query }); }
  getApproval(ref: CredentialRef, approvalId: string) { return this.request<ApprovalDetail>(ref, "GET", `/v1/email/approvals/${encodeURIComponent(approvalId)}`); }
  approve(approvalId: string, heldIds: string[]) {
    return this.request<ApproveBody>({ kind: "owner" }, "POST", `/v1/email/approvals/${encodeURIComponent(approvalId)}/approve`, { body: { scope: "once", held_ids: heldIds, acknowledge_future_sends: false } });
  }
  withdrawHeld(ref: CredentialRef, heldId: string) { return this.request<Record<string, unknown>>(ref, "DELETE", `/v1/email/held/${encodeURIComponent(heldId)}`); }
  retryHeld(heldId: string, idempotencyKey: string) { return this.request<SendBody>({ kind: "owner" }, "POST", `/v1/email/held/${encodeURIComponent(heldId)}/send`, { idempotencyKey }); }
  // #28 long-poll
  events(ref: CredentialRef, query: { cursor?: string; wait?: number; limit?: number; inbox_id?: string } = {}) {
    const wait = Math.max(0, Math.min(25, query.wait ?? 25));
    return this.request<ListBody<EmailEvent>>(ref, "GET", "/v1/email/events", { query: { ...query, wait }, timeoutMs: (wait + 15) * 1000 });
  }
}
