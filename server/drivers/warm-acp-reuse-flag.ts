// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The grokwarm flag `warm.acpReuse` (design-1022-grokwarm r2, B2 and gate G), DEFAULT OFF.
// Owners: the setting = GROKWARM-1022 builder (Side M); its flip = MAIN (gate G, with the C6 relay-scope ruling).
// OFF: every ACP turn runs exactly as before the flag (no prompt id is sent, no frame is classified).
// ON: Fuigo parks only with the `fuigo/promptScope: 1` capability and a quiet turn. Method frames are classified by
// dispatch and prompt ID (B3). A MOUNTED handoff also
// needs `warm.s2r` ON (contract C1) and the per-turn relay admission (B5); until B5 ships a mounted process is retired
// before handoff whatever both flags say.
// WARM-FUIGO-1022 (MAIN-RULING warm-grok-vs-fuigo): eligibility is the Fuigo row (`fuigoAgent`) only; the Grok row never
// reuses a process. The flip also waits on Sean's D1/D2 conditions (direct-parent check, W-MAC and W-WIN real-CLI runs);
// until MAIN records them the setting stays unwritten and reads OFF.
// Stored in config.json `features.warmAcpReuse`; only an explicit `true` turns it on.

let source: () => unknown = () => undefined;

export function warmAcpReuseFromFeatures(features: unknown): boolean {
  return (features as Record<string, unknown> | undefined)?.warmAcpReuse === true;
}

/** Read live at every dispatch (the server points it at its config); a throw reads OFF. */
export function warmAcpReuseOn(): boolean {
  try { return warmAcpReuseFromFeatures(source()); } catch { return false; }
}

/** `features` is the config.json `features` object (or a test's stand-in). */
export function setWarmAcpReuseSource(features: () => unknown): void { source = features; }
