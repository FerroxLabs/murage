// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A backup held up by a bot that is waiting for the person's answer.
 *
 * Every backup closes and reopens Murage, and a run waiting on an approval or
 * a question cannot survive that: the engine holding the request stops, and
 * an answer given after the restart only says the run ended. So a backup
 * waits while such a run is open. Ask cards now wait indefinitely, which made
 * one forgotten card stop every backup with nothing saying why (0.1.60 Linux
 * re-test 2, D6). These are the words that say why, the same on the Backups
 * page, in the Inbox and in the notification. */
export interface BackupWaitingBot { botId: string; name: string; threadId: string; messageId?: string }
export interface BackupWaiting { since: number; bots: BackupWaitingBot[] }
export type BackupWaitingOccasion = "daily" | "manual" | "skipped";

/** One name per bot, however many of its conversations are waiting. */
export function backupWaitingNames(bots: readonly BackupWaitingBot[]): string[] {
  return [...new Set(bots.map(bot => bot.name.trim()).filter(Boolean))];
}

function who(bots: readonly BackupWaitingBot[]) {
  const names = backupWaitingNames(bots);
  const one = names.length <= 1;
  const subject = names.length === 0 ? "a bot" : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} bots`;
  return { subject, one };
}

export function backupWaitingSentence(bots: readonly BackupWaitingBot[], occasion: BackupWaitingOccasion): string {
  const { subject, one } = who(bots);
  const answer = one ? "Answer it, or end that run" : "Answer them, or end those runs";
  if (occasion === "skipped") return `The last daily backup was skipped because ${subject} ${one ? "was" : "were"} waiting for your answer. ${answer}, so the next backup can run.`;
  if (occasion === "manual") return `The backup can't start because ${subject} ${one ? "is" : "are"} waiting for your answer. ${answer}, then back up again.`;
  return `Today's backup is waiting because ${subject} ${one ? "is" : "are"} waiting for your answer. ${answer}, and the backup starts by itself.`;
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
/** Keeps only well-formed entries; used where the list crosses a process. */
export function backupWaitingBots(value: unknown): BackupWaitingBot[] {
  if (!Array.isArray(value)) return [];
  const bots: BackupWaitingBot[] = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const v = entry as Record<string, unknown>;
    const botId = text(v.botId, 200), name = text(v.name, 120), threadId = text(v.threadId, 200), messageId = text(v.messageId, 200);
    if (botId && name && threadId) bots.push({ botId, name, threadId, ...(messageId ? { messageId } : {}) });
  }
  return bots;
}
