// Copyright 2026 Ferrox Labs
// Adapted from Hermes Agent scripts/whatsapp-bridge/bridge.js (self-chat and allowlist gates) and
// OpenClaw extensions/whatsapp/src/inbound/access-control.ts (pairing) (both MIT).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Inbound policy (design 5.1 to 5.4, 0a W2.2). One pure decision per message, returning the
// conversation, the principal the turn runs as and whether the audience is a non-owner.
// Only the linked number is ever the owner. A group is its own conversation with its own
// guest principal. Baileys alternate JIDs (remoteJidAlt, participantAlt) count as the phone
// twin of a LID sender (Hermes 3926c4209c); device suffixes are stripped before every
// comparison so mention and reply gating match (Hermes 6bf1032609).
import { classifyOwnerGate, type EchoLedger } from "./echo.ts";
import {
  canonicalJid, displayPn, humanUserId, isSelfChat, jidKind, matchesAllowListWithAlt, NO_MAPPING, parseAllowList, sameJid, stripDevice,
  type LidMapping, type SelfIdentity,
} from "./lid.ts";

export const STALE_APPEND_MS = 60_000;
export const PAIRING_REPLY_GRACE_MS = 30_000;
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_MAX_PENDING = 3;
export const PAIRING_TTL_MS = 60 * 60_000;
// No 0, O, 1, I, L: codes are read off a phone and typed into Settings.
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type WhatsAppMode = "self-chat" | "contacts";
export type GroupActivation = "mention" | "always";
export type Activation = "mention" | "reply" | "digits" | "always";

export interface GroupsPolicy {
  policy: "disabled" | "allowlist";
  allow: ReadonlyArray<{ jid: string; name?: string; activation: GroupActivation }>;
  senders: "members" | "allowlist";
}

export interface InboundCandidate {
  id: string;
  /** `key.remoteJid`. */
  chatJid: string;
  /** `key.remoteJidAlt`: the phone twin of a LID chat. */
  chatJidAlt?: string;
  fromMe: boolean;
  /** Message time in milliseconds. */
  timestampMs: number;
  upsertType: "notify" | "append";
  pushName?: string;
  /** `key.participant`, groups only. */
  participant?: string;
  /** `key.participantAlt`. */
  participantAlt?: string;
  /** `contextInfo.mentionedJid`. */
  mentionedJids?: readonly string[];
  /** `contextInfo.stanzaId`: the message this one replies to. */
  quotedMessageId?: string;
  /** `contextInfo.participant`: who wrote the quoted message. */
  quotedParticipant?: string;
  text?: string;
}

export interface AccessPolicy {
  mode: WhatsAppMode;
  self: SelfIdentity;
  /** E.164 numbers the owner approved. A `*` entry is ignored. */
  allowFrom: readonly string[];
  /** Outbound id ledger (reserve-first, id only). */
  echo: Pick<EchoLedger, "classify" | "isOutbound">;
  nowMs: number;
  /** Written on every clean disconnect and every 5 minutes while connected; bounds offline catch-up of append upserts. */
  lastSeenAtMs?: number;
  /** When the socket last connected; used to keep a backlog from fanning out pairing replies. */
  connectedAtMs?: number;
  /** Default true. False drops even the owner's own self-chat lines (OpenClaw selfChatMode). */
  selfChat?: boolean;
  groups?: GroupsPolicy;
  /** Human ids already bound; a `lid:` id in this set is never re-keyed (design 0a W2.4). */
  knownUserIds?: ReadonlySet<string>;
}

export type DropReason =
  | "ignored-chat" | "group-not-allowed" | "group-sender" | "group-not-addressed" | "stale-append" | "echo"
  | "not-self-chat" | "from-me-other-chat" | "pairing-backlog" | "self-chat-off";

export type Principal = { kind: "owner-self" } | { kind: "sender"; userId: string } | { kind: "group-guest"; groupJid: string };

interface Routed {
  conversationKey: string;
  principal: Principal;
  /** True whenever the turn must not carry the owner's memory, shares or approvals. */
  notOwnerAudience: boolean;
}

export type AccessResult =
  | (Routed & {
      decision: "accept";
      role: "owner" | "contact" | "group";
      chatJid: string;
      senderJid: string;
      userId: string;
      /** Phone number JID for display when the sender is known by LID. */
      displayPn?: string;
      activation?: Activation;
    })
  | (Routed & { decision: "pair"; chatJid: string; senderJid: string; userId: string; pushName?: string })
  | { decision: "drop"; reason: DropReason };

