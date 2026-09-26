// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { backupWaitingSentence, type BackupWaiting, type BackupWaitingBot } from "../shared/backup-waiting.ts";

type CardMessage = { id: string; from?: { botId?: string }; card?: { answered?: unknown; dismissed?: boolean; expired?: boolean } | null };
type NamedBot = { id: string; name: string };

/** The bots whose runs are waiting on the person right now: every ask still
 * held open for a live turn (askMessageByRequest, `threadId:requestId` to the
 * card's message id) whose card is unanswered. */
export function backupWaitingBotsFrom(asks: Iterable<[string, string]>, deps: {
  messagesFor: (threadId: string) => readonly CardMessage[];
  botFor: (threadId: string, askingBotId?: string) => NamedBot | undefined;
}): BackupWaitingBot[] {
  const found: BackupWaitingBot[] = [], seen = new Set<string>();
  for (const [key, messageId] of asks) {
    const cut = key.indexOf(":");
    if (cut <= 0) continue;
    const threadId = key.slice(0, cut);
    if (seen.has(`${threadId}:${messageId}`)) continue;
    const message = deps.messagesFor(threadId).find(candidate => candidate.id === messageId);
    const card = message?.card;
    if (!message || !card || (card.answered !== undefined && card.answered !== null) || card.dismissed || card.expired) continue;
    const bot = deps.botFor(threadId, message.from?.botId);
    if (!bot) continue;
    seen.add(`${threadId}:${messageId}`);
    found.push({ botId: bot.id, name: bot.name, threadId, messageId });
  }
  return found;
}

/** Remembers that a backup is being held up, for as long as the desktop keeps
 * asking (a due daily backup asks once a minute), and says so once.
 *
 * `refused` is called each time a backup could not start because work was
 * active, with the bots waiting on the person at that moment; `proceeded`
 * when one starts. The notice goes out once per bot per episode, so a card
 * left for a day rings once, not every minute. */
export function createBackupWaitTracker(deps: { now: () => number; notify: (bot: BackupWaitingBot, text: string) => void; staleMs?: number }) {
  const staleMs = deps.staleMs ?? 3 * 60_000;
  let episode: { since: number; lastAt: number; told: Set<string> } | null = null;
  const live = () => (episode && deps.now() - episode.lastAt <= staleMs ? episode : null);
  return {
    /** Only a scheduled backup starts an episode and rings: the person who
     * pressed Back up now is looking at the page that already says why. */
    refused(bots: readonly BackupWaitingBot[], occasion: "daily" | "manual" = "daily") {
      if (!bots.length || occasion !== "daily") return;
      const now = deps.now();
      if (!live()) episode = { since: now, lastAt: now, told: new Set() };
      episode!.lastAt = now;
      for (const bot of bots) {
        if (episode!.told.has(bot.botId)) continue;
        episode!.told.add(bot.botId);
        try { deps.notify(bot, backupWaitingSentence(bots, "daily")); } catch { /* A notice never changes the backup. */ }
      }
    },
    proceeded() { episode = null; },
    /** What the Inbox shows: the episode, with who is waiting NOW. Answering
     * the card empties this at once, before the next backup attempt. */
    current(waitingNow: readonly BackupWaitingBot[]): BackupWaiting | null {
      const current = live();
      return current && waitingNow.length ? { since: current.since, bots: [...waitingNow] } : null;
    },
  };
}
