// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bot email wiring of the server (BOT-EMAIL-MURAGE-109 2.0, 3.1 to 3.4), in one module so index.ts keeps thin hooks only.
// Dark launch: the capability probe is the only thing that runs while email is off. The email tables, the send service, the tools and the
// tick exist only after Flux answered enabled: true for the saved account; with the probe off nothing mounts, no table is created and no
// call reaches Flux beyond #31.
import { markTurnEmailDerived, persistTurnMarks, type TurnMarkStore } from "./external-marks.ts";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { EmailCapabilityProbe } from "./capabilities.ts";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, credentialFingerprint, emailCredentialProvider, type EmailSecretsDoc } from "./email-secrets.ts";
import { EmailStore, LIVE_BINDING_STATES, type BindingState } from "./email-store.ts";
import { EmailSendService, type EmailOutcomeEvent } from "./send-service.ts";
import { EmailTools, type EmailToolResult } from "./tools.ts";
import { authorizeEmailCall, emailMounts, EMAIL_UNAVAILABLE, type EmailCallLive, type EmailMountInput, type EmailMountVerdict } from "./admission.ts";
import { recordEmailTurn } from "./email-turns.ts";
import { isEmailToolName } from "../drivers/email-tool-schemas.ts";
import type { SendRow } from "./email-store.ts";
import { EmailCards, type EmailCardHost } from "./cards.ts";
import { EmailBindingService, commitDeletionIntent, recordDeletionIntent, withdrawDeletionIntent } from "./binding-service.ts";
import { EmailEventReader, type EmailArrival } from "./event-reader.ts";
import type { BotRecord } from "../store.ts";
import { EmailKeyHealth, KEY_HEALTH_LINES } from "./key-health.ts";

export const FLUX_API_BASE = "https://api.fluxrouter.ai";
export const FLUX_APP_BASE = "https://fluxrouter.ai";
const INSTALL_ID_SCOPE = "install-id";
const TICK_MS = 30_000;
/** Live bindings are re-read from #5 this often (pause and hold notices, section 6). */
const BINDING_REFRESH_TICKS = 20;
/** Retention (Astra r1 High): one prune pass at boot and then once an hour of ticks, each step bounded to EMAIL_PRUNE_BATCH rows. */
export const PRUNE_TICKS = 120;
export const EMAIL_PRUNE_BATCH = 500;
/** Cached Flux events outlive Flux's own 7-day replay window (contract 5), so a replayed event is still known and never handled twice. */
export const EMAIL_EVENT_KEEP_MS = 30 * 86_400_000;
const EVER_ENABLED_SCOPE = "ever-enabled";

export interface EmailRuntimeOptions {
  /** The saved Flux account key (flux-config.ts fluxKey()); only #31 uses it. */
  accountKey: () => string | null;
  /** database.ts database() */
  database: () => DatabaseSync;
  /** database.ts transaction, as fn => transaction(() => fn()) */
  transaction: <T>(fn: () => T) => T;
  fetch?: typeof fetch;
  apiBase?: string;
  appBase?: string;
  now?: () => number;
  /** Hands every key change to the desktop shell's secret storage. */
  persistSecrets?: (doc: EmailSecretsDoc) => void;
  workspaceRoot: (botId: string, threadId: string) => string | undefined;
  bot: (botId: string) => BotRecord | undefined;
  onOutcome?: (event: EmailOutcomeEvent) => void;
  onChange?: (row: SendRow) => void;
  /** The thread side of the email card (index.ts); without it no card, outcome row or notification is made. */
  cardHost?: EmailCardHost;
  /** 5.2: the owner's arrival notice on the bot's main thread (one row per batch per bot, the first sender and how many more). Owner-only,
   *  never a turn. Filtered mail (spam, blocked, unauthenticated) makes no notice; it is listed under Filtered in the panel. */
  onArrival?: (botId: string, threadId: string, notice: { from: string; more: number }) => void;
  log?: (line: string) => void;
  /** 2.6 boot: whether the bot's deletion proof (botDeletionKey) exists. Absent = false: an intent without proof waits (L2). */
  deletionProof?: (botId: string) => boolean;
}

type Services = { db: DatabaseSync; store: EmailStore; send: EmailSendService; tools: EmailTools; bindings: EmailBindingService; cards: EmailCards | null; events: EmailEventReader };

