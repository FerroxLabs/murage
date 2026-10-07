// Copyright 2026 Ferrox Labs
// Adapted from Hermes Agent scripts/whatsapp-bridge/outbound_ids.js and owner_message_gate.js
// (MIT, Nous Research) and OpenClaw extensions/whatsapp/src/inbound/dedupe.ts (MIT, OpenClaw Foundation).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Echo and dedupe (design 5.5, 0a W2.1). Reserve-first and id-only: the outbound
// id is taken and recorded BEFORE the network send, so no crash between send and
// persistence can turn an echo into an owner turn. Classification never looks at
// message text (OpenClaw deleted its text-keyed tracker because it dropped
// legitimate repeats, 9013ab80a8a). The key carries the chat and its phone/LID
// aliases, so an echo that arrives as `@lid` finds an id reserved for `@s.whatsapp.net`.
// Group ids never match across groups.
import { canonicalJid, jidKind } from "./lid.ts";

export const SENT_RING_MAX = 5000;
export const SENT_RING_TTL_MS = 7 * 24 * 60 * 60_000;

export interface SentRingEntry { id: string; at: number }

export interface SentRing {
  remember(id: string | null | undefined, at?: number): void;
  has(id: string | null | undefined, at?: number): boolean;
  size(): number;
  /** Oldest first, expired entries already dropped. */
  snapshot(at?: number): SentRingEntry[];
}

/** Bounded FIFO of outbound message ids with a time limit. Re-remembering an id keeps its place. */
export function createSentRing(options: { max?: number; ttlMs?: number; now?: () => number; initial?: readonly SentRingEntry[] } = {}): SentRing {
  const max = options.max ?? SENT_RING_MAX;
  const ttlMs = options.ttlMs ?? SENT_RING_TTL_MS;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(max) || max < 1) throw new RangeError("createSentRing: max must be a positive integer");
  const entries = new Map<string, number>();
  const prune = (at: number) => {
    for (const [id, stamp] of entries) {
      if (at - stamp >= ttlMs) entries.delete(id);
      else break; // insertion order is time order
    }
    while (entries.size > max) entries.delete(entries.keys().next().value as string);
  };
  for (const entry of options.initial ?? []) {
    if (entry && typeof entry.id === "string" && entry.id && Number.isFinite(entry.at) && !entries.has(entry.id)) entries.set(entry.id, entry.at);
  }
  prune(now());
  return {
    remember(id, at = now()) {
      if (!id) return;
      if (!entries.has(id)) entries.set(id, at);
      prune(at);
    },
    has(id, at = now()) {
      if (!id) return false;
      prune(at);
      return entries.has(id);
    },
    size: () => entries.size,
    snapshot(at = now()) {
      prune(at);
      return [...entries].map(([id, stamp]) => ({ id, at: stamp }));
    },
  };
}

export type ChatKind = "self" | "dm" | "group";
export type EchoClass = "echo" | "owner-self" | "owner-group-participant" | "owner-typed-dm-drop" | "other";
export type SettleResult = { ok: true } | { ok: false; uncertain?: boolean; error?: string };
export type ReservedState = "reserved" | "sent" | "failed" | "uncertain";

/** One persisted row of the outbound journal (`outbound/<connectionId>.json`). */
export interface ReservedRecord {
  id: string;
  /** Canonical chat JID plus its known aliases, all lower-case and device-free. */
  chats: string[];
  at: number;
  state: ReservedState;
  /** Text kept only so Baileys `getMessage` can answer a retry; never used for matching. */
  text?: string;
}

