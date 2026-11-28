// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

export type HeldReason = "target_moved" | "bot_shared" | "cloud_check_unavailable";

export const HELD_COPY: Record<HeldReason, string> = {
  target_moved: "Results waiting. The results chat was moved or shared.",
  bot_shared: "Results waiting. This bot is shared with a team, so its results chat can't be private. Results arrive when the bot is private again.",
  cloud_check_unavailable: "Results waiting. Murage Cloud couldn't confirm who can see the results chat. Retrying automatically.",
};
export const heldActions = (reason: HeldReason): readonly string[] => (reason === "target_moved" ? ["Recreate results chat"] : []);

export function isHeldReason(reason: string | undefined): reason is HeldReason {
  return reason !== undefined && Object.hasOwn(HELD_COPY, reason);
}
