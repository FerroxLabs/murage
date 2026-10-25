// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The second line of an @mention row: what the bot does, or how many bots
// @everyone reaches.
import { botRole, type RoleBot } from "@/lib/bot-role";
import { t } from "@/lib/i18n";

export const MENTION_EVERYONE_ID = "__everyone__";
const MAX_DESCRIPTION = 70;

export interface MentionRowSource {
  id: string;
  bot?: RoleBot & { title?: string; description?: string };
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 3).trimEnd()}...` : line;
}

/** `reachable` is the number of bots @everyone reaches in this room. */
export function mentionRowDescription(choice: MentionRowSource, reachable: number): string {
  if (choice.id === MENTION_EVERYONE_ID || !choice.bot) {
    return reachable === 1 ? t("mention.everyoneOne") : t("mention.everyoneMany", { count: reachable });
  }
  const bot = choice.bot;
  const title = firstLine(bot.title);
  if (title) return title;
  if (botRole(bot) === "chief") return t("mention.chiefRuns");
  return firstLine(bot.description);
}
