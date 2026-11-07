// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who Today's Tell box writes to (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2). Pure, so the view
// (TodayView, TellChiefBox) and the end-to-end test (server/today-tell-flow.test.ts) pick the same bot from the
// same bot list. The box then sends through the Chief's own Composer, to the Chief's current `threadId`.
// Relative with its extension: the server's end-to-end test imports this file under NodeNext resolution.
import { botRole, type RoleBot } from "./bot-role.ts";

type ChiefCandidate = RoleBot & { id: string; hidden?: boolean };

/** The Chief: the setup view's Chief when it names one, else the first visible bot whose role is chief. */
export function todayChiefId(bots: readonly ChiefCandidate[], chiefBotId: string | null): string | null {
  return chiefBotId ?? bots.find((bot) => !bot.hidden && botRole(bot) === "chief")?.id ?? null;
}

/** The bot the Tell box writes to; null hides the box (no Chief, a hidden or missing Chief, or first run). */
export function tellChief<B extends { id: string; hidden?: boolean }>(bots: readonly B[], chiefId: string | null, firstRun: boolean): B | null {
  if (firstRun || !chiefId) return null;
  return bots.find((bot) => bot.id === chiefId && !bot.hidden) ?? null;
}