export interface EchoLedgerOptions {
  /** Baileys `generateMessageIDV2(sock.user.id)`. */
  generateId: () => string;
  /** Other forms of a chat (its LID or PN twin), if known. Called at reserve and at classify. */
  aliasesOf?: (chatJid: string) => readonly string[];
  /** Writes the full record list to disk with fsync. Resolves when durable. */
  persist?: (records: readonly ReservedRecord[]) => Promise<void>;
  initial?: readonly ReservedRecord[];
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface EchoLedger {
  /** The id is known to `classify` immediately; `persisted` resolves once it is durable. Send only after awaiting it. */
  reserve(input: { chatJid: string; text: string }): { id: string; persisted: Promise<void> };
  settle(id: string, result: SettleResult): void;
  classify(input: { fromMe: boolean; chatKind: ChatKind; id: string; chatJid: string; chatAltJid?: string | null }): EchoClass;
  /** True when the id is a reserved bot id for that chat (groups: exactly that group). */
  isOutbound(id: string, chatJid: string, chatAltJid?: string | null): boolean;
  /** `reserved` until the send reports back; the bridge refuses a send whose ids are not freshly reserved. */
  stateOf(id: string): ReservedState | undefined;
  /** For `getMessage`: the text sent under this id, if still held. */
  textFor(id: string): string | undefined;
  /** Reserved ids whose send never reported back; the ledger shows them as `uncertain`. */
  uncertainIds(): string[];
  records(): ReservedRecord[];
  size(): number;
}

const chatForms = (chatJid: string, extra: readonly string[] = []): string[] => {
  const forms = new Set<string>();
  for (const jid of [chatJid, ...extra]) {
    const canon = canonicalJid(jid);
    if (canon) forms.add(canon);
  }
  return [...forms];
};

export function parseOutboundJournal(value: unknown): ReservedRecord[] {
  const data = value as { version?: unknown; records?: ReservedRecord[]; aliases?: Record<string, unknown> };
  if (data?.aliases !== undefined && (!data.aliases || typeof data.aliases !== "object" || Array.isArray(data.aliases) ||
    Object.entries(data.aliases).some(([from, to]) => !["pn", "lid"].includes(jidKind(from)) || typeof to !== "string" || !["pn", "lid"].includes(jidKind(to))))) throw new Error("WhatsApp aliases need recovery");
  const ids = new Set<string>();
  if (!data || (data.version !== undefined && data.version !== 1) || !Array.isArray(data.records) || data.records.length > SENT_RING_MAX || data.records.some(row => {
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 200 || /[\x00-\x1f\x7f]/.test(row.id) || ids.has(row.id) || !Number.isSafeInteger(row.at) || row.at < 0 ||
      !Array.isArray(row.chats) || !row.chats.length || row.chats.some(jid => typeof jid !== "string" || canonicalJid(jid) !== jid || !["pn", "lid", "group"].includes(jidKind(jid))) ||
      (row.chats.some(jid => jidKind(jid) === "group") && row.chats.length !== 1) ||
      !["reserved", "sent", "failed", "uncertain"].includes(row.state) || (row.text !== undefined && typeof row.text !== "string")) return true;
    ids.add(row.id); return false;
  })) throw new Error("WhatsApp outbound journal needs recovery");
  return data.records;
}

