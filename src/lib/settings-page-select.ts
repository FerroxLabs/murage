// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone page selector (SettingsModal): one name per page, the same one the breadcrumb uses, and names that never
// break mid-word. A select shows only what fits; this shortens a long name at a word boundary with an ellipsis, and the
// option keeps the full name as its accessible label.
import { t } from "./i18n";
import { settingsPageLabel } from "./settings-sections";

/** About two thirds of a 390 px row at the selector text size. */
export const PAGE_SELECT_MAX_CHARS = 22;

/** Shorten at the last word boundary that fits, then add an ellipsis. One very long word is cut at the limit. */
export function truncateAtWord(name: string, max: number = PAGE_SELECT_MAX_CHARS): string {
  const clean = name.trim();
  if (clean.length <= max) return clean;
  const room = max - 1;
  const head = clean.slice(0, room + 1);
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : clean.slice(0, room);
  return cut.replace(/[\s,.;:-]+$/, "") + "…";
}

/** The page contract names the messaging page "Messaging apps" when it was asked for as channels; the selector says the same. */
export function selectorPageLabel(id: string, requested: string | null | undefined): string {
  return id === "connections" && requested === "channels" ? t("settings.page.channels") : settingsPageLabel(id as Parameters<typeof settingsPageLabel>[0]);
}
