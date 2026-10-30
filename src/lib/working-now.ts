// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Working now (UX 1.0.13, lane L2A): which bots are running a turn right now,
// on what, and since when. Read from the roster the app already holds (each
// bot's and each task's `busy` / `activity` / `turnStartedAt`); nothing here
// asks the server. Stop is the existing interrupt (store action `interrupt`).
//
// Rules:
//  - A conversation counts while its turn runs: `activity === "working"`, or
//    `busy` with no activity reported. "waiting-on-you" is NOT working: the
//    bot is stopped on the owner, and that belongs to Needs you.
//  - A hidden bot still counts. Hiding a bot from the list does not stop it,
//    and Stop must stay one click away from anything that is running.
//  - The rail tooltip reads "Working: <what>, <n> min".
//  - "Still working on this" shows after STILL_WORKING_MS with nothing new in
//    the conversation (the turn's start or its newest row, whichever is later).
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

/** Ten quiet minutes: the chat header offers Stop and "Ask what is taking long". */
export const STILL_WORKING_MS = 10 * 60_000;

export interface WorkingItem {
  botId: string;
  botName: string;
  threadId: string;
  /** what the conversation is about (its task title); empty when it has none */
  what: string;
  /** turn start, epoch ms; null when the server did not say */
  since: number | null;
}

type WorkingSource = Pick<Bot, "id" | "name" | "threadId" | "busy" | "activity" | "turnStartedAt" | "tasks">;

function running(entry: { busy?: boolean; activity?: Bot["activity"] }): boolean {
  if (entry.activity) return entry.activity === "working";
  return entry.busy === true;
}

/** Every running conversation, longest-running first (unknown starts last). */
export function workingNow(bots: readonly WorkingSource[]): WorkingItem[] {
  const items: WorkingItem[] = [];
  for (const bot of bots) {
    const seen = new Set<string>();
    for (const task of bot.tasks ?? []) {
      if (!running(task)) continue;
      seen.add(task.threadId);
      items.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, what: (task.title ?? "").trim(), since: finite(task.turnStartedAt) });
    }
    // The bot's own fields describe its open conversation; count it once.
    if (!seen.has(bot.threadId) && running(bot)) {
      const open = bot.tasks?.find((task) => task.threadId === bot.threadId);
      items.push({ botId: bot.id, botName: bot.name, threadId: bot.threadId, what: (open?.title ?? "").trim(), since: finite(bot.turnStartedAt) });
    }
  }
  return items.sort((a, b) => (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY));
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Whole minutes since `since`, never below zero (a server clock ahead of this one reads 0). */
export function minutesSince(since: number | null, now: number): number | null {
  if (since === null) return null;
  return Math.max(0, Math.floor((now - since) / 60_000));
}

/** "4 min so far" / "Under a minute so far" / "" when the start is unknown. */
export function soFarLine(since: number | null, now: number): string {
  const minutes = minutesSince(since, now);
  if (minutes === null) return "";
  return minutes < 1 ? t("ux.l2a.working.underMinute") : t("ux.l2a.working.minutesSoFar", { n: minutes });
}

/** The rail dot's tooltip: "Working: matching invoices, 4 min". */
export function railWorkingTip(item: WorkingItem, now: number): string {
  const minutes = minutesSince(item.since, now);
  const what = item.what || t("ux.l2a.working.aTask");
  return minutes === null
    ? t("ux.l2a.working.tipNoTime", { what })
    : t("ux.l2a.working.tip", { what, n: Math.max(1, minutes) });
}

/** True once a running turn has gone STILL_WORKING_MS with nothing new on screen. */
export function stillWorking(input: { working: boolean; since: number | null; lastRowAt: number | null; now: number }): boolean {
  if (!input.working) return false;
  const latest = Math.max(input.since ?? 0, input.lastRowAt ?? 0);
  if (latest <= 0) return false;
  return input.now - latest >= STILL_WORKING_MS;
}

/** The working items for one bot (the rail's pulse dot). */
export function workingForBot(items: readonly WorkingItem[], botId: string): WorkingItem | undefined {
  return items.find((item) => item.botId === botId);
}