/** Turn marks (5.4) kept as cursor rows `turn-mark:<threadId>`: no new table, and a restore drops them with the other cursors. */
const TURN_MARK_SCOPE = "turn-mark:";
const SESSION_FROM_SCOPE = "session-from:";
function turnMarksIn(store: EmailStore): TurnMarkStore {
  return {
    all: () => store.cursorScopes(TURN_MARK_SCOPE).map(scope => scope.slice(TURN_MARK_SCOPE.length)),
    add: threadId => store.setCursor(`${TURN_MARK_SCOPE}${threadId}`, "1", Date.now()),
    remove: threadId => store.clearCursor(`${TURN_MARK_SCOPE}${threadId}`),
    sessionFrom: (threadId, instanceId) => {
      const raw = store.getCursor(`${SESSION_FROM_SCOPE}${threadId}:${instanceId}`);
      const seq = raw === null ? NaN : Number(raw);
      return Number.isFinite(seq) ? seq : undefined;
    },
    setSessionFrom: (threadId, instanceId, seq) => store.setCursor(`${SESSION_FROM_SCOPE}${threadId}:${instanceId}`, String(seq), Date.now()),
  };
}

export class EmailRuntime {
  readonly secrets: EmailSecretStore;
  readonly client: FluxEmailClient;
  readonly probe: EmailCapabilityProbe;
  /** Section 8: per-credential health (each bot's email key and the owner token). */
  readonly health: EmailKeyHealth;
  private current: Services | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  private readonly options: EmailRuntimeOptions;
  constructor(options: EmailRuntimeOptions) {
    this.options = options;
    this.secrets = new EmailSecretStore(options.persistSecrets);
    this.health = new EmailKeyHealth({ now: options.now });
    const account = () => {
      const key = options.accountKey();
      return key ? { token: key, keyId: `account:${credentialFingerprint(key)}` } : null;
    };
    this.client = new FluxEmailClient({
      fetch: options.fetch ?? fetch, apiBase: options.apiBase ?? FLUX_API_BASE, appBase: options.appBase ?? FLUX_APP_BASE,
      credentials: emailCredentialProvider(this.secrets, account),
      observe: (ref, outcome) => this.health.observe(ref, outcome),
      gate: ref => this.health.gate(ref),
    });
    this.probe = new EmailCapabilityProbe({ client: this.client, accountRef: () => { const key = options.accountKey(); return key ? credentialFingerprint(key) : null; }, now: options.now });
    this.probe.onChange(enabled => { if (enabled) this.startTick(); else this.stopTick(); });
  }

  /** The launch switch (2.0). */
  enabled(): boolean { return this.probe.emailEnabled(); }

