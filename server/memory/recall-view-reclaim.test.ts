// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { executionStore, setExecutionStore } from '../execution-audience.ts';
import { OWNER, threadHumanPrincipal } from '../human-principals.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ownerMemoryTicket } from './authority.ts';
import { buildMemoryBundle as readMemoryBundle } from './bundle.ts';
import { setMemoryCaptureRoster } from './capture-scope.ts';
import { buildMemoryBundleAfterReset } from './dispatch.ts';
import { writeBotIdentity } from './identity.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { assertMemoryAccess, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import * as views from './recall-view.ts';

// An equivalent audience republishes the same view, so churn tests change the reader's audience each generation.
function churnAudience(roster: MemoryRoster, n: number): void {
  roster.groups.push({ id: `churn-${n}`, threadId: `churn-thread-${n}`, memberIds: ['reader'] });
}

// Alternating membership between two rooms gives every generation a different audience, so each one publishes a new view.
function alternateAudience(roster: MemoryRoster, n: number): void {
  roster.groups[0].memberIds = n % 2 ? ['reader'] : [];
  roster.groups[1].memberIds = n % 2 ? [] : ['reader'];
}

// q1022-upgradecatchup (CHANGED-EXPECTATIONS.md): this file's rows predate the build pace (recall-view.ts RECALL_BUILD_BYTES_PER_MINUTE) and test what is reclaimed and built, not how fast; the pace is opened for them. The pace has its own witnesses (upgrade-catchup-1022.test.ts W-PACE, W-CAP, W-STEADY).
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); views.setRecallBuildPaceForTest(Infinity); });
afterEach(() => { closeDatabase(); });

