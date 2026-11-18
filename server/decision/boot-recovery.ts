// SPDX-License-Identifier: AGPL-3.0-or-later
/** What the start records when decision recovery throws: a fixed code only (the error text can carry request data). */
export type DecisionRecoveryFailure = { readonly code: string; readonly at: number };
const KNOWN_CODES = new Set([
  'queue-recovery-source-missing', 'queue-renewal-conflict', 'queue-delivery-conflict',
  'queue-action-mismatch', 'queue-delivery-failed', 'approval-queue-format',
  'approval-queue-capacity', 'approval-queue-conflict',
]);
/** Recovery refuses with short codes (queue-recovery-source-missing, queue-renewal-conflict); anything else is one generic code. */
export function decisionRecoveryFailure(error: unknown, at = Date.now()): DecisionRecoveryFailure {
  const message = error instanceof Error ? error.message : "";
  return { code: KNOWN_CODES.has(message) ? message : "decision-recovery-failed", at };
}