  /** The store, send service and tools, made on first use while enabled (the tables with them) and again when the database handle
   *  changes. Null while email is off: nothing is created. */
  services(): Services | null {
    if (!this.enabled()) return null;
    const db = this.options.database();
    if (this.current?.db === db) return this.current;
    const store = new EmailStore(db, { transaction: this.options.transaction });
    persistTurnMarks(turnMarksIn(store));
    let installId = store.getCursor(INSTALL_ID_SCOPE);
    if (!installId) { installId = randomUUID(); store.setCursor(INSTALL_ID_SCOPE, installId, (this.options.now ?? Date.now)()); }
    const send = new EmailSendService({
      store, client: this.client, installId, now: this.options.now,
      onRefusal: (code, botId, fields) => {
        void this.probe.noteRefusal(code).catch(() => undefined);
        // Flux #519: 403 email_scope_required names the scope it wanted; owner-side log only (scope names, never a key)
        if (code === "email_scope_required") this.options.log?.(`[email] Flux asked for scope ${(Array.isArray(fields?.required) ? fields.required : []).map(item => String(item).replace(/[^\w:.-]/g, "").slice(0, 40)).join(",") || "unknown"}`);
        if (botId) { try { bindingsRef.current?.noteRefusal(botId, code, fields); } catch { /* the next #5 read mirrors it */ } }
      },
      // the card follows its row and the bot hears the outcome (4.1, 4.6); a view never decides a transition
      onOutcome: event => { try { cardsRef.current?.outcome(event); } catch (error) { this.options.log?.(`[email] outcome row: ${(error as Error)?.message ?? error}`); } this.options.onOutcome?.(event); },
      onChange: row => { try { cardsRef.current?.sync(row); } catch (error) { this.options.log?.(`[email] card: ${(error as Error)?.message ?? error}`); } this.options.onChange?.(row); },
    });
    const cardsRef: { current: EmailCards | null } = { current: null };
    const bindingsRef: { current: EmailBindingService | null } = { current: null };
    cardsRef.current = this.options.cardHost ? new EmailCards({
      store, send, host: this.options.cardHost, now: this.options.now,
      // earned trust (3.5): Add writes the exact address to Flux with the email:owner token, then the local list
      addTrusted: async (botId, address) => {
        const inboxId = store.getBinding(botId)?.inboxId;
        if (!inboxId) return { ok: false, code: "no_inbox" };
        const answer = await this.client.addRecipient(inboxId, address, "allow");
        return answer.kind === "ok" ? { ok: true } : { ok: false, code: answer.kind === "refused" ? answer.code : "unavailable" };
      },
    }) : null;
    const bindings = new EmailBindingService({
      store, client: this.client, secrets: this.secrets, installId, now: this.options.now,
      withdrawSends: (botId, reason) => { send.withdrawAllForBot(botId, reason); },
      onRefusal: code => { void this.probe.noteRefusal(code).catch(() => undefined); },
      // section 6: pause and hold raise one email-status notice per inbox per state change, on the bot's own thread
      onStateChange: row => {
        const threadId = this.options.bot(row.botId)?.threadId;
        if (threadId) cardsRef.current?.bindingNotice(row.botId, threadId, row.inboxId, row.state);
        this.current?.events.wake();
      },
    });
    bindingsRef.current = bindings;
    // section 8: this install has had email on (the Flux line may show if the key is later lost)
    if (store.getCursor(EVER_ENABLED_SCOPE) !== "1") store.setCursor(EVER_ENABLED_SCOPE, "1", (this.options.now ?? Date.now)());
    const tools = new EmailTools({
      store, send, client: this.client, workspaceRoot: this.options.workspaceRoot, bot: this.options.bot, now: this.options.now,
      onRefusal: code => { void this.probe.noteRefusal(code).catch(() => undefined); },
      onUnknownCode: code => this.options.log?.(`[email] Flux answered an unlisted code: ${code.replace(/[^\w.-]/g, "").slice(0, 60)}`),
    });
    const events = new EmailEventReader({
      store, client: this.client, send, bindings, enabled: () => this.enabled(), now: this.options.now, log: this.options.log,
      onRefusal: code => { void this.probe.noteRefusal(code).catch(() => undefined); },
      onArrivals: (botId, arrivals) => this.arrived(botId, arrivals),
    });
    if (this.current) this.current.events.stop();
    this.current = { db, store, send, tools, bindings, cards: cardsRef.current, events };
    if (this.timer) events.start();
    return this.current;
  }

  /** 5.2: one owner notice per bot per batch; filtered mail makes none. */
  private arrived(botId: string, arrivals: EmailArrival[]): void {
    const shown = arrivals.filter(item => !item.filtered);
    const threadId = this.options.bot(botId)?.threadId;
    if (!shown.length || !threadId) return;
    this.options.onArrival?.(botId, threadId, { from: shown[0]!.from, more: shown.length - 1 });
  }

  /** Whether this install ever had email on (section 8). Reads only: no table is made while email is off. */
  everEnabled(): boolean {
    if (this.current) return true;
    try {
      const db = this.options.database();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_event_cursor'").get()) return false;
      return (db.prepare("SELECT cursor FROM email_event_cursor WHERE scope=?").get(EVER_ENABLED_SCOPE) as { cursor?: string } | undefined)?.cursor === "1";
    } catch { return false; }
  }

