// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The App Settings sections and their groups.
//
// Plain data, apart from the modal, so the store (normalizeSettingsSection),
// the command palette and the modal read one list. The modal is its own lazy
// chunk; this file rides the first paint, so it holds no icons, no components
// and no search words (those are lib/settings-search.ts, loaded with the
// modal or when the palette opens).
//
// Ids are a contract. They arrive from deep links all over the app, from the
// What's new tiles and from server-sent announcements (lib/announcements.ts),
// so an id is never removed or renamed: a label can change, the id stays.
// 0.1.62 added botDefaults, images, webSearch, voice and about.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type AppSettingsGroup = "you" | "bots" | "models" | "tools" | "channels" | "app";

export type AppSettingsSection =
  | "general"
  | "aboutMe"
  | "botDefaults"
  | "houseRules"
  | "skills"
  | "memory"
  | "models"
  | "engines"
  | "images"
  | "webSearch"
  | "voice"
  | "connections"
  | "computer"
  | "channels"
  | "companion"
  | "backups"
  | "usage"
  | "about"
  | "experimental";

export interface SettingsSectionEntry {
  id: AppSettingsSection;
  group: AppSettingsGroup;
  /** Hidden on any surface that is not the confirmed desktop. */
  desktopOnly?: boolean;
}

export const SETTINGS_GROUPS: readonly AppSettingsGroup[] = ["you", "bots", "models", "tools", "channels", "app"];

// `desktopOnly` is not a tidiness flag. Most of these are the credential and
// execution surface of the app: API keys, the VPS connection, the engine CLI
// installers, the local VM controls. A paired phone was rendering every one
// of them: readable, editable, on a device that is only supposed to be able
// to read conversations. The door already refuses the routes behind them, so
// nothing could execute, but a key on screen is a key disclosed.
//
// Phone is here for a different reason: on a phone it is an offer to do the
// thing you have already done.
export const SETTINGS_SECTIONS: readonly SettingsSectionEntry[] = [
  { id: "general", group: "you" },
  { id: "aboutMe", group: "you", desktopOnly: true },
  { id: "botDefaults", group: "bots", desktopOnly: true },
  { id: "houseRules", group: "bots", desktopOnly: true },
  { id: "skills", group: "bots", desktopOnly: true },
  { id: "memory", group: "bots", desktopOnly: true },
  { id: "models", group: "models", desktopOnly: true },
  { id: "engines", group: "models", desktopOnly: true },
  { id: "images", group: "tools", desktopOnly: true },
  { id: "webSearch", group: "tools", desktopOnly: true },
  { id: "voice", group: "tools", desktopOnly: true },
  { id: "connections", group: "tools", desktopOnly: true },
  { id: "computer", group: "tools", desktopOnly: true },
  { id: "channels", group: "channels", desktopOnly: true },
  { id: "companion", group: "channels", desktopOnly: true },
  { id: "backups", group: "app", desktopOnly: true },
  { id: "usage", group: "app" },
  { id: "about", group: "app" },
  { id: "experimental", group: "app", desktopOnly: true },
];

const SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((entry) => entry.id));

/** The one door every section request goes through (store.tsx). A known id
 *  passes as it is; anything else, a stale stored value or a target this
 *  build does not know, lands on General rather than on nothing. When an id
 *  is ever renamed, its alias goes here. */
export function normalizeSettingsSection(id: unknown): AppSettingsSection {
  return typeof id === "string" && SECTION_IDS.has(id) ? (id as AppSettingsSection) : "general";
}

export function settingsSectionLabel(id: AppSettingsSection): string {
  return t(`settings.section.${id}` as LocaleKey);
}

export function settingsGroupLabel(group: AppSettingsGroup): string {
  return t(`settings.group.${group}` as LocaleKey);
}

/** One plain line under a page's title: what the page is for. */
export function settingsSectionNote(id: AppSettingsSection): string {
  return t(`settings.pageNote.${id}` as LocaleKey);
}

/** One plain line for a group heading's tooltip. */
export function settingsGroupNote(group: AppSettingsGroup): string {
  return t(`settings.groupNote.${group}` as LocaleKey);
}

export function settingsSectionGroup(id: AppSettingsSection): AppSettingsGroup {
  return SETTINGS_SECTIONS.find((entry) => entry.id === id)?.group ?? "you";
}

/** The sections this surface may see.
 *
 * `undefined` (the surface has not answered yet) withholds the desktop-only
 * ones. Neutral is the narrow side: showing an API key for one frame and then
 * hiding it has already disclosed it, and a section appearing a moment late on
 * the desktop costs nothing. */
export function sectionsForSurface<T extends Pick<SettingsSectionEntry, "id" | "desktopOnly">>(
  sections: readonly T[],
  desktop: boolean | undefined,
): T[] {
  return desktop === true ? [...sections] : sections.filter((entry) => !entry.desktopOnly);
}

/** Where Settings moves when the open section is not on offer, or null to
 * stay. While the surface has not answered, a desktop-only section is waited
 * on, not left: the Flux card's "Open Flux Router in Models" pressed in the
 * first moments landed on General for good (0.1.61 CI, flux-entrypoints). */
export function settingsSectionRedirect<T extends Pick<SettingsSectionEntry, "id" | "desktopOnly">>(
  sections: readonly T[],
  section: AppSettingsSection,
  desktop: boolean | undefined,
  visible: readonly T[],
  confirmed = desktop !== undefined,
): AppSettingsSection | null {
  if (visible.some((entry) => entry.id === section)) return null;
  // A fallback false after a failed ask is not a phone either (0.1.61 audit).
  if ((desktop === undefined || !confirmed) && sections.some((entry) => entry.id === section && entry.desktopOnly)) return null;
  return visible[0]?.id ?? null;
}
