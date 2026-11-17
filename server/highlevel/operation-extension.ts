// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OperationId } from '../../shared/highlevel.ts';
import type { FrozenRequest } from './held-request.ts';
import type { HighLevelEndpoint } from './provider-contract.ts';
import type { ManifestRow } from './operations/registry.ts';
import type { ReturnedIdentitySchema } from './operations/returned-identity-schemas.ts';

/** Optional contract alongside the frozen registry. Only an explicitly supplied
 * extension row opts in; no operation ID changes the legacy contract globally. */
export interface OperationExtension {
 readonly row: ManifestRow;
 readonly endpoint: HighLevelEndpoint;
 readonly reconciliation: readonly OperationId[];
 readonly readRow: (id: OperationId) => ManifestRow | undefined;
 readonly identities?: ReturnedIdentitySchema;
 readonly bindDraft?: (frozen: FrozenRequest, draft: import('./operations/registry.ts').RequestDraft) => void;
 readonly reviewRefs?: (frozen: FrozenRequest) => readonly string[];
 readonly revalidate?: (frozen: FrozenRequest, fresh: FrozenRequest) => boolean;
 readonly absenceConfirmation?: Readonly<Record<string, true>>;
}
const rows = new WeakMap<ManifestRow, OperationExtension>();
const requests = new WeakMap<FrozenRequest, OperationExtension>();
export function registerOperationExtension(extension: OperationExtension): void {
 if (rows.has(extension.row)) throw new Error('Duplicate operation extension');
 rows.set(extension.row, Object.freeze(extension));
}
export function operationExtension(row: ManifestRow): OperationExtension | undefined { return rows.get(row); }
export function frozenOperationExtension(frozen: FrozenRequest): OperationExtension | undefined { return requests.get(frozen); }
export function bindOperationExtension(frozen: FrozenRequest, row: ManifestRow, draft: import('./operations/registry.ts').RequestDraft): void {
 const extension = rows.get(row);
 if (extension) { requests.set(frozen, extension); extension.bindDraft?.(frozen, draft); }
}
