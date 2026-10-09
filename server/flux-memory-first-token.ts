// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feeds the Flux Memory circuit breaker (PROPOSAL-v2 5.7) from one place: the turn dispatch notes that
// a Flux-routed turn started and whether recall was on, and the shared runtime-event fold reports the
// first assistant token. No engine needs its own hook.
import type { SendTurnInput } from "./contracts.ts";
import { fluxMemoryBreaker, fluxMemoryContextForTurn, fluxMemoryDecision, type FluxMemoryBreaker } from "./flux-memory-headers.ts";
import { isFluxModel } from "./flux-routing.ts";

interface Pending { injectOn: boolean; startedAt: number }

export class FluxFirstTokenProbe {
  private readonly pending = new Map<string, Pending>();
  private readonly options: { breaker?: FluxMemoryBreaker; now?: () => number };
  // No parameter property: the server runs under Node type stripping.
  constructor(options: { breaker?: FluxMemoryBreaker; now?: () => number } = {}) {
    this.options = options;
  }
  private now(): number { return (this.options.now ?? Date.now)(); }

  /** A turn is being dispatched. Only a turn that reaches Flux is measured. */
  begin(turn: Pick<SendTurnInput, "threadId" | "model" | "providerRoute" | "background" | "prewarm" | "warmIdentity">): void {
    const flux = turn.providerRoute ? turn.providerRoute.preset === "flux" : isFluxModel(turn.model);
    if (!flux || turn.prewarm) { this.pending.delete(turn.threadId); return; }
    const decision = fluxMemoryDecision(fluxMemoryContextForTurn(turn), this.options.breaker ? { breaker: this.options.breaker } : {});
    this.pending.set(turn.threadId, { injectOn: decision.inject === "on", startedAt: this.now() });
  }

  /** Every runtime event passes through here. The first assistant token settles the sample. */
  observe(event: { type: string; threadId: string; streamKind?: string }): void {
    const pending = this.pending.get(event.threadId);
    if (!pending) return;
    if (event.type === "content.delta" && event.streamKind === "assistant_text") {
      this.pending.delete(event.threadId);
      (this.options.breaker ?? fluxMemoryBreaker).record({ firstTokenMs: this.now() - pending.startedAt, injectOn: pending.injectOn });
    } else if (event.type === "turn.completed" || event.type === "session.exited") {
      this.pending.delete(event.threadId);
    }
  }
}

export const fluxFirstTokenProbe = new FluxFirstTokenProbe();
