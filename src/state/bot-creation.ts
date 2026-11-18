// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fromAnswer } from "./answer-tag";
import { announceNewBot } from "@/lib/new-bot-step";
import type { Action, Bot } from "./store";

/** Keep the creation answer's admission tag and its optional computer fallback explanation. */
export function acceptCreatedBot(dispatch: (action: Action) => void, answer: { bot: Bot; computerNotice?: string }): void {
  const { bot, computerNotice } = answer;
  dispatch({ type: "botAdded", ...fromAnswer(bot), bot });
  announceNewBot({ id: bot.id, name: bot.name });
  if (computerNotice) dispatch({ type: "botComputerNotice", botId: bot.id, message: computerNotice });
}
