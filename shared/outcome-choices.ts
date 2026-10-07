// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The outcome mark: which two choices a bot's messages offer, and the words
// for them. Shared by the chat menu and the server so both agree. A bot whose
// job is selling gets Won / Lost; every other bot gets Good / Bad. There is no
// role field on a bot, so the role is read from what the owner wrote about it.

export type OutcomeKind = "won" | "lost" | "good" | "bad";
export const OUTCOME_KINDS: readonly OutcomeKind[] = Object.freeze(["won", "lost", "good", "bad"]);
export type OutcomeAnswer = OutcomeKind | "not-yet";

const SALES_WORDS = /\b(sales?|sdr|bdr|closer|prospect(?:s|ing)?|leads?|deals?|pipeline|crm|outreach|quotes?)\b/i;

/** True for a bot that sells (its name, title or description says so). */
export function isSalesBot(bot: { name?: string; title?: string; description?: string }): boolean {
  return [bot.name, bot.title, bot.description].some(part => typeof part === "string" && SALES_WORDS.test(part));
}

export interface OutcomeChoice { kind: OutcomeKind; label: string }
const LABELS: Record<OutcomeKind, string> = { won: "Mark as won", lost: "Mark as lost", good: "Mark as good", bad: "Mark as bad" };

/** The two choices shown first, in order. */
export function outcomeChoices(bot: { name?: string; title?: string; description?: string }): [OutcomeChoice, OutcomeChoice] {
  const kinds: [OutcomeKind, OutcomeKind] = isSalesBot(bot) ? ["won", "lost"] : ["good", "bad"];
  return [{ kind: kinds[0], label: LABELS[kinds[0]] }, { kind: kinds[1], label: LABELS[kinds[1]] }];
}

const WORDS: Record<OutcomeKind, string> = { won: "Won", lost: "Lost", good: "Good", bad: "Bad" };
export const outcomeWord = (kind: OutcomeKind): string => WORDS[kind];
export const isOutcomeKind = (value: unknown): value is OutcomeKind => typeof value === "string" && (OUTCOME_KINDS as readonly string[]).includes(value);

export type OutcomeState = "confirmed" | "proposed" | "dismissed" | "expired" | "revoked" | "superseded";
/** One outcome as the routes and the chat see it. */
export interface OutcomeView {
  id: string; botId: string; threadId: string | null; messageId: string | null;
  kind: OutcomeKind | "open"; state: OutcomeState;
  reason: string | null; value: number | null; currency: string | null; note: string | null;
  proposedBy: "owner" | "bot" | "app"; confirmedBy: "owner" | null;
  createdAt: number; expiresAt: number | null;
  /** How many rows this message's outcome has had; the next change names it as expectedRevision. */
  revision: number;
}
