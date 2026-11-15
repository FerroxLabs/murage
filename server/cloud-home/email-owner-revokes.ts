// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeInternal } from "./copy.ts";
/** Supervisor-only sealed queue. Keep the oldest entries; defer replacement when full rather than discard a key. */
export const OWNER_REVOKES_KEY = "botEmailPendingOwnerRevokes";
export const OWNER_REVOKES_MAX = 4;
export function pendingOwnerRevokes(records: Record<string, string>): string[] {
  const raw: unknown = JSON.parse(records[OWNER_REVOKES_KEY] || "[]");
  if (!Array.isArray(raw) || raw.length > OWNER_REVOKES_MAX || raw.some(t => typeof t !== "string" || !t || t.length > 4096)) throw new Error(cloudHomeInternal.emailRevokeListUnreadable);
  return [...new Set(raw as string[])];
}
export const ownerRevokesPatch = (tokens: string[]): Record<string, string> => ({ [OWNER_REVOKES_KEY]: JSON.stringify(tokens) });
/** Included in the owner transaction, before the old token can disappear from its slot. */
export function queueOwnerRevoke(records: Record<string, string>, token?: string): Record<string, string> {
  const pending = pendingOwnerRevokes(records);
  if (!token || pending.includes(token)) return ownerRevokesPatch(pending);
  if (pending.length >= OWNER_REVOKES_MAX) throw new Error(cloudHomeInternal.emailRevokeListFull);
  return ownerRevokesPatch([...pending, token]);
}
