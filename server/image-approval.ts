// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// When an image render asks the owner first.
//
// Until 0.1.61 every generate_image call raised an approval card, even for a
// bot on Full access. Now the card follows the bot's approval level, and a
// per-bot "Images" setting can override it either way:
//
//   Follow permission level (default)  Full access and No limits make images
//                                      without a card; Ask and Auto keep it.
//   Ask before each image              the card, whatever the level.
//   Make images without asking         no card, whatever the level.
//
// Three things hold under every setting, because an image is spend the owner
// has not been shown:
//   - the turn's audience is the owner (owner-audience.ts). A contact, someone
//     else in a room, or words nobody proved are the owner's always get the
//     card;
//   - the turn is one Full access itself would cover (auto-approve.ts
//     fullAccessCovers): the owner at the desktop, the owner's routine at its
//     level, the owner's own channel message only with the bot's channel
//     option. A webhook or any unattended turn asks. The setting widens the
//     LEVEL, never who is listening;
//   - the optional "ask again after N images in one turn" has not been hit.
//
// This file only decides. server/index.ts gathers the facts from the turn
// (the task's level, the routine's level, the turn's origin and audience) and
// server/image-operations.ts acts on the answer. The tool is a Murage tool, so
// the same decision serves every engine.
import { hasFullAccess, hasNoLimits, type AutoApprover, type FullAccessOrigin } from "./auto-approve.ts";

import { IMAGE_ASK_AFTER_MAX, imageApprovalOf, imageAskAfterOf, type ImageApprovalSetting, type StoredImageApproval } from "../shared/image-approval-setting.ts";
export { IMAGE_ASK_AFTER_MAX, imageApprovalOf, imageAskAfterOf, type ImageApprovalSetting, type StoredImageApproval };

export interface ImageApprovalFacts {
  /** The bot as the turn judges it: the task's level in a 1:1, the profile's
   * in a room, a routine run at the routine's own level. Absent = unknown. */
  level: (AutoApprover & { fullAccessChannelMessages?: boolean }) | null | undefined;
  /** The bot's Images setting (absent = follow). */
  setting?: ImageApprovalSetting | undefined;
  /** Who started the turn, as Full access reads it (server/index.ts fullAccessTurnOrigin). */
  origin: FullAccessOrigin;
  /** Everyone the turn answers to is the workspace owner. */
  ownerAudience: boolean;
  /** The turn began outside the desktop with nobody at the keyboard. */
  unattended?: boolean;
  /** "Ask again after N images in one turn"; absent = the ceiling of 50. */
  askAfter?: number | undefined;
  /** Images already made without asking in this turn. */
  madeThisTurn: number;
  /** Images this request asks for. */
  count: number;
}

export type ImageApprovalDecision =
  | { ask: false; basis: "Full access" | "No limits" | "the Images setting" }
  | { ask: true; reason: "setting" | "audience" | "unattended" | "origin" | "level" | "loop-guard" };

/** Does the bot's own channel option let the owner's channel message through?
 *
 * For IMAGES this branch never opens in the running app, and that is on
 * purpose: the owner's own Telegram, Slack and Discord messages (and a routine
 * run a channel started) are marked unattended when the turn is dispatched, and
 * an unattended turn always shows the card (above). So `fullAccessChannelMessages`
 * covers peer contact and setup requests but not images: for an image, the
 * owner's channel messages always get the card. It fails closed. The branch is
 * kept so this function answers the same question Full access does. */
function originAllowed(origin: FullAccessOrigin, level: ImageApprovalFacts["level"]): boolean {
  if (origin === "owner" || origin === "routine") return true;
  return origin === "owner-channel" && level?.fullAccessChannelMessages === true;
}

export function decideImageApproval(facts: ImageApprovalFacts): ImageApprovalDecision {
  const setting = facts.setting ?? "follow";
  if (setting === "ask") return { ask: true, reason: "setting" };
  if (!facts.ownerAudience) return { ask: true, reason: "audience" };
  if (facts.unattended === true) return { ask: true, reason: "unattended" };
  if (!originAllowed(facts.origin, facts.level)) return { ask: true, reason: "origin" };
  let basis: Extract<ImageApprovalDecision, { ask: false }>["basis"];
  if (setting === "allow") basis = "the Images setting";
  else if (hasNoLimits(facts.level)) basis = "No limits";
  else if (hasFullAccess(facts.level)) basis = "Full access";
  else return { ask: true, reason: "level" };
  // "Ask again after N images in one turn". Blank is not "no limit": it is an
  // internal ceiling of IMAGE_ASK_AFTER_MAX, so a model that loops cannot spend
  // without bound, and a normal batch never meets it.
  const limit = facts.askAfter ?? IMAGE_ASK_AFTER_MAX;
  if (facts.madeThisTurn + facts.count > limit) return { ask: true, reason: "loop-guard" };
  return { ask: false, basis };
}

export const IMAGE_SETTING_DESKTOP_ONLY = "not found";

/** What a bot settings PATCH does to the Images setting and its guard. Both
 * are spend authority, so only the desktop app may change them (the same bare
 * 404 the other desktop-only settings give). `follow` and `null` are stored as
 * no field at all. */
export function imageApprovalChange(
  body: Record<string, unknown>,
  desktop: boolean,
): { ok: true; patch: { imageApproval?: StoredImageApproval | undefined; imageAskAfter?: number | undefined } } | { ok: false; status: number; error: string } {
  const patch: { imageApproval?: StoredImageApproval | undefined; imageAskAfter?: number | undefined } = {};
  if (body.imageApproval !== undefined) {
    if (body.imageApproval !== "follow" && body.imageApproval !== "ask" && body.imageApproval !== "allow") return { ok: false, status: 400, error: "imageApproval must be follow, ask, or allow" };
    if (!desktop) return { ok: false, status: 404, error: IMAGE_SETTING_DESKTOP_ONLY };
    patch.imageApproval = imageApprovalOf(body.imageApproval);
  }
  if (body.imageAskAfter !== undefined) {
    if (body.imageAskAfter !== null && imageAskAfterOf(body.imageAskAfter) === undefined) return { ok: false, status: 400, error: `imageAskAfter must be a whole number from 1 to ${IMAGE_ASK_AFTER_MAX}, or null for no limit` };
    if (!desktop) return { ok: false, status: 404, error: IMAGE_SETTING_DESKTOP_ONLY };
    patch.imageAskAfter = imageAskAfterOf(body.imageAskAfter);
  }
  return { ok: true, patch };
}