it('W-B28 presentation save and identity writes reach the guarded dispatch bundle', async () => {
  // Only explicit setImmediate construction and requested upkeep may advance this sequence.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const previousStore = executionStore();
  const roster = new Store(), registry = new InternalCapabilities();
  try {
    const bot = roster.createBot({ name: 'Keeper fixture' }, { seedMessages: false, noAccess: true });
    setMemoryMode('active');
    views.prepareRosterRecallViews(roster);
    await views.waitForRecallConstructionIdleForTest(roster);
    const binding = { botId: bot.id, threadId: bot.threadId, humanPrincipal: OWNER, notOwnerAudience: false };
    const original = views.resolveRecallView(binding, roster).handle;
    const revision = roster.memoryRosterRevision;
    roster.patchBot(bot.id, { persona: 'Speaks gently in short lines.' });
    expect(roster.memoryRosterRevision).toBeGreaterThan(revision);
    // Admission still accepts the old publication, proving the real store acknowledged this save.
    expect(views.resolveRecallView(binding, roster).handle).toEqual(original);
    const ticket = ownerMemoryTicket();
    const input = { action: 'identity-write' as const, botId: bot.id, expectedVersion: 0, basis: 'fiction' as const, audience: 'owner-private' as const };
    const brief = writeBotIdentity(ticket, { ...input, kind: 'continuity-brief', key: 'core', text: 'BRIEF continue the fictional harbour story.' }, roster);
    const canon = writeBotIdentity(ticket, { ...input, kind: 'character-canon', key: 'brass-key', text: 'CANON a brass key rests under the lamp.' }, roster);
    const reveal = writeBotIdentity(ticket, { ...input, kind: 'reveal-state', key: 'brass-key', text: 'REVEAL the owner heard about the key.', canon: { id: canon.id, version: canon.version }, revealed: true }, roster);
    views.prepareRosterRecallViews(roster);
    await views.waitForRecallConstructionIdleForTest(roster);
    const view = views.resolveRecallView(binding, roster).handle, db = database();
    const projection = () => db.prepare(`SELECT watermark,(SELECT coalesce(max(sequence),0) FROM memory_recall_changes) AS latest
      FROM memory_recall_views WHERE view_id=? AND generation=?`).get(view.viewId, view.generation)!;
    const records = (handle: views.RecallViewHandle) => db.prepare('SELECT record_id,version FROM memory_recall_view_records WHERE view_id=? AND generation=? ORDER BY record_id,version').all(handle.viewId, handle.generation);
    const beforeGuard = projection(), beforeRecords = records(view);
    registry.begin(bot.id, bot.threadId, 'turn');
    const token = registry.mint({ botId: bot.id, threadId: bot.threadId, generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
    // index.ts dispatch guard, with immediate turns in place of its wall-clock delay.
    for (let remaining = 64; ; remaining--) {
      const mark = projection();
      if (Number(mark.watermark) >= Number(mark.latest)) break;
      if (remaining === 1) throw new Error('MEMORY_RECALL_UNAVAILABLE');
      views.requestRecallViewMaintenance(access.view);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const bundle = await readMemoryBundle('', access, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() });
    const projected = records(view);
    // A plain snapshot forces fresh construction instead of certified-roster hydration.
    const freshRoster: MemoryRoster = { memoryRosterRevision: roster.memoryRosterRevision, bots: roster.bots, groups: roster.groups };
    await views.prepareRecallContext(bot.id, bot.threadId, freshRoster);
    const fresh = records(views.resolveRecallView(binding, freshRoster).handle);
    console.info(JSON.stringify({ witness: 'W-B28', reused: view.viewId === original.viewId, beforeGuard, afterGuard: projection(), beforeRecords: beforeRecords.length, projected: projected.length, fresh: fresh.length, identityKinds: bundle.identity.map(row => row.kind), recordSetsEqual: JSON.stringify(projected) === JSON.stringify(fresh) }));
    expect(bundle.identity.map(row => row.id)).toContain(brief.id);
    expect(bundle.identity.map(row => row.id)).toContain(reveal.id);
    expect(bundle.text).toContain('REVEAL the owner heard about the key.');
    expect(projected).toEqual(fresh);
  } finally {
    registry.revokeAll();
    roster.stopSeqStamps();
    setMemoryCaptureRoster(null);
    setExecutionStore(previousStore);
    views.stopRecallViewMaintenance();
    vi.useRealTimers();
  }
});

for (const stalled of [false, true]) it(`W-B28-WINDOW post-CANON view ${stalled ? 'fails closed with maintenance stalled' : 'delivers a later REVEAL'}`, async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const previousStore = executionStore(), roster = new Store(), registry = new InternalCapabilities();
  try {
    const bot = roster.createBot({ name: 'Window fixture' }, { seedMessages: false, noAccess: true });
    setMemoryMode('active');
    const ticket = ownerMemoryTicket();
    const input = { action: 'identity-write' as const, botId: bot.id, expectedVersion: 0, basis: 'fiction' as const, audience: 'owner-private' as const };
    const brief = writeBotIdentity(ticket, { ...input, kind: 'continuity-brief', key: 'core', text: 'BRIEF continue the harbour story.' }, roster);
    const canon = writeBotIdentity(ticket, { ...input, kind: 'character-canon', key: 'key', text: 'CANON a brass key.' }, roster);
    views.prepareRosterRecallViews(roster);
    await views.waitForRecallConstructionIdleForTest(roster);
    const binding = { botId: bot.id, threadId: bot.threadId, humanPrincipal: OWNER, notOwnerAudience: false };
    const view = views.resolveRecallView(binding, roster).handle, db = database();
    const projection = () => db.prepare(`SELECT watermark,(SELECT coalesce(max(sequence),0) FROM memory_recall_changes) AS latest
      FROM memory_recall_views WHERE view_id=? AND generation=?`).get(view.viewId, view.generation)!;
    expect(projection().watermark).toBe(projection().latest);
    const epoch = views.recallAuthorityEpoch(db);
    const reveal = writeBotIdentity(ticket, { ...input, kind: 'reveal-state', key: 'key', text: 'REVEAL the owner heard about the key.', canon: { id: canon.id, version: canon.version }, revealed: true }, roster);
    expect(views.recallAuthorityEpoch(db)).toBe(epoch);
    expect(views.resolveRecallView(binding, roster).handle).toEqual(view);
    expect(Number(projection().watermark)).toBeLessThan(Number(projection().latest));
    const maintenance = stalled ? vi.spyOn(views, 'maintainRecallViewSlice').mockReturnValue(false) : undefined;
    // ESM-local calls bypass an export spy; route this test's request through the spied export.
    if (stalled) vi.spyOn(views, 'requestRecallViewMaintenance').mockImplementation(handle => { views.maintainRecallViewSlice(handle); });
    registry.begin(bot.id, bot.threadId, 'turn');
    const token = registry.mint({ botId: bot.id, threadId: bot.threadId, generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
    const guardedRead = async () => {
      for (let remaining = 64; ; remaining--) {
        const mark = projection();
        if (Number(mark.watermark) >= Number(mark.latest)) return readMemoryBundle('', access, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() });
        if (remaining === 1) throw new Error('MEMORY_RECALL_UNAVAILABLE');
        views.requestRecallViewMaintenance(access.view);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    let bundle: Awaited<ReturnType<typeof readMemoryBundle>> | undefined;
    try { bundle = await guardedRead(); }
    catch (error) { if (!stalled) throw error; expect(error).toEqual(new Error('MEMORY_RECALL_UNAVAILABLE')); }
    if (bundle) {
      expect(bundle.identity.map(row => row.id)).toContain(brief.id);
      expect(bundle.identity.map(row => row.id)).toContain(reveal.id);
      expect(bundle.text).toContain('REVEAL the owner heard about the key.');
    } else expect(stalled).toBe(true);
    if (stalled) expect(maintenance).toHaveBeenCalled();
    console.info(JSON.stringify({ witness: 'W-B28-WINDOW', stalled, viewId: view.viewId, epoch, ...projection(), outcome: bundle ? 'REVEAL' : 'MEMORY_RECALL_UNAVAILABLE' }));
  } finally {
    vi.restoreAllMocks();
    registry.revokeAll();
    roster.stopSeqStamps();
    setMemoryCaptureRoster(null);
    setExecutionStore(previousStore);
    views.stopRecallViewMaintenance();
    vi.useRealTimers();
  }
});

// Hydration producer: recall-fix-g; delivery witness consumer: salvrow-recall-b28-sol.
it('W-B28-ALLOWANCE required identity evidence is delivered together or the dispatch bundle refuses', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const previousStore = executionStore(), roster = new Store(), registry = new InternalCapabilities();
  try {
    const bot = roster.createBot({ name: 'Evidence fixture' }, { seedMessages: false, noAccess: true });
    setMemoryMode('active');
    const input = { action: 'identity-write' as const, botId: bot.id, expectedVersion: 0, basis: 'fiction' as const, audience: 'owner-private' as const };
    const ticket = ownerMemoryTicket();
    const brief = writeBotIdentity(ticket, { ...input, kind: 'continuity-brief', key: 'core', text: 'BRIEF continue the harbour story.' }, roster);
    const canon = writeBotIdentity(ticket, { ...input, kind: 'character-canon', key: 'key', text: 'CANON a brass key.' }, roster);
    const reveal = writeBotIdentity(ticket, { ...input, kind: 'reveal-state', key: 'key', text: 'REVEAL the owner heard about the key.', canon: { id: canon.id, version: canon.version }, revealed: true }, roster);
    views.prepareRosterRecallViews(roster);
    await views.waitForRecallConstructionIdleForTest(roster);
    registry.begin(bot.id, bot.threadId, 'turn');
    const token = registry.mint({ botId: bot.id, threadId: bot.threadId, generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
    const db = database(), mark = db.prepare(`SELECT watermark,(SELECT coalesce(max(sequence),0) FROM memory_recall_changes) AS latest
      FROM memory_recall_views WHERE view_id=? AND generation=?`).get(access.view.viewId, access.view.generation)!;
    expect(mark.watermark).toBe(mark.latest);
    const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
    const controlAllowance = LineageAllowance.turn();
    const control = await buildMemoryBundleAfterReset('', access, bridge, undefined, { allowance: controlAllowance });
    expect(control.identity.map(row => row.id)).toEqual(expect.arrayContaining([brief.id, reveal.id]));
    const allowance = LineageAllowance.turn(), bound = allowance.room();
    allowance.spendNodes(bot.threadId, bound);
    const result = await buildMemoryBundleAfterReset('', access, bridge, undefined, { allowance }).then(bundle => ({ bundle }), error => ({ error }));
    console.info(JSON.stringify({ witness: 'W-B28-ALLOWANCE', bound, controlSpent: controlAllowance.spent, spent: allowance.spent, room: allowance.room(), outcome: 'error' in result ? 'refused' : 'bundle', ...('bundle' in result ? { brief: result.bundle.identity.some(row => row.id === brief.id), reveal: result.bundle.identity.some(row => row.id === reveal.id), degradedReason: result.bundle.degradedReason } : {}) }));
    expect(allowance.spent).toBe(bound);
    expect(() => assertMemoryAccess(access)).not.toThrow();
    if ('error' in result) expect(result.error).toMatchObject({ message: expect.stringMatching(/^MEMORY_(REPLAY_LIMIT|RECALL_UNAVAILABLE)$/) });
    else expect(result.bundle.identity.map(row => row.id)).toEqual(expect.arrayContaining([brief.id, reveal.id]));
  } finally {
    registry.revokeAll();
    roster.stopSeqStamps();
    setMemoryCaptureRoster(null);
    setExecutionStore(previousStore);
    views.stopRecallViewMaintenance();
    vi.useRealTimers();
  }
});

it('W-REF admitted dispatch retains its view across 160 sync and async generations until bundle completion', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  setMemoryMode('active');
  await views.prepareRecallContext('reader', 'direct', roster);
  const db = database(), registry = new InternalCapabilities();
  registry.begin('reader', 'direct', 'turn');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  let resume!: () => void, completed = false, highWater = 0;
  const reset = new Promise<void>(resolve => { resume = resolve; });
  // This is the same reset-before-bundle boundary used by direct and room dispatch.
  const pending = buildMemoryBundleAfterReset('', access, { search: async () => ({ hits: [], vectorRows: 0 }) }, () => reset, { allowance: LineageAllowance.tool() });
  try {
    for (let n = 0; n < 160; n++) {
      roster.memoryRosterRevision!++;
      reconcileMemoryRoster(roster);
      if (n % 2) await views.prepareRecallContext('reader', 'direct', roster);
      else views.prepareRecallContextSync('reader', 'direct', roster);
      highWater = Math.max(highWater, Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n));
      expect(highWater).toBeLessThanOrEqual(128);
    }
    // Equivalent revisions republish one view, so supersede the admitted view explicitly: drop its context row and publish a fresh build.
    db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=? AND generation=?').run(access.view.viewId, access.view.generation);
    views.prepareRecallContextSync('reader', 'direct', roster);
    expect(views.resolveRecallView({ botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false }, roster).handle.viewId).not.toBe(access.view.viewId);
    expect(db.prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation)?.state).toBe('ready');
    expect(() => views.assertRecallView(db, access.view, { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false })).toThrow('MEMORY_RECALL_UNAVAILABLE');
    resume();
    await expect(pending).resolves.toMatchObject({ recordVersions: [] });
    completed = true;
    expect(() => assertMemoryAccess(access)).not.toThrow();
    console.info(JSON.stringify({ witness: 'W-REF', generations: 160, highWater, completed }));
    db.exec("INSERT INTO memory_scopes VALUES('admitted-authority','project','fixture-admitted','[]',0)");
    expect(() => views.assertRecallView(db, access.view)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  } finally {
    resume();
    await pending.catch(() => undefined);
    registry.revokeAll();
    views.stopRecallViewMaintenance();
  }
  while (!views.collectRecallViewSlice(db)) { /* Release the dispatch's obsolete publication. */ }
  expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
});

it('W-REF-CHURN audience churn supersedes the admitted view every generation: its rows stay until teardown and the read fails closed', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }],
    groups: [{ id: 'alt-a', threadId: 'alt-a-thread', memberIds: ['reader'] }, { id: 'alt-b', threadId: 'alt-b-thread', memberIds: ['reader'] }] };
  reconcileMemoryRoster(roster);
  setMemoryMode('active');
  await views.prepareRecallContext('reader', 'direct', roster);
  const db = database(), registry = new InternalCapabilities();
  registry.begin('reader', 'direct', 'turn');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
  const admitted = () => db.prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation);
  let resume!: () => void, highWater = 0;
  const reset = new Promise<void>(resolve => { resume = resolve; });
  const pending = buildMemoryBundleAfterReset('', access, { search: async () => ({ hits: [], vectorRows: 0 }) }, () => reset, { allowance: LineageAllowance.tool() });
  const outcome = pending.then(() => 'delivered', error => String((error as Error).message));
  const published = new Set<string>();
  try {
    for (let n = 0; n < 160; n++) {
      roster.memoryRosterRevision!++;
      alternateAudience(roster, n);
      reconcileMemoryRoster(roster);
      if (n % 2) await views.prepareRecallContext('reader', 'direct', roster);
      else views.prepareRecallContextSync('reader', 'direct', roster);
      published.add(views.resolveRecallView(binding, roster).handle.viewId);
      highWater = Math.max(highWater, Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n));
      expect(highWater).toBeLessThanOrEqual(128);
      // The admitted reader's view outlives every later generation while its read is pending.
      expect(admitted()).toBeDefined();
    }
    expect(published.size).toBe(160);
    expect(published.has(access.view.viewId)).toBe(false);
    resume();
    // The audience changed under the admitted turn: its read is refused, never served from the superseded view.
    expect(await outcome).toBe('MEMORY_CONTEXT_REVOKED');
    console.info(JSON.stringify({ witness: 'W-REF-CHURN', generations: published.size, highWater, admitted: admitted()?.state }));
  } finally {
    resume();
    await outcome;
    registry.revokeAll();
    views.stopRecallViewMaintenance();
  }
  while (!views.collectRecallViewSlice(db)) { /* Release the dispatch's obsolete publication. */ }
  expect(admitted()).toBeUndefined();
});

