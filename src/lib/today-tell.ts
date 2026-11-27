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

/** The bot the Tell box writes to; null hides the box (no Chief, a hidden or missing Chief, or first run).
 *  Setup keeps reporting the Chief it first recorded for as long as that bot exists (GH#47), so once the owner has
 *  moved the role, the current visible workspace Chief wins over a pick that is hidden or no longer the Chief. With
 *  no workspace Chief the pick stands while it is visible (setup adopted the oldest bot). */
export function tellChief<B extends RoleBot & { id: string; hidden?: boolean }>(bots: readonly B[], chiefId: string | null, firstRun: boolean): B | null {
  if (firstRun || !chiefId) return null;
  const picked = bots.find((bot) => bot.id === chiefId && !bot.hidden);
  if (picked && botRole(picked) === "chief") return picked;
  return bots.find((bot) => !bot.hidden && botRole(bot) === "chief") ?? picked ?? null;
}