export function createEchoLedger(options: EchoLedgerOptions): EchoLedger {
  const max = options.max ?? SENT_RING_MAX;
  const ttlMs = options.ttlMs ?? SENT_RING_TTL_MS;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(max) || max < 1) throw new RangeError("createEchoLedger: max must be a positive integer");
  const rows = new Map<string, ReservedRecord>();
  const prune = (at: number) => {
    for (const [id, row] of rows) {
      if (at - row.at >= ttlMs) rows.delete(id);
      else break; // insertion order is time order
    }
    while (rows.size > max) rows.delete(rows.keys().next().value as string);
  };
  for (const row of options.initial ?? []) {
    if (row && typeof row.id === "string" && row.id && Array.isArray(row.chats) && Number.isFinite(row.at) && !rows.has(row.id)) rows.set(row.id, { ...row, chats: [...row.chats] });
  }
  prune(now());

  const aliases = (chatJid: string): string[] => {
    try { return [...(options.aliasesOf?.(chatJid) ?? [])]; } catch { return []; }
  };
  const persist = (): Promise<void> => (options.persist ? options.persist([...rows.values()].map((row) => ({ ...row, chats: [...row.chats] }))) : Promise.resolve());

  const isOutbound = (id: string, chatJid: string, chatAltJid?: string | null): boolean => {
    if (!id) return false;
    prune(now());
    const row = rows.get(id);
    if (!row) return false;
    const incoming = chatForms(chatJid, [...(chatAltJid ? [chatAltJid] : []), ...aliases(chatJid)]);
    if (jidKind(chatJid) === "group") return incoming.length > 0 && row.chats.length === 1 && row.chats[0] === incoming[0];
    return incoming.some((form) => row.chats.includes(form));
  };

  return {
    reserve({ chatJid, text }) {
      const at = now();
      prune(at);
      let id = options.generateId();
      for (let tries = 0; rows.has(id) && tries < 8; tries++) id = options.generateId();
      const group = jidKind(chatJid) === "group";
      const chats = group ? chatForms(chatJid) : chatForms(chatJid, aliases(chatJid));
      rows.set(id, { id, chats, at, state: "reserved", text });
      prune(at);
      return { id, persisted: persist() };
    },
    settle(id, result) {
      const row = rows.get(id);
      if (!row) return;
      row.state = result.ok ? "sent" : result.uncertain ? "uncertain" : "failed";
      // A failed or uncertain send keeps its id: the message may still arrive as an echo.
    },
    classify({ fromMe, chatKind, id, chatJid, chatAltJid }) {
      if (!fromMe) return "other";
      prune(now());
      if ((chatKind === "self" && rows.has(id)) || isOutbound(id, chatJid, chatAltJid)) return "echo";
      if (chatKind === "self") return "owner-self";
      if (chatKind === "group") return "owner-group-participant";
      return "owner-typed-dm-drop";
    },
    isOutbound,
    stateOf: (id) => rows.get(id)?.state,
    textFor: (id) => rows.get(id)?.text,
    uncertainIds: () => [...rows.values()].filter((row) => row.state === "reserved" || row.state === "uncertain").map((row) => row.id),
    records: () => [...rows.values()].map((row) => ({ ...row, chats: [...row.chats] })),
    size: () => rows.size,
  };
}

export type OwnerGateAction = "pass" | "drop_echo" | "drop_disabled" | "drop_allowlist" | "forward_owner";

/**
 * Hermes classifyOwnerMessageGate, same outcomes and same order: echo first,
 * then the opt-in flag, then the allowlist on the customer chat (never the sender).
 */
export function classifyOwnerGate(input: {
  fromMe: boolean;
  fromOwnerEnabled: boolean;
  recentlySent?: { has(id: string): boolean } | null;
  allowlistMatches?: ((chatId: string) => boolean) | null;
  messageId: string;
  chatId: string;
}): { action: OwnerGateAction } {
  if (!input.fromMe) return { action: "pass" };
  if (input.recentlySent && input.recentlySent.has(input.messageId)) return { action: "drop_echo" };
  if (!input.fromOwnerEnabled) return { action: "drop_disabled" };
  if (typeof input.allowlistMatches === "function" && !input.allowlistMatches(input.chatId)) return { action: "drop_allowlist" };
  return { action: "forward_owner" };
}

export const webhookIdFor = (connectionId: string): string => `whatsapp:${connectionId}`;

/**
 * Key for the durable webhook delivery ledger (design 5.5). A LID chat whose phone twin
 * (`remoteJidAlt`) is known is keyed by the phone form, so the same message arriving
 * under either address dedupes (OpenClaw dedupe.ts, DM alternate JID).
 */
export function deliveryIdFor(remoteJid: string, messageId: string, remoteJidAlt?: string | null): string | null {
  const id = messageId.trim();
  if (!remoteJid.trim() || !id || id === "unknown") return null;
  const alt = remoteJidAlt && jidKind(remoteJidAlt) === "pn" && jidKind(remoteJid) === "lid" ? canonicalJid(remoteJidAlt) : "";
  const jid = alt || canonicalJid(remoteJid);
  return `${jid}:${id}`;
}
