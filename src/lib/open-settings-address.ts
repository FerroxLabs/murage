// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S8: what opening a Settings address does. Loaded on the press, never with the first paint: it reads
// the Settings index (its words). An app entry opens the Settings window on its page and card, exactly as a search
// "Open" does (the modal opens the Advanced fold and highlights the card). A bot entry opens that bot's settings on the
// section, and the window highlights the row.
import type { Action } from "@/state/store";
import { BOT_SETTINGS_SECTIONS, type BotSettingsSection } from "@/components/bot-settings-sections";
import { SETTINGS_INDEX, type SettingsIndexEntry } from "./settings-index";
import type { SettingsAddress } from "./settings-address";
import type { AppSettingsSection } from "./settings-sections";
import { leaveBotPage } from "./settings-leave";

const BOT_SECTION_IDS = new Set<string>(BOT_SETTINGS_SECTIONS.map((section) => section.id));

export interface AddressContext {
  /** The bots the person can open, by id. */
  botIds: readonly string[];
  /** The bot in view, if any. */
  selectedBotId: string | null;
}

/** The store actions an address turns into, or null when it cannot open (an unknown bot, or no bot in view). */
export function settingsAddressActions(address: SettingsAddress, context: AddressContext, index: readonly SettingsIndexEntry[] = SETTINGS_INDEX): Action[] | null {
  if (address.scope === "app") {
    const id = address.name ? `${address.section}.${address.name}` : null;
    const entry = id ? index.find((item) => item.scope === "app" && item.id === id) : undefined;
    if (entry && entry.scope === "app") return [{ type: "toggleAppSettings", open: true, section: entry.section, anchor: entry.anchor }];
    // A page, an old id, or a card that has since moved: its page (unknown lands on General, as everywhere else).
    return [{ type: "toggleAppSettings", open: true, section: address.section as AppSettingsSection }];
  }
  const botId = address.botId ?? context.selectedBotId;
  if (!botId || !context.botIds.includes(botId)) return null;
  if (!BOT_SECTION_IDS.has(address.section)) return null;
  const section = address.section as BotSettingsSection;
  const entry = address.name ? index.find((item) => item.scope === "bot" && item.id === `bot.${section}.${address.name}`) : undefined;
  const actions: Action[] = [];
  if (botId !== context.selectedBotId) actions.push({ type: "select", id: botId });
  actions.push({ type: "toggleSettings", open: true, botId, intent: { section, ...(entry ? { anchor: entry.anchor } : {}) } });
  return actions;
}

/** Opens an address. False when it could not open, so the caller can say so. */
export function openSettingsAddress(address: SettingsAddress, context: AddressContext, dispatch: (action: Action) => void): boolean {
  const actions = settingsAddressActions(address, context);
  if (!actions) return false;
  // One question for the whole open: a "No" on a bot page's unsaved edits leaves the chat and the window as they were.
  leaveBotPage(() => { for (const action of actions) dispatch(action); });
  return true;
}
