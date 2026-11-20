// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (view admission). Consumer owner: recall-s1s2 (dispatch recovery).
export class RecallPreparationPending extends Error {
  constructor() { super('MEMORY_RECALL_UNAVAILABLE'); }
}
/** R01 owner: recall-reclaim-r2. Every recall view is in use by a live reader; a waiting turn ends on its card. */
export class RecallCapacityPending extends RecallPreparationPending {}
/** Record callers retain their scope-denial diagnostic, without confusing availability with authority. */
export class RecallViewLost extends Error {
  constructor() { super('MEMORY_SCOPE_DENIED'); }
}
export class MemoryPinProjectionPending extends Error {
  constructor() { super('MEMORY_RECALL_UNAVAILABLE'); }
}
export class MemoryPinSetTooLarge extends Error {
  constructor() { super('MEMORY_PIN_SET_TOO_LARGE'); }
}
/** Only a typed view loss is preparation work. Genuine authority denials keep their identity. */
export function recallPreparationFailure(error: unknown): unknown {
  if (error instanceof RecallViewLost) return new RecallPreparationPending();
  return error;
}