it('released readers permit more than 128 builds across four contexts and roster generations', async () => {
  const threads = ['direct', 'task-a', 'task-b', 'task-c'];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRosterRecallViews(roster);
  await views.waitForRecallConstructionIdleForTest(roster);
  const db = database(), before = views.recallViewCounters().oracleComputes;
  let completed = 0, highWater = 0;
  for (let n = 0; n < 160; n++) {
    const thread = threads[n % threads.length];
    roster.memoryRosterRevision!++;
    reconcileMemoryRoster(roster);
    try { await expect(views.prepareRecallContext('reader', thread, roster)).resolves.toBeUndefined(); }
    catch (error) {
      console.info(JSON.stringify({ completed, highWater, activeReaders: 0, contexts: db.prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n }));
      throw error;
    }
    const registry = new InternalCapabilities();
    registry.begin('reader', thread, 'turn');
    const token = registry.mint({ botId: 'reader', threadId: thread, generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
    try {
      const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
      expect(() => assertMemoryAccess(access)).not.toThrow();
      highWater = Math.max(highWater, Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n));
      expect(highWater).toBeLessThanOrEqual(128);
      completed++;
    } finally { registry.revokeAll(); }
  }
  expect(completed).toBe(160);
  expect(views.recallViewCounters().oracleComputes - before).toBeGreaterThanOrEqual(160);
  while (!views.collectRecallViewSlice(db)) { /* Drain obsolete generations after the burst. */ }
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n).toBe(threads.length * 2);
  console.info(JSON.stringify({ completed, highWater, contexts: db.prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n }));
});

