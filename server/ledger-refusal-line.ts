// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one line a refused turn is told with. It lives in a module that imports nothing, because spawned MCP proxies load it
// (through proxy-turn-release.ts) before they answer `initialize`: taking it from ledger-refusal.ts loaded the server's
// fence and lease graph into every proxy and made each list its tools late (nativecrash-g0-proxy-import-1019.test.ts).
export const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";

// 1.0.21 cause22: a turn its release budget ended (checking:retained-budget) lost no context: nothing was revoked or became unavailable,
// a counter filled. It is never told with the sentence above. The owner's own turn is not ended by that budget at all (release-budget.ts
// keepOwner); for every turn it still ends, this is the line. Structural: the verdict's two fixed words, nothing of the turn.
export const BUDGET_REFUSAL_LINE = "I stopped this turn because it grew past a safety limit. Nothing was removed from memory.";
/** cause22 r2: the one response header (value "retained-budget" only) by which a 409 tells a spawned proxy its turn was a budget stop. */
export const REFUSAL_KIND_HEADER = "x-murage-refusal";
export function refusalLineFor(verdict: { state?: unknown; reason?: unknown } | null | undefined): string {
  return verdict?.state === "checking" && verdict.reason === "retained-budget" ? BUDGET_REFUSAL_LINE : LEDGER_REFUSAL_LINE;
}
