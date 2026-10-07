// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Lane cards review 2 (N3): what the lead's next turn is told about the cards
// of a text plan that were not made. The room line the owner sees stays short
// (for a repeat of the owner's card it names only that card's number); the
// lead gets each card's full reason, with the card id and what to do instead.
// Room activity lines are not in a member's transcript, so this is the lead's
// only way to learn it on the text path. Kept in memory, as members'
// suggestions are (project-memory-tools.ts): a restart drops them, and the
// lead's goal wakes still list the open cards with their ids.
import { murageTool } from "./murage-tool-surface.ts";

export interface LeadPlanRefusal { key: string; reason: string }
interface Entry extends LeadPlanRefusal { leadBotId: string; at: number }

const KEPT = 12;
const refusals = new Map<string, Entry[]>();

/** One line of plain data: no line breaks or separators, bounded. */
function oneLine(text: string, max: number): string {
  return [...String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** The cards the lead's last text plan could not make (afterProjectLeadTurn).
 * A new lead never reads a former lead's. */
export function recordLeadPlanRefusals(groupId: string, leadBotId: string, refused: readonly LeadPlanRefusal[], at: number): void {
  if (!refused.length) return;
  const kept = (refusals.get(groupId) ?? []).filter(entry => entry.leadBotId === leadBotId);
  const added = refused.map(entry => ({ key: oneLine(entry.key, 40), reason: oneLine(entry.reason, 400), leadBotId, at }));
  refusals.set(groupId, [...kept, ...added].slice(-KEPT));
}

/** The lines for the lead's project status on its next owner-audience turn,
 * or "" when there are none. */
export function leadPlanRefusalLines(groupId: string, botId: string): string {
  const list = (refusals.get(groupId) ?? []).filter(entry => entry.leadBotId === botId);
  if (!list.length) return "";
  return [
    "Cards from your last plan that were not made (make no new card for them):",
    ...list.map(entry => `- ${JSON.stringify(entry.key)}: ${entry.reason}`),
    `To give an existing card to a member, use ${murageTool("project_card_manage")} with action "reassign", its card_id and assignee_bot_id.`,
  ].join("\n");
}

/** The lead's turn that carried them was accepted: they are delivered. */
export function deliveredLeadPlanRefusals(groupId: string, upTo: number): void {
  const left = (refusals.get(groupId) ?? []).filter(entry => entry.at > upTo);
  if (left.length) refusals.set(groupId, left); else refusals.delete(groupId);
}
