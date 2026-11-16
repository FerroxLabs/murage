// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one door every Flux dispatch goes through (UX-L2C-PAUSE r4 2.2, r5 1.2). A call carries the key it is about to send;
// a call inside an admitted turn is entitled only while that turn's permission matches this key's account, anything else
// is a start and meets the gate. Until index.ts installs the gate (and in every test) the door is open, which is also
// what the pause-off path does.
import type { SpendGate } from "./spend-gate.ts";

let installed: SpendGate | null = null;
export function installFluxStartGate(gate: SpendGate | null): void { installed = gate; }

/** Await right before a Flux request, with the key being sent (omit for the account key). Throws SpendGateRefusal (code "spend_limit") when held. */
export async function authorizeFluxDispatch(key?: string | null): Promise<void> {
  if (installed) await installed.authorizeFluxDispatch(key);
}

/** A Flux 402 body from a transport, with the key the request was sent with: arms the scoped refusal (spend-gate.ts). */
export function reportFlux402(rawBody: string, key?: string | null): void {
  if (!installed) return;
  try { installed.onBudgetReached(JSON.parse(rawBody), key); } catch { /* not JSON: today's behavior */ }
}