// Pressure policy producer: recall-privacy-close-b; async reclaim consumer: salvrow-recall-b28-sol.
// D7 (recall-cap, 1.0.19 merge): b28 asserted that a new context refuses at the cap before any reclamation. That contradicts the train's
// collector witness ("more than 128 contexts", review H1 arev-r12fix-s3b6) and reclaim-r2 W2/W3, which require every waiting build to
// reclaim in place. The merged rule: a new admission retires an unheld obsolete generation first and never evicts a live publication.
for (const asyncBuild of [false, true]) it(`W-PRESSURE ${asyncBuild ? 'async' : 'sync'} new admission retires an obsolete generation before any current publication`, async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: [{ threadId: 'incoming' }] }], groups: [] };
  try {
    reconcileMemoryRoster(roster);
    views.prepareRecallContextSync('reader', 'direct', roster);
    const db = database(), count = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
    const current = db.prepare('SELECT view_id FROM memory_recall_contexts').get()!.view_id;
    const add = db.prepare(`INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader)
      VALUES(?,'generation',?,1,'ready',1,'fixture',0)`);
    for (let n = 0; n < 127; n++) add.run(`obsolete-${n}`, views.recallAuthorityEpoch(db));
    expect(count()).toBe(128);
    if (asyncBuild) await expect(views.prepareRecallContext('reader', 'incoming', roster)).resolves.toBeUndefined();
    else expect(() => views.prepareRecallContextSync('reader', 'incoming', roster)).not.toThrow();
    expect(count()).toBeLessThanOrEqual(128);
    const incoming = views.recallContextKey({ botId: 'reader', threadId: 'incoming', humanPrincipal: threadHumanPrincipal('incoming'), notOwnerAudience: false });
    // The existing publication survives; only obsolete generations made the room.
    expect(db.prepare('SELECT view_id FROM memory_recall_contexts WHERE context_key<>?').all(incoming)).toEqual([{ view_id: current }]);
    expect(db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(incoming)).toBeTruthy();
    for (let n = 0; n < 127; n++) add.run(`refill-${n}`, views.recallAuthorityEpoch(db));
    while (count() > 128) db.prepare("DELETE FROM memory_recall_views WHERE view_id=(SELECT max(view_id) FROM memory_recall_views WHERE view_id LIKE 'refill-%')").run();
    expect(count()).toBe(128);
    // The existing idle context still makes progress at the same cap, without a maintenance tick.
    roster.memoryRosterRevision!++;
    if (asyncBuild) await expect(views.prepareRecallContext('reader', 'direct', roster)).resolves.toBeUndefined();
    else expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).not.toThrow();
    expect(count()).toBeLessThan(128);
    views.prepareRecallContextSync('reader', 'incoming', roster);
    expect(count()).toBeLessThanOrEqual(128);
  } finally { views.stopRecallViewMaintenance(); vi.useRealTimers(); }
});

