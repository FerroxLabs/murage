// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The D1 flag `warm.s2r` (design WARM-W1 r3.5, section (g) HARD GATE and OWNERS):
// one setting for mounted Claude S2-R and mounted Codex reuse, DEFAULT OFF.
// Owners: the setting and its flip = WARM-DRIVER builder + MAIN (Sean D1 G1-G5);
// the Codex and ACP reads of it = WARM-CODEX builder.
// OFF: every mounted Codex and ACP turn is single use, exactly as before the flag.
// ON: a mounted Codex app-server may serve the next mounted turn of its thread,
// proved per turn (codex.ts). Mounted ACP reuse stays PARKED in W1 whatever
// this says: a mounted ACP process is retired before handoff (F8).
// Stored in config.json `features.warmS2r`; only an explicit `true` turns it on.

let source: () => unknown = () => undefined;

export function warmS2rFromFeatures(features: unknown): boolean {
  return (features as Record<string, unknown> | undefined)?.warmS2r === true;
}

/** Read live at every dispatch (the server points it at its config); a throw reads OFF. */
export function warmS2rOn(): boolean {
  try { return warmS2rFromFeatures(source()); } catch { return false; }
}

/** `features` is the config.json `features` object (or a test's stand-in). */
export function setWarmS2rSource(features: () => unknown): void { source = features; }