const drop = (reason: DropReason): AccessResult => ({ decision: "drop", reason });

const digitsOf = (jid: string): string => canonicalJid(jid).split("@")[0].replace(/\D/g, "");

/** Does `mentionedJids` name the linked account, by PN or LID, device suffix ignored? */
export function mentionsSelf(mentionedJids: readonly string[] | undefined, self: SelfIdentity): boolean {
  return (mentionedJids ?? []).some((jid) => sameJid(jid, self.pn) || (!!self.lid && sameJid(jid, self.lid)));
}

/** OpenClaw mentions.ts: the linked number's digits in the text, with no explicit mention of anyone else. */
function digitsActivation(text: string | undefined, mentioned: readonly string[] | undefined, self: SelfIdentity): boolean {
  if (!text || (mentioned && mentioned.length > 0)) return false;
  const digits = digitsOf(self.pn);
  return digits.length >= 6 && text.replace(/[^\d]/g, "").includes(digits);
}

async function decideGroup(message: InboundCandidate, policy: AccessPolicy, mapping: LidMapping): Promise<AccessResult> {
  const groups = policy.groups;
  const groupJid = canonicalJid(message.chatJid);
  const entry = groups && groups.policy === "allowlist" ? groups.allow.find((item) => canonicalJid(item.jid) === groupJid) : undefined;
  if (!groups || !entry) return drop("group-not-allowed");

  const cls = policy.echo.classify({ fromMe: message.fromMe, chatKind: "group", id: message.id, chatJid: groupJid });
  if (cls === "echo") return drop("echo");

  // The owner typing from the phone is a participant like any other: guest principal, conversation scope only.
  const participant = message.fromMe ? stripDevice(policy.self.pn) : message.participant ? stripDevice(message.participant) : "";
  if (!participant) return drop("group-sender");
  const participantAlt = message.fromMe ? undefined : message.participantAlt;
  if (groups.senders === "allowlist") {
    const allowed = parseAllowList(policy.allowFrom);
    allowed.delete("*");
    if (!(await matchesAllowListWithAlt(participant, participantAlt, allowed, mapping))) return drop("group-sender");
  }

  let activation: Activation | undefined;
  if (entry.activation === "always") activation = "always";
  else if (mentionsSelf(message.mentionedJids, policy.self)) activation = "mention";
  else if (message.quotedMessageId && policy.echo.isOutbound(message.quotedMessageId, groupJid)) activation = "reply";
  else if (digitsActivation(message.text, message.mentionedJids, policy.self)) activation = "digits";
  if (!activation) return drop("group-not-addressed");

  const userId = await humanUserId(participant, mapping, { altJid: participantAlt, existing: policy.knownUserIds });
  const pn = await displayPn(participant, mapping, participantAlt);
  return {
    decision: "accept", role: "group", chatJid: groupJid, senderJid: participant, userId, ...(pn ? { displayPn: pn } : {}), activation,
    conversationKey: `group:${groupJid}`, principal: { kind: "group-guest", groupJid }, notOwnerAudience: true,
  };
}

