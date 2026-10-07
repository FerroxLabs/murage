// Copyright 2026 Ferrox Labs
// Shape follows server/channels/slack/service.ts; the contract is WHATSAPP-DESIGN.md 2, 4, 5, 6 and 7.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WhatsApp service: link and connection state, hashed pairing, the access decision for every received
// message, one receipt ledger per chat (so a reply can never cross chats), revocation. The socket, echo and
// dedupe-by-message-id live in the bridge; this file never touches Baileys.
//
// Seams left for later batches (all injected, none reach into server/index.ts):
//   people     W5: owner self binding and the person created when the owner approves a pairing request
//   runs       W5: one ChannelRuns per chat; groups pass `notOwnerAudience` here (W6 proves it reaches startTurn)
//   authKey    W5: the credential store behind the parent-port key request (auth-key.ts)
//   wipeData   W5: within-DATA_DIR delete of the bridge directories (the safe-wipe helper)
import { createHash, randomInt, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic.ts";
import { ChannelSendError, DurableDelivery, type ChannelRuns, type DeliveryMedia, type DeliveryQuote } from "../durable-delivery.ts";
import type { ChannelTranscript } from "../../voice/channel-transcribe.ts";
import { ownedMediaFile, sweepMedia } from "./media.ts";
import { CLOUD_API_MESSAGE, CLOUD_API_NOT_AVAILABLE } from "./cloud-transport.ts";
import { checkedProvider, AuthKeyUnavailable, type AuthKeyProvider } from "./auth-key.ts";
import { decide, newPairingCode, pairingReplyText, PAIRING_MAX_PENDING, PAIRING_TTL_MS, type AccessPolicy, type GroupsPolicy, type Principal, type WhatsAppMode } from "./core/access.ts";
import type { LinkState } from "./core/close-decision.ts";
import { createEchoLedger, parseOutboundJournal } from "./core/echo.ts";
import { canonicalJid, jidKind, maskNumber, normalizeIdentifier, parseAllowList, type LidMapping } from "./core/lid.ts";
import type { BridgeOptions } from "./core/protocol.ts";
import { normalizeWhatsAppMessage, whatsappBindingSchema, whatsappPrompt, type WhatsAppBinding } from "./event.ts";
import type { HealthEvent, LinkEvent, StatusNote, WhatsAppTransport } from "./transport.ts";

/** What the owner has configured; read live so a settings change is seen without rebuilding the service. */
export interface WhatsAppSettings {
  mode: WhatsAppMode;
  /** E.164 numbers (or LID identifiers) the owner approved. */
  allowFrom: readonly string[];
  groups: GroupsPolicy;
  readReceipts: boolean;
  quoteReplies: "off" | "groups" | "all";
}

export interface TransportContext {
  connectionId: string;
  mode: WhatsAppMode;
  bridgeOptions: BridgeOptions;
  /** Called by the bridge host on every spawn. Fails closed. */
  getAuthKey: () => Promise<string>;
  initExtras: () => { lastGoodWebVersion?: [number, number, number]; lastSeenAtMs?: number; retainedBinding?: boolean };
}

/** Why a ledger exists: it decides who the run is for. */
export interface ChatContext {
  binding: WhatsAppBinding;
  chatKey: string;
  chatJid: string;
  /** `pairing` chats hold the single pairing reply and can never start a run. */
  role: "owner" | "contact" | "group" | "pairing";
  conversationKey: string;
  principal: Principal;
  /** The human the turn is about: the linked number, a contact's id, or the group JID. */
  userId: string;
  /** True for everyone except the linked number. W6 forwards it into `startTurn`. */
  notOwnerAudience: boolean;
  /** Bumped whenever allowFrom, the group list or the mode changes; the run factory can compare it at enqueue. */
  accessRevision: number;
  /** Live: is this chat still allowed by the owner's current settings? The run factory checks it at every enqueue, so a removed contact or disabled group cannot start a task from a ledger that has not been drained yet. Unlike `accessRevision` it never goes stale for a chat that survived a settings change. */
  allowed: () => boolean;
  name?: string;
}

export interface WhatsAppPeople {
  /** The linked number becomes the workspace owner's self binding (W5 mints the owner ticket). */
  linkOwner?(binding: WhatsAppBinding): Promise<void> | void;
  /** Approval creates, or links to `personId`, a NON-owner person for this sender. Must never link the owner. */
  linkContact(input: { binding: WhatsAppBinding; userId: string; senderJid: string; name?: string; personId?: string }): Promise<{ personId: string }>;
  /** The owner enabled this group: create its guest principal (idempotent). Participants are never linked by this. */
  enableGroup?(input: { binding: WhatsAppBinding; groupJid: string; name?: string }): void;
  /** Display and People list only; never the turn's principal. */
  observe?(input: { binding: WhatsAppBinding; userId: string; name?: string; displayPn?: string; groupJid?: string }): void;
}

export interface WhatsAppOptions {
  dataDir: string;
  chosen: { chiefBotId: string };
  settings: () => WhatsAppSettings;
  transport: (context: TransportContext) => WhatsAppTransport;
  /** Which backend `transport` builds (config.whatsapp.backend). "cloud-api" is the later official route: it refuses with a clear state and changes nothing on disk (cloud-transport.ts). */
  backend?: () => "linked-device" | "cloud-api";
  authKey: AuthKeyProvider;
  isCurrentChief: (botId: string) => boolean;
  runs: (context: ChatContext) => ChannelRuns;
  /** Cancels every unfinished run of the connection, or only the listed run ids. */
  revokeRuns: (connectionId: string, runIds?: string[]) => Promise<void>;
  people: WhatsAppPeople;
  /** Removes bridge directories (`auth`, `ingress`, `outbound`, `media`) and, for `all`, the connection's receipt ledgers. */
  wipeData: (connectionId: string, scope: "auth" | "all") => Promise<void>;
  /**
   * Speech to text for a voice note (design 5.6). Production wires `transcribeChannelClip`, which shares the push-to-talk
   * route's container list, clip cap and process-wide budget. Absent: a voice note gets one reply saying transcription
   * needs to be turned on in Murage.
   */
  transcribeVoice?: (clip: { bytes: Uint8Array; mime: string }) => Promise<ChannelTranscript>;
  /** Persists an approved number into allowFrom (config is owned by W5). */
  addAllowFrom: (entry: string) => Promise<void> | void;
  now?: () => number;
  /** Retries and timers for tests. */
  random?: (maxExclusive: number) => number;
}

const pairingEntry = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite(), createdAt: z.number().finite(), chatKey: z.string().regex(/^[a-f0-9]{24}$/),
  userId: z.string().min(1).max(200), senderJid: z.string().min(1).max(200), name: z.string().max(80).optional(),
}).strict();
const connectionSchema = z.object({
  version: z.literal(1), chiefBotId: z.string().min(1).max(180), enabled: z.boolean(), paused: z.boolean(),
  connectionId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9-]+$/),
  binding: whatsappBindingSchema.nullable(), pairing: z.array(pairingEntry).max(PAIRING_MAX_PENDING),
  lastSeenAt: z.number().finite().optional(), lastGoodWebVersion: z.tuple([z.number().int(), z.number().int(), z.number().int()]).optional(),
}).strict().superRefine((c, ctx) => {
  if (c.binding && (c.binding.connectionId !== c.connectionId || c.binding.chiefBotId !== c.chiefBotId)) ctx.addIssue({ code: "custom", message: "WhatsApp binding mismatch" });
});
type Connection = z.infer<typeof connectionSchema>;

