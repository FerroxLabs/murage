// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OperationId } from '../../shared/highlevel.ts';
import type { PreflightRequester, ReadDraft } from './operations/registry.ts';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** One-page recovery budget. Continuation is never evidence of absence. */
export function completeReconciliationCollection(raw: unknown, count: number, search: boolean): boolean {
  if (!object(raw)) return false;
  const envelopes = [raw, ...(object(raw.meta) ? [raw.meta] : [])];
  if (envelopes.some(row => row.hasMore === true || ['next', 'nextPage', 'nextPageUrl', 'nextCursor', 'nextPageToken', 'startAfterId', 'startAfter']
    .some(key => row[key] !== undefined && row[key] !== null && row[key] !== '' && row[key] !== false))) return false;
  const totals = envelopes.filter(row => Object.hasOwn(row, 'total')).map(row => row.total);
  return (!search || totals.length > 0) && totals.every(total => Number.isSafeInteger(total) && total === count);
}
export class UnconfirmedReconciliation extends Error {}
/** Typed marker for every recovery read; AST inventory rejects bypasses. */
export async function readReconciliation(pre: PreflightRequester, operation: OperationId, draft: ReadDraft): Promise<unknown> {
  const raw = await readReconciliationPage(pre, operation, draft);
  if (operation.endsWith('.search')) {
    const rows = object(raw) ? raw[operation.split('.')[0]] : undefined;
    if (!Array.isArray(rows) || !completeReconciliationCollection(raw, rows.length, true)) throw new UnconfirmedReconciliation('Incomplete reconciliation search');
  }
  return raw;
}
/** A single provider page for an operation-specific bounded lookup. The caller
 * must enforce its page/row ceiling and collection completeness before proof. */
export async function readReconciliationPage(pre: PreflightRequester, operation: OperationId, draft: ReadDraft): Promise<unknown> {
  const raw = await pre.read(operation, draft);
  if (!recoveryConfirmationSafe(raw)) throw new UnconfirmedReconciliation('Unconfirmed provider recovery response');
  return raw;
}
/** Check original provider flags before constructing any response witness. */
export function recoveryConfirmationSafe(raw: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return true;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.every(visit);
    return Object.entries(value).every(([key, child]) => {
      if (['success', 'succeeded', 'succeded', 'ok', 'deleted'].includes(key) && child !== true) return false;
      if ((['error', 'errors'].includes(key) && child !== undefined && child !== null && child !== false && child !== '' && !(Array.isArray(child) && child.length === 0))
        || (key === 'errorCount' && typeof child === 'number' && child > 0)
        || (['status', 'statusCode'].includes(key) && typeof child === 'number' && child >= 400)
        || (key === 'status' && typeof child === 'string' && /^(failed|failure|error|denied|not_applied)$/i.test(child))) return false;
      return visit(child);
    });
  };
  return !!raw && typeof raw === 'object' && visit(raw);
}
