// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.19 Settings pages: 13 sidebar pages plus the Messaging tab under Apps, under six
// headings, "Each bot" (your bots, under You) having no page of its own here: its rows are bots, and past five of them
// one list page, Browse bots (BROWSE_BOTS_ROUTE, not one of the 13).
//
// Every one of the 20 older section ids stays valid for good (deep links, What's new tiles, published
// announcements): the 13 are pages, the rest are aliases that land on a page and an anchor on it. Plain data, no words
// and no components: it rides the first paint like lib/settings-sections.ts.
//
// Pages are filled through the contract in SETTINGS-SHELL-CONTRACT-1019.md (components/settings/page-registry.tsx):
// this file is the shell's and changes only with the shell.
import type { AppSettingsSection } from "./settings-sections";

/** Headings in sidebar order. "bots" is Each bot: bot rows, no pages. */
export type SettingsPageGroup = "you" | "bots" | "allBots" | "ai" | "reach" | "app";

export type SettingsPage =
  | "general"
  | "calls"
  | "botDefaults"
  | "skills"
  | "memory"
  | "models"
  | "webSearch"
  | "connections"
  | "computer"
  | "companion"
  | "backups"
  | "usage"
  | "about";

/** The list page past five bots (section 2.1). A route, not one of the 13 pages. */
export const BROWSE_BOTS_ROUTE = "browseBots" as const;

export type SettingsAlias = Exclude<AppSettingsSection, SettingsPage | typeof BROWSE_BOTS_ROUTE>;

export interface SettingsPageEntry {
  id: SettingsPage;
  group: SettingsPageGroup;
  /** Hidden on any surface that is not the confirmed desktop (same rule as sectionsForSurface). */
  desktopOnly?: boolean;
  /** Shown in Simple mode (LOCKED 2.5: about seven). The single place that says which pages Simple has. */
  simple: boolean;
}

export const SETTINGS_PAGE_GROUPS: readonly SettingsPageGroup[] = ["you", "bots", "allBots", "ai", "reach", "app"];

/** Sidebar order. Labels: General, Calls; How every bot behaves, Skills, Memory; Models & engines, Search, images and
 *  dictation; Connected apps (including Messaging), Computer & browser, Phone and other devices; Backups, Usage, About & help. */
export const SECTION_PAGES: readonly SettingsPageEntry[] = [
  { id: "general", group: "you", simple: true },
  // Desktop only until its phone classification ships with the page builder (LOCKED 2.4: a phone gets Calls as a page).
  { id: "calls", group: "you", desktopOnly: true, simple: false },
  { id: "botDefaults", group: "allBots", desktopOnly: true, simple: false },
  { id: "skills", group: "allBots", desktopOnly: true, simple: false },
  { id: "memory", group: "allBots", desktopOnly: true, simple: false },
  { id: "models", group: "ai", desktopOnly: true, simple: true },
  { id: "webSearch", group: "ai", desktopOnly: true, simple: false },
  { id: "connections", group: "reach", simple: true },
  { id: "computer", group: "reach", desktopOnly: true, simple: true },
  { id: "companion", group: "reach", desktopOnly: true, simple: true },
  { id: "backups", group: "app", desktopOnly: true, simple: true },
  { id: "usage", group: "app", simple: true },
  { id: "about", group: "app", simple: true },
];

export interface SettingsTarget { section: SettingsPage; anchor: string | null }

/** An old id to the page and the anchor it lands on. The anchor is a DOM id the target card renders; when that card is
 *  `advanced` (settings-cards.ts) the opener opens the page's Advanced section first, then scrolls and focuses.
 *  `computer` became a page of its own in 1.0.19; `images` and `voice` are sections of Search, images and dictation. */
export const SECTION_ALIASES: Readonly<Record<SettingsAlias, { section: SettingsPage; anchor: string }>> = {
  channels: { section: "connections", anchor: "telegram-settings-title" },
  aboutMe: { section: "general", anchor: "about-me-heading" },
  houseRules: { section: "botDefaults", anchor: "house-rules-heading" },
  engines: { section: "models", anchor: "engines-heading" },
  images: { section: "webSearch", anchor: "image-settings-heading" },
  voice: { section: "webSearch", anchor: "voice-settings-heading" },
  // Keep published links working after the controls moved into regular Settings.
  experimental: { section: "skills", anchor: "skill-recorder-heading" },
  // 1.0.3 attachment storage (fix/103-attachment-cap): the Storage card sits on the Backups page
  storage: { section: "backups", anchor: "storage-heading" },
};

const PAGE_IDS = new Set<string>(SECTION_PAGES.map((entry) => entry.id));

export function isSettingsPage(id: unknown): id is SettingsPage {
  return typeof id === "string" && PAGE_IDS.has(id);
}

/** Any section id, or anything else, to where it lands. Unknown input lands on General, as normalizeSettingsSection does.
 *  Browse bots is a route (BROWSE_BOTS_ROUTE), not a page: the modal reads it by name before this, so here it is General. */
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

/** The pages Simple shows, in sidebar order. */
export function simplePages(): SettingsPage[] {
  return SECTION_PAGES.filter((entry) => entry.simple).map((entry) => entry.id);
}

/** True when `id` (a page or any older id) lands on a page Simple shows. Browse bots is always on offer. */
export function isSimpleTarget(id: unknown): boolean {
  if (id === BROWSE_BOTS_ROUTE) return true;
  const page = resolveSettingsSection(id).section;
  return SECTION_PAGES.find((entry) => entry.id === page)?.simple === true;
}
