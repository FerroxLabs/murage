// SPDX-License-Identifier: AGPL-3.0-or-later
// RecallView producer owner: recall-scope. Legacy fixture consumer owner: recall-fix-a.
import type { InternalCapabilities, InternalCapability } from '../internal-capabilities.ts';
import { memoryAccess, recallRosterSnapshotSteps, type MemoryRoster } from '../memory/policy.ts';
import { prepareRecallContextSync, maintainRecallViewSlice } from '../memory/recall-view.ts';
import { ConstructionBudget } from '../memory/recall-construction.ts';
import { database } from '../database.ts';
import { catchUpRecentMemory } from '../memory/recent.ts';

const fixtureRosters = new WeakMap<() => MemoryRoster, MemoryRoster>();
/** Old fixtures often return a new object on every roster read. Production's
 * Store has stable identity and a structural revision. Give those plain fixture
 * producers the same contract, while continuing to read their live membership.
 * A change advances the revision; it never prepares a view during assertion. */
function fixtureRoster(read: () => MemoryRoster): MemoryRoster {
  const current = read();
  if (current === read()) {
    current.memoryRosterRevision ??= 1;
    return current;
  }
  let stable = fixtureRosters.get(read);
  if (!stable) {
    let signature: string | undefined, revision = 0;
    stable = {
      get bots() { return read().bots; },
      get groups() { return read().groups; },
      get memoryRosterRevision() {
        const value = read(), budget = new ConstructionBudget(true);
        let next: string;
        try {
          const steps = recallRosterSnapshotSteps(value, budget);
          let step = steps.next();
          while (!step.done) step = steps.next();
          next = JSON.stringify(step.value);
        } finally { budget.release(); }
        if (next !== signature) { signature = next; revision++; }
        return revision;
      },
    };
    fixtureRosters.set(read, stable);
  }
  return stable;
}

/** Settle the same bounded projection pages the application's idle worker
 * runs, after a fixture synchronously publishes records without that worker. */
export function settleFixtureRecallViews(): void {
  const db = database();
  for (const view of db.prepare(`SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c
    JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation
    WHERE v.state='ready' AND v.authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1)`).all()) {
    while (!maintainRecallViewSlice({ viewId: String(view.view_id), generation: String(view.generation), digest: String(view.digest) })) {
      /* Explicit fixture preparation, outside measured recall. */
    }
  }
}

/** A fixture has no idle worker to project a just-captured job before the
 * turn's catch-up, or its newly published records before immediate recall. */
export function fixtureCatchUpRecentMemory(...args: Parameters<typeof catchUpRecentMemory>): ReturnType<typeof catchUpRecentMemory> {
  settleFixtureRecallViews();
  const completed = catchUpRecentMemory(...args);
  settleFixtureRecallViews();
  return completed;
}

/** Explicit fixture admission, before the measured handler. Build the serving
 * view from its real roster and settle its projection; never fabricate a handle
 * or replace the private claim checks. */
export function fixtureMemoryAccess(registry: InternalCapabilities, claim: InternalCapability, roster: () => MemoryRoster) {
  if (claim.kind !== 'memory' || !registry.isActive(claim)) return memoryAccess(registry, claim, roster);
  const source = roster(), current = fixtureRoster(roster);
  prepareRecallContextSync(claim.botId, claim.threadId, current, claim.notOwnerAudience === true);
  const access = memoryAccess(registry, claim, source === current ? roster : () => current);
  while (!maintainRecallViewSlice(access.view)) { /* fixture projection preparation */ }
  return access;
}
