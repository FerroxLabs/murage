// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The per-bot "Images" setting and its "ask again after N images" guard, as
// they are stored and read back. The decision itself is server/image-approval.ts.

/** What the Images setting offers. `follow` is the default and is never stored. */
export type ImageApprovalSetting = "follow" | "ask" | "allow";
/** What a bot record holds: only a non-default value. */
export type StoredImageApproval = "ask" | "allow";

/** The most the "ask again after N images" guard can be set to. */
export const IMAGE_ASK_AFTER_MAX = 50;

/** From a stored record: an exact `ask` or `allow`, else the default. */
export function imageApprovalOf(value: unknown): StoredImageApproval | undefined {
  return value === "ask" || value === "allow" ? value : undefined;
}

/** From a stored record: a whole number from 1 to 50, else the default of 50. */
export function imageAskAfterOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= IMAGE_ASK_AFTER_MAX ? value : undefined;
}