const chatEntry = z.object({
  jid: z.string().min(1).max(200), kind: z.enum(["self", "dm", "group"]), conversationKey: z.string().min(1).max(260),
  userId: z.string().min(1).max(200), name: z.string().max(120).optional(), pn: z.string().max(200).optional(),
  state: z.enum(["active", "pairing", "dismissed"]), replyJid: z.string().max(200).optional(), aliases: z.array(z.string().max(200)).optional(),
}).strict();
const chatsSchema = z.object({ version: z.literal(1), chats: z.record(z.string().regex(/^[a-f0-9]{24}$/), chatEntry) }).strict();
type ChatEntry = z.infer<typeof chatEntry>;
const MAX_CHATS = 250;
const CHATS_FILE_MAX = 64 * 1024;
const CONNECTION_FILE_MAX = 16384;
const MAX_UNFINISHED = 200;
const ADMISSION_WINDOW_MS = 7 * 86_400_000;
const LINK_SECRET_VISIBLE_MS = 60_000;
const VOICE_CLIP_MAX_BYTES = 4 * 1024 * 1024;
const MEDIA_SWEEP_EVERY_MS = 6 * 60 * 60_000;
const VOICE_HINT_EVERY_MS = 60 * 60_000;

/** The sentences a voice note can earn instead of a task. Plain, no blame, no mention of money. */
export const VOICE_REPLIES = {
  unconfigured: "Voice notes need transcription turned on in Murage. Turn it on in Settings, or send this as text.",
  busy: "Murage is still working on another voice note. Send this one again in a moment.",
  unreadable: "I could not read that voice note. Voice notes work up to about two minutes. You can send it again or type it.",
} as const;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const chatKeyOf = (jid: string): string => digest(canonicalJid(jid)).slice(0, 24);

export type ServiceState = LinkState | "verifying";

/** The sync half of the access test: is this stored chat still allowed by the owner's current settings? */
function stillAllowed(entry: ChatEntry, settings: WhatsAppSettings): boolean {
  if (entry.state === "dismissed") return false;
  if (entry.state === "pairing" || entry.kind === "self") return true;
  if (entry.kind === "group") return settings.groups.policy === "allowlist" && settings.groups.allow.some(g => canonicalJid(g.jid) === canonicalJid(entry.jid));
  if (settings.mode !== "contacts") return false;
  const allowed = parseAllowList(settings.allowFrom); allowed.delete("*");
  return [entry.pn, entry.userId.startsWith("lid:") ? entry.userId.slice(4) : entry.userId, entry.jid]
    .some(candidate => candidate !== undefined && allowed.has(normalizeIdentifier(candidate)));
}

const settingsKey = (s: WhatsAppSettings): string => JSON.stringify({ m: s.mode, a: [...parseAllowList(s.allowFrom)].sort(), p: s.groups.policy, s: s.groups.senders,
  g: s.groups.allow.map(x => [canonicalJid(x.jid), x.activation]).sort() });

export class WhatsAppService {
  private connection?: Connection;
  private transport?: WhatsAppTransport;
  private chats = new Map<string, ChatEntry>();
  private ledgers = new Map<string, DurableDelivery>();
  private generation = 0;
  private live = false;
  private authorised = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryFailures = 0;
  private state: ServiceState = "idle";
  private error: string | null = null;
  private blockedReason: string | null = null;
  private nextRetryAt: number | null = null;
  private connecting = false;
  private qr: { text: string; version: number; issuedAt: number } | null = null;
  private pairingCode: { code: string; phone: string; issuedAt: number } | null = null;
  private runningMode: WhatsAppMode | null = null;
  private runningOptions = "";
  private connectedAt?: number;
  private catchUpWatermark?: number;
  private revision = 1;
  private accessKey: string;
  private notes = { ingressWriteFailed: false, catchUpTruncated: false };
  private voiceInFlight = new Set<string>();
  private voiceHintAt = new Map<string, number>();
  private mediaSweptAt = 0;
  private options: WhatsAppOptions;