for (const asyncBuild of [false, true]) it(`W-PRESSURE ${asyncBuild ? 'async' : 'sync'} idle replacement finishes after retiring its own publication`, async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const threads = ['direct', ...Array.from({ length: 127 }, (_, n) => `idle-${n}`)];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  try {
    reconcileMemoryRoster(roster);
    for (const thread of threads) views.prepareRecallContextSync('reader', thread, roster);
    const db = database(), binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
    const original = views.resolveRecallView(binding, roster).handle;
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
    roster.memoryRosterRevision!++;
    if (asyncBuild) await expect(views.prepareRecallContext('reader', 'direct', roster)).resolves.toBeUndefined();
    else expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).not.toThrow();
    const current = views.resolveRecallView(binding, roster).handle;
    expect(current.viewId).not.toBe(original.viewId);
    expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(original.viewId)).toBeUndefined();
    expect(() => views.assertRecallView(db, current, binding)).not.toThrow();
    expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)).toBeLessThanOrEqual(128);
  } finally { views.stopRecallViewMaintenance(); vi.useRealTimers(); }
});

it('W-PRESSURE an existing idle context commits bounded partial reclamation before refusing', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  try {
    reconcileMemoryRoster(roster);
    views.prepareRecallContextSync('reader', 'direct', roster);
    const db = database(), add = db.prepare(`INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader)
      VALUES(?,'generation',?,1,'ready',1,'fixture',0)`);
    for (let n = 0; n < 127; n++) add.run(`obsolete-${n}`, views.recallAuthorityEpoch(db));
    const term = db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let n = 0; n < 17_000; n++) term.run('obsolete-0', 'generation', `term-${n}`, n, 'record', 1);
    db.exec('COMMIT');
    roster.memoryRosterRevision!++;
    expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    const remaining = Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE view_id='obsolete-0'").get()!.n);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(17_000 - 60 * 256);
    expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).not.toThrow();
  } finally { views.stopRecallViewMaintenance(); vi.useRealTimers(); }
});

