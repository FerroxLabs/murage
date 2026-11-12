// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Producers report observations, never permission. A complete observation with
 * no effect is the only clean result. Failure is monotone under composition. */
export type EffectClass = "root" | "home" | "system" | "disk" | "fork" | "word";
export type ReaderVerdict =
  | { state: "clean"; producer: string }
  | { state: "cut"; producer: string; mandatory?: true }
  | { state: "effect"; producer: string; cls: EffectClass; mandatory?: true };
export const cleanRead = (producer: string): ReaderVerdict => ({ state: "clean", producer });
export const cutRead = (producer: string): ReaderVerdict => ({ state: "cut", producer });
export function observed(producer: string, cls: EffectClass | "cut" | ""): ReaderVerdict {
  return cls === "cut" ? cutRead(producer) : cls ? { state: "effect", producer, cls } : cleanRead(producer);
}
export type FinalDecision =
  | { verdict: "run"; cls: ""; approve: string }
  | { verdict: "card"; cls: EffectClass | "cut"; approve: null };
/** Conservative parser oracle only. Product permission is decided by the
 * registered server decision API; no actor/level gate is exported here. */
export function readerOracle(reads: readonly ReaderVerdict[], tool = 'tool'): FinalDecision {
  for (const cls of ['root','home','system','disk','fork','word'] as const) if (reads.some(r=>r.state==='effect'&&r.cls===cls)) return {verdict:'card',cls,approve:null};
  if (!reads.length || reads.some(r=>r.state!=='clean')) return {verdict:'card',cls:'cut',approve:null};
  return {verdict:'run',cls:'',approve:`auto-approved ${tool} (no limits)`};
}
/** Legacy corpus signatures remain readable during producer migration. Neither
 * a claimed actor nor a clean-owner label grants execution authority here. */
export function finalDecision<T>(reads: readonly ReaderVerdict[], tool: string, context: { kind: 'base'; verdict: T }): T;
export function finalDecision(reads: readonly ReaderVerdict[], tool?: string, context?: { kind: 'clean-owner' | 'tainted-owner'; deny?: boolean }): FinalDecision;
export function finalDecision(level: { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean }, actor: { kind: string }, request: { tool: string; base: FinalDecision }): FinalDecision;
export function finalDecision(first: unknown, second?: unknown, context?: unknown): unknown {
  if (!Array.isArray(first)) return { verdict: 'card', cls: 'cut', approve: null } satisfies FinalDecision;
  const base = context as { kind?: string; verdict?: unknown; deny?: boolean } | undefined;
  if (base?.kind === 'base') return base.verdict;
  if (base?.deny) return { verdict: 'card', cls: 'cut', approve: null } satisfies FinalDecision;
  return readerOracle(first as ReaderVerdict[], typeof second === 'string' ? second : undefined);
}
