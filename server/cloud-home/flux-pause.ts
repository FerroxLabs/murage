// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: the pause check every Flux route runs. Kept apart from flux-home-gate.ts because
// flux-routing.ts is in the browser bundle (src/lib/model-metadata.ts) and the gate pulls
// in undici and node:crypto, so nothing here may import more than the copy table.
import { cloudHomeCopy } from "./copy.ts";

export type FluxHomeState = "unknown" | "no-key" | "ok" | "capped" | "stopped" | "revoked" | "ip_refused" | "unavailable" | "invalid";
export interface FluxPause {
  paused: boolean;
  state: FluxHomeState;
  /** Plain words for the customer (ours, never the router's), or null while not paused. */
  message: string | null;
  checkedAt: number | null;
  capMicrocents?: number;
  spentMicrocents?: number;
  resetsAt?: string;
}

let source: (() => FluxPause) | null = null;

/** The gate registers its reader at home start and clears it at stop. */
export function setFluxPauseSource(next: (() => FluxPause) | null): void {
  source = next;
}

export function fluxHomePause(): FluxPause {
  return source ? source() : { paused: false, state: "unknown", message: null, checkedAt: null };
}

/** Throws the owner-facing message when this home's Flux use is paused. A no-op
 *  off a Cloud home and while Flux has not said otherwise. */
export function assertFluxNotPaused(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MURAGE_CLOUD_ROLE !== "home") return;
  const pause = fluxHomePause();
  if (pause.paused) throw new Error(pause.message ?? cloudHomeCopy.fluxPausedUnavailable);
}
