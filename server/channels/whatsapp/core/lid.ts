// Copyright 2026 Ferrox Labs
// Adapted from Hermes Agent scripts/whatsapp-bridge/allowlist.js (MIT, Nous Research).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Alternate-JID handling and the device-suffix rule follow Hermes bridge_helpers.js normalizeWhatsAppId
// (a ":" to "@" swap once produced "<user>@<device>@lid" and silently broke mention and reply gating)
// and OpenClaw inbound/dedupe.ts (hosted PN/LID domains collapse as Baileys cleanMessage does) (both MIT).
//
// WhatsApp identifiers: phone-number JIDs (PN) and linked-identity JIDs (LID).
// Pure. Mapping between the two is injected, because the real mapping lives in
// Baileys' encrypted key store (design 5.2), not in files this code may read.

export const PN_SERVER = "s.whatsapp.net";
export const LID_SERVER = "lid";
export const GROUP_SERVER = "g.us";

/** Asks the library for the other form of an identity. Always takes and returns full JIDs. */
export interface LidMapping {
  pnForLid(lidJid: string): Promise<string | null | undefined> | string | null | undefined;
  lidForPn(pnJid: string): Promise<string | null | undefined> | string | null | undefined;
}

export const NO_MAPPING: LidMapping = { pnForLid: () => undefined, lidForPn: () => undefined };

export type JidKind = "pn" | "lid" | "group" | "broadcast" | "newsletter" | "bare" | "other";

/** Hermes normalizeWhatsAppIdentifier: strip device suffix, server and a leading plus. */
export function normalizeIdentifier(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/:.*@/, "@")
    .replace(/@.*/, "")
    .replace(/^\+/, "");
}

export function jidServer(jid: string): string {
  const at = jid.lastIndexOf("@");
  return at < 0 ? "" : jid.slice(at + 1).toLowerCase();
}

export function jidKind(jid: string): JidKind {
  const server = jidServer(jid);
  if (!server) return jid.trim() ? "bare" : "other";
  if (server === PN_SERVER || server === "c.us" || server === "hosted") return "pn";
  if (server === LID_SERVER || server === "hosted.lid") return "lid";
  if (server === GROUP_SERVER) return "group";
  if (server === "broadcast") return "broadcast";
  if (server === "newsletter") return "newsletter";
  return "other";
}

/** `123:4@s.whatsapp.net` becomes `123@s.whatsapp.net` (device suffix removed). */
export function stripDevice(jid: string): string {
  return jid.trim().replace(/:\d+(?=@)/, "").replace(/:\d+$/, "");
}

/**
 * Device suffix removed and the hosted PN/LID domains collapsed onto their plain
 * servers, so the same account always compares equal (OpenClaw dedupe.ts).
 */
export function canonicalJid(jid: string | null | undefined): string {
  if (!jid) return "";
  const bare = stripDevice(jid).toLowerCase();
  const at = bare.lastIndexOf("@");
  if (at < 0) return bare;
  const user = bare.slice(0, at);
  switch (jidKind(bare)) {
    case "pn": return `${user}@${PN_SERVER}`;
    case "lid": return `${user}@${LID_SERVER}`;
    default: return bare;
  }
}

/** True when two ids name the same account or chat once device suffixes and hosted domains are ignored. */
export function sameJid(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalJid(a);
  return !!left && left === canonicalJid(b);
}

/** Wildcards are Hermes' open-bot switch; Murage never honours them from user config. */
export function parseAllowList(raw: string | readonly string[] | null | undefined): Set<string> {
  const items = typeof raw === "string" ? raw.split(",") : [...(raw ?? [])];
  return new Set(items.map((item) => normalizeIdentifier(item)).filter(Boolean));
}

