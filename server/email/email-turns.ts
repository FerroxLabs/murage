// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The email-mount records (BOT-EMAIL-MURAGE-109 3.1), in a module with no Murage imports so internal-capabilities.ts can delete a generation's
// record when its claims are revoked without loading the email runtime. Shaped like venue-read-turns.ts: the listing is presentation,
// this record (written only by the mount in index.ts runTurn, when emailMounts held) is what every email call is checked against.
import { createHash } from "node:crypto";

/** The owner's direct or routine turn, or a server-proven owner-rooted hand-off. */
export type EmailTurnKind =
  | { kind: "direct"; origin: "desktop" | "companion" }
  | { kind: "routine"; trigger: "schedule" | "manual" }
  | { kind: "delegated"; handoffId: string; rootThreadId: string; attended: boolean };
/** `send`: every tool; `delegated`: send/reply/list/read, never trust_offer; `read`: list/read only (3.2). */
export type EmailToolMode = "send" | "read" | "delegated";
export type EmailTurnRecord = { botId: string; threadId: string; mode: EmailToolMode } & EmailTurnKind;

/** The email-mount records by capability generation. Deleted when the generation's claims are revoked (internal-capabilities.ts). */
export const emailTurns = new Map<string, EmailTurnRecord>();

export function recordEmailTurn(generation: string, record: EmailTurnRecord): void {
  // one live generation per thread: a newer turn's record replaces any older one on the thread
  for (const [key, old] of emailTurns) if (old.threadId === record.threadId && key !== generation) emailTurns.delete(key);
  emailTurns.set(generation, { ...record });
}
export function forgetEmailTurn(generation: string): void { emailTurns.delete(generation); }
export function forgetAllEmailTurns(): void { emailTurns.clear(); }

/** The send rows' generation column (an integer) for a capability generation (a UUID): the first 48 bits of its SHA-256, so the same turn
 *  always maps to the same number and two turns collide only by chance (2^-48). Stop (4.5) maps the stopped generation the same way. */
export function emailGeneration(generation: string): number {
  return Number.parseInt(createHash("sha256").update(`email-generation:${generation}`).digest("hex").slice(0, 12), 16);
}
