// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: recall-scope owns the authority refusals; recall-smoke owns their
// consumption by direct and room dispatch preparation.

/** A refused recall view cannot authorize memory, but it need not refuse the
 * person's turn. Use the existing bounded, proven-unwritten recovery chain:
 * fresh authority first, then a fresh session with no remembered context.
 * This only classifies the failure; submission/Stop fences still decide
 * whether another attempt is safe. Pins and unrelated setup errors keep
 * their original failure contracts. Never enumerate scopes as a fallback. */
export function recallPreparationFailure(error: unknown): unknown {
  if (!(error instanceof Error) || (error.message !== "MEMORY_RECALL_UNAVAILABLE" && error.message !== "MEMORY_SCOPE_DENIED")) return error;
  // assertMemoryAccess reports a view lost during assembly as SCOPE_DENIED;
  // initial admission reports RECALL_UNAVAILABLE. Neither grants authority.
  console.warn(`[memory] recall preparation refused cause=${error.message}; recovering the turn without recalled memory if fresh recall is unavailable`);
  return new Error("MEMORY_CONTEXT_REVOKED", { cause: error });
}