  /** store.deleteBot's email hooks (2.6). They act whenever the email tables exist (email on or off now), never create them, never call
   * Flux; commit with email on also moves the binding to removing and wakes the reaper. */
  deletionHooks(): { record: (id: string) => void; withdraw: (id: string) => void; commit: (id: string) => void } {
    const present = (): EmailStore | null => {
      const services = this.services();
      if (services) return services.store;
      const db = this.options.database();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_bindings'").get()) return null;
      return new EmailStore(db, { transaction: this.options.transaction });
    };
    const now = () => (this.options.now ?? Date.now)();
    return {
      record: id => { const store = present(); if (store) recordDeletionIntent(store, id, now()); },
      withdraw: id => { const store = present(); if (store) withdrawDeletionIntent(store, id); },
      commit: id => {
        const services = this.services();
        if (services) { services.bindings.commitDeletionIntent(id); void services.bindings.reap().catch(() => undefined); return; }
        const store = present(); if (store) commitDeletionIntent(store, id);
      },
    };
  }

  /** G15: Flux refused this bot's stored email key; its tools stay unmounted until the key changes (Reconnect rotates it). */
  keyRejected(botId: string): boolean { return this.health.rejected(botId, this.secrets.botKey(botId)?.keyId); }

  /** Section 8 owner lines: the owner token's and this bot's key health, or null when nothing is wrong. */
  ownerKeyLine(): string | null { return this.health.line("owner", this.secrets.owner()?.keyId); }
  botKeyLine(botId: string): string | null { return this.health.line(`bot:${botId}`, this.secrets.botKey(botId)?.keyId); }

  /** The bot's binding state, or null (and no table made) while email is off. */
  bindingState(botId: string): BindingState | null {
    try { return this.services()?.store.getBinding(botId)?.state ?? null; } catch { return null; }
  }

  /** Boot: read the launch switch; when on, recover open sends and start the tick. Never throws. */
  async start(): Promise<void> {
    // 5.4: a turn mark a crash left behind holds again, email on or off now (only where the email tables already exist; none is made)
    try {
      const db = this.options.database();
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_event_cursor'").get()) persistTurnMarks(turnMarksIn(new EmailStore(db, { transaction: this.options.transaction })));
    } catch { /* marks stay in memory */ }
    try { await this.probe.refresh(); } catch { /* off until a later read says otherwise */ }
    if (!this.enabled()) return;
    // 2.5, 2.6: unfinished setups, removals and policy writes carry on before anything else reads a binding
    // 2.6 (Astra R4, L2): uncommitted bot-deletion intents are dropped (bot still here), promoted (bot gone with proof) or left for next boot
    try { this.services()?.bindings.settleDeletionIntents(botId => Boolean(this.options.bot(botId)), botId => this.options.deletionProof?.(botId) ?? false); } catch (error) { this.options.log?.(`[email] deletion intents: ${(error as Error)?.message ?? error}`); }
    try { await this.services()?.bindings.reconcileBindings(); await this.services()?.bindings.reap(); } catch (error) { this.options.log?.(`[email] bindings: ${(error as Error)?.message ?? error}`); }
    try { await this.services()?.send.recover(); } catch (error) { this.options.log?.(`[email] recovery did not finish: ${(error as Error)?.message ?? error}`); }
    // F4: a pending Flux approval with no local row lands on the bot's main thread (Don't send only)
    try { await this.services()?.send.adoptHolds(botId => this.options.bot(botId)?.threadId); } catch (error) { this.options.log?.(`[email] approvals: ${(error as Error)?.message ?? error}`); }
    // 9.3: every card is rebuilt from its row after the recovery settled what it could
    try { this.services()?.cards?.rebuild(); } catch (error) { this.options.log?.(`[email] cards: ${(error as Error)?.message ?? error}`); }
    try { const services = this.services(); for (const row of services?.store.bindings() ?? []) services?.cards?.syncTrustOffers(row.botId); } catch { /* the next offer makes its card */ }
    this.prune();
    this.startTick();
  }

