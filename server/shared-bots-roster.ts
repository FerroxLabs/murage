// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mayInspectBot } from "./bot-management.ts";
import { isAutomationThread, mayMessage } from "./message-allow.ts";
import { authorizeWork, issueExecutionAudience, threadPartition, isHomePartition } from "./execution-audience.ts";
import { sectionKey, isIndividualAssistant, type BotRecord, type Store } from "./store.ts";
import { ownerOnly } from "./owner-audience.ts";

export function partitionRoster(store: Store, sender: BotRecord, threadId: string, ownerAudience: boolean) {
  // Preserve the existing inspect/message projection for ordinary bots. A
  // partitioned endpoint still uses the narrower work authorization below.
  const legacy = sender.partitionedAt === undefined;
  const reachAudience = ownerAudience && !isAutomationThread(sender.id, threadId);
  const tag = issueExecutionAudience(sender.id, threadId, threadId);
  return store.bots.filter(bot => bot.id !== sender.id && !bot.hidden && (legacy && bot.partitionedAt === undefined ? mayInspectBot(sender, bot) || mayMessage(sender, bot, { ownerAudience: reachAudience }) : authorizeWork({ edge: "peer", requesterBotId: sender.id, requesterThreadId: threadId, targetBotId: bot.id, verb: "ask", tag, ownerAudience }).ok))
    .map(bot => bot.partitionedAt !== undefined && sectionKey(bot.section) !== sectionKey(sender.section)
      ? { id: bot.id, name: `${bot.name} (shared)`, shared: true as const, busy: Boolean(bot.busy) }
      : { id: bot.id, name: bot.name, model: bot.modelSelection.model, busy: Boolean(bot.busy), reachable: legacy && bot.partitionedAt === undefined ? mayMessage(sender, bot, { ownerAudience: reachAudience }) : true, individual: isIndividualAssistant(bot) || undefined, title: bot.title || undefined, description: bot.description || undefined, section: bot.section || undefined, chiefOfStaff: bot.chiefOfStaff || undefined });
}

/** Internal routes that manage bots: creating one, changing or archiving one, or asking for its access (SPEC-X 5.1). */
const BOT_MANAGEMENT_ROUTES = new Set(["/api/internal/create-bot", "/api/internal/bot-management", "/api/internal/access-request"]);

export function partitionToolRefusal(bot: BotRecord, threadId: string, path: string): string | null {
  if (bot.partitionedAt === undefined || isHomePartition(threadPartition(bot, threadId))) return null;
  if (path.startsWith("/api/internal/routine") || path.startsWith("/api/internal/skills")) return `Routines and skill drafts belong to ${bot.name}'s own team.`;
  // A shared bot working for another team manages nobody (L1).
  return BOT_MANAGEMENT_ROUTES.has(path) ? `Manage bots from ${bot.name}'s own team.` : null;
}

/** The owner's line for a shared bot's load (SPEC-X 5.2), shown in the owner
 *  roster and Team settings only: never in a turn a bot or a contact hears. */
export function sharedLoadPrompt(ownerAudience: boolean, load: { name: string; home: string; team: string; waiting: number }): string {
  return ownerOnly("shared-load", ownerAudience, () => `${load.name}, shared from ${load.home}: working for ${load.team}, ${load.waiting} waiting`);
}
