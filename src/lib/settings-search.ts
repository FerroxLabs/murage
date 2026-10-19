// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words that find each Settings page: the Settings search box, and the
// command palette's Settings group ("images" jumps to Settings > Images).
// Apart from lib/settings-sections.ts so the words stay out of the first
// paint: the modal is a lazy chunk, and the palette loads this when it opens.
//
// 1.0.3: the words live on the cards (lib/settings-card-registry.ts) and a
// card that moves takes its words with it. Search lists cards and rows, never
// pages (searchSettingsCards); the palette still matches a section by its
// label, its group's name and the words of the cards that section names.
import { cloudCardBlocked } from "./cloud-settings";
import { isCloudOrigin } from "./cloud-workspace";
import { SECTION_ALIASES, SECTION_PAGES } from "./settings-pages";
import { cardsForSurface, type SettingsCard } from "./settings-cards";
import { SETTINGS_CARDS, cardLabel } from "./settings-card-registry";
import {
  SETTINGS_SECTIONS,
  settingsGroupLabel,
  settingsPageLabel,
  settingsSectionLabel,
  type AppSettingsSection,
  type SettingsSectionEntry,
} from "./settings-sections";

const PAGE_IDS = new Set<string>(SECTION_PAGES.map((entry) => entry.id));

/** The words that find a section: a page takes the words of its own cards, an alias the words of the card it lands on. */
function wordsFor(id: AppSettingsSection): readonly string[] {
  const alias = (SECTION_ALIASES as Readonly<Record<string, { section: string; anchor: string }>>)[id];
  if (alias) return SETTINGS_CARDS.filter((card) => card.anchor === alias.anchor).flatMap((card) => card.words);
  if (!PAGE_IDS.has(id)) return [];
  const aliasAnchors = new Set(Object.values(SECTION_ALIASES).map((entry) => entry.anchor));
  return SETTINGS_CARDS.filter((card) => card.section === id && !aliasAnchors.has(card.anchor)).flatMap((card) => card.words);
}

export const SETTINGS_KEYWORDS = Object.fromEntries(SETTINGS_SECTIONS.map((entry) => [entry.id, wordsFor(entry.id)])) as Readonly<Record<AppSettingsSection, readonly string[]>>;

/** True when `query` (already trimmed and lower-cased) finds this section. */
export function settingsSectionMatches(section: Pick<SettingsSectionEntry, "id" | "group">, query: string): boolean {
  if (!query) return true;
  return [settingsSectionLabel(section.id), settingsGroupLabel(section.group), ...SETTINGS_KEYWORDS[section.id]]
    .some((part) => part.toLowerCase().includes(query));
}

/** The desktop sections the settings search box keeps for `query`. */
export function settingsSearchResults(query: string): AppSettingsSection[] {
  const q = query.trim().toLowerCase();
  return SETTINGS_SECTIONS.filter((entry) => settingsSectionMatches(entry, q)).map((entry) => entry.id);
}

export interface SettingsSearchHit {
  card: SettingsCard;
  label: string;
  /** "Bots > Advanced" style path, as plain parts. */
  page: string;
  advanced: boolean;
}

/** The cards (and rows) a query finds: first by name, then by the words people type, then by the page's own name.
 *  `cardsForSurface` first, so a phone or browser door never lists a desktop card's row, and nothing while `desktop`
 *  is still undefined. In a Cloud window a card on a page SettingsModal blocks there is not listed (cloudCardBlocked). */
export function searchSettingsCards(
  query: string,
  desktop: boolean | undefined,
  cards: readonly SettingsCard[] = SETTINGS_CARDS,
  labelOf: (card: SettingsCard) => string = cardLabel,
  pageLabelOf: (page: SettingsCard["section"]) => string = settingsPageLabel,
  cloud: boolean = isCloudOrigin(),
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<{ hit: SettingsSearchHit; rank: number; at: number }> = [];
  cardsForSurface(cards, desktop).filter((card) => !cloudCardBlocked(card, cloud)).forEach((card, at) => {
    const label = labelOf(card), page = pageLabelOf(card.section);
    const rank = label.toLowerCase().includes(q) ? 0 : card.words.some((word) => word.toLowerCase().includes(q)) ? 1 : page.toLowerCase().includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ hit: { card, label, page, advanced: card.advanced }, rank, at });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.at - b.at).map((entry) => entry.hit);
}
