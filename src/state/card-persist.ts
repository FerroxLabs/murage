// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Saving the person's choice on a card (answered, dismissed, restored).
//
// This used to be fire-and-forget with `.catch(() => {})`. On a surface the
// harness refused, the choice was dropped with no sign, and the card came back
// after a reload. It now reports: a refusal or a dropped connection rejects
// with plain copy, and the caller shows it.
import type { OptionCardData } from "./store";

export const CARD_NOT_SAVED = "Your choice on that card could not be saved. Try again.";

export async function persistCardPatch(
  botId: string,
  messageId: string,
  patch: Partial<OptionCardData>,
  surfaceHeaders: Record<string, string>,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/bots/${botId}/cards/${messageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-murage-surface": "desktop", ...surfaceHeaders },
      body: JSON.stringify(patch),
    });
  } catch {
    throw new Error(CARD_NOT_SAVED);
  }
  if (!response.ok) throw new Error(CARD_NOT_SAVED);
}