it('a reopened file retains its issued reader without automatically rebuilding its cold context', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRecallContextSync('reader', 'direct', roster);
  const registry = new InternalCapabilities();
  registry.begin('reader', 'direct', 'turn');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  try {
    closeDatabase();
    const db = database(), before = views.recallViewCounters().oracleComputes;
    views.prepareActiveRecallReaders();
    expect(views.recallViewCounters().oracleComputes).toBe(before);
    db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(access.view.viewId);
    for (let slice = 0; slice < 64; slice++) views.collectRecallViewSlice(db);
    expect(() => views.assertIssuedRecallView(db, access.view)).not.toThrow();
  } finally { registry.revokeAll(); }
  const db = database();
  for (let slice = 0; slice < 64; slice++) views.collectRecallViewSlice(db);
  expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
});

for (const asyncBuild of [false, true]) for (const obsolete of [false, true]) it(`W-PRESSURE ${asyncBuild ? 'async' : 'sync'} live context ${obsolete ? 'retires only unheld obsolete generations' : 'refuses to evict idle publications'}`, async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const threads = ['direct', ...Array.from({ length: 127 }, (_, n) => `idle-${n}`)];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  const registry = new InternalCapabilities();
  try {
    reconcileMemoryRoster(roster);
    for (const thread of obsolete ? ['direct'] : threads) views.prepareRecallContextSync('reader', thread, roster);
    registry.begin('reader', 'direct', 'turn');
    const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster), db = database();
    if (obsolete) {
      const add = db.prepare(`INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader)
        VALUES(?,'generation',?,1,'ready',1,'fixture',0)`);
      for (let n = 0; n < 127; n++) add.run(`obsolete-${n}`, views.recallAuthorityEpoch(db));
    }
    const before = db.prepare('SELECT * FROM memory_recall_contexts ORDER BY context_key').all();
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
    roster.memoryRosterRevision!++;
    if (asyncBuild) {
      const pending = views.prepareRecallContext('reader', 'direct', roster);
      if (obsolete) await expect(pending).resolves.toBeUndefined();
      else await expect(pending).rejects.toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    } else if (obsolete) expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).not.toThrow();
    else expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    const after = db.prepare('SELECT * FROM memory_recall_contexts ORDER BY context_key').all();
    if (obsolete) {
      // recallrest-1020 (port onto 1.0.19): 1.0.19's publishRecallView gives a roster object that prepares its own cached context again a
      // fresh generation, so this context's row names the new view. No other context exists here; what the pressure may retire is the
      // unheld obsolete generations, never the view the live reader was issued (asserted below).
      expect(after.map(row => row.context_key)).toEqual(before.map(row => row.context_key));
      expect(db.prepare("SELECT 1 FROM memory_recall_views WHERE view_id=? AND generation=? AND state='ready'").get(after[0]!.view_id, after[0]!.generation)).toBeDefined();
      expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation)).toBeDefined();
      expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE view_id LIKE 'obsolete-%'").get()!.n)).toBeLessThan(127);
    } else expect(after).toEqual(before);
    expect(() => views.assertIssuedRecallView(db, access.view)).not.toThrow();
    expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)).toBeLessThanOrEqual(128);
  } finally { registry.revokeAll(); views.stopRecallViewMaintenance(); vi.useRealTimers(); }
});

