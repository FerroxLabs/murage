// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The ONE place the "Sign in with Flux" default lives. On since 1.0.11: the
// Flux desktop authorize and token routes are live in production (FluxMain,
// 2026-10-30). An explicit features.fluxDesktopSignin in config.json (true or
// false) always wins, so false still turns the button off on that computer.
export const FLUX_DESKTOP_SIGNIN_DEFAULT = true;

/** features is config.features (or undefined). fallback is injectable for tests. */
export function fluxDesktopSigninOn(features, fallback = FLUX_DESKTOP_SIGNIN_DEFAULT) {
  const value = features?.fluxDesktopSignin;
  return typeof value === "boolean" ? value : fallback;
}
