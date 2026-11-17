import type { HeldRequest, FrozenSendCopy } from './held-request.ts';
import { ActionRefused } from './actions.ts';
export const heldValidators = new WeakMap<HeldRequest, (out: FrozenSendCopy, approved?: string) => void>();
export function validateFrozenCopy(held: HeldRequest, out: FrozenSendCopy, approved?: string): void {
  const validate = heldValidators.get(held);
  if (!validate) throw new ActionRefused('request_shape', 'A held request is required.');
  validate(out, approved);
}
