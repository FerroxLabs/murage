// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-time note 0.1.61 leaves in a Hermes bot's chat when its engine was
// pinned to the profile Hermes' own sticky default had been running (owner
// decision O12, server/hermes-profiles.ts). Like a host stop or a folder-trust
// notice it is one activity message whose tool name carries this prefix: a
// neutral row, visible with Settings > Tool calls off, never an error card,
// and never part of what the model reads.
import { isHermesProfileName } from "./hermes-profile-name.ts";

export const HERMES_PIN_NOTE_PREFIX = "hermes profile pinned:";

export function hermesPinNoteActivityName(profile: string): string {
  return `${HERMES_PIN_NOTE_PREFIX} ${profile}`;
}

/** The profile a pin note names, or undefined for any other activity. */
export function hermesPinNoteProfile(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(HERMES_PIN_NOTE_PREFIX)) return undefined;
  const profile = name.slice(HERMES_PIN_NOTE_PREFIX.length).trim();
  return isHermesProfileName(profile) ? profile : undefined;
}

/** The sentence the chat shows for the note (ChatView). */
export function hermesPinNoteText(profile: string): string {
  return `Murage now starts Hermes with a named profile. This bot keeps running your Hermes profile "${profile}", the one it has been using. You can add your other Hermes profiles as bots from New bot, Import from Hermes.`;
}
