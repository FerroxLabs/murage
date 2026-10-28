// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.3 Settings pages (SETTINGS-REDESIGN.md r1 C, r2.4 to r2.6; the
// approved mockup): 12 pages in 5 groups. Frozen by I0 (SETTINGS-LANES.md);
// lane L1 makes the modal, the sidebar, the store and search read this, and
// only I0's owner changes it.
//
// Every one of the 19 section ids stays valid for good (deep links, What's
// new tiles, published announcements): 12 are pages, 7 are aliases that land
// on a page and an anchor on it. Plain data, no words and no components: it
// rides the first paint like lib/settings-sections.ts.
import type { AppSettingsSection } from "./settings-sections";

export type SettingsPageGroup = "you" | "bots" | "ai" | "reach" | "app";

export type SettingsPage =
  | "general"
  | "botDefaults"
  | "skills"
  | "memory"
  | "models"
  | "webSearch"
  | "connections"
  | "channels"
  | "companion"
  | "backups"
  | "usage"
  | "about";

export type SettingsAlias = Exclude<AppSettingsSection, SettingsPage>;

export interface SettingsPageEntry {
  id: SettingsPage;
  group: SettingsPageGroup;
  /** Hidden on any surface that is not the confirmed desktop (same rule as sectionsForSurface). */
  desktopOnly?: boolean;
}

export const SETTINGS_PAGE_GROUPS: readonly SettingsPageGroup[] = ["you", "bots", "ai", "reach", "app"];

/** Sidebar order. Labels: General; Bots, Skills, Memory; Models & engines, Tools; Connected apps, Messaging apps, Devices;
 *  Backups, Usage, About & updates. */
export const SECTION_PAGES: readonly SettingsPageEntry[] = [
  { id: "general", group: "you" },
  { id: "botDefaults", group: "bots", desktopOnly: true },
  { id: "skills", group: "bots", desktopOnly: true },
  { id: "memory", group: "bots", desktopOnly: true },
  { id: "models", group: "ai", desktopOnly: true },
  { id: "webSearch", group: "ai", desktopOnly: true },
  { id: "connections", group: "reach", desktopOnly: true },
  { id: "channels", group: "reach", desktopOnly: true },
  { id: "companion", group: "reach", desktopOnly: true },
  { id: "backups", group: "app", desktopOnly: true },
  { id: "usage", group: "app" },
  { id: "about", group: "app" },
];

export interface SettingsTarget { section: SettingsPage; anchor: string | null }

/** An old id to the page and the anchor it lands on. The anchor is a DOM id the target card renders; when that card is
 *  `advanced` (settings-cards.ts) the opener opens the page's Advanced section first, then scrolls and focuses. */
export const SECTION_ALIASES: Readonly<Record<SettingsAlias, { section: SettingsPage; anchor: string }>> = {
  aboutMe: { section: "general", anchor: "about-me-heading" },
  houseRules: { section: "botDefaults", anchor: "house-rules-heading" },
  engines: { section: "models", anchor: "engines-heading" },
  images: { section: "webSearch", anchor: "image-settings-heading" },
  voice: { section: "webSearch", anchor: "voice-settings-heading" },
  computer: { section: "companion", anchor: "computer-settings-heading" },
  // Keep published links working after the controls moved into regular Settings.
  experimental: { section: "skills", anchor: "skill-recorder-heading" },
  // 1.0.3 attachment storage (fix/103-attachment-cap): the Storage card sits on the Backups page
  storage: { section: "backups", anchor: "storage-heading" },
};

const PAGE_IDS = new Set<string>(SECTION_PAGES.map((entry) => entry.id));

export function isSettingsPage(id: unknown): id is SettingsPage {
  return typeof id === "string" && PAGE_IDS.has(id);
}

/** Any of the 19 ids, or anything else, to where it lands. Unknown input lands on General, as normalizeSettingsSection does. */
export function resolveSettingsSection(id: unknown): SettingsTarget {
  if (isSettingsPage(id)) return { section: id, anchor: null };
  if (typeof id === "string" && Object.prototype.hasOwnProperty.call(SECTION_ALIASES, id)) {
    const alias = SECTION_ALIASES[id as SettingsAlias];
    return { section: alias.section, anchor: alias.anchor };
  }
  return { section: "general", anchor: null };
}

export function settingsPageGroup(id: SettingsPage): SettingsPageGroup {
  return SECTION_PAGES.find((entry) => entry.id === id)?.group ?? "you";
}