  /** Retention: settled sends' frozen bytes after 30 days and their records after 180 (EmailStore.pruneSettledSends), cached events after
   *  EMAIL_EVENT_KEEP_MS; open sends are never touched. Bounded per pass; never throws. */
  prune(): { payloads: number; rows: number; events: number } | null {
    const services = this.services();
    if (!services) return null;
    try {
      const now = (this.options.now ?? Date.now)();
      const sends = services.store.pruneSettledSends(now, undefined, undefined, EMAIL_PRUNE_BATCH);
      return { ...sends, events: services.store.pruneEvents(now - EMAIL_EVENT_KEEP_MS, EMAIL_PRUNE_BATCH) };
    } catch (error) {
      this.options.log?.(`[email] prune: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  private startTick(): void {
    if (this.timer || !this.enabled()) return;
    // 5.1: the one long-poll of this install (it idles while no binding can receive)
    this.services()?.events.start();
    this.timer = setInterval(() => {
      const services = this.services();
      if (!services) { this.stopTick(); return; }
      const refresh = ++this.ticks % BINDING_REFRESH_TICKS === 0;
      if (this.ticks % PRUNE_TICKS === 0) this.prune();
      void services.send.tick().then(async () => {
        await services.cards?.sweep(); services.cards?.digest();
        await services.bindings.reap();
        if (refresh) for (const row of services.store.bindings()) if (LIVE_BINDING_STATES.has(row.state)) await services.bindings.refresh(row.botId).catch(() => undefined);
      }).catch(error => this.options.log?.(`[email] tick: ${(error as Error)?.message ?? error}`));
    }, TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }
  private stopTick(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.current?.events.stop(); }
  stop(): void { this.stopTick(); }

  /** The mount (3.1, 3.2): the verdict, and on a mount the generation-bound record. Off: { mounted: false, line: null } with nothing read. */
  mount(generation: string, input: Omit<EmailMountInput, "enabled" | "binding">): EmailMountVerdict {
    if (!this.enabled()) return { mounted: false, line: null };
    let verdict: EmailMountVerdict;
    try { verdict = emailMounts({ ...input, enabled: true, binding: this.bindingState(input.bot.id) }); } catch { return { mounted: false, line: null }; }
    // G15: a revoked or expired email key unmounts the tools (the owner sees the section 8 line and Reconnect)
    if (verdict.mounted && this.keyRejected(input.bot.id)) return { mounted: false, line: KEY_HEALTH_LINES.rejected };
    if (verdict.mounted) recordEmailTurn(generation, { botId: input.bot.id, threadId: input.threadId, mode: verdict.mode, ...verdict.turn });
    return verdict;
  }

  /** One /api/internal/email/<tool> call: authorised against the record and current state, then handled. Every refusal is 403 with the
   *  fixed line, and Flux is never called for it. */
  async call(tool: string, claim: { botId: string; threadId: string; generation: string }, body: unknown, live: Omit<EmailCallLive, "enabled" | "binding">): Promise<{ status: number; body: EmailToolResult | { error: string } }> {
    try {
      if (!isEmailToolName(tool)) return { status: 404, body: { error: EMAIL_UNAVAILABLE } };
      const verdict = authorizeEmailCall(claim, tool, { ...live, enabled: () => this.enabled(), binding: botId => this.bindingState(botId) });
      if (!verdict.ok) return { status: 403, body: { error: verdict.line } };
      if (this.keyRejected(claim.botId)) return { status: 403, body: { error: EMAIL_UNAVAILABLE } };
      const services = this.services();
      if (!services) return { status: 403, body: { error: EMAIL_UNAVAILABLE } };
      const result = await services.tools.handle(tool, verdict.record, claim.generation, body);
      // 5.4: a turn that read mail marks the bot text rows it writes from here on
      if (tool === "email_read" || tool === "email_list") markTurnEmailDerived(claim.threadId);
      // 3.5: a recorded offer becomes the owner's proposal card (Murage's own record, never the bot's words)
      if (tool === "email_trust_offer") { try { services.cards?.syncTrustOffers(verdict.record.botId); } catch { /* the next boot makes it */ } }
      return { status: 200, body: result };
    } catch (error) {
      this.options.log?.(`[email] ${tool} failed: ${(error as Error)?.message ?? error}`);
      return { status: 200, body: { text: "Email could not do that this time; try again shortly.", isError: true } };
    }
  }
}

/** Stop (4.5): the stopped turn's email rows, by the same generation mapping the mount used. Never throws; off = nothing. */
export async function stopEmailForTurn(runtime: EmailRuntime, botId: string, generation: string | undefined, map: (generation: string) => number): Promise<void> {
  if (!generation || !runtime.enabled()) return;
  try { await runtime.services()?.send.stop(botId, map(generation)); } catch { /* the next tick retries withdraw_pending rows */ }
}
