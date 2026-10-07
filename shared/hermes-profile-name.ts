// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hermes' own profile id rule (`hermes_cli/profiles.py` `_PROFILE_ID_RE`),
// shared by the server and the renderer. A name is never used to build a
// path, an instance id or a command without passing this.
export const HERMES_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_HERMES_PROFILE = "default";
/** The instance id prefix Import from Hermes gives a profile's engine. The
 * design named it `hermes@<profile>`, but every instance route, the model
 * selection checks and the restore gate take ids of `[\w-]` only, so an `@`
 * id could not be switched off in Settings or survive a restore (0.1.61
 * audit, Astra 1 and 5). Profile names are `[a-z0-9_-]`, so this stays in. */
export const HERMES_INSTANCE_PREFIX = "hermes-profile-";

export function isHermesProfileName(value: unknown): value is string {
  return typeof value === "string" && HERMES_PROFILE_NAME.test(value);
}

/** The part of a Hermes instance's config a backup and a restore carry: the
 * profile it runs (identity, not a credential or a grant). Anything else in
 * the config still needs review, so it is dropped. Undefined when the entry
 * is not a Hermes engine or names no valid profile. */
export function hermesProfileCarry(driver: unknown, config: unknown): { profile: string; profileOrigin?: "sticky" } | undefined {
  if (driver !== "hermesAgent" || !config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const { profile, profileOrigin } = config as { profile?: unknown; profileOrigin?: unknown };
  if (!isHermesProfileName(profile)) return undefined;
  return profileOrigin === "sticky" ? { profile, profileOrigin } : { profile };
}
