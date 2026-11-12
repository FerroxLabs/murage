import type { HighLevelCallContext } from './client.ts';
export const requestChanged = new WeakMap<HighLevelCallContext, () => void>();
// Internal transport state: keep the frozen HighLevelCallContext surface unchanged.
export const dispatchAdmissions = new WeakMap<HighLevelCallContext, AbortSignal>();
export const recheckAdmissions = new WeakSet<HighLevelCallContext>();
export const noLimitsForContext = new WeakMap<HighLevelCallContext, () => boolean>();
