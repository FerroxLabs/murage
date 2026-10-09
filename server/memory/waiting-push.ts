// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone push for memories waiting (PROPOSAL-v2 9.3). Counts only: the
// sentence carries the bot's name and a number, never any memory text.
import { buildNotification, type Notification, type NotifyBot } from "../notify.ts";

export interface WaitingPushChange { subject: "bot" | "room" | "other"; id: string; name: string; waiting: number }

export function waitingPushSentence(name: string, waiting: number): string {
  return `${name} would like to remember ${waiting} ${waiting === 1 ? "thing" : "things"}`;
}

/** The notification for one gated change, or null when it should stay quiet (not a bot, bot unknown, bot's notifications off). */
export function buildWaitingNotification(change: WaitingPushChange, bot: (id: string) => (NotifyBot & { avatarUrl?: string }) | undefined): Notification | null {
  if (change.subject !== "bot") return null;
  const found = bot(change.id);
  if (!found) return null;
  return buildNotification("memories-waiting", found, found.threadId, waitingPushSentence(found.name, change.waiting), found.avatarUrl ? { avatarUrl: found.avatarUrl } : undefined);
}
