// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RequestDraft } from './operations/registry.ts';
import type { HeldRequest } from './held-request.ts';
import { prepareTagReturnedIdentitySchema } from './returned-confirmation.ts';
import { validTagSet } from './returned-confirmation-state.ts';

// The ownership-validated pre-state travels with this exact prepared draft.
// It is never a mutable family-wide cache or reconstructed from a response.
const beforeTags = new WeakMap<RequestDraft, readonly string[]>();
export function retainContactTags(draft: RequestDraft, tags: unknown): void {
  if (!validTagSet(tags)) throw new Error('Missing contact tag pre-state');
  beforeTags.set(draft, Object.freeze([...tags]));
}
export function prepareContactConfirmation(held: HeldRequest, draft: RequestDraft, locationId: string): void {
  if (!['contacts.tags.add', 'contacts.tags.remove'].includes(held.frozen.operation)) return;
  const tags = beforeTags.get(draft);
  if (!tags) throw new Error('Missing contact tag pre-state');
  prepareTagReturnedIdentitySchema(held, locationId, tags);
}
