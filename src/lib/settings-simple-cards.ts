// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which cards a Simple page shows (SETTINGS-LOCKED-1019.md 2.5), as data the shell can read before a page file has loaded:
// a link or a search result that names a card Simple leaves out turns Advanced mode on first. The page files read the same
// list for their `simple` flags, so there is one place that says it. Only the seven Simple pages have an entry; a page with
// no entry here is treated as "unknown", never as Advanced-only. Ids are registry ids and never change.
import { SECTION_PAGES, type SettingsPage } from "./settings-pages";

const SIMPLE_CARDS: Partial<Record<SettingsPage, readonly string[]>> = {
  general: ["general.mode", "general.profile", "general.about-me", "general.appearance", "general.sidebar-density", "general.notifications", "general.startup"],
  models: ["models.providers", "models.engines", "models.paste-keys", "models.existing-keys"],
  connections: ["connections.apps", "connections.mcp", "channels.telegram", "channels.slack", "channels.discord", "channels.whatsapp"],
  computer: ["companion.browser"],
  companion: ["companion.pairing"],
  backups: ["backups.backups"],
  usage: ["usage.by-bot", "usage.by-routine", "usage.spend-limit", "usage.account"],
  about: ["about.version", "about.whats-new"],
};

/** True when Simple shows this card. */
export function isSimpleCard(id: string): boolean {
  return Object.values(SIMPLE_CARDS).some((ids) => ids?.includes(id));
}

/** True when a card on `page` is shown only in Advanced: its page is not a Simple page, or it is a Simple page that lists
 *  its Simple cards here and this is not one. Unknown (a Simple page with no list yet) is false: nothing is flipped. */
export function isAdvancedOnlyCard(page: SettingsPage, id: string): boolean {
  const entry = SECTION_PAGES.find((each) => each.id === page);
  if (!entry) return false;
  if (!entry.simple) return true;
  const ids = SIMPLE_CARDS[page];
  return ids ? !ids.includes(id) : false;
}
