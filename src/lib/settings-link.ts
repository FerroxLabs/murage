// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one Copy link (SETTINGS-LOCKED-1019.md 2.2): the address of the page in view, or of the card in view when a
// person arrived on one (search Open, an old link, a What's new tile). A card's id is its identity and does not change
// when the card moves to another page, so its address is the one search rows already carry (settingsAddressFor).
import { SETTINGS_ADDRESS_PREFIX, settingsAddressFor } from "./settings-address";
import { BROWSE_BOTS_ROUTE, type SettingsPage } from "./settings-pages";

/** `murage://settings/app/{page}`, or the card's own address when `cardId` (a registry id) is given. */
export function settingsPageLink(page: SettingsPage | typeof BROWSE_BOTS_ROUTE, cardId?: string | null): string {
  if (cardId && cardId.includes(".")) return settingsAddressFor({ id: cardId, scope: "app" });
  return `${SETTINGS_ADDRESS_PREFIX}app/${page}`;
}
