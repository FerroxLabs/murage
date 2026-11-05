// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Ask about this screen" in the help panel, the 1.0.17 version (L4B
// fallback, designs/UX-ASK-THIS-SCREEN-1014.md section 8): the question goes
// to the Chief of Staff's chat, with the screen named, through the same
// Ask your bot path Health uses (prefillBotChat). It is put in the composer
// and never sent: the owner reads it and taps Send. The Chief answers in that
// chat, which already has Stop, the level chip and approval cards.
import { botRole, type RoleBot } from "@/lib/bot-role";
import { prefillBotChat } from "@/lib/compose-link";
import { t } from "@/lib/i18n";

interface ChiefBot extends RoleBot { id: string; name: string; threadId: string; hidden?: boolean }

/** The Chief of Staff, else the first bot shown. */
export function chiefFor<B extends ChiefBot>(bots: readonly B[]): B | undefined {
  const visible = bots.filter((bot) => !bot.hidden);
  return visible.find((bot) => botRole(bot) === "chief") ?? visible[0];
}

/** At most this many characters of the question go into the draft. */
export const ASK_MAX_CHARS = 500;

/** The words put in the Chief's composer: the screen by its title, then the owner's question. */
export function askText(screenTitle: string, question: string): string {
  const screen = screenTitle.replace(/\s+/g, " ").trim().slice(0, 120);
  const words = question.replace(/\r\n/g, "\n").trim().slice(0, ASK_MAX_CHARS);
  const lead = t("ux.l4b.ask.prefill", { screen });
  return words ? `${lead}\n\n${words}` : lead;
}

export interface AskChiefDeps {
  select: (botId: string) => void;
  prefill?: typeof prefillBotChat;
}

/** Opens the Chief's chat with the question in the composer, not sent. False when there is no bot to ask. */
export function askChiefAboutScreen<B extends ChiefBot>(bots: readonly B[], screenTitle: string, question: string, deps: AskChiefDeps): boolean {
  const chief = chiefFor(bots);
  if (!chief) return false;
  deps.select(chief.id);
  (deps.prefill ?? prefillBotChat)({ botId: chief.id, threadId: chief.threadId }, askText(screenTitle, question));
  return true;
}
