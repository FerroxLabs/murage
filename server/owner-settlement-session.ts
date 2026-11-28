// Session binding and authenticated revoke-route adapter owner: skills lane. Queue delivery owner: decision lane.
import { createHash } from 'node:crypto';
import type { OwnerSession } from './skill-switch-settlement.ts';
type PhoneSession = { reference: object; epoch: number; keyHash?: string; revoked: boolean };
const phones = new Map<string, PhoneSession>();
/** Called only after the admitting route proved the companion launch credential and paired device key. */
export function phoneOwnerSettlementSession(deviceId: string, key: string): OwnerSession | undefined {
  const keyHash = createHash('sha256').update(key).digest('hex');
  let entry = phones.get(deviceId);
  if (!entry) {
    if (phones.size >= 1024) return;
    entry = { reference: Object.freeze({}), epoch: 1, keyHash, revoked: false };
    phones.set(deviceId, entry);
  }
  if (entry.revoked) return;
  if (entry.keyHash !== keyHash) { entry.epoch++; entry.keyHash = keyHash; }
  const epoch = entry.epoch, session = entry;
  return { reference: session.reference, principal: 'owner', epoch: String(epoch),
    live: () => phones.get(deviceId) === session && !session.revoked && session.epoch === epoch && session.keyHash === keyHash };
}
/** The already-authenticated revoke-device route calls this before its first await.
 * Tokens never survive restart. A revoked device id cannot be revived by an older in-flight request. */
export function revokePhoneOwnerSettlementSession(deviceId: string): void {
  const entry = phones.get(deviceId);
  if (entry) { entry.revoked = true; entry.epoch++; }
  else if (phones.size < 1024) phones.set(deviceId, { reference: Object.freeze({}), epoch: 1, revoked: true });
}
