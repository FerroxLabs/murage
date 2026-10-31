// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.13 UX-TRUST-L1B: when PATCH /api/bots/:id may move a bot's level. Called
// after the route's last await and right before the write, so nothing can
// interleave. A raise to Full access or No limits carries the preview the owner
// reviewed (previewId, ifRev), or is the exact step back of an Undo: the same
// revision, the level the bot just left, and the very routines it had there.
// The bot's default is written alone; conversations move only through the
// reviewed apply or their own PATCH.

import type { BotRecord, Store } from "./store.ts";
import { openRefreshPreview, PERMISSION_LEVELS, permissionLevel, routineEffects, routinesId, type OpenPermissionCandidate, type PermissionHolder, type PermissionLevel, type PreviewRoutine, type RoutineEffect } from "./thread-permissions-refresh.ts";

export const LEVEL_SAVE_FAILED = "Murage could not save the level. Try again.";
export const LEVEL_REVIEW_FIRST = "Review the change first.";

const FLAGS = ["autoApprove", "fullAccess", "noLimits"] as const;
const ACKNOWLEDGEMENTS = ["fullAccessAcknowledgedAt", "noLimitsAcknowledgedAt"] as const;
const rank = (level: PermissionLevel) => PERMISSION_LEVELS.indexOf(level);

/** The 409 every refused level write answers: the current level and revision, nothing written. */
export function previewStale(record: PermissionHolder, name?: string) {
  return {
    code: "preview_stale" as const,
    error: name ? `${name}'s settings changed while this was open. Look again, then choose.` : "This conversation changed since. Look again, then choose.",
    level: permissionLevel(record),
    permissionRev: record.permissionRev ?? 0,
  };
}

export interface LevelChangeInput {
  bot: BotRecord;
  /** the route's finished settings patch */
  patch: Partial<BotRecord>;
  previewId?: string;
  ifRev?: number;
  routines: () => readonly PreviewRoutine[];
  candidates: () => readonly OpenPermissionCandidate[];
}
export type LevelChange =
  | { action: "refuse"; status: number; body: object }
  /** no level move: an ordinary patch, flags included (the legacy at-level acknowledgement) */
  | { action: "patch" }
  | { action: "write"; flags: Pick<BotRecord, (typeof FLAGS)[number]>; acknowledgements: Pick<BotRecord, (typeof ACKNOWLEDGEMENTS)[number]>; rest: Partial<BotRecord>; routinesId: string; routines: RoutineEffect[] };

export function levelChange({ bot, patch, previewId, ifRev, routines, candidates }: LevelChangeInput): LevelChange {
  const flags: Pick<BotRecord, (typeof FLAGS)[number]> = {}, acknowledgements: Pick<BotRecord, (typeof ACKNOWLEDGEMENTS)[number]> = {}, rest: Partial<BotRecord> = { ...patch };
  for (const key of FLAGS) if (Object.hasOwn(patch, key)) { flags[key] = patch[key]; delete rest[key]; }
  for (const key of ACKNOWLEDGEMENTS) if (Object.hasOwn(patch, key)) { acknowledgements[key] = patch[key]; delete rest[key]; }
  const from = permissionLevel(bot), to = permissionLevel({ ...bot, ...flags });
  const stale: LevelChange = { action: "refuse", status: 409, body: previewStale(bot, bot.name) };
  if (ifRev !== undefined && ifRev !== (bot.permissionRev ?? 0)) return stale;
  if (from === to && previewId === undefined) return { action: "patch" };
  const list = routines(), routinesHash = routinesId(list);
  if (previewId !== undefined && previewId !== openRefreshPreview(bot, candidates(), { targetLevel: to, routines: list }).previewId) return stale;
  if (from === to) return { action: "patch" };
  if (rank(to) > rank(from) && rank(to) >= rank("full")) {
    if (ifRev === undefined) return { action: "refuse", status: 400, body: { error: LEVEL_REVIEW_FIRST } };
    if (previewId === undefined && (bot.permissionPrev?.level !== to || bot.permissionPrev.routinesId !== routinesHash)) return stale;
  }
  return { action: "write", flags, acknowledgements, rest, routinesId: routinesHash, routines: routineEffects(bot, list, to) };
}

/** The other settings first, then the level in its own staged write. "failed" when the level did not reach the disk: nothing of it is live. */
export function commitLevelChange(store: Pick<Store, "patchBot" | "setPermissionLevel">, botId: string, change: Extract<LevelChange, { action: "write" }>, options: { preserveTaskSettings: boolean; ifRev?: number }): BotRecord | null | "failed" {
  if (Object.keys(change.rest).length && !store.patchBot(botId, change.rest, { preserveTaskSettings: options.preserveTaskSettings })) return null;
  try {
    return store.setPermissionLevel(botId, { flags: change.flags, acknowledgements: change.acknowledgements, ifRev: options.ifRev, routinesId: change.routinesId, mirrorSoleTask: !options.preserveTaskSettings });
  } catch (error) {
    console.error("level change: could not save", error);
    return "failed";
  }
}
