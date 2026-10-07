// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP rendering rules the bundle reads (design §2.2 and §2.4): attribution and
// labels chosen from the tier tag, the order inside the self slot, the
// observed-row reservation, the import fade, and the sentence cut the brief
// takes when it does not fit. Pure functions, no database.
import type { PipTier } from "./pip-kinds.ts";

/** Attribution by tier tag (§2.4). Imported rows add the suffix below. */
export const PIP_ATTRIBUTION: Readonly<Record<PipTier, string>> = {
  attested: "you wrote this",
  observed: "confirmed by the owner from the owner's own words",
  proposal: "a proposal I made from your words, not yet confirmed",
  counter: "a count of times your words disagreed with a row, not something you said",
  self: "my own reflection, not something the owner said",
  hypothetical: "a possibility I considered, not something that happened",
  summary: "a summary I wrote of an earlier conversation",
};
export const PIP_IMPORTED_SUFFIX = ", brought in from my earlier notes";

const OWNER_LABELS: Readonly<Record<string, Partial<Record<PipTier, string>>>> = {
  relation: { attested: "How we work together" },
  commitment: { attested: "Commitments (you said)", observed: "Commitments (confirmed)" },
  "self-trait": { attested: "About me (you said)", observed: "About me (confirmed)" },
};
const CONCERN_LABELS: Readonly<Record<string, string>> = {
  intention: "Something I meant to come back to",
  wondering: "Something I've been wondering",
  connection: "A connection I made between conversations",
  tension: "Something that does not sit right in my record",
  stance: "A position I formed",
  branch: "A possibility I'm holding open",
};
/** The kind label for a PIP line, or undefined for a kind that keeps its generic label. */
export function pipKindLabel(kind: string, tier: PipTier, facet?: string): string | undefined {
  if (kind === "concern") return facet ? CONCERN_LABELS[facet] : undefined;
  if (kind === "episode") return "Earlier conversation";
  return OWNER_LABELS[kind]?.[tier];
}
export function pipAttribution(tier: PipTier, imported: boolean): string {
  return PIP_ATTRIBUTION[tier] + (imported ? PIP_IMPORTED_SUFFIX : "");
}

/** `reinforcedAt:<ms>` from a row's entities, else its creation time. */
export function reinforcedAtOf(entities: unknown, createdAt: number): number {
  let list: unknown[] = [];
  try { const parsed = typeof entities === "string" ? JSON.parse(entities) : entities; if (Array.isArray(parsed)) list = parsed; } catch { /* a malformed list falls back to the creation time */ }
  for (const entry of list) {
    const match = typeof entry === "string" ? /^reinforcedAt:(\d{1,16})$/.exec(entry) : null;
    if (match) return Number(match[1]);
  }
  return createdAt;
}

export interface SelfSlotRow { id: string; tier: PipTier; reinforcedAt: number; contested?: boolean; disputed?: boolean }
/** §2.2: attested before observed; within a tier newest `reinforcedAt` first; contested after uncontested; disputed last. Ties break on id. */
export function selfSlotOrder<T extends SelfSlotRow>(rows: readonly T[]): T[] {
  const tierRank = (tier: PipTier) => (tier === "attested" ? 0 : tier === "observed" ? 1 : 2);
  const standing = (row: T) => (row.disputed ? 2 : row.contested ? 1 : 0);
  return [...rows].sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || standing(a) - standing(b) || b.reinforcedAt - a.reinforcedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Bytes of the self slot held back for observed rows when any exists (F-7): at least a third. */
export const observedReservation = (slotBytes: number, anyObserved: boolean): number => (anyObserved ? Math.ceil(slotBytes / 3) : 0);

/** Rank multiplier for imported self-written proposals and seed rows (F-7): `exp(-0.05 * sessionsSinceImport)`. Applied in the Proposed list and the compact line's candidates, never to owner text in the self slot. */
export const importFadeMultiplier = (sessionsSinceImport: number): number => Math.exp(-0.05 * Math.max(0, sessionsSinceImport));

/** Offsets just after each sentence end of `text` (a full stop, `!` or `?` followed by space or the end), ascending. */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) ends.push(match.index! + 1);
  return ends;
}
/** The longest prefix of `text` that fits `maxBytes` and ends at a sentence boundary; undefined when none does. */
export function cutAtSentence(text: string, maxBytes: number): string | undefined {
  const bytes = (value: string) => Buffer.byteLength(value, "utf8");
  if (bytes(text) <= maxBytes) return text;
  const ends = sentenceEnds(text);
  for (let i = ends.length - 1; i >= 0; i--) {
    const candidate = text.slice(0, ends[i]).trimEnd();
    if (candidate && bytes(candidate) <= maxBytes) return candidate;
  }
  return undefined;
}
