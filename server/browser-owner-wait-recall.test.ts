// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Projection producer owner: recall-scope; browser-wait consumer owner: r3-browser-wait.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { InternalCapabilities } from './internal-capabilities.ts';
import { Store } from './store.ts';
import { OWNER } from './human-principals.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './memory/policy.ts';
import { prepareRecallContext, requestRecallViewMaintenance, stopRecallViewMaintenance, waitForRecallConstructionIdleForTest, resolveRecallView, hydrateRecallViewSteps } from './memory/recall-view.ts';
import { buildMemoryBundle } from './memory/bundle.ts';
import { LineageAllowance } from './memory/lineage-allowance.ts';
import { setMemoryMode } from './memory/repository.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture() {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active');
  const db = database(), scope = ensureScope('bot', 'reader');
  await prepareRecallContext('reader', 'direct', roster); stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const bundle = () => buildMemoryBundle('', access, { async search() { return { hits: [], vectorRows: 0 }; } }, { allowance: LineageAllowance.tool(1_000_000_000) });
  const watermark = () => Number(database().prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation)!.watermark);
  const pin = () => db.prepare("INSERT INTO memory_records VALUES('constraint',1,?,'constraint','fixture owner constraint','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  return { db, scope, access, bundle, watermark, pin };
}

it('advances the waiting reader without waiting for idle contexts, retaining the mandatory-pin refusal', async () => {
  const f = await fixture(); await f.bundle(); f.pin();
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
  expect((await f.bundle()).pinned.map(row => row.id)).toEqual(['constraint']);
  const before = f.watermark();
  requestRecallViewMaintenance(f.access.view);
  expect(f.watermark()).toBe(before); // No projection work in the foreground read.
  await tick();
  expect((await f.bundle()).pinned.map(row => row.id)).toEqual(['constraint']);
});

it('coalesces repeated requests into one bounded change page and refuses until the pin is projected', async () => {
  const f = await fixture(), before = f.watermark();
  f.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300)
    INSERT INTO memory_records SELECT 'record-'||i,1,?,'fact','fixture fact','owner-statement','active',0,1,NULL,NULL,1 FROM n`).run(f.scope);
  f.pin();
  for (let n = 0; n < 40; n++) requestRecallViewMaintenance(f.access.view);
  await tick();
  expect(f.watermark() - before).toBe(256);
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
  expect((await f.bundle()).pinned.map(row => row.id)).toEqual(['constraint']);
  requestRecallViewMaintenance(f.access.view); await tick();
  expect((await f.bundle()).pinned.map(row => row.id)).toEqual(['constraint']);
});

it('does not advance a forged or retired projection generation', async () => {
  const f = await fixture(); f.pin(); const before = f.watermark();
  requestRecallViewMaintenance({ ...f.access.view, generation: 'retired' }); await tick();
  expect(f.watermark()).toBe(before);
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
  expect((await f.bundle()).pinned.map(row => row.id)).toEqual(['constraint']);
});

it('does not run an old request against a reopened database', async () => {
  const f = await fixture(); f.pin(); const before = f.watermark();
  requestRecallViewMaintenance(f.access.view); closeDatabase(); database(); await tick();
  expect(f.watermark()).toBe(before);
});

it('leaves a hydration snapshot unchanged until its reader finishes', async () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const bot = store.createBot({ name: 'Reader' }, { seedMessages: false });
  store.finishSharingBoot(); await waitForRecallConstructionIdleForTest(store); stopRecallViewMaintenance();
  const db = database(), binding = { botId: bot.id, threadId: bot.threadId, notOwnerAudience: false, humanPrincipal: OWNER };
  const view = resolveRecallView(binding, store).handle;
  const watermark = () => db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.watermark;
  const steps = hydrateRecallViewSteps(binding, store);
  expect(steps.next().done).toBe(false);
  try {
    db.exec("INSERT INTO memory_records VALUES('constraint',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','fixture owner constraint','owner-statement','active',1,1,NULL,NULL,1)");
    const before = watermark();
    requestRecallViewMaintenance(view); await tick();
    expect(watermark()).toBe(before);
    let finished = steps.next(); while (!finished.done) finished = steps.next();
    expect(finished.value).toBe(true);
    requestRecallViewMaintenance(view); await tick();
    expect(Number(watermark())).toBeGreaterThan(Number(before));
  } finally { steps.return(false); }
});
