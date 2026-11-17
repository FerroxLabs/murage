// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TurnIdentity } from "./types.ts";

// Natural completion hands already attached cards back to their durable queue.
// Keep this host lifecycle operation separate from the frozen cancellation API:
// Stop, deletion and posture changes always cancel every matching request.
let retire: ((identity: TurnIdentity) => Promise<void>) | undefined;

export function installGenerationRetirement(handler: (identity: TurnIdentity) => Promise<void>): void {
  retire = handler;
}

export function completeDecisionGeneration(identity: TurnIdentity): Promise<void> {
  if (!retire) throw new Error("decision-retirement-unavailable");
  return retire(identity);
}
