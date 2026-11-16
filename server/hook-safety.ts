// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { noteHookRepairFailure } from './hook-repair-notice.ts';
export { noteHookRepairFailure, hookRepairLine, hookRepairNeeds, withHookRepairNeeds, onHookRepairNeedsChanged } from './hook-repair-notice.ts';
import { registerCanon, ensureCanon, ensureAllLive, dropCanon, type CanonFile, type CanonSet } from './hook-canon.ts';
import { HookRepairFailed } from './drivers/scoped-cli-home.ts';

export const HOOK_CHECK_DENIED = 'Murage could not confirm its tool check';

type Owner = { engine: string; revoke(): void; stop(): void };
const owners = new Map<CanonSet, Owner>();
export function ownHookCanon(set: CanonSet, owner: Owner): void { owners.set(set, owner); }
export function releaseHookCanon(set: CanonSet | undefined): void { if (set) { owners.delete(set); dropCanon(set); } }
export function canonFile(path: string, text: string, kind: CanonFile['kind'], engine: CanonFile['engine'], root: string): CanonFile {
  const bytes = Buffer.from(text);
  return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), kind, engine, root };
}
export function prepareHookCanon(files: CanonFile[], at: Parameters<typeof ensureCanon>[1], engine: string, current?: CanonSet): CanonSet {
  const same = current && current.files.length === files.length && files.every(file => current.files.some(prior => prior.path === file.path && prior.sha256 === file.sha256));
  const set = same ? current : registerCanon(files);
  if (!ensureCanon(set, at).ok) {
    if (set !== current) dropCanon(set);
    noteHookRepairFailure(engine);
    throw new HookRepairFailed(engine);
  }
  return set;
}
export function checkHookCanon(set: CanonSet | undefined, at: Parameters<typeof ensureCanon>[1], engine: string): boolean {
  if (!set || ensureCanon(set, at).ok) return true;
  noteHookRepairFailure(engine);
  const owner = owners.get(set);
  if (owner) {
    try { owner.revoke(); } finally { setImmediate(() => owner.stop()); }
  }
  return false;
}
// Suppress repeated reports while an obstruction remains present, including
// scans at both sides of a permission delivery and shared-file registrations.
let reportedFailures = new Set<string>();
/** Repair every live set, but return readiness only for the delivery in hand.
 * Its caller denies before stopping its child; foreign owners stop independently.
 */
export function checkAllHookCanon(at: Parameters<typeof ensureAllLive>[0], deliverySet?: CanonSet): boolean {
  const deliveryReady = !!deliverySet && owners.has(deliverySet) && deliverySet.files.length > 0 && ensureCanon(deliverySet, at).ok;
  const failures = ensureAllLive(at).filter(result => !result.ok);
  const affects = (set: CanonSet, path: string) => set.files.some(file => file.path === path || file.path.startsWith(path + '/') || file.path.startsWith(path + '\\'));
  const reported = new Set<string>();
  for (const [set, owner] of owners) {
    const affected = failures.filter(result => affects(set, result.path));
    if (!affected.length) continue;
    for (const result of affected) {
      const key = JSON.stringify([owner.engine, result.path]);
      if (!reported.has(key) && !reportedFailures.has(key)) {
        try { console.warn(`hooks: could not restore tool check for ${owner.engine}: ${JSON.stringify(result.path)}`); } catch { /* Reporting cannot bypass revocation. */ }
      }
      reported.add(key);
    }
    if (set === deliverySet) continue;
    noteHookRepairFailure(owner.engine);
    try { owner.revoke(); } catch { /* Still stop this owner and revoke the others. */ }
    try { owner.stop(); } catch { /* Other owners must be revoked independently. */ }
  }
  reportedFailures = reported;
  return deliveryReady && !failures.some(result => affects(deliverySet!, result.path));
}