/** Decide what to do with one inbound message. `mapping` resolves PN and LID forms (design 5.2). */
export async function decide(message: InboundCandidate, policy: AccessPolicy, mapping: LidMapping = NO_MAPPING): Promise<AccessResult> {
  const chat = stripDevice(message.chatJid);
  const kind = jidKind(chat);
  if (kind === "broadcast" || kind === "newsletter" || kind === "other" || kind === "bare") return drop("ignored-chat");
  // Offline catch-up (design 5.5): append upserts older than the last time we were connected are history, not messages.
  if (message.upsertType === "append" && message.timestampMs < (policy.lastSeenAtMs ?? policy.nowMs) - STALE_APPEND_MS) return drop("stale-append");
  if (kind === "group") return decideGroup(message, policy, mapping);

  if (message.fromMe) {
    const selfChat = isSelfChat(chat, policy.self) || (!!message.chatJidAlt && isSelfChat(message.chatJidAlt, policy.self));
    // In self-chat the other form of our own address is known: a reply reserved under the PN can echo back under the LID.
    const otherSelf = selfChat ? (jidKind(chat) === "lid" ? policy.self.pn : policy.self.lid) : undefined;
    const cls = policy.echo.classify({ fromMe: true, chatKind: selfChat ? "self" : "dm", id: message.id, chatJid: chat, chatAltJid: message.chatJidAlt ?? otherSelf });
    if (cls === "echo") return drop("echo");
    if (!selfChat) return drop(policy.mode === "self-chat" ? "not-self-chat" : "from-me-other-chat");
    if (policy.selfChat === false) return drop("self-chat-off");
    const own = canonicalJid(policy.self.pn);
    return { decision: "accept", role: "owner", chatJid: chat, senderJid: own, userId: own, conversationKey: `self:${own}`, principal: { kind: "owner-self" }, notOwnerAudience: false };
  }

  // Every message from another person: strangers never trigger a turn in self-chat mode (Hermes bug #8389).
  if (policy.mode === "self-chat") return drop("not-self-chat");
  const allowed = parseAllowList(policy.allowFrom);
  allowed.delete("*");
  const userId = await humanUserId(chat, mapping, { altJid: message.chatJidAlt, existing: policy.knownUserIds });
  const route: Routed = { conversationKey: `dm:${userId}`, principal: { kind: "sender", userId }, notOwnerAudience: true };
  if (await matchesAllowListWithAlt(chat, message.chatJidAlt, allowed, mapping)) {
    const pn = await displayPn(chat, mapping, message.chatJidAlt);
    return { decision: "accept", role: "contact", chatJid: chat, senderJid: chat, userId, ...(pn ? { displayPn: pn } : {}), ...route };
  }
  if (message.timestampMs < (policy.connectedAtMs ?? Number.NEGATIVE_INFINITY) - PAIRING_REPLY_GRACE_MS) return drop("pairing-backlog");
  return { decision: "pair", chatJid: chat, senderJid: chat, userId, ...(message.pushName?.trim() ? { pushName: message.pushName.trim() } : {}), ...route };
}

/** Hermes owner gate for a bot-number deployment; kept for the Cloud API seam and its fixtures. */
export const classifyOwnerMessage = classifyOwnerGate;

export interface PairingRequest { code: string; userId: string; senderJid: string; name?: string; createdAt: number }

export type PairingUpsert =
  | { kind: "created"; request: PairingRequest; requests: PairingRequest[] }
  | { kind: "existing"; request: PairingRequest; requests: PairingRequest[] }
  | { kind: "limited"; requests: PairingRequest[] };

export function prunePairing(requests: readonly PairingRequest[], nowMs: number): PairingRequest[] {
  return requests.filter((request) => nowMs - request.createdAt < PAIRING_TTL_MS);
}

export function newPairingCode(randomInt: (maxExclusive: number) => number): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

/**
 * Records a pairing request. Only `created` earns the one reply; an existing
 * request for the same sender and a full queue (3 pending) send nothing.
 */
export function upsertPairing(
  requests: readonly PairingRequest[],
  sender: { userId: string; senderJid: string; name?: string },
  nowMs: number,
  randomInt: (maxExclusive: number) => number,
): PairingUpsert {
  const live = prunePairing(requests, nowMs);
  const existing = live.find((request) => request.userId === sender.userId);
  if (existing) return { kind: "existing", request: existing, requests: live };
  if (live.length >= PAIRING_MAX_PENDING) return { kind: "limited", requests: live };
  let code = newPairingCode(randomInt);
  for (let tries = 0; live.some((request) => request.code === code) && tries < 8; tries++) code = newPairingCode(randomInt);
  const request: PairingRequest = { code, userId: sender.userId, senderJid: sender.senderJid, createdAt: nowMs, ...(sender.name ? { name: sender.name } : {}) };
  return { kind: "created", request, requests: [...live, request] };
}

/** Owner approval from Settings. Never reachable from chat text (see core event rule). */
export function approvePairing(requests: readonly PairingRequest[], code: string, nowMs: number): { request: PairingRequest; requests: PairingRequest[] } | null {
  const wanted = code.trim().toUpperCase();
  const live = prunePairing(requests, nowMs);
  const request = live.find((entry) => entry.code === wanted);
  if (!request) return null;
  return { request, requests: live.filter((entry) => entry !== request) };
}

export const pairingReplyText = (code: string): string =>
  `This number is linked to a Murage assistant. Ask its owner to approve code ${code} in Murage to start.`;
