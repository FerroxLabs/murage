// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot's `learning` settings (bot-learning feature, batch B0).
//
// Stored on the bot record as `learning`. Absent means the defaults, so every
// bot learns from its owner's own words, edits and marks out of the box
// (design principle 1) and no migration touches bots.json. `revision` counts
// effective changes: every mutation names the revision it was based on, and a
// stale one is refused instead of overwriting another window's choice.
//
// Permissions are not learning (principle 7): nothing here can widen a tool,
// a permission, a budget or an audience.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface BotLearning {
  /** Learn from the owner's words, edits and marks. On by default. */
  enabled: boolean;
  /** "Ask me before it changes anything": every change becomes a suggestion. */
  askFirst: boolean;
  /** Learn from conversations with prospects and customers. Off by default;
   * what is learned that way stays on this computer (learning-local/). */
  prospectLearning: boolean;
  /** The chats the owner chose for prospect learning (the switch writes it). Kept when
   * any switch is toggled, so turning the opt-in off and on again never loses the choice.
   * Only used while `prospectLearning` is on. */
  prospectThreadIds?: readonly string[];
  /** Counts effective changes; starts at 0 for a bot that never changed it. */
  revision: number;
}

export const DEFAULT_BOT_LEARNING: Readonly<BotLearning> = Object.freeze({ enabled: true, askFirst: false, prospectLearning: false, prospectThreadIds: Object.freeze([]) as readonly string[], revision: 0 });

export const BOT_LEARNING_SWITCHES = ["enabled", "askFirst", "prospectLearning"] as const;
export type BotLearningSwitch = (typeof BOT_LEARNING_SWITCHES)[number];
export type BotLearningChange = Partial<Record<BotLearningSwitch, boolean>> & { prospectThreadIds?: readonly string[] };

export const PROSPECT_THREADS_MAX = 500;
export const PROSPECT_THREAD_ID_MAX = 200;
/** Real ids only: strings, 1 to 200 characters, no repeats, at most 500. */
export function cleanProspectThreadIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) if (typeof id === "string" && id.length > 0 && id.length <= PROSPECT_THREAD_ID_MAX && !out.includes(id)) out.push(id);
  return out.slice(0, PROSPECT_THREADS_MAX);
}

/** The bot's settings with defaults filled in. Lenient on purpose: a damaged
 * field falls back to its default rather than blocking the bot. */
export function readBotLearning(bot: { learning?: unknown }): BotLearning {
  const raw = bot.learning && typeof bot.learning === "object" ? bot.learning as Record<string, unknown> : {};
  const flag = (key: BotLearningSwitch) => typeof raw[key] === "boolean" ? raw[key] as boolean : DEFAULT_BOT_LEARNING[key];
  const revision = Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 0 ? raw.revision as number : 0;
  return { enabled: flag("enabled"), askFirst: flag("askFirst"), prospectLearning: flag("prospectLearning"), prospectThreadIds: cleanProspectThreadIds(raw.prospectThreadIds), revision };
}

export type BotLearningUpdate =
  | { ok: true; learning: BotLearning; changed: boolean }
  | { ok: false; reason: "revision-conflict"; learning: BotLearning };

/** The next settings, or a conflict when `expectedRevision` is not current.
 * A request that changes nothing keeps the revision (a retry is harmless). */
export function nextBotLearning(current: BotLearning, expectedRevision: number, change: BotLearningChange): BotLearningUpdate {
  if (expectedRevision !== current.revision) return { ok: false, reason: "revision-conflict", learning: current };
  // The spread keeps the chosen chats whatever switch moves.
  const next: BotLearning = { ...current, prospectThreadIds: [...(current.prospectThreadIds ?? [])] };
  let changed = false;
  if (change.prospectThreadIds !== undefined) {
    const scope = cleanProspectThreadIds(change.prospectThreadIds);
    const before = current.prospectThreadIds ?? [];
    if (scope.length !== before.length || scope.some((id, index) => id !== before[index])) { next.prospectThreadIds = scope; changed = true; }
  }
  for (const key of BOT_LEARNING_SWITCHES) if (change[key] !== undefined && change[key] !== current[key]) { next[key] = change[key]!; changed = true; }
  if (changed) next.revision = current.revision + 1;
  return { ok: true, learning: next, changed };
}

/** Where learning that must not leave this computer lives, under the data
 * folder. data-dir-inventory.ts classifies it "excluded": no backup, restore,
 * bot package or damaged-installation export carries it. */
export const LEARNING_LOCAL_DIR = "learning-local";
export const learningLocalPath = (dataDir: string, ...parts: string[]) => join(dataDir, LEARNING_LOCAL_DIR, ...parts);
/** Create the folder on first use, owner-only. */
export function ensureLearningLocalDir(dataDir: string): string {
  const dir = learningLocalPath(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
