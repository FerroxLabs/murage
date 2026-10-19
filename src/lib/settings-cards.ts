// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The card registry and the one Advanced section (SETTINGS-REDESIGN.md r2.4,
// r2.5, r1 B.2 and B.5). Frozen by I0 (SETTINGS-LANES.md): every Settings card
// registers one SettingsCard; search lists cards and rows, never pages; an
// opener resolves an alias to {section, anchor} and opens Advanced first when
// the anchor's card is advanced. Lanes L1 to L6 register their own cards; only
// I0's owner changes these types.
//
// Loaded with the modal and the palette, never on the first paint (the words).
import type { ReactNode } from "react";
import type { SettingsPage } from "./settings-pages";

export type SettingsCardSurface = "desktop" | "any";

export interface SettingsCard {
  /** Unique across the registry, kebab-case: "general.about-me", "memory.ceiling". */
  id: string;
  /** The page it renders on. */
  section: SettingsPage;
  /** True when it renders inside the page's AdvancedSection. */
  advanced: boolean;
  /** "desktop": rendered and searchable only when the surface is the confirmed desktop (`desktop === true`). */
  surface: SettingsCardSurface;
  /** What a person might type to find it: matched, never shown (copy-rules.test.ts reads them as keywords). */
  words: readonly string[];
  /** The DOM id the card renders on its heading or row; unique; openers scroll to it and focus it. */
  anchor: string;
}

/** The one Advanced level of a page: at the bottom, one toggle, the label is always "Advanced".
 *  Controlled by the modal so an opener can open it before scrolling to an advanced anchor. */
export interface AdvancedSectionProps {
  section: SettingsPage;
  /** One line after "Advanced · " naming what is inside, e.g. "Start at login, keep running in the background, usage analytics, sidebar density". */
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** DOM id of a page's Advanced region; the toggle's aria-controls. */
export const advancedRegionId = (section: SettingsPage) => `settings-advanced-${section}`;

/** The cards this surface may see: `undefined` (not answered yet) withholds desktop cards, like sectionsForSurface. */
export function cardsForSurface<T extends Pick<SettingsCard, "surface">>(cards: readonly T[], desktop: boolean | undefined): T[] {
  return desktop === true ? [...cards] : cards.filter((card) => card.surface === "any");
}

/** The card that renders `anchor`, for an opener deciding whether to open Advanced first. */
export function cardForAnchor<T extends Pick<SettingsCard, "anchor">>(cards: readonly T[], anchor: string): T | undefined {
  return cards.find((card) => card.anchor === anchor);
}

/** Registry invariants, for each lane's test: unique ids, unique anchors, at least one word each. Returns the problems found. */
export function settingsCardProblems(cards: readonly SettingsCard[]): string[] {
  const problems: string[] = [], ids = new Set<string>(), anchors = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) problems.push(`duplicate id ${card.id}`);
    if (anchors.has(card.anchor)) problems.push(`duplicate anchor ${card.anchor}`);
    if (!card.words.length) problems.push(`${card.id} has no words`);
    if (!/^[a-z][a-zA-Z0-9-]*(\.[a-z0-9-]+)+$/.test(card.id)) problems.push(`${card.id} is not section.name`);
    ids.add(card.id);
    anchors.add(card.anchor);
  }
  return problems;
}