it('W-PRESSURE pressure-marked teardown commits only a bounded obsolete-generation batch', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: [{ threadId: 'incoming' }] }], groups: [] };
  const registry = new InternalCapabilities(), other = new InternalCapabilities();
  try {
    reconcileMemoryRoster(roster);
    views.prepareRecallContextSync('reader', 'direct', roster);
    registry.begin('reader', 'direct', 'turn');
    const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster), db = database();
    other.begin('reader', 'direct', 'other-turn');
    const otherToken = other.mint({ botId: 'reader', threadId: 'direct', generation: 'other-turn', depth: 0, kind: 'memory', skillAuthoring: false });
    const otherAccess = memoryAccess(other, other.resolve(`Bearer ${otherToken}`)!, () => roster);
    expect(otherAccess.view).toEqual(access.view);
    db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(access.view.viewId);
    const add = db.prepare(`INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader)
      VALUES(?,'generation',?,1,'ready',1,'fixture',0)`);
    for (let n = 0; n < 127; n++) {
      const id = `z-current-${n}`;
      add.run(id, views.recallAuthorityEpoch(db));
      db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(JSON.stringify([id]), id, 'generation');
    }
    const term = db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let n = 0; n < 17_000; n++) term.run(access.view.viewId, access.view.generation, `term-${n}`, n, 'record', 1);
    db.exec('COMMIT');
    // D7: a new context now reclaims an idle slot in place, so the pressure mark comes from the live context's own refusal:
    // its readers hold the only unheld-looking generation, and it may never evict another context's publication.
    expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    registry.revokeAll();
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
    expect(() => views.assertIssuedRecallView(db, otherAccess.view)).not.toThrow();
    other.revokeAll();
    const remaining = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms WHERE view_id=?').get(access.view.viewId)!.n);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(17_000 - 60 * 256);
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
  } finally { registry.revokeAll(); other.revokeAll(); views.stopRecallViewMaintenance(); vi.useRealTimers(); }
});

it('all 128 held generations survive pressure, refuse another view, and free capacity on teardown', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.startRecallViewMaintenance();
  const db = database(), readers: { registry: InternalCapabilities; view: views.RecallViewHandle }[] = [];
  try {
    for (let n = 0; n < 128; n++) {
      roster.memoryRosterRevision!++;
      churnAudience(roster, n);
      reconcileMemoryRoster(roster);
      await expect(views.prepareRecallContext('reader', 'direct', roster)).resolves.toBeUndefined();
      const registry = new InternalCapabilities();
      registry.begin('reader', 'direct', 'turn');
      const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
      const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
      readers.push({ registry, view: access.view });
      expect(() => views.assertIssuedRecallView(db, readers[0].view)).not.toThrow();
    }
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
    expect(() => views.prepareRecallContextSync('reader', 'direct', roster, true)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    await expect(views.prepareRecallContext('reader', 'direct', roster, true)).rejects.toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    for (const reader of readers) expect(() => views.assertIssuedRecallView(db, reader.view)).not.toThrow();
    readers[0].registry.revokeAll();
    for (const reader of readers.slice(1)) expect(() => views.assertIssuedRecallView(db, reader.view)).not.toThrow();
  } finally { for (const reader of readers) reader.registry.revokeAll(); }
  await expect(views.prepareRecallContext('reader', 'direct', roster, true)).resolves.toBeUndefined();
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBeLessThanOrEqual(128);
});

it('authority changes reject both a published view and suspended construction', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  await views.prepareRecallContext('reader', 'direct', roster);
  const db = database();
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
  const view = views.resolveRecallView(binding, roster).handle;
  const pending = views.prepareRecallContext('reader', 'direct', roster);
  db.exec("INSERT INTO memory_scopes VALUES('changed-authority','project','fixture-project','[]',0)");
  expect(() => views.assertRecallView(db, view)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await expect(pending).rejects.toThrow('MEMORY_CONTEXT_REVOKED');
});


