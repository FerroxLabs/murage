// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The roster capability vocabulary (SPEC-P 13.3): the tags a card's `needs`
// list may use and a roster line may name. `app:<slug>` names a connected
// app by its slug and is owner-audience material when shown.
/** The fixed tags. `app:<slug>` entries are accepted by the matcher. */
export const PROJECT_CAPABILITY_TAGS = ["files", "shell", "browser", "computer", "images", "vision", "web"] as const;

const APP_TAG = /^app:[a-z0-9][a-z0-9-]{0,63}$/;

/** A tag is one of the fixed words or an `app:<slug>` reference. */
export function isProjectCapabilityTag(tag: string): boolean {
  return (PROJECT_CAPABILITY_TAGS as readonly string[]).includes(tag) || APP_TAG.test(tag);
}
