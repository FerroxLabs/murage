// SPDX-License-Identifier: AGPL-3.0-or-later
// What the menu bar / system tray menu shows (electron/background-lifecycle.mjs).
//
// Read-only. The menu answers an approval through the SAME route and checks
// as the app's own buttons (/api/threads/:id/respond); this module only
// decides which cards are simple enough to answer from a one-line menu item.
// Everything else gets "Open" and is answered on the full card.
import type { InboxItem, InboxPage } from "../shared/inbox.ts";
import { isQuestionCard } from "../shared/questions.ts";
import { looksDestructive, looksSensitive } from "./auto-approve.ts";
import { isStopLineKey } from "./stop-line.ts";
import type { BotRecord, Message } from "./store.ts";

/** How many waiting items the menu lists before "See all in Inbox". */
export const TRAY_ITEM_LIMIT = 5;
/** Longer summaries are never approved from a menu: the owner would be
 * saying yes to words the menu could not show. */
export const TRAY_QUICK_SUMMARY_MAX = 240;
const BOT_LIMIT = 15;

type Card = NonNullable<Message["card"]>;

export interface TrayItem {
  /** Inbox item id, stable for dedupe. */
  id: string;
  botId?: string;
  botName: string;
  summary: string;
  threadId: string;
  messageId: string;
  requestId?: string;
  /** Allow once / Deny may be offered from the menu. */
  quick: boolean;
}
export interface TrayWorking { botId: string; botName: string; threadId: string; doing: string; startedAt?: number }
export interface TrayBot { id: string; name: string; chief: boolean }
export interface TraySummary {
  /** The Inbox's "Needs you" number: the same count the sidebar badge reads. */
  needsYou: number;
  items: TrayItem[];
  working: TrayWorking[];
  bots: TrayBot[];
  moreBots: boolean;
}

/** An ordinary tool approval, and only that. Stop-line cards (deleting
 * outside its folder, paying, messaging someone new or in public), anything
 * touching keys or secrets, destructive commands, local-computer control,
 * questions, folder trust, routine and skill proposals and anything held by
 * a guard stay on the full card, where the owner sees all of it. */
export function trayQuickAnswer(card: Card | undefined, context: { stopHit?: boolean } = {}): boolean {
  if (!card?.requestId || !card.tool || card.answered || card.dismissed || card.expired) return false;
  if (isQuestionCard(card) || card.folderTrust || card.routineRequest || card.skillRequest || card.intake || card.setup) return false;
  if (context.stopHit || card.taskAllowKey || (card.allowKey && isStopLineKey(card.allowKey))) return false;
  if (card.approvalScope) return false;
  const summary = card.subtitle ?? "";
  if (!summary.trim() || summary.length > TRAY_QUICK_SUMMARY_MAX) return false;
  const text = `${card.tool}\n${summary}`;
  if (looksSensitive(text) || looksDestructive(text)) return false;
  return true;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export interface TraySummaryDeps {
  page: Pick<InboxPage, "decisions" | "items">;
  bots: readonly BotRecord[];
  chiefId?: string;
  messagesFor(threadId: string): readonly Message[];
  stopHit(threadId: string, requestId: string): boolean;
}

export function traySummary(deps: TraySummaryDeps): TraySummary {
  const botById = new Map(deps.bots.map(bot => [bot.id, bot]));
  const items = deps.page.items.slice(0, TRAY_ITEM_LIMIT).map((item: InboxItem): TrayItem => {
    const message = item.kind === "request" ? deps.messagesFor(item.link.threadId).find(entry => entry.id === item.link.messageId) : undefined;
    const card = message?.card;
    const botId = message?.from?.botId ?? item.botId;
    const botName = (botId ? botById.get(botId)?.name : undefined) ?? item.sourceLabel.split(" · ")[0]?.trim() ?? "Murage";
    const quick = trayQuickAnswer(card, { stopHit: card?.requestId ? deps.stopHit(item.link.threadId, card.requestId) : false });
    return {
      id: item.id, ...(botId ? { botId } : {}), botName,
      summary: oneLine(card?.subtitle || item.summary || item.title),
      threadId: item.link.threadId, messageId: item.link.messageId,
      ...(card?.requestId ? { requestId: card.requestId } : {}), quick,
    };
  });
  const working: TrayWorking[] = [];
  for (const bot of deps.bots) {
    if (bot.hidden) continue;
    const tasks = new Map((bot.tasks ?? []).map(task => [task.threadId, task]));
    const threads = new Set([bot.threadId, ...tasks.keys()]);
    for (const threadId of threads) {
      const task = tasks.get(threadId);
      const activity = task?.activity ?? (threadId === bot.threadId ? bot.activity : undefined);
      const busy = task ? task.busy : bot.busy;
      // waiting on the owner is "Needs you", not working
      if (!busy || activity === "waiting-on-you" || activity === "idle" || activity === "dead") continue;
      const startedAt = task?.turnStartedAt;
      const last = [...deps.messagesFor(threadId)].reverse().find(message => message.kind === "activity" && message.tool && (!startedAt || message.at >= startedAt));
      const doing = oneLine(last?.tool?.spoken ?? last?.tool?.summary ?? (task?.title && task.title !== "New task" ? task.title : "") ?? "") || "Working";
      working.push({ botId: bot.id, botName: bot.name, threadId, doing, ...(startedAt ? { startedAt } : {}) });
    }
  }
  const visible = deps.bots.filter(bot => !bot.hidden);
  const chief = visible.find(bot => bot.id === deps.chiefId);
  const others = visible.filter(bot => bot !== chief).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const ordered = [...(chief ? [chief] : []), ...others];
  return {
    needsYou: deps.page.decisions,
    items,
    working,
    bots: ordered.slice(0, BOT_LIMIT).map(bot => ({ id: bot.id, name: bot.name, chief: bot === chief })),
    moreBots: ordered.length > BOT_LIMIT,
  };
}
