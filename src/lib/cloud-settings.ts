// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP6: Settings when the window points at a Cloud home (murage-home://).
//
// The Cloud window has no window.muragebox. Its bridge (preload-cloud.cjs) refuses credential:set, model-signin:*,
// backup-*, companion:*, mcp-servers:*, desktop:pick-folder, engine terminals and cua:*. And the home answers
// /api/config with surface "desktop" to an owner-desktop session, so the Settings modal would otherwise list every
// desktop-only page, and most of those pages end in a button that needs the local computer. Every section has one
// class here; a test fails on an unclassified section.
//
//   home           Saves through /api/* to the home. Works as it does on the desktop.
//   mixed          Works, except the named cards that need this computer (hidden in the Cloud window).
//   computer-only  Needs this computer (local keys, terminals, folders, backups, phone pairing). The page shows
//                  "On your computer only" and points the person to the "This computer" workspace.
import { isCloudOrigin } from "./cloud-workspace";
import { SECTION_ALIASES } from "./settings-pages";
import type { SettingsCard } from "./settings-cards";
import type { AppSettingsSection } from "./settings-sections";

export type CloudSettingsClass = "home" | "mixed" | "computer-only";

export const CLOUD_SETTINGS_CLASS: Readonly<Record<AppSettingsSection, CloudSettingsClass>> = Object.freeze({
  // Startup (login item) and Set up again are this computer's; profile, appearance, language, notifications are not.
  general: "mixed",
  aboutMe: "home",
  botDefaults: "home",
  houseRules: "home",
  skills: "mixed",
  memory: "home",
  // API keys, Flux and provider connections are stored by this computer's encrypted credential store (credential:set,
  // model-signin:* are refused from the Cloud window); a home's own sign-ins are made from the connect screen.
  models: "computer-only",
  engines: "computer-only",
  images: "home",
  webSearch: "computer-only",
  voice: "computer-only",
  // The Apps card works; the local MCP servers button (mcp-servers:*) does not.
  connections: "mixed",
  computer: "computer-only",
  channels: "computer-only",
  companion: "computer-only",
  backups: "computer-only",
  // The free space and attachments of this computer's data folder (1.0.3).
  storage: "computer-only",
  usage: "home",
  // The updater and diagnostics export are this computer's.
  about: "mixed",
  // Legacy link to the skill recorder, which runs on this computer.
  experimental: "computer-only",
});

export const ON_YOUR_COMPUTER_ONLY = "On your computer only";
export const ON_YOUR_COMPUTER_ONLY_DETAIL =
  "This page changes things on this computer, so it is not available while you are in your Cloud home. Switch to \"This computer\" to use it.";

/** True when `section` must not render its controls in this window. */
export function cloudSectionBlocked(section: AppSettingsSection, cloud: boolean = isCloudOrigin()): boolean {
  return cloud && CLOUD_SETTINGS_CLASS[section] === "computer-only";
}

/** The cards on a page a Cloud window renders that still need this computer, by anchor. SettingsModal hides each one with
 *  cloudCardHidden and search leaves them out through cloudCardBlocked, so the two never disagree. */
export const CLOUD_COMPUTER_ONLY_CARDS: ReadonlySet<string> = new Set([
  "startup-heading", // General: start at login is this computer's login item.
  "setup-heading", // About: Set up again walks this computer's first run.
  "updates-heading", // About: the updater is this computer's (the Cloud window has no window.muragebox).
  "diagnostics-heading", // About: the diagnostics export is this computer's.
  "skill-recorder-heading", // Skills: the recorder runs on this computer.
  "mcp-servers-heading", // Connected apps: this computer's MCP servers (mcp-servers:*).
]);

/** True when the card rendering `anchor` needs this computer and this is a Cloud window. */
export function cloudCardHidden(anchor: string, cloud: boolean = isCloudOrigin()): boolean {
  return cloud && CLOUD_COMPUTER_ONLY_CARDS.has(anchor);
}

/** True when `card` sits on a page this window cannot use, or is one of this computer's cards on a page it can
 *  (CLOUD_COMPUTER_ONLY_CARDS). A card an old id points at (Images on the Tools page) takes that
 *  id's class, so the one Cloud-usable card on a computer-only page stays listed, as SettingsModal renders it. */
export function cloudCardBlocked(card: Pick<SettingsCard, "section" | "anchor">, cloud: boolean = isCloudOrigin()): boolean {
  if (!cloud) return false;
  const alias = (Object.keys(SECTION_ALIASES) as Array<keyof typeof SECTION_ALIASES>).find((id) => SECTION_ALIASES[id].anchor === card.anchor);
  return cloudCardHidden(card.anchor, true) || cloudSectionBlocked(alias ?? card.section, true);
}
