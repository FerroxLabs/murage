// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "learned from that" / "will remember that" chip: the parts the server
// and the app agree on (design section 12a). Wording is a shipped set per
// kind, rotated, with the specific thing kept filled in. It is never written
// by a model, so it reads the same on every engine and costs nothing.
//
// The honesty rule lives here as code: a chip model can only be built from
// items that carry the id of a stored learning event. No item, no chip.

/** The three kinds of chip. */
export type ChipKind = "remembered" | "lesson" | "kept" | "improved";
/** A kind may draw on more than one template group ("kept" is praise or a win). */
export type TemplateGroup = "remembered" | "lesson" | "praise" | "win" | "improved";

/** Shipped templates per group (6 to 8 each, design section 12a). The wording
 * lives in the language packs as learnedChip.<group>.<n>, n from 1. */
export const TEMPLATE_COUNTS: Readonly<Record<TemplateGroup, number>> = Object.freeze({ remembered: 7, lesson: 7, praise: 6, win: 6, improved: 6 });

export const templateKey = (group: TemplateGroup, template: number): string => `learnedChip.${group}.${template}`;

export const groupOf = (kind: ChipKind, variant?: "praise" | "win"): TemplateGroup => kind === "kept" ? (variant === "win" ? "win" : "praise") : kind === "improved" ? "improved" : kind;

/** How long Keep is offered after an Undo. */
export const KEEP_WINDOW_MS = 30_000;
/** The specific clause of a memory chip is the entry's first 80 characters. */
export const CLAUSE_MAX = 80;

/** A 1-based template number that is never `previous`. `seed` picks among the
 * rest, so a caller with no randomness (a test, a replay) gets a stable answer. */
export function pickTemplate(group: TemplateGroup, previous: number | null | undefined, seed: number): number {
  const count = TEMPLATE_COUNTS[group];
  const start = Math.abs(Math.trunc(seed)) % count;
  for (let step = 0; step < count; step += 1) {
    const candidate = ((start + step) % count) + 1;
    if (candidate !== previous) return candidate;
  }
  return 1;
}

/** The clause a chip names: one line, no stray whitespace, 80 characters at most. */
export function chipClause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= CLAUSE_MAX) return flat;
  return `${flat.slice(0, CLAUSE_MAX - 1).trimEnd()}…`;
}

export interface ChipActions { edit: boolean; undo: boolean; forget: boolean; notQuite: boolean; notExample: boolean; restorable: boolean; /** A suggestion: one tap on "Keep it" makes it a lesson. */ keepIt?: boolean }

/** One stored thing the chip stands for. `eventId` is the learning event that
 * proves it was stored. */
export interface ChipItem {
  eventId: string;
  kind: ChipKind;
  /** Which template group wrote the wording, and which template in it. */
  group: TemplateGroup;
  template: number;
  /** The lesson text, the memory entry or the exemplar label. */
  text: string;
  state: "active" | "undone" | "suggested";
  /** A suggestion about approvals: the chip points to Access instead of offering Keep. */
  aboutApprovals?: boolean;
  /** A suggestion's reach once kept: this conversation only, or the owner's chats with this bot. */
  keepScope?: "thread" | "owner" | "customers" | "everywhere";
  /** When it was undone, for the 30-second Keep. */
  undoneAt?: number | null;
  /** The reply it sits under. */
  replyMessageId: string;
  /** In a room: which member bot learned it, so a tap goes to that bot's ledger. */
  botId?: string;
  /** For a lesson: which one, and the version an edit must name. */
  lessonId?: string;
  lessonVersion?: number;
  /** For a memory: the entry and the version the chip shows (Edit corrects it; Forget archives it once edited). */
  recordId?: string;
  recordVersion?: number;
  /** For an improved chip: whether a skill or a routine was changed. The text is its name. */
  procedureKind?: "skill" | "routine";
  /** The owner has already edited the entry since it was learned. */
  edited?: boolean;
  /** True for the first chip a bot ever shows: the tap sheet adds where lessons live. */
  first?: boolean;
  /** What the tap sheet may offer. `restorable`: Keep can bring it back after Undo. */
  actions: ChipActions;
}

export const keepAvailable = (item: Pick<ChipItem, "state" | "undoneAt">, now: number): boolean =>
  item.state === "undone" && typeof item.undoneAt === "number" && now - item.undoneAt <= KEEP_WINDOW_MS;

/** An undone item is shown for the Keep window and then gone: nothing is
 * stored any more, so nothing is claimed. */
export const chipItemVisible = (item: Pick<ChipItem, "state" | "undoneAt" | "eventId">, now: number): boolean =>
  Boolean(item.eventId) && (item.state === "active" || item.state === "suggested" || keepAvailable(item, now));

export interface ChipModel {
  mode: "single" | "merged";
  items: ChipItem[];
  /** The headline when merged: counts of what was kept. */
  counts: { remembered: number; learned: number };
  /** The single item, when mode is "single". */
  only: ChipItem | null;
}

/** At most one chip per reply. Several items merge into one. Returns null when
 * there is nothing stored behind it (the honesty rule). */
export function buildChip(items: readonly ChipItem[], now: number): ChipModel | null {
  const live = items.filter(item => chipItemVisible(item, now));
  if (!live.length) return null;
  const remembered = live.filter(item => item.kind === "remembered").length;
  return {
    mode: live.length === 1 ? "single" : "merged",
    items: live,
    counts: { remembered, learned: live.length - remembered },
    only: live.length === 1 ? live[0]! : null,
  };
}

/** Of several replies' items, the chip belongs to its own reply; this groups
 * them so each reply gets at most one. */
export function chipsByReply(items: readonly ChipItem[], now: number): Map<string, ChipModel> {
  const grouped = new Map<string, ChipItem[]>();
  for (const item of items) grouped.set(item.replyMessageId, [...(grouped.get(item.replyMessageId) ?? []), item]);
  const out = new Map<string, ChipModel>();
  for (const [reply, group] of grouped) {
    const chip = buildChip(group, now);
    if (chip) out.set(reply, chip);
  }
  return out;
}

/** The window event the live stream's "learning.remembered" frame becomes (src/state/store.tsx). */
export const REMEMBERED_EVENT = "murage:learning-remembered";

/** Praise and win chips show at most once per 10 turns per bot. */
export const KEPT_CHIP_TURNS = 10;
