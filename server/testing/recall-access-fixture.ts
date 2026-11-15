// SPDX-License-Identifier: AGPL-3.0-or-later
// RecallView producer: recall-scope. Legacy tool fixture consumer: c4-misc-d2.
import type { InternalCapabilities, InternalCapability } from '../internal-capabilities.ts';
import { memoryAccess, type MemoryRoster } from '../memory/policy.ts';
import { prepareRecallContextSync, maintainRecallViewSlice } from '../memory/recall-view.ts';

/** Explicit fixture admission, before the measured handler. Build the serving
 * view from its real roster and settle its projection; never fabricate a handle
 * or replace the private claim checks. */
export function fixtureMemoryAccess(registry: InternalCapabilities, claim: InternalCapability, roster: () => MemoryRoster) {
  if (claim.kind !== 'memory' || !registry.isActive(claim)) return memoryAccess(registry, claim, roster);
  const current = roster();
  current.memoryRosterRevision ??= 1;
  prepareRecallContextSync(claim.botId, claim.threadId, current, claim.notOwnerAudience === true);
  const access = memoryAccess(registry, claim, roster);
  while (!maintainRecallViewSlice(access.view)) { /* fixture projection preparation */ }
  return access;
}
