// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The contract every Settings page plugs into (SETTINGS-SHELL-CONTRACT-1019.md). Types and pure rules only, no
// components and no words: the page files and the shell both read it, and it rides no first paint.
import type { ReactNode } from "react";
import type { SettingsMode } from "./settings-mode";
import { SECTION_PAGES, type SettingsPage } from "./settings-pages";

/** What the shell hands every page. */
export interface SettingsPageProps {
  page: SettingsPage;
  /** Simple or Advanced, already read for the page (a page never reads the store for it). */
  mode: SettingsMode;
  /** `true` the confirmed desktop, `false` a phone or paired browser, `undefined` not answered yet (treat as neutral). */
  desktop: boolean | undefined;
  /** A Cloud window (lib/cloud-workspace.isCloudOrigin). */
  cloud: boolean;
  /** The card anchor an opener named, or null. The shell scrolls and focuses; a page only needs it to open a closed part of its own. */
  anchor: string | null;
}

/** One card on a page, as data: the shell and the tests can count, filter and find it without rendering anything. */
export interface SettingsPageCard {
  /** The registry id (lib/settings-card-registry.ts), "section.name". */
  id: string;
  /** The DOM id the card renders (the registry's `anchor`); the slot wraps the card in it. */
  anchor: string;
  /** Shown in Simple mode. A card is never copied for Simple: Simple shows fewer cards, never different ones. */
  simple: boolean;
  /** Renders the card, or its stub (never null: SETTINGS-LOCKED-1019.md 2.3). Called only when the card is shown. */
  render: () => ReactNode;
}

/** The cards Simple or Advanced shows, in page order, and how many Simple left out (the "Set in Advanced" line's count). */
export function visibleCards<T extends Pick<SettingsPageCard, "simple">>(cards: readonly T[], mode: SettingsMode): { shown: T[]; hidden: number } {
  if (mode === "advanced") return { shown: [...cards], hidden: 0 };
  const shown = cards.filter((card) => card.simple);
  return { shown, hidden: cards.length - shown.length };
}

/** Registry invariants for a page's card list, for each page builder's test. Returns the problems found. */
export function pageCardProblems(page: SettingsPage, cards: readonly SettingsPageCard[], registry: ReadonlyArray<{ id: string; section: SettingsPage; anchor: string }>): string[] {
  const problems: string[] = [], ids = new Set<string>();
  for (const card of cards) {
    const entry = registry.find((each) => each.id === card.id);
    if (!entry) problems.push(`${card.id} is not in the card registry`);
    else {
      if (entry.section !== page) problems.push(`${card.id} is registered on ${entry.section}, not ${page}`);
      if (entry.anchor !== card.anchor) problems.push(`${card.id} renders anchor ${card.anchor}, the registry says ${entry.anchor}`);
    }
    if (ids.has(card.id)) problems.push(`duplicate ${card.id}`);
    ids.add(card.id);
  }
  for (const entry of registry) if (entry.section === page && !ids.has(entry.id)) problems.push(`${entry.id} is registered on ${page} and the page does not list it`);
  const simplePage = SECTION_PAGES.find((each) => each.id === page)?.simple === true;
  if (simplePage && !cards.some((card) => card.simple)) problems.push(`${page} is a Simple page and lists no Simple card`);
  if (!simplePage && cards.some((card) => card.simple)) problems.push(`${page} is not a Simple page, so none of its cards can be Simple`);
  return problems;
}