  constructor(options: WhatsAppOptions) {
    this.options = options;
    this.accessKey = settingsKey(options.settings());
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private file() { return join(this.options.dataDir, "channels", "whatsapp", "connection.json"); }
  private chatsFile(connectionId: string) { return join(this.options.dataDir, "channels", "whatsapp", connectionId, "chats.json"); }

  // -- files ------------------------------------------------------------------------------------------------

  private checked(path: string, max: number): void {
    try {
      const s = lstatSync(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) throw new Error("Invalid WhatsApp data file");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  private save(next: Connection): void {
    const valid = connectionSchema.parse(next);
    mkdirSync(join(this.options.dataDir, "channels", "whatsapp"), { recursive: true, mode: 0o700 });
    this.checked(this.file(), CONNECTION_FILE_MAX);
    const bytes = JSON.stringify(valid);
    if (Buffer.byteLength(bytes) > CONNECTION_FILE_MAX) throw new Error("WhatsApp connection data is too large");
    writeFileAtomic(this.file(), bytes, { mode: 0o600 });
    this.connection = valid;
  }
  private read(): Connection | undefined {
    this.checked(this.file(), CONNECTION_FILE_MAX);
    try { return connectionSchema.parse(JSON.parse(readFileSync(this.file(), "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("WhatsApp connection data needs recovery; original data preserved."); }
  }
  private saveChats(): void {
    const connection = this.connection!;
    const file = this.chatsFile(connection.connectionId);
    const bytes = JSON.stringify(chatsSchema.parse({ version: 1, chats: Object.fromEntries(this.chats) }));
    if (Buffer.byteLength(bytes) > CHATS_FILE_MAX) throw new Error("WhatsApp chat list is full");
    mkdirSync(join(this.options.dataDir, "channels", "whatsapp", connection.connectionId), { recursive: true, mode: 0o700 });
    this.checked(file, CHATS_FILE_MAX);
    writeFileAtomic(file, bytes, { mode: 0o600 });
  }
  private loadChats(connectionId: string): void {
    this.chats.clear();
    const file = this.chatsFile(connectionId);
    this.checked(file, CHATS_FILE_MAX);
    try {
      const parsed = chatsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      for (const [key, entry] of Object.entries(parsed.chats)) this.chats.set(key, entry);
      this.consolidateChats(connectionId);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("WhatsApp chat list needs recovery; original data preserved."); }
  }

  private consolidateChats(connectionId: string): void {
    const before = JSON.stringify(Object.fromEntries(this.chats));
    const formsOf = (entry: ChatEntry) => new Set([entry.jid, ...(entry.aliases ?? []), ...(entry.pn ? [entry.pn] : []),
      ...(entry.kind === "dm" && jidKind(entry.userId) === "pn" ? [entry.userId] : []),
      ...(entry.kind === "self" ? this.ownerRecipients() : [])].map(canonicalJid));
    const remaining = new Map(this.chats);
    const merged = new Map<string, ChatEntry>();
    const keys = new Map<string, string>();
    const ledger = (key: string, jid: string) => ({ file: join(this.options.dataDir, "channels", "whatsapp", connectionId, `${key}.json`),
      bindingKey: digest(JSON.stringify({ c: connectionId, j: canonicalJid(jid) })), recipient: jid });
    while (remaining.size) {
      const [firstKey, first] = remaining.entries().next().value!;
      const members = new Map([[firstKey, first]]), forms = formsOf(first);
      remaining.delete(firstKey);
      let added = true;
      while (added) {
        added = false;
        for (const [key, entry] of remaining) if ([...formsOf(entry)].some(jid => forms.has(jid))) {
          if (entry.kind !== first.kind || entry.userId !== first.userId || entry.conversationKey !== first.conversationKey || entry.state !== first.state) throw new Error("WhatsApp alias audience mismatch");
          members.set(key, entry); remaining.delete(key);
          for (const jid of formsOf(entry)) forms.add(jid);
          added = true;
        }
      }
      const identity = (first.kind === "self" ? this.ownerRecipients()[0] : undefined) ?? [...forms].find(jid => jidKind(jid) === "pn") ?? canonicalJid(first.jid);
      const key = chatKeyOf(identity);
      DurableDelivery.consolidate(ledger(key, identity), [...members].map(([k, entry]) => ledger(k, entry.jid)), id => {
        for (const alias of forms) if (id.startsWith(`${alias}:`)) return `${identity}:${id.slice(alias.length + 1)}`;
        return id;
      }, this.now());
      for (const alias of forms) keys.set(chatKeyOf(alias), key);
      for (const member of members.keys()) keys.set(member, key);
      merged.set(key, { ...first, jid: identity, aliases: [...forms] });
    }
    const connection = this.connection!;
    const pairing = connection.pairing.map(p => ({ ...p, chatKey: keys.get(p.chatKey) ?? p.chatKey }));
    // Ledgers first, references second, chats last. Old chats can reconstruct the same mapping on retry.
    if (pairing.some((p, i) => p.chatKey !== connection.pairing[i].chatKey)) this.save({ ...connection, pairing });
    this.chats = merged;
    if (JSON.stringify(Object.fromEntries(this.chats)) !== before) this.saveChats();
  }

  // -- reads --------------------------------------------------------------------------------------------------

  /** The linked number and its LID: a message there is never to "someone new" (server/stop-line.ts). */
  ownerRecipients(): string[] {
    const b = this.connection?.binding;
    return b ? [b.linkedPn, ...(b.linkedLid ? [b.linkedLid] : [])] : [];
  }

  status() {
    const totals = { pending: 0, uncertain: 0, rejected: 0, needsReview: 0 };
    for (const ledger of this.ledgers.values()) {
      const s = ledger.status();
      totals.pending += s.pending; totals.uncertain += s.uncertain; totals.rejected += s.rejected; totals.needsReview += s.needsReview;
    }
    const now = this.now();
    return {
      state: this.state, linked: Boolean(this.connection?.binding), enabled: this.live, error: this.error, blockedReason: this.blockedReason,
      nextRetryAt: this.nextRetryAt, accessRevision: this.revision, ...totals,
      // QR text and pairing codes exist only while linking, are shown briefly, and are never written down (design 2.2, 2.3).
      ...(this.state === "linking" && this.qr ? { qr: this.qr } : {}),
      ...(this.state === "linking" && this.pairingCode && now - this.pairingCode.issuedAt < LINK_SECRET_VISIBLE_MS ? { pairingCode: { code: this.pairingCode.code, phone: this.pairingCode.phone } } : {}),
      pairing: (this.connection?.pairing ?? []).filter(p => p.expiresAt > now)
        .map(p => ({ id: p.hash.slice(0, 12), name: p.name ?? null, number: maskNumber(p.senderJid), expiresAt: p.expiresAt })),
      ingressWriteFailed: this.notes.ingressWriteFailed, catchUpTruncated: this.notes.catchUpTruncated,
    };
  }

  /** The cached group list is the transport's; the picker lives in W6/W7. */
  async groups(): Promise<Array<{ jid: string; name: string }>> {
    if (!this.transport?.groups) return [];
    return this.transport.groups();
  }

  isCurrent(binding: WhatsAppBinding, accessRevision?: number): boolean {
    return this.authorised && this.connection?.enabled === true && !this.connection.paused &&
      this.connection.binding?.connectionId === binding.connectionId &&
      JSON.stringify(this.connection.binding) === JSON.stringify(binding) && this.options.isCurrentChief(binding.chiefBotId) &&
      (accessRevision === undefined || accessRevision === this.revision);
  }

  // -- link and resume ------------------------------------------------------------------------------------------

  private context(connectionId: string): TransportContext {
    const settings = this.options.settings();
    return {
      connectionId, mode: settings.mode, bridgeOptions: { readReceipts: settings.readReceipts, quoteReplies: settings.quoteReplies, access: { allowFrom: [...settings.allowFrom], groups: settings.groups } },
      getAuthKey: async () => {
        try { return await checkedProvider(this.options.authKey)(); }
        catch (e) {
          if (e instanceof AuthKeyUnavailable) { this.state = "blocked"; this.blockedReason = e.reason; this.error = e.reason; }
          throw e;
        }
      },
      initExtras: () => ({ retainedBinding: !!this.connection?.binding, ...(this.connection?.lastGoodWebVersion ? { lastGoodWebVersion: this.connection.lastGoodWebVersion } : {}),
        ...(this.connection?.lastSeenAt !== undefined ? { lastSeenAtMs: this.connection.lastSeenAt } : {}) }),
    };
  }

  /** Starts linking with a QR (default) or an 8 character pairing code. From `connected` the answer is "unlink first" (design 2.5). */
  async link(input: { method: "qr" | "code"; phone?: string }): Promise<void> {
    if (this.connecting) throw new Error("WhatsApp is busy; try again in a moment.");
    if (this.options.backend?.() === "cloud-api") { this.refuseCloud(); throw new Error(CLOUD_API_MESSAGE); }
    if (!this.options.isCurrentChief(this.options.chosen.chiefBotId)) throw new Error("WhatsApp links only with the current Chief.");
    const phone = input.method === "code" ? (input.phone ?? "").replace(/[^\d]/g, "") : undefined;
    if (input.method === "code" && (!phone || phone.length < 8 || phone.length > 15)) throw new Error("Enter the phone number with its country code.");
    const saved = this.read();
    // Design 2.5: a dead or blocked session may be relinked; anything still alive, or saved but not running, must be unlinked first.
    // This refusal changes nothing: a live connection stays live.
    if (saved?.binding && !["logged-out", "conflict", "blocked", "linking"].includes(this.state)) throw new Error("WhatsApp is already linked. Unlink it first.");
    const generation = ++this.generation; this.connecting = true;
    try {
      await this.releaseTransport();
      const connectionId = saved?.connectionId ?? randomUUID();
      // A dead or unreadable session is wiped before a fresh link.
      if (saved) await this.options.wipeData(connectionId, "auth");
      this.save({ version: 1, chiefBotId: this.options.chosen.chiefBotId, enabled: true, paused: false, connectionId,
        binding: saved?.binding ?? null, pairing: saved?.pairing ?? [],
        ...(saved?.lastSeenAt !== undefined ? { lastSeenAt: saved.lastSeenAt } : {}),
        ...(saved?.lastGoodWebVersion ? { lastGoodWebVersion: saved.lastGoodWebVersion } : {}) });
      this.state = "linking"; this.error = null; this.blockedReason = null; this.qr = null; this.pairingCode = null;
      this.live = true; this.authorised = true;
      if (saved?.binding) { this.loadChats(connectionId); this.openLedgers(saved.binding); }
      await this.startTransport(generation);
      if (generation !== this.generation) return;
      await this.transport!.link({ method: input.method, ...(phone ? { phone } : {}) });
    } catch {
      if (generation === this.generation) { this.live = false; this.authorised = false; this.state = "blocked"; this.error = "link-failed"; }
      throw new Error("WhatsApp linking could not start");
    } finally { this.connecting = false; if (generation === this.generation && this.live) await this.applySettings(); }
  }

  /** The official route is not built yet. Say so; start nothing, wipe nothing, save nothing. */
  private refuseCloud(): void {
    this.state = "blocked"; this.blockedReason = null; this.error = CLOUD_API_NOT_AVAILABLE;
  }

  /** Brings the saved connection back without a QR (server boot, Chief unchanged). */
  async resume(): Promise<void> {
    if (this.connecting || this.live) return;
    if (this.options.backend?.() === "cloud-api") { this.refuseCloud(); return; }
    const generation = ++this.generation; this.connecting = true; this.state = "verifying";
    try {
      await this.releaseTransport();
      const saved = this.read(); this.connection = saved;
      if (!saved?.enabled) { this.state = "idle"; return; }
      if (saved.paused || saved.chiefBotId !== this.options.chosen.chiefBotId || !this.options.isCurrentChief(saved.chiefBotId)) { await this.pause(); return; }
      if (!saved.binding) { this.state = "idle"; this.error = "link-required"; return; }
      this.loadChats(saved.connectionId);
      this.live = true; this.authorised = true; this.error = null;
      this.openLedgers(saved.binding);
      await this.startTransport(generation);
    } catch (e) {
      if (generation === this.generation) {
        this.live = false;
        if (e instanceof AuthKeyUnavailable) { this.authorised = false; this.state = "blocked"; this.blockedReason = e.reason; this.error = e.reason; }
        else if (e instanceof ChannelSendError && ["unavailable", "offline", "timeout", "rate-limit"].includes(e.code)) this.retry();
        else { this.authorised = false; this.state = "blocked"; this.error = "connection-recovery-required"; }
      }
    } finally { this.connecting = false; if (generation === this.generation && this.live) await this.applySettings(); }
  }

  private async startTransport(generation: number): Promise<void> {
    const connection = this.connection!;
    const context = this.context(connection.connectionId);
    this.runningMode = context.mode;
    this.runningOptions = JSON.stringify(context.bridgeOptions);
    this.catchUpWatermark = connection.lastSeenAt ?? this.now();
    const transport = this.options.transport(context);
    this.transport = transport;
    transport.onLink(event => { if (generation === this.generation) this.onLink(event); });
    await transport.start({
      onEnvelope: (envelope, ack) => { void this.receive(envelope, ack, generation).catch(() => { if (generation === this.generation) this.error = "intake-failed"; }); },
      onHealth: event => { if (generation === this.generation) void this.onHealth(event).catch(() => { this.error = "health-failed"; }); },
      onNote: note => { if (generation === this.generation) this.onNote(note); },
    });
    if (generation !== this.generation) { await transport.stop(); return; }
    this.schedule(generation);
  }

  private onLink(event: LinkEvent): void {
    if (event.kind === "qr") { this.qr = { text: event.text, version: event.version, issuedAt: event.issuedAt }; this.pairingCode = null; }
    else this.pairingCode = { code: event.code, phone: event.phone, issuedAt: this.now() };
  }

  private onNote(note: StatusNote): void {
    if (note.kind === "admitted") { this.touchLastSeen(note.at); return; }
    if (note.kind === "ingress-write-failed") { this.notes.ingressWriteFailed = true; this.error = "ingress-write-failed"; }
    else if (note.kind === "catch-up-truncated") this.notes.catchUpTruncated = true;
    else this.error = "bridge-fatal";
  }

  private async onHealth(event: HealthEvent): Promise<void> {
    // Socket-open time is not a receipt watermark.
    if (event.webVersion && this.connection) { try { this.save({ ...this.connection, lastGoodWebVersion: event.webVersion }); } catch { this.error = "state-write-failed"; } }
    this.state = event.state;
    if (event.state === "connected") {
      this.qr = null; this.pairingCode = null; this.error = null; this.blockedReason = null; this.retryFailures = 0; this.nextRetryAt = null;
      this.connectedAt ??= this.now();
      if (event.self) await this.onConnected(event.self);
      if (!this.connecting) await this.applySettings();
    } else if (event.state === "retry") {
      this.nextRetryAt = event.retryInMs !== undefined ? this.now() + event.retryInMs : null;
    } else if (event.state === "blocked") {
      this.blockedReason = event.blockedReason ?? null; this.error = event.blockedReason ?? "blocked";
    } else if (event.state === "logged-out" || event.state === "conflict") {
      this.error = event.state; this.qr = null; this.pairingCode = null;
    }
  }

  private async onConnected(self: { pn: string; lid?: string }): Promise<void> {
    const c = this.connection;
    if (!c) return;
    if (!this.options.isCurrentChief(c.chiefBotId)) { await this.pause(); return; }
    const pn = canonicalJid(self.pn);
    if (c.binding) {
      if (canonicalJid(c.binding.linkedPn) !== pn) {
        // A different phone answered the link. The saved bindings and people belong to the old number.
        this.authorised = false; this.state = "blocked"; this.blockedReason = null; this.error = "identity-mismatch"; return;
      }
      return;
    }
    const binding = whatsappBindingSchema.parse({ connectionId: c.connectionId, linkedPn: pn, ...(self.lid ? { linkedLid: canonicalJid(self.lid) } : {}), chiefBotId: c.chiefBotId });
    this.save({ ...c, binding });
    try { await this.options.people.linkOwner?.(binding); }
    catch { this.authorised = false; this.state = "blocked"; this.error = "owner-link-failed"; return; }
    this.loadChats(c.connectionId);
    this.ensureGroupGuests();
    this.openLedgers(binding);
  }

  private touchLastSeen(at: number): void {
    if (!this.connection || at <= (this.connection.lastSeenAt ?? 0)) return;
    try { this.save({ ...this.connection, lastSeenAt: at }); } catch { this.error = "state-write-failed"; }
  }

  // -- access settings ------------------------------------------------------------------------------------------

  /** Creates the guest principal of every enabled group. Idempotent; a failure surfaces as an error and the group simply cannot run yet. */
  private ensureGroupGuests(): void {
    const binding = this.connection?.binding, settings = this.options.settings();
    if (!binding || !this.options.people.enableGroup || settings.groups.policy !== "allowlist") return;
    for (const g of settings.groups.allow) {
      try { this.options.people.enableGroup({ binding, groupJid: canonicalJid(g.jid), ...(g.name ? { name: g.name } : {}) }); }
      catch { this.error = "group-guest-failed"; }
    }
  }

  /** Call when config changes. Bumps `accessRevision` and revokes the chats the owner just removed. */
  async applySettings(restartOnModeChange = true): Promise<void> {
    const settings = this.options.settings();
    this.ensureGroupGuests();
    const key = settingsKey(settings);
    if (key !== this.accessKey) {
      this.accessKey = key; this.revision++;
      const runIds: string[] = [];
      for (const [chatKey, entry] of this.chats) {
        if (stillAllowed(entry, settings)) continue;
        for (const jid of new Set([entry.jid, entry.replyJid, ...(entry.aliases ?? [])])) if (jid) this.transport?.revoke?.(jid);
        const ledger = this.ledgers.get(chatKey);
        if (!ledger) continue;
        runIds.push(...ledger.pendingRunIds());
        try { ledger.revoke(); } catch { this.error = "revoke-recovery-required"; }
        this.ledgers.delete(chatKey);
      }
      if (runIds.length && this.connection?.binding) await this.options.revokeRuns(this.connection.binding.connectionId, runIds);
    }
    // Bridge-owned access and message options take effect together on a fresh initialization.
    if (restartOnModeChange && this.runningMode !== null && (this.runningMode !== settings.mode || this.runningOptions !== JSON.stringify(this.context(this.connection!.connectionId).bridgeOptions)) && this.live && !this.connecting && this.connection?.binding) { await this.stopLive(); await this.resume(); }
  }

  // -- chats and ledgers --------------------------------------------------------------------------------------------

  private contextFor(binding: WhatsAppBinding, chatKey: string, entry: ChatEntry): ChatContext {
    const role: ChatContext["role"] = entry.state === "pairing" ? "pairing" : entry.kind === "self" ? "owner" : entry.kind === "group" ? "group" : "contact";
    const principal: Principal = role === "owner" ? { kind: "owner-self" } : role === "group" ? { kind: "group-guest", groupJid: entry.jid } : { kind: "sender", userId: entry.userId };
    return { binding, chatKey, chatJid: entry.jid, role, conversationKey: entry.conversationKey, principal, userId: entry.userId,
      notOwnerAudience: role !== "owner", accessRevision: this.revision, ...(entry.name ? { name: entry.name } : {}),
      allowed: () => { const latest = this.chats.get(chatKey); return this.live && latest === entry && stillAllowed(latest, this.options.settings()); } };
  }

  private openLedgers(binding: WhatsAppBinding): void {
    for (const [chatKey, entry] of this.chats) if (!this.ledgers.has(chatKey) && entry.state !== "dismissed") this.makeLedger(binding, chatKey, entry);
  }

  private makeLedger(binding: WhatsAppBinding, chatKey: string, entry: ChatEntry): DurableDelivery {
    const context = this.contextFor(binding, chatKey, entry);
    const current = () => {
      const latest = this.chats.get(chatKey);
      return this.live && this.isCurrent(binding) && latest === entry && stillAllowed(latest, this.options.settings());
    };
    const runs: ChannelRuns = context.role === "pairing"
      ? { enqueue: () => { throw new Error("A pairing chat never starts a task"); }, result: () => null }
      : this.options.runs(context);
    const receiptRuns = { ...runs, enqueue: (input: Parameters<ChannelRuns["enqueue"]>[0]) => {
      // A migrated accepted receipt may already have a run under its original chat key.
      const origin = entry.aliases?.find(jid => input.deliveryId.startsWith(`${jid}:`));
      const originalKey = origin ? chatKeyOf(origin) : chatKey;
      return originalKey !== chatKey && context.role !== "pairing"
        ? this.options.runs({ ...context, chatKey: originalKey }).enqueue(input) : runs.enqueue(input);
    } };
    const ledger = new DurableDelivery({
      file: join(this.options.dataDir, "channels", "whatsapp", binding.connectionId, `${chatKey}.json`),
      bindingKey: digest(JSON.stringify({ c: binding.connectionId, j: canonicalJid(entry.jid) })), recipient: entry.jid,
      isCurrent: current, runs: receiptRuns, now: this.options.now, maxResponse: 20_000, clearResponseOnSettle: context.role === "pairing",
      reserve: async ({ recipient, text }) => {
        if (!current() || !this.transport) throw new ChannelSendError("forbidden", false);
        return (await this.transport.reserve({ chatId: this.chats.get(chatKey)?.replyJid ?? recipient, text })).ids;
      },
      send: async ({ recipient, text, signal, reserved, quote }) => {
        if (!current() || !this.transport) throw new ChannelSendError("forbidden", false);
        if (!reserved?.length) throw new ChannelSendError("unavailable", false);
        const sent = await this.transport.sendText({ chatId: this.chats.get(chatKey)?.replyJid ?? recipient, text, ids: reserved, signal,
          ...(quote ? { quote: { remoteJid: quote.remoteJid ?? recipient, id: quote.id, ...(quote.fromMe !== undefined ? { fromMe: quote.fromMe } : {}),
            ...(quote.participant ? { participant: quote.participant } : {}), ...(quote.text ? { text: quote.text } : {}) } } : {}) });
        const last = sent.ids.at(-1);
        if (!last) throw new ChannelSendError("invalid-request", true);
        return { recipient, messageId: last };
      },
      // A voice note the bot made goes out after its text reply. Murage's voices produce mp3 or wav, with no Opus encoder
      // here, so those arrive as audio messages (a file with a play button), not as voice bubbles; only an Ogg clip is
      // sent as a bubble (bridge.ts). The ledger treats a failed note as best effort: it is still in the Murage chat.
      sendAudio: async ({ recipient, name, mime, bytes, signal }) => {
        if (!current() || !this.transport?.sendAudio || !this.transport.reserveAudio) throw new ChannelSendError("unavailable", false);
        const replyJid = this.chats.get(chatKey)?.replyJid ?? recipient;
        const { ids } = await this.transport.reserveAudio(replyJid);
        await this.transport.sendAudio({ chatId: replyJid, name, mime, bytes, ids, signal });
      },
    });
    this.ledgers.set(chatKey, ledger);
    return ledger;
  }

  private unfinished(): number {
    let n = 0;
    for (const ledger of this.ledgers.values()) { const s = ledger.status(); n += s.pending + s.uncertain + s.needsReview; }
    return n;
  }

  // -- inbound ---------------------------------------------------------------------------------------------------

  private async receive(raw: unknown, ack: () => Promise<void>, generation: number): Promise<void> {
    if (generation !== this.generation || !this.live || !this.connection) return;
    const c = this.connection;
    if (!this.options.isCurrentChief(c.chiefBotId)) { await this.pause(); return; }
    const binding = c.binding;
    if (!binding) { await ack(); return; }
    await this.applySettings(false);
    const started = this.now();
    const message = normalizeWhatsAppMessage(raw);
    if (message && !message.candidate.chatJidAlt && message.chatKind !== "group") {
      const known = [...this.chats.values()].find(entry => [entry.jid, ...(entry.aliases ?? [])].includes(canonicalJid(message.chatJid)));
      const alt = known && [known.jid, ...(known.aliases ?? [])].find(jid => jid !== canonicalJid(message.chatJid));
      if (alt) message.candidate.chatJidAlt = alt;
    }
    if (!message) { await ack(); return; }
    const settings = this.options.settings();
    const known = new Set([...this.chats.values()].map(e => e.userId).filter(id => id.startsWith("lid:")));
    // Reopen the same durable outbound ledger for echo classification and group reply activation.
    let records;
    try {
      const file = join(this.options.dataDir, "whatsapp", "outbound", `${c.connectionId}.json`);
      this.checked(file, 4 * 1024 * 1024);
      records = parseOutboundJournal(JSON.parse(readFileSync(file, "utf8")));
    }
    catch { this.error = "outbound-recovery-required"; return; }
    const echo = createEchoLedger({ generateId: () => { throw new Error("Bridge reserves ids"); }, initial: records, now: () => this.now() });
    const policy: AccessPolicy = { mode: settings.mode, self: { pn: binding.linkedPn, ...(binding.linkedLid ? { lid: binding.linkedLid } : {}) },
      allowFrom: settings.allowFrom, echo, nowMs: started, groups: settings.groups, knownUserIds: known,
      ...(this.catchUpWatermark !== undefined ? { lastSeenAtMs: this.catchUpWatermark } : {}), connectedAtMs: this.connectedAtMs() };
    const forms = new Set([canonicalJid(message.chatJid), ...(message.candidate.chatJidAlt ? [canonicalJid(message.candidate.chatJidAlt)] : [])]);
    const resolveAlias = async (op: keyof LidMapping, jid: string) => {
      const alias = await this.transport?.resolve[op](jid);
      if (message.chatKind !== "group" && alias) { forms.add(canonicalJid(jid)); forms.add(canonicalJid(alias)); }
      return alias;
    };
    const result = await decide(message.candidate, policy, { pnForLid: jid => resolveAlias("pnForLid", jid), lidForPn: jid => resolveAlias("lidForPn", jid) });
    if (generation !== this.generation || !this.live) return;
    if (result.decision === "drop") { await ack(); return; }
    if (result.decision === "accept" && result.role === "owner") {
      forms.add(canonicalJid(binding.linkedPn));
      if (binding.linkedLid) forms.add(canonicalJid(binding.linkedLid));
    }
    if (message.occurredAt < started - ADMISSION_WINDOW_MS) { await ack(); return; }
    const occurredAt = Math.min(message.occurredAt, started + 60_000);

    if (result.decision === "pair") {
      await this.handlePairing(binding, message.chatJid, result, occurredAt, ack);
      return;
    }
    const kind: ChatEntry["kind"] = result.role === "owner" ? "self" : result.role === "group" ? "group" : "dm";
    const previous = [...this.chats].find(([, chat]) => [chat.jid, ...(chat.aliases ?? [])].some(jid => forms.has(canonicalJid(jid))));
    const identity = previous?.[1].jid ?? [...forms].find(jid => jidKind(jid) === "pn") ?? canonicalJid(message.chatJid);
    const chatKey = previous?.[0] ?? chatKeyOf(identity);
    message.deliveryId = `${canonicalJid(identity)}:${message.messageId}`;
    let entry = this.chats.get(chatKey);
    const name = result.role === "group" ? this.groupName(settings, message.chatJid) : message.pushName;
    if (entry?.state === "active") {
      const stored = this.contextFor(binding, chatKey, entry);
      if (stored.role !== result.role || stored.conversationKey !== result.conversationKey ||
        JSON.stringify(stored.principal) !== JSON.stringify(result.principal) || stored.notOwnerAudience !== result.notOwnerAudience) {
        for (const jid of new Set([entry.jid, entry.replyJid, ...(entry.aliases ?? [])])) if (jid) this.transport?.revoke?.(jid);
        const ledger = this.ledgers.get(chatKey), runIds = ledger?.pendingRunIds() ?? [];
        ledger?.revoke(); this.ledgers.delete(chatKey);
        this.chats.set(chatKey, { ...entry, state: "dismissed" }); this.saveChats();
        if (runIds.length) await this.options.revokeRuns(binding.connectionId, runIds);
        this.error = "audience-mismatch"; await ack(); return;
      }
    }
    if (!entry || entry.state !== "active") {
      if (!entry && this.chats.size >= MAX_CHATS) { this.error = "chat-list-full"; return; }
      entry = { jid: identity, aliases: [...forms], kind, conversationKey: result.conversationKey, userId: result.role === "group" ? message.chatJid : result.userId,
        state: "active", ...(name ? { name: name.slice(0, 120) } : {}), ...(result.role === "contact" && result.displayPn ? { pn: result.displayPn } : {}) };
      this.chats.set(chatKey, entry);
      this.saveChats();
      this.ledgers.get(chatKey)?.stop(); this.ledgers.delete(chatKey);
    }
    entry.replyJid = message.chatJid;
    entry.aliases = [...new Set([...(entry.aliases ?? []), ...forms])];
    this.saveChats();
    if (this.unfinished() >= MAX_UNFINISHED) { this.error = "capacity"; return; }
    if (result.role !== "owner") this.options.people.observe?.({ binding, userId: result.userId, ...(message.pushName ? { name: message.pushName } : {}),
      ...(result.displayPn ? { displayPn: result.displayPn } : {}), ...(result.role === "group" ? { groupJid: message.chatJid } : {}) });
    const quote = this.quoteFor(settings, message, result.role === "group");
    try {
      const first = this.ledgers.get(chatKey) ?? this.makeLedger(binding, chatKey, entry);
      if (first.has(message.deliveryId)) { await ack(); return; }
    } catch {
      this.error = "ledger-write-failed";
      return;
    }
    // Voice notes and stored files are handled before the receipt is written, so the receipt carries the finished prompt.
    const prepared = await this.prepareMedia(binding, chatKey, message);
    if (generation !== this.generation || !this.live || this.chats.get(chatKey) !== entry || !stillAllowed(entry, this.options.settings())) return;
    if (prepared.kind === "busy") return; // the same message is already being transcribed; the bridge resends it later
    if (prepared.kind === "silent") { await ack(); return; }
    const prompt = prepared.kind === "reply" ? { prompt: "", response: prepared.text }
      : whatsappPrompt(message, { ...(name ? { groupTitle: name } : {}), ...(prepared.kind === "voice" ? { voiceTranscript: prepared.text } : {}) });
    try {
      const ledger = this.ledgers.get(chatKey) ?? this.makeLedger(binding, chatKey, entry);
      ledger.accept({ deliveryId: message.deliveryId, occurredAt, ...prompt, ...(quote ? { quote } : {}),
        ...(prepared.kind !== "reply" && prepared.media.length ? { media: prepared.media } : {}) });
    } catch {
      // The receipt could not be written. Nothing runs and nothing is acknowledged: the bridge keeps the message and sends it again.
      this.error = "ledger-write-failed";
      return;
    }
    if (prepared.kind === "voice" && message.media?.path) rmSync(message.media.path, { force: true });
    await ack();
    if (result.role === "contact" && settings.readReceipts) this.transport?.markRead?.([{ remoteJid: message.chatJid, id: message.messageId, fromMe: false }]);
    if (this.now() - started > 1000) this.error = "ack-slow";
    // Model work stays outside receipt and acknowledgement handling.
    if (generation === this.generation) queueMicrotask(() => { void this.tick().catch(() => { this.error = "delivery-failed"; }); });
  }

  /**
   * What a message's media turns into (design 5.6):
   * - a voice note: transcribed (budgeted, shared with push-to-talk), the clip deleted afterwards;
   * - an image: kept in the media directory and referenced from the receipt, so the run gets it as an attachment;
   * - any other file, sticker, video, location or contact: a placeholder in the prompt, the file kept under the same quotas;
   * - a voice note that cannot be turned into text: one fixed reply and no task.
   */
  private async prepareMedia(binding: WhatsAppBinding, chatKey: string, message: { deliveryId: string; media?: { kind: string; mime?: string; ptt?: boolean; path?: string } }):
    Promise<{ kind: "plain"; media: DeliveryMedia[] } | { kind: "voice"; text: string; media: DeliveryMedia[] } | { kind: "reply"; text: string } | { kind: "busy" } | { kind: "silent" }> {
    const m = message.media;
    if (!m) return { kind: "plain", media: [] };
    const file = ownedMediaFile(this.options.dataDir, binding.connectionId, m.path);
    if (m.kind === "audio" && m.ptt === true) {
      if (!file || file.bytes > VOICE_CLIP_MAX_BYTES) return { kind: "reply", text: VOICE_REPLIES.unreadable };
      if (!this.options.transcribeVoice) return this.voiceHint(chatKey, VOICE_REPLIES.unconfigured, file.path);
      if (this.voiceInFlight.has(message.deliveryId)) return { kind: "busy" };
      this.voiceInFlight.add(message.deliveryId);
      try {
        const bytes = readFileSync(file.path);
        const result = await this.options.transcribeVoice({ bytes, mime: (m.mime ?? "audio/ogg").split(";")[0].trim().toLowerCase() });
        if (result.ok) { return { kind: "voice", text: result.text, media: [] }; }
        if (result.reason === "unconfigured") return this.voiceHint(chatKey, VOICE_REPLIES.unconfigured, file.path);
        rmSync(file.path, { force: true });
        return { kind: "reply", text: result.reason === "busy" ? VOICE_REPLIES.busy : VOICE_REPLIES.unreadable };
      } catch {
        rmSync(file.path, { force: true });
        return { kind: "reply", text: VOICE_REPLIES.unreadable };
      } finally { this.voiceInFlight.delete(message.deliveryId); }
    }
    if (!file) return { kind: "plain", media: [] };
    return { kind: "plain", media: [{ path: file.path, mime: (m.mime ?? "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 120), bytes: file.bytes }] };
  }

  /** "Turn on transcription" is said once an hour per chat; further voice notes in that hour get no reply. */
  private voiceHint(chatKey: string, text: string, path: string): { kind: "reply"; text: string } | { kind: "silent" } {
    rmSync(path, { force: true });
    const last = this.voiceHintAt.get(chatKey);
    if (last !== undefined && this.now() - last < VOICE_HINT_EVERY_MS) return { kind: "silent" };
    this.voiceHintAt.set(chatKey, this.now());
    return { kind: "reply", text };
  }

  /** Old media goes (seven days), except files an unfinished receipt still needs. Runs on connect and every six hours. */
  private sweepMedia(): void {
    const binding = this.connection?.binding;
    if (!binding || this.now() - this.mediaSweptAt < MEDIA_SWEEP_EVERY_MS) return;
    this.mediaSweptAt = this.now();
    try {
      const keep: string[] = [];
      for (const ledger of this.ledgers.values()) keep.push(...ledger.referencedMedia());
      sweepMedia({ dataDir: this.options.dataDir, connectionId: binding.connectionId, keep, nowMs: this.now() });
    } catch { /* best effort; the next pass tries again */ }
  }

  private connectedAtMs(): number { return this.connectedAt ?? Number.NEGATIVE_INFINITY; }

  private groupName(settings: WhatsAppSettings, jid: string): string | undefined {
    return settings.groups.allow.find(g => canonicalJid(g.jid) === canonicalJid(jid))?.name;
  }

  private quoteFor(settings: WhatsAppSettings, message: { messageId: string; chatJid: string; participant?: string; fromMe: boolean; text: string }, group: boolean): DeliveryQuote | undefined {
    if (settings.quoteReplies === "off" || (settings.quoteReplies === "groups" && !group)) return undefined;
    return { id: message.messageId, remoteJid: message.chatJid, fromMe: message.fromMe, ...(message.participant ? { participant: message.participant } : {}),
      ...(message.text ? { text: message.text.slice(0, 500) } : {}) };
  }

  private async handlePairing(binding: WhatsAppBinding, chatJid: string, who: { userId: string; senderJid: string; pushName?: string }, occurredAt: number, ack: () => Promise<void>): Promise<void> {
    const c = this.connection!, now = this.now();
    const live = c.pairing.filter(p => p.expiresAt > now);
    const existing = live.find(p => p.userId === who.userId);
    if (existing || live.length >= PAIRING_MAX_PENDING || this.chats.size >= MAX_CHATS) {
      if (live.length !== c.pairing.length) this.save({ ...c, pairing: live });
      await ack(); return;
    }
    const random = this.options.random ?? (n => randomInt(n));
    let code = newPairingCode(random);
    for (let tries = 0; live.some(p => p.hash === digest(code)) && tries < 8; tries++) code = newPairingCode(random);
    const chatKey = chatKeyOf(chatJid);
    const entry: ChatEntry = { jid: chatJid, kind: "dm", conversationKey: `dm:${who.userId}`, userId: who.userId, state: "pairing",
      ...(who.pushName ? { name: who.pushName.slice(0, 80) } : {}) };
    const previous = this.chats.get(chatKey);
    if (previous?.state === "active" && (previous.kind !== "dm" || previous.userId !== who.userId)) { this.error = "audience-mismatch"; await ack(); return; }
    this.ledgers.get(chatKey)?.revoke(); this.ledgers.delete(chatKey);
    this.chats.set(chatKey, entry);
    this.save({ ...c, pairing: [...live, { hash: digest(code), expiresAt: now + PAIRING_TTL_MS, createdAt: now, chatKey, userId: who.userId, senderJid: who.senderJid,
      ...(who.pushName ? { name: who.pushName.slice(0, 80) } : {}) }] });
    this.saveChats();
    const ledger = this.ledgers.get(chatKey) ?? this.makeLedger(binding, chatKey, entry);
    ledger.accept({ deliveryId: `pair:${chatKey}:${digest(code).slice(0, 12)}`, prompt: "", response: pairingReplyText(code), occurredAt });
    await ack();
    queueMicrotask(() => { void this.tick().catch(() => { this.error = "delivery-failed"; }); });
  }

  // -- owner actions ----------------------------------------------------------------------------------------------

  /**
   * The owner approves a pairing code in Settings. The sender becomes an admissible NON-owner person in one step
   * (design 5.3): the person is linked first, then the number is allowed. Never reachable from chat text.
   */
  async approve(code: string, options: { personId?: string } = {}): Promise<{ userId: string; name?: string; personId: string }> {
    const c = this.connection;
    if (!c?.binding) throw new Error("WhatsApp is not linked.");
    const now = this.now(), wanted = digest(code.trim().toUpperCase());
    const request = c.pairing.find(p => p.hash === wanted && p.expiresAt > now);
    if (!request) throw new Error("That pairing code is not pending or has expired.");
    const { personId } = await this.options.people.linkContact({ binding: c.binding, userId: request.userId, senderJid: request.senderJid,
      ...(request.name ? { name: request.name } : {}), ...(options.personId ? { personId: options.personId } : {}) });
    await this.options.addAllowFrom(normalizeIdentifier(request.senderJid));
    this.save({ ...c, pairing: c.pairing.filter(p => p !== request && p.expiresAt > now) });
    const entry = this.chats.get(request.chatKey);
    if (entry) {
      this.chats.set(request.chatKey, { ...entry, state: "active", conversationKey: `dm:${request.userId}`,
        ...(jidKind(request.senderJid) === "pn" ? { pn: canonicalJid(request.senderJid) } : {}) });
      this.saveChats();
      // The pairing ledger could only send its one reply; the approved chat gets a ledger that can run tasks.
      this.ledgers.get(request.chatKey)?.stop(); this.ledgers.delete(request.chatKey);
      this.makeLedger(c.binding, request.chatKey, this.chats.get(request.chatKey)!);
    }
    return { userId: request.userId, ...(request.name ? { name: request.name } : {}), personId };
  }

  async dismiss(code: string): Promise<void> {
    const c = this.connection;
    if (!c) return;
    const wanted = digest(code.trim().toUpperCase());
    const request = c.pairing.find(p => p.hash === wanted);
    if (!request) return;
    this.save({ ...c, pairing: c.pairing.filter(p => p !== request) });
    const entry = this.chats.get(request.chatKey);
    if (entry?.state === "pairing") { this.chats.set(request.chatKey, { ...entry, state: "dismissed" }); this.saveChats(); this.ledgers.get(request.chatKey)?.revoke(); this.ledgers.delete(request.chatKey); }
  }

  // -- delivery loop ----------------------------------------------------------------------------------------------

  async tick(): Promise<void> {
    if (!this.live) return;
    if (!this.connection || !this.options.isCurrentChief(this.connection.chiefBotId)) { await this.pause(); return; }
    if (this.state === "connected") {
      this.sweepMedia();
    }
    for (const ledger of [...this.ledgers.values()]) await ledger.drain();
  }

  private schedule(generation: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick().catch(() => { this.error = "delivery-failed"; }).finally(() => { if (generation === this.generation && this.live) this.schedule(generation); }); }, 1000);
    this.timer.unref?.();
  }

  private retry(): void {
    if (this.state === "retry" || this.state === "blocked" || this.connection?.paused) return;
    clearTimeout(this.retryTimer);
    if (++this.retryFailures > 5) { this.state = "blocked"; this.error = "retry-limit"; return; }
    this.state = "retry"; this.nextRetryAt = this.now() + Math.min(30, 2 ** this.retryFailures) * 1000;
    const generation = this.generation;
    this.retryTimer = setTimeout(() => { if (generation === this.generation) void this.resume(); }, this.nextRetryAt - this.now());
    this.retryTimer.unref?.();
  }

  // -- stop, pause, revoke, unlink --------------------------------------------------------------------------------

  private async releaseTransport(): Promise<void> {
    const t = this.transport;
    await t?.stop();
    if (this.transport === t) this.transport = undefined;
  }

  private async stopLive(): Promise<void> {
    this.live = false; this.authorised = false; this.generation++;
    clearTimeout(this.timer); clearTimeout(this.retryTimer);
    for (const ledger of this.ledgers.values()) ledger.stop();
    this.ledgers.clear(); this.connectedAt = undefined; this.runningMode = null;
    this.state = "idle"; this.qr = null; this.pairingCode = null;
    await this.releaseTransport();
  }

  async stop(): Promise<void> { await this.stopLive(); }
  async pause(): Promise<void> { await this.disable(false); }
  async revoke(): Promise<void> { await this.disable(true); }

  /** Logs out of WhatsApp (10 s at most), stops the bridge, deletes its data and the receipt ledgers, and forgets the binding. */
  async unlink(): Promise<void> {
    const connectionId = this.connection?.connectionId ?? this.read()?.connectionId;
    let failed = false;
    try { await Promise.race([this.transport?.unlink(), new Promise<void>(resolve => { const t = setTimeout(resolve, 10_000); t.unref?.(); })]); } catch { /* the wipe below still removes the local session */ }
    await this.disable(true);
    if (connectionId) {
      try { await this.options.wipeData(connectionId, "all"); } catch { failed = true; }
      try {
        const c = this.connection ?? this.read();
        if (c) this.save({ ...c, connectionId: randomUUID(), enabled: false, paused: true, binding: null, pairing: [] });
      } catch { failed = true; }
    }
    this.chats.clear();
    if (failed) { this.state = "blocked"; this.error = "revoke-recovery-required"; throw new Error("WhatsApp unlink needs recovery; check Settings."); }
    this.state = "idle"; this.error = null;
  }

  private async disable(revoke: boolean): Promise<void> {
    let failed = false;
    for (const ledger of this.ledgers.values()) { try { ledger.revoke(); } catch { failed = true; } }
    try { await this.stopLive(); } catch { failed = true; }
    this.state = revoke ? "idle" : "blocked"; this.error = revoke ? null : "chief-changed";
    try { this.connection ??= this.read(); } catch { failed = true; }
    try { if (this.connection) this.save({ ...this.connection, ...(revoke ? { enabled: false, pairing: [] } : {}), paused: true }); } catch { failed = true; }
    try { if (this.connection?.binding) await this.options.revokeRuns(this.connection.binding.connectionId); } catch { failed = true; }
    if (failed) { this.state = "blocked"; this.error = "revoke-recovery-required"; throw new Error("WhatsApp shutdown or saved revocation needs recovery."); }
  }
}
