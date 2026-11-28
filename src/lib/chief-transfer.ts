// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 client side (designs/CHIEF-TRANSFER-1023.md r3 D1/D2): where the owner is sent when a click would drop or move the
// workspace Chief. Free of React components so the sidebar, the role control and the sheet share one routing rule.
import { useSyncExternalStore } from "react";
import type { BotRole } from "./bot-role";

export interface ChiefTransferRequest {
  /** The bot that hands the role over (always the current workspace Chief). */
  from: string;
  /** The incoming bot, when the click already named one. */
  to?: string;
  /** Where the sheet was opened from: only "archive" offers "Archive {old}" in the done state. */
  source: "archive" | "role" | "sidebar";
}

interface ChiefBot { id: string; hidden?: boolean; chiefOfStaff?: boolean; chiefScope?: "workspace" | string }

export const CHIEF_TRANSFER_REQUIRED_HINT = "Choose a new Chief first.";

export function workspaceChiefOf<T extends ChiefBot>(bots: readonly T[]): T | undefined {
  return bots.find((bot) => bot.hidden !== true && bot.chiefOfStaff === true && bot.chiefScope === "workspace");
}

/** D2: where choosing `next` for `bot` goes. Null means the ordinary direct change (no workspace Chief exists, or the role is not a Chief move). */
export function chiefTransferRoute(bots: readonly ChiefBot[], bot: ChiefBot, next: BotRole): ChiefTransferRequest | null {
  const chief = workspaceChiefOf(bots);
  if (!chief) return null;
  if (bot.id === chief.id) return next === "chief" ? null : { from: chief.id, source: "role" };
  return next === "chief" ? { from: chief.id, to: bot.id, source: "role" } : null;
}

/** D2 reducer rule: a PATCH-shaped role change that the server will refuse with 409 must not be painted optimistically. */
export function chiefTransferBlocksPatch(
  bots: readonly ChiefBot[],
  botId: string,
  patch: { chiefOfStaff?: boolean; chiefTier?: "workspace" | "section" | null; hidden?: boolean },
): boolean {
  const chief = workspaceChiefOf(bots);
  if (!chief) return false;
  if (chief.id === botId) {
    return patch.hidden === true || patch.chiefOfStaff === false || (patch.chiefTier !== undefined && patch.chiefTier !== "workspace");
  }
  return patch.chiefTier === "workspace";
}

let current: ChiefTransferRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };
export function openChiefTransfer(request: ChiefTransferRequest): void { current = request; emit(); }
export function closeChiefTransfer(): void { current = null; emit(); }
export function currentChiefTransfer(): ChiefTransferRequest | null { return current; }
export function useChiefTransferRequest(): ChiefTransferRequest | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => null);
}

/** D1 team-import undo: an imported bot that now holds the workspace Chief role cannot be archived by the undo (the server answers 409), so
 * the undo checks first, shows the hint and changes nothing. */
export function undoTouchesChief(bots: readonly ChiefBot[], importedBotIds: readonly string[]): boolean {
  const chief = workspaceChiefOf(bots);
  return !!chief && importedBotIds.includes(chief.id);
}