async function ask(call: () => unknown): Promise<string | undefined> {
  try {
    const value = await call();
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every bare identifier (digits only) the sender is known by. Walks phone to
 * LID and LID to phone so an allowlist written as either form matches.
 */
export async function expandIdentifiers(identifier: string, mapping: LidMapping = NO_MAPPING): Promise<Set<string>> {
  const resolved = new Set<string>();
  const first = normalizeIdentifier(identifier);
  if (!first) return resolved;
  const startKind = jidKind(identifier);
  const queue: Array<{ id: string; kind: "pn" | "lid" }> = [{ id: first, kind: startKind === "lid" ? "lid" : "pn" }];
  let hops = 0;
  while (queue.length && hops++ < 8) {
    const current = queue.shift()!;
    if (resolved.has(current.id)) continue;
    resolved.add(current.id);
    if (current.kind === "pn") {
      const lid = await ask(() => mapping.lidForPn(`${current.id}@${PN_SERVER}`));
      const id = lid ? normalizeIdentifier(lid) : "";
      if (id && !resolved.has(id)) queue.push({ id, kind: "lid" });
    } else {
      const pn = await ask(() => mapping.pnForLid(`${current.id}@${LID_SERVER}`));
      const id = pn ? normalizeIdentifier(pn) : "";
      if (id && !resolved.has(id)) queue.push({ id, kind: "pn" });
    }
  }
  return resolved;
}

/** Hermes matchesAllowedUser. An empty allowlist allows no one (bug #8389). */
export async function matchesAllowList(senderJid: string, allowed: ReadonlySet<string>, mapping: LidMapping = NO_MAPPING): Promise<boolean> {
  if (!allowed || allowed.size === 0) return false;
  if (allowed.has("*")) return true;
  for (const alias of await expandIdentifiers(senderJid, mapping)) if (allowed.has(alias)) return true;
  return false;
}

/** Allowlist match over a sender and its Baileys alternate JID (the phone twin of a LID sender). */
export async function matchesAllowListWithAlt(senderJid: string, altJid: string | null | undefined, allowed: ReadonlySet<string>, mapping: LidMapping = NO_MAPPING): Promise<boolean> {
  if (await matchesAllowList(senderJid, allowed, mapping)) return true;
  return altJid ? matchesAllowList(altJid, allowed, mapping) : false;
}

export interface SelfIdentity { pn: string; lid?: string }

/** True when `chatJid` is the linked account's own chat, by PN or LID, device suffix ignored. */
export function isSelfChat(chatJid: string, self: SelfIdentity): boolean {
  const chat = canonicalJid(chatJid);
  if (!chat) return false;
  return sameJid(chat, self.pn) || (!!self.lid && sameJid(chat, self.lid));
}

/**
 * Stable id for observeVerifiedHuman (design 5.2, 0a W2.4): the PN JID when it is
 * known, otherwise the LID under a `lid:` prefix. Durable bindings are never
 * re-keyed: a sender already bound as `lid:<jid>` (listed in `existing`) keeps that
 * key even after a PN mapping appears; the PN is display metadata only. `altJid` is
 * the Baileys `remoteJidAlt` / `participantAlt` phone twin.
 */
export async function humanUserId(senderJid: string, mapping: LidMapping = NO_MAPPING, options: { altJid?: string | null; existing?: ReadonlySet<string> } = {}): Promise<string> {
  const jid = stripDevice(senderJid);
  if (jidKind(jid) !== "lid") {
    const lid = options.altJid && jidKind(options.altJid) === "lid" ? options.altJid : await ask(() => mapping.lidForPn(jid));
    const lidKey = lid ? `lid:${canonicalJid(lid)}` : undefined;
    return lidKey && options.existing?.has(lidKey) ? lidKey : canonicalJid(jid) || jid;
  }
  const lidKey = `lid:${canonicalJid(jid)}`;
  if (options.existing?.has(lidKey)) return lidKey;
  const alt = options.altJid && jidKind(options.altJid) === "pn" ? canonicalJid(options.altJid) : undefined;
  if (alt) return alt;
  const pn = await ask(() => mapping.pnForLid(jid));
  return pn ? canonicalJid(pn) : lidKey;
}

/** The phone number JID for a sender when one is known (alt JID first, then the mapping), for display. */
export async function displayPn(senderJid: string, mapping: LidMapping = NO_MAPPING, altJid?: string | null): Promise<string | undefined> {
  const jid = stripDevice(senderJid);
  if (jidKind(jid) === "pn") return canonicalJid(jid);
  if (altJid && jidKind(altJid) === "pn") return canonicalJid(altJid);
  const pn = await ask(() => mapping.pnForLid(jid));
  return pn ? canonicalJid(pn) : undefined;
}

/** Masks a number to its last four digits for display ("+•••• 1234"). */
export function maskNumber(jid: string): string {
  const digits = normalizeIdentifier(jid).replace(/\D/g, "");
  return digits.length ? `+•••• ${digits.slice(-4)}` : "";
}
