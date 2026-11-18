// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalBindingJson } from './binding-json.ts';
import { highlevelIdSchema } from './operations/schemas/common.ts';
import { recoveryConfirmationSafe } from './reconciliation-read.ts';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => Buffer.from(canonicalBindingJson(a)).equals(Buffer.from(canonicalBindingJson(b)));
/** Discard every unreviewed provider field before releasing a create result.
 * Approved effects must be confirmed, including permission and scope values.
 * No provider message, unknown response field, or cause is ever returned. */
export function userCreatePublicResponse(raw: unknown, reviewed: Record<string, unknown>): unknown {
  const refuse = (): never => { throw new Error('The user could not be confirmed.'); };
  if (!object(raw) || !recoveryConfirmationSafe(raw)) return refuse();
  const user = object(raw.user) ? raw.user : raw;
  if (!highlevelIdSchema.safeParse(user.id).success || (raw.userId !== undefined && raw.userId !== user.id)
    || (raw.user !== undefined && raw.id !== undefined && raw.id !== user.id)) return refuse();
  const roles = object(user.roles) ? user.roles : {};
  for (const [key, expected] of Object.entries(reviewed)) {
    const observed = ['type', 'role', 'locationIds'].includes(key) ? roles[key] ?? user[key] : user[key];
    if (observed === undefined || !same(observed, expected)) return refuse();
    if (roles[key] !== undefined && user[key] !== undefined && !same(roles[key], user[key])) return refuse();
  }
  return { user: { id: user.id, ...structuredClone(reviewed) } };
}
