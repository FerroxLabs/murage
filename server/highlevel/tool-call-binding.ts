// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { InternalCapability } from '../internal-capabilities.ts';
import type { HeldRequest } from './held-request.ts';

/** Transport identity only: tool arguments cannot supply or replace an approval. */
export function toolCallActionId(claim: InternalCapability, id: string | number): string {
  return 'hla_' + createHash('sha256').update(JSON.stringify(['highlevel-tool-call', 1, claim.botId, claim.threadId, claim.generation, id])).digest('hex');
}
/** Carries the transport identity into proposal without changing the frozen F0 API. */
export const heldToolCallActions = new WeakMap<HeldRequest, string>();
