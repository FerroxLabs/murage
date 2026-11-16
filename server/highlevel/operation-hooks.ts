// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrozenRequest, HeldRequest } from './held-request.ts';
import type { OperationRunContext, OperationSpec } from './operations/registry.ts';
import type { OperationId } from '../../shared/highlevel.ts';
/** S-INT owns this internal adapter under binding scope amendment A-F3,
 * HLF3-UPLOAD-CONTAINMENT-DESIGN.md section 3. Hooks are host-owned and bound
 * to the exact held request; frozen public signatures remain unchanged. */
export interface OperationHooks {
  retainRequest?(held: HeldRequest, ctx: OperationRunContext): void;
  reviewValues?(held: HeldRequest): Record<string, unknown>;
  confirmsResponse?(value: unknown, frozen: FrozenRequest): boolean;
  recoveryTargets?(held: HeldRequest): readonly { operation: OperationId; path: string; query?: Record<string, string> }[];
}
export const heldOperationHooks = new WeakMap<FrozenRequest, OperationSpec<any> & OperationHooks>();
