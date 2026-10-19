// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The ONE place the "Sign in with Flux" default lives. Flip this constant to
// ship the button on; an explicit features.fluxDesktopSignin in config.json
// (true or false) always wins.
export const FLUX_DESKTOP_SIGNIN_DEFAULT = false;

/** features is config.features (or undefined). fallback is injectable for tests. */
export function fluxDesktopSigninOn(features, fallback = FLUX_DESKTOP_SIGNIN_DEFAULT) {
  const value = features?.fluxDesktopSignin;
  return typeof value === "boolean" ? value : fallback;
}