it('synchronous publication reclaims superseded generations while a live original handle survives', () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRecallContextSync('reader', 'direct', roster);
  const db = database(), registry = new InternalCapabilities();
  registry.begin('reader', 'direct', 'turn');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  let highWater = 0;
  try {
    for (let n = 0; n < 160; n++) {
      roster.memoryRosterRevision!++;
      churnAudience(roster, n);
      reconcileMemoryRoster(roster);
      expect(() => views.prepareRecallContextSync('reader', 'direct', roster)).not.toThrow();
      expect(() => views.assertIssuedRecallView(db, access.view)).not.toThrow();
      highWater = Math.max(highWater, Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n));
      expect(highWater).toBeLessThanOrEqual(128);
      // The publication itself reclaims: only the current view and the live original remain, not a pile awaiting the cap.
      expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(2);
    }
  } finally { registry.revokeAll(); }
  while (!views.collectRecallViewSlice(db)) { /* Finish normal teardown. */ }
  expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
});

it('acknowledged presentation revisions reuse a demanded view without consuming capacity', () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRecallContextSync('reader', 'direct', roster);
  const before = views.recallViewCounters().oracleComputes;
  for (let n = 0; n < 160; n++) {
    roster.memoryRosterRevision!++;
    views.acknowledgeRecallRosterRevision(roster);
    views.prepareRecallContextSync('reader', 'direct', roster);
  }
  expect(views.recallViewCounters().oracleComputes).toBe(before);
  expect(database().prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(1);
});

it('acknowledged presentation revisions leave background roster preparation nothing to rebuild', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRecallContextSync('reader', 'direct', roster);
  views.queueRecallRosterPreparation(() => roster);
  await views.waitForRecallConstructionIdleForTest(roster);
  const published = () => database().prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts ORDER BY context_key').all();
  const before = views.recallViewCounters().oracleComputes, contexts = published();
  expect(contexts.length).toBeGreaterThan(0);
  for (let n = 0; n < 8; n++) {
    roster.memoryRosterRevision!++;
    views.acknowledgeRecallRosterRevision(roster);
    views.queueRecallRosterPreparation(() => roster);
    await views.waitForRecallConstructionIdleForTest(roster);
  }
  expect(views.recallViewCounters().oracleComputes).toBe(before);
  expect(published()).toEqual(contexts);
});

it('speculative rebuilds on a full store cannot evict a current idle publication', async () => {
  const tasks = Array.from({ length: 127 }, (_, n) => ({ threadId: `task-${n}` }));
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database();
  // Demanded preparation fills all 128 contexts; no reader holds any of them.
  for (const threadId of ['direct', ...tasks.map(task => task.threadId)]) await views.prepareRecallContext('reader', threadId, roster);
  const published = () => db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts ORDER BY context_key').all();
  const before = published();
  expect(before).toHaveLength(128);
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
  // An unacknowledged revision makes every cached context stale; rebuilding them is speculative warming with no free slot.
  roster.memoryRosterRevision!++;
  views.prepareRosterRecallViews(roster);
  // Refusal is internal: each speculative rebuild is dropped and construction settles instead of spinning to the deadline.
  await expect(views.waitForRecallConstructionIdleForTest(roster)).resolves.toBeUndefined();
  // Speculative refusal must also protect the publication when the next bounded collector tick runs.
  for (let slice = 0; slice < 64; slice++) views.collectRecallViewSlice(db);
  expect(published()).toEqual(before);
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(128);
}, 30_000);

it('512 speculative tasks preserve the demanded original publication within the 128-view high-water bound', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: Array.from({ length: 512 }, (_, n) => ({ threadId: `task-${n}` })) }], groups: [] };
  reconcileMemoryRoster(roster);
  await views.prepareRecallContext('reader', 'direct', roster);
  const db = database(), binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
  const original = views.resolveRecallView(binding, roster).handle;
  let highWater = 0, finished = false, constructionFailure: unknown;
  views.prepareRosterRecallViews(roster);
  await new Promise<void>(resolve => setImmediate(resolve));
  roster.memoryRosterRevision!++;
  views.acknowledgeRecallRosterRevision(roster);
  const construction = views.waitForRecallConstructionIdleForTest(roster).catch(error => { constructionFailure = error; }).finally(() => { finished = true; });
  try {
    while (!finished) {
      highWater = Math.max(highWater, Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n));
      expect(highWater).toBeLessThanOrEqual(128);
      expect(() => views.assertRecallView(db, original, binding)).not.toThrow();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (constructionFailure) throw constructionFailure;
    expect(highWater).toBeGreaterThan(0);
    expect(highWater).toBeLessThanOrEqual(128);
    expect(views.resolveRecallView(binding, roster).handle).toEqual(original);
    console.info(JSON.stringify({ tasks: 512, highWater }));
  } finally { closeDatabase(); await construction; }
}, 30_000);
