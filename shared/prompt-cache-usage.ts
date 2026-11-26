// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Coverage only; never permission, billing evidence, or a provider cache key. */
export interface UsageAccounting { version: 1; inputComplete: boolean; cacheComplete: boolean }
export interface CacheUsage { input: number; output: number; cachedInput?: number; usageAccounting?: UsageAccounting }
export type UsageContribution = Partial<CacheUsage>;
export const tokenCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function reportedCacheRead(u: UsageContribution): number | undefined {
  return tokenCount(u.input) && tokenCount(u.cachedInput) && u.cachedInput <= u.input ? u.cachedInput : undefined;
}
export function usageAccounting(value: unknown): UsageAccounting {
  const v = value as Partial<UsageAccounting> | null;
  const inputComplete = v?.version === 1 && v.inputComplete === true;
  return { version: 1, inputComplete, cacheComplete: inputComplete && v?.cacheComplete === true };
}
export function coverage(u: UsageContribution): UsageAccounting {
  const a = usageAccounting(u.usageAccounting);
  const inputComplete = a.inputComplete && tokenCount(u.input) && tokenCount(u.output) && tokenCount(u.input + u.output);
  return { version: 1, inputComplete, cacheComplete: inputComplete && a.cacheComplete && (u.input === 0 || reportedCacheRead(u) !== undefined) };
}
/** Exactly one actual provider request/round, after adapter-specific input normalization.
 * A missing report is an incomplete contribution, rather than an invented zero. */
export function requestUsage(input: unknown, output: unknown, cached: unknown): CacheUsage {
  const inputKnown = tokenCount(input);
  const inputComplete = inputKnown && tokenCount(output);
  const cacheValid = tokenCount(cached) && inputKnown && cached <= input;
  return {
    input: inputKnown ? input : 0,
    output: tokenCount(output) ? output : 0,
    ...(cacheValid ? { cachedInput: cached } : {}),
    usageAccounting: { version: 1, inputComplete, cacheComplete: inputComplete && (input === 0 || cacheValid) },
  };
}
export function addTokenCounts(x: unknown, y: unknown): number {
  const left = x === undefined ? 0 : x;
  const right = y === undefined ? 0 : y;
  if (!tokenCount(left) || !tokenCount(right)) return Number.NaN;
  const sum = left + right;
  return tokenCount(sum) ? sum : Number.NaN;
}
/** Missing metadata denotes a legacy/incomplete interval. No historical inference. */
export function addCacheUsage(previous: UsageContribution | undefined, next: UsageContribution): CacheUsage {
  const a = previous ? coverage(previous) : { version: 1 as const, inputComplete: true, cacheComplete: true };
  const b = coverage(next);
  const input = addTokenCounts(previous?.input, next.input), output = addTokenCounts(previous?.output, next.output);
  const previousRead = previous && reportedCacheRead(previous);
  const nextRead = reportedCacheRead(next);
  const cachedInput = previousRead !== undefined || nextRead !== undefined ? addTokenCounts(previousRead, nextRead) : undefined;
  const valid = tokenCount(input) && tokenCount(output) && tokenCount(input + output) && (cachedInput === undefined || (tokenCount(cachedInput) && cachedInput <= input));
  return { input, output, ...(cachedInput === undefined ? {} : { cachedInput }), usageAccounting: { version: 1, inputComplete: valid && a.inputComplete && b.inputComplete, cacheComplete: valid && a.cacheComplete && b.cacheComplete } };
}
/** A newly settled legacy driver's report, validated without manufacturing a cached lower bound. */
export function legacyTurnUsage(turn: { input?: number; output?: number; cachedInput?: number }): CacheUsage {
  return requestUsage(turn.input, turn.output, turn.cachedInput);
}
/** Existing adapters with reads beside fresh input normalize once, here at their boundary. */
export function splitRequestUsage(fresh: unknown, output: unknown, read: unknown, write?: unknown): CacheUsage {
  const input = tokenCount(fresh) ? fresh + (tokenCount(read) ? read : 0) + (tokenCount(write) ? write : 0) : undefined;
  const u = requestUsage(input, output, read);
  if ((read !== undefined && !tokenCount(read)) || (write !== undefined && !tokenCount(write))) u.usageAccounting = { version: 1, inputComplete: false, cacheComplete: false };
  return u;
}
