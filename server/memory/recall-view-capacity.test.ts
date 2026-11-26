// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// R01 owner: recall-reclaim-r2 (view cap: reclaim, parked demand and the never-silent refusal).
// Readiness schedule owner: recall-s1s2. Reader lease owner: askcards-flake-b.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { OWNER } from '../human-principals.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { assertMemoryAccess, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from './policy.ts';
import { RecallCapacityRefused, RecallDispatchPending, RecallHeld, RecallReadiness } from './recall-readiness.ts';
import { RecallCapacityPending, RecallPreparationPending, MemoryPinProjectionPending } from './recall-recovery.ts';
import { OWNER_PIN } from './schema.ts';
import * as views from './recall-view.ts';

const REVIEWED_CARD = 'This reply is still being prepared, so this message was not sent. Send it again in a moment.';
const registries: InternalCapabilities[] = [];
// Reader leases are process-wide, so a lease taken without a registry must be released at teardown or it outlives its database.
const releases: (() => void)[] = [];
// q1022-rvh (CHANGED-EXPECTATIONS.md, q1022-upgradecatchup build pace): this file's rows predate the build pace (recall-view.ts RECALL_BUILD_BYTES_PER_MINUTE) and test what is built, reclaimed and refused, not how fast; the pace is opened for them. The pace has its own witnesses (upgrade-catchup-1022.test.ts W-PACE, W-CAP, W-STEADY, W-TURN-PACE).
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql); views.setRecallBuildPaceForTest(Infinity); });
afterEach(() => { vi.useRealTimers(); for (const release of releases.splice(0)) release(); for (const registry of registries.splice(0)) registry.revokeAll(); views.stopRecallViewMaintenance(); closeDatabase(); });

const binding = (botId: string, threadId: string) => ({ botId, threadId, humanPrincipal: OWNER, notOwnerAudience: false });
const viewRows = () => Number(database().prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
const deadRows = () => Number(database().prepare(`SELECT count(*) AS n FROM memory_recall_views v
  WHERE NOT EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation)`).get()!.n);
const hasContext = (botId: string, threadId: string) => !!database().prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey(binding(botId, threadId)));
/** One turn's memory claim. The reader lease lasts until the registry is revoked, as at turn teardown. */
function turn(botId: string, threadId: string, roster: MemoryRoster): { registry: InternalCapabilities; read: () => MemoryAccess } {
  const registry = new InternalCapabilities();
  registries.push(registry);
  registry.begin(botId, threadId, 'turn');
  const token = registry.mint({ botId, threadId, generation: 'turn', depth: 0, kind: 'memory', skillAuthoring: false });
  return { registry, read: () => memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster) };
}
// An equivalent audience republishes the same view, so each generation changes the reader's audience.
function nextGeneration(roster: MemoryRoster, n: number): void {
  roster.memoryRosterRevision!++;
  roster.groups.push({ id: `busy-${n}`, threadId: `busy-thread-${n}`, memberIds: ['reader'] });
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
}
/** `live` bots hold an admitted reader each; the rest of the first 128 have an idle current view. One more bot has none. */
async function filledStore(live: number, late = 0): Promise<{ roster: MemoryRoster; readers: { registry: InternalCapabilities; access: MemoryAccess; botId: string; threadId: string }[] }> {
  const bots = Array.from({ length: 128 }, (_, n) => ({ id: `bot-${n}`, threadId: `thread-${n}` }));
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [...bots, { id: 'newcomer', threadId: 'first-thread' },
    ...Array.from({ length: late }, (_, n) => ({ id: `late-${n}`, threadId: `late-thread-${n}` }))], groups: [] };
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  const readers = [];
  for (const [n, bot] of bots.entries()) {
    await views.prepareRecallContext(bot.id, bot.threadId, roster);
    if (n < 128 - live) continue;
    const reader = turn(bot.id, bot.threadId, roster);
    readers.push({ registry: reader.registry, access: reader.read(), botId: bot.id, threadId: bot.threadId });
  }
  expect(viewRows()).toBe(128);
  expect(deadRows()).toBe(0);
  return { roster, readers };
}

// Timer upkeep is stopped throughout: on the unfixed tree dead generations wait for its 50 ms tick, which a busy
// conversation outruns. Stopping it makes that order deterministic and proves reclaim does not depend on the timer.
for (const path of ['turn', 'sync'] as const) it(`W1 a busy conversation keeps recall through 220 generations (${path} path) and dead views never fill the cap`, async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  let highWater = 0, kept = 0;
  for (let n = 0; n < 220; n++) {
    nextGeneration(roster, n);
    if (path === 'sync') views.prepareRecallContextSync('reader', 'direct', roster);
    else {
      // The turn's first probe finds the superseded view, asks for the new one and construction runs on the queue.
      expect(() => views.resolveRecallView(binding('reader', 'direct'), roster)).toThrow(RecallPreparationPending);
      await views.waitForRecallConstructionIdleForTest(roster);
    }
    const reader = turn('reader', 'direct', roster);
    let access: MemoryAccess | undefined;
    try { access = reader.read(); } catch (error) { expect({ generation: n, viewRows: viewRows(), deadRows: deadRows(), error: String(error) }).toEqual({ generation: n, recall: 'kept' }); }
    expect(() => assertMemoryAccess(access!)).not.toThrow();
    reader.registry.revokeAll();
    kept++;
    highWater = Math.max(highWater, viewRows());
    expect(highWater).toBeLessThanOrEqual(128);
  }
  expect(kept).toBe(220);
  expect(hasContext('reader', 'direct')).toBe(true);
  console.info(JSON.stringify({ witness: 'W1', path, generations: kept, highWater, deadRows: deadRows() }));
});

it('W2 128 live readers and a new bot: the owner first turn is refused on its card after the bounded wait, never held, and the parked demand builds when a reader ends', async () => {
  const { roster, readers } = await filledStore(128);
  const db = database(), newcomer = turn('newcomer', 'first-thread', roster);
  const readiness = new RecallReadiness(), started = performance.now();
  const outcome = await readiness.access(newcomer.read, new AbortController().signal).then(() => 'ran with recall', (error: unknown) => error);
  const elapsed = performance.now() - started;
  // RecallHeld would redispatch this turn without recall. The refusal is a dispatch failure with the reviewed words.
  expect(outcome).not.toBeInstanceOf(RecallHeld);
  expect(outcome).toBeInstanceOf(RecallDispatchPending);
  expect((outcome as Error).message).toBe(REVIEWED_CARD);
  expect(() => readiness.assertHeld()).toThrow(MemoryPinProjectionPending);
  expect(elapsed).toBeGreaterThanOrEqual(290);
  expect(elapsed).toBeLessThan(2000);
  expect(viewRows()).toBe(128);
  for (const reader of readers) expect(() => assertMemoryAccess(reader.access)).not.toThrow();
  expect(hasContext('newcomer', 'first-thread')).toBe(false);
  // No new request from the refused turn: one live reader ends, and the parked demand is built.
  readers[0].registry.revokeAll();
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(hasContext('newcomer', 'first-thread')).toBe(true);
  expect(viewRows()).toBeLessThanOrEqual(128);
  for (const reader of readers.slice(1)) expect(() => assertMemoryAccess(reader.access)).not.toThrow();
  const again = await new RecallReadiness().access(newcomer.read, new AbortController().signal);
  expect(() => assertMemoryAccess(again)).not.toThrow();
  expect(() => views.assertRecallView(db, again.view, binding('newcomer', 'first-thread'))).not.toThrow();
  console.info(JSON.stringify({ witness: 'W2', refusedAfterMs: Math.round(elapsed), viewRows: viewRows() }));
});

it('W2-WAIT a reader that ends inside the bounded wait lets the new bot first turn run with recall, with no card and no longer wait', async () => {
  const { roster, readers } = await filledStore(128);
  const newcomer = turn('newcomer', 'first-thread', roster);
  const readiness = new RecallReadiness(), started = performance.now();
  const pending = readiness.access(newcomer.read, new AbortController().signal);
  pending.catch(() => undefined);
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  expect(hasContext('newcomer', 'first-thread')).toBe(false);
  readers[7].registry.revokeAll();
  const access = await pending;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(() => assertMemoryAccess(access)).not.toThrow();
  expect(viewRows()).toBeLessThanOrEqual(128);
  for (const reader of readers) if (reader !== readers[7]) expect(() => assertMemoryAccess(reader.access)).not.toThrow();
});

it('W3 making room retires only the one idle view: 127 live views keep every handle and the new bot gets recall', async () => {
  const { roster, readers } = await filledStore(127);
  const db = database();
  expect(readers).toHaveLength(127);
  expect(hasContext('bot-0', 'thread-0')).toBe(true);
  const newcomer = turn('newcomer', 'first-thread', roster);
  const access = await new RecallReadiness().access(newcomer.read, new AbortController().signal);
  expect(() => assertMemoryAccess(access)).not.toThrow();
  expect(hasContext('bot-0', 'thread-0')).toBe(false);
  expect(viewRows()).toBeLessThanOrEqual(128);
  for (const reader of readers) {
    expect(hasContext(reader.botId, reader.threadId)).toBe(true);
    expect(() => views.assertRecallView(db, reader.access.view, binding(reader.botId, reader.threadId))).not.toThrow();
    expect(() => assertMemoryAccess(reader.access)).not.toThrow();
  }
  // The store is now full of live views only: a second new demand cannot retire any of them.
  roster.bots.push({ id: 'second-newcomer', threadId: 'second-thread' });
  roster.memoryRosterRevision!++;
  views.acknowledgeRecallRosterRevision(roster);
  expect(() => views.resolveRecallView(binding('second-newcomer', 'second-thread'), roster)).toThrow(RecallPreparationPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(hasContext('second-newcomer', 'second-thread')).toBe(false);
  expect(() => views.resolveRecallView(binding('second-newcomer', 'second-thread'), roster)).toThrow(RecallCapacityPending);
  for (const reader of readers) expect(() => views.assertRecallView(db, reader.access.view, binding(reader.botId, reader.threadId))).not.toThrow();
  expect(() => assertMemoryAccess(access)).not.toThrow();
});

it('W2-UNIT only a capacity refusal at the last probe ends on the card; a view still building keeps the held path', async () => {
  const capacity = new RecallReadiness();
  const refused = await capacity.access(() => { throw new RecallCapacityPending(); }, new AbortController().signal).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(RecallCapacityRefused);
  expect(refused).not.toBeInstanceOf(RecallPreparationPending);
  expect((refused as Error).message).toBe(REVIEWED_CARD);
  expect(() => capacity.assertHeld()).toThrow(MemoryPinProjectionPending);
  let probe = 0;
  const cleared = new RecallReadiness();
  await expect(cleared.access(() => { throw probe++ < 2 ? new RecallCapacityPending() : new RecallPreparationPending(); }, new AbortController().signal)).rejects.toBeInstanceOf(RecallHeld);
  expect(() => cleared.assertHeld()).not.toThrow();
});

/** Every view of the full store held by a lease that can end without its release call (as an expired turn's does). */
async function silentLeases(newcomers: number): Promise<{ roster: MemoryRoster; live: boolean[]; handles: views.RecallViewHandle[]; asks: () => number }> {
  const { roster } = await filledStore(0, newcomers);
  const db = database(), live = Array.from({ length: 128 }, () => true), handles: views.RecallViewHandle[] = [];
  for (let n = 0; n < 128; n++) {
    handles.push(views.resolveRecallView(binding(`bot-${n}`, `thread-${n}`), roster).handle);
    releases.push(views.retainRecallView(handles[n], binding(`bot-${n}`, `thread-${n}`), () => live[n]));
  }
  for (let n = 0; n < newcomers; n++) {
    expect(() => views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), roster)).toThrow(RecallPreparationPending);
    await views.waitForRecallConstructionIdleForTest(roster);
    expect(() => views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), roster)).toThrow(RecallCapacityPending);
    // That probe asked again too; let it settle parked before any tick is counted.
    await views.waitForRecallConstructionIdleForTest(roster);
  }
  const prepare = vi.spyOn(db, 'prepare');
  const asks = () => prepare.mock.calls.filter(([sql]) => sql === 'SELECT count(*) AS n FROM memory_recall_views').length;
  views.stopRecallViewMaintenance();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  views.startRecallViewMaintenance();
  return { roster, live, handles, asks };
}
async function oneUpkeepTick(roster: MemoryRoster): Promise<void> {
  vi.advanceTimersByTime(50);
  // memv2 lane A: the upkeep is no longer a 50 ms timer. While a reader is in a turn it looks again on a deadline of lane W's registry
  // (wall-clock times, which this file's fake setTimeout does not move), so "one tick" is one upkeep look, run here as that deadline would.
  views.runRecallUpkeepForTest();
  await views.waitForRecallConstructionIdleForTest(roster);
}

it('W4 a lease that ends without its release call: the next upkeep tick asks the parked demand again and it builds', async () => {
  const { roster, live, handles } = await silentLeases(1);
  await oneUpkeepTick(roster);
  expect(hasContext('late-0', 'late-thread-0')).toBe(false);
  live[5] = false;
  await oneUpkeepTick(roster);
  expect(hasContext('late-0', 'late-thread-0')).toBe(true);
  expect(viewRows()).toBeLessThanOrEqual(128);
  const db = database();
  for (let n = 0; n < 128; n++) if (n !== 5) expect(() => views.assertRecallView(db, handles[n], binding(`bot-${n}`, `thread-${n}`))).not.toThrow();
});

it('W5 an upkeep tick asks one parked demand again however many are parked, so tick work does not grow with the backlog', async () => {
  const one = await silentLeases(1);
  let before = one.asks();
  await oneUpkeepTick(one.roster);
  const single = one.asks() - before;
  expect(single).toBeGreaterThan(0);
  expect(() => views.resolveRecallView(binding('late-0', 'late-thread-0'), one.roster)).toThrow(RecallCapacityPending);
  vi.useRealTimers(); views.stopRecallViewMaintenance(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql);
  const six = await silentLeases(6);
  before = six.asks();
  await oneUpkeepTick(six.roster);
  expect(six.asks() - before).toBe(single);
  for (let n = 0; n < 6; n++) expect(() => views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), six.roster)).toThrow(RecallCapacityPending);
});

it('W6 a released reader asks the parked demand again at once, with no upkeep tick', async () => {
  const { roster, readers } = await filledStore(128);
  expect(() => views.resolveRecallView(binding('newcomer', 'first-thread'), roster)).toThrow(RecallPreparationPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(() => views.resolveRecallView(binding('newcomer', 'first-thread'), roster)).toThrow(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  // Upkeep is held still for the rest of the test: only the release itself can wake the parked demand.
  views.stopRecallViewMaintenance();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  views.startRecallViewMaintenance();
  readers[3].registry.revokeAll();
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(hasContext('newcomer', 'first-thread')).toBe(true);
  expect(viewRows()).toBeLessThanOrEqual(128);
  for (const reader of readers) if (reader !== readers[3]) expect(() => assertMemoryAccess(reader.access)).not.toThrow();
});

// MAIN ruling Q2: only a WAITING demand's build steps hold a ref'd handle; once nothing waits, none remains (shutdown not held).
it('W7 with no waiting demand no ref\'d build handle stays after construction is idle', async () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'solo', threadId: 'solo-thread' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  const pendingImmediates = () => process.getActiveResourcesInfo().filter((name) => name === 'Immediate').length;
  await views.waitForRecallConstructionIdleForTest(roster);
  const before = pendingImmediates();
  expect(() => views.resolveRecallView(binding('solo', 'solo-thread'), roster)).toThrow(RecallPreparationPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(hasContext('solo', 'solo-thread')).toBe(true);
  expect(pendingImmediates()).toBe(before);
});

// Review H1: the parked queue and its refusal marks are bounded at 128, so a 129th refused demand pushes the oldest out.
it('W8 more refused demands than the parked queue holds: the pushed-out turn still ends on its card at the last probe, never held', async () => {
  const { roster } = await filledStore(0, 129);
  const db = database(), handles: views.RecallViewHandle[] = [];
  for (let n = 0; n < 128; n++) {
    handles.push(views.resolveRecallView(binding(`bot-${n}`, `thread-${n}`), roster).handle);
    releases.push(views.retainRecallView(handles[n], binding(`bot-${n}`, `thread-${n}`), () => true));
  }
  views.stopRecallViewMaintenance();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const probes: unknown[] = [];
  const read = () => { try { return views.resolveRecallView(binding('late-0', 'late-thread-0'), roster); } catch (error) { probes.push(error); throw error; } };
  const readiness = new RecallReadiness();
  const outcome = readiness.access(read, new AbortController().signal).then(() => 'ran with recall', (error: unknown) => error);
  // First probe (0 ms) asked for the view; the store is full of live views, so the demand is refused and parked.
  await views.waitForRecallConstructionIdleForTest(roster);
  await vi.advanceTimersByTimeAsync(50);
  expect(probes).toHaveLength(2);
  expect(probes[1]).toBeInstanceOf(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  // 128 more first turns are refused while this one waits for its last probe; the bounded queue pushes the oldest out.
  for (let n = 1; n <= 128; n++) {
    expect(() => views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), roster)).toThrow(RecallPreparationPending);
    await views.waitForRecallConstructionIdleForTest(roster);
  }
  expect(() => views.resolveRecallView(binding('late-128', 'late-thread-128'), roster)).toThrow(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  // The last probe (300 ms) runs before anything can ask again for the pushed-out demand.
  vi.advanceTimersByTime(250);
  const ended = await outcome;
  expect(probes).toHaveLength(3);
  expect(probes[2]).toBeInstanceOf(RecallCapacityPending);
  expect(ended).not.toBeInstanceOf(RecallHeld);
  expect(ended).toBeInstanceOf(RecallCapacityRefused);
  expect((ended as Error).message).toBe(REVIEWED_CARD);
  expect(() => readiness.assertHeld()).toThrow(MemoryPinProjectionPending);
  expect(hasContext('late-0', 'late-thread-0')).toBe(false);
  expect(viewRows()).toBe(128);
  for (let n = 0; n < 128; n++) expect(() => views.assertRecallView(db, handles[n], binding(`bot-${n}`, `thread-${n}`))).not.toThrow();
});

it('W9 a refusal mark pushed out by a newer refusal still reads as refused, and the store-wide refusal ends once every refused demand is built', async () => {
  const { roster } = await filledStore(0, 129);
  const leases: (() => void)[] = [];
  for (let n = 0; n < 128; n++) leases.push(views.retainRecallView(views.resolveRecallView(binding(`bot-${n}`, `thread-${n}`), roster).handle, binding(`bot-${n}`, `thread-${n}`), () => true));
  releases.push(...leases);
  views.stopRecallViewMaintenance();
  for (let n = 0; n < 128; n++) {
    expect(() => views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), roster)).toThrow(RecallPreparationPending);
    await views.waitForRecallConstructionIdleForTest(roster);
  }
  // A new first turn is refused while one parked demand is asking again: every mark is in use, so the oldest mark is pushed out
  // although its own demand is still parked.
  expect(() => views.resolveRecallView(binding('late-128', 'late-thread-128'), roster)).toThrow(RecallPreparationPending);
  expect(() => views.resolveRecallView(binding('late-5', 'late-thread-5'), roster)).toThrow(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  const refusals = Array.from({ length: 129 }, (_, n) => { try { views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), roster); return 'ran'; } catch (error) { return error instanceof RecallCapacityPending ? 'refused' : 'pending'; } });
  expect(refusals.filter((kind) => kind !== 'refused')).toEqual([]);
  expect(viewRows()).toBe(128);
  // Every live turn ends: each refused demand is asked again and built, and the store-wide refusal ends with the last of them.
  for (const release of leases) release();
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(viewRows()).toBeLessThanOrEqual(128);
  let first: unknown;
  try { views.resolveRecallView(binding('newcomer', 'first-thread'), roster); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(RecallPreparationPending);
  expect(first).not.toBeInstanceOf(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(hasContext('newcomer', 'first-thread')).toBe(true);
});

// Review H1 (n4): the refusal must outlive the demands that pushed this one out. Capacity recovers between the pushed-out
// turn's second and last probe; its own view is still not built, so the turn ends on its card and is never dispatched held.
it('W10 capacity recovers before the pushed-out turn\'s last probe: that turn still ends on its card, then its view is built with no new request', async () => {
  const { roster } = await filledStore(0, 129);
  const leases: (() => void)[] = [];
  for (let n = 0; n < 128; n++) leases.push(views.retainRecallView(views.resolveRecallView(binding(`bot-${n}`, `thread-${n}`), roster).handle, binding(`bot-${n}`, `thread-${n}`), () => true));
  releases.push(...leases);
  views.stopRecallViewMaintenance();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const probes: unknown[] = [];
  const read = () => { try { return views.resolveRecallView(binding('late-0', 'late-thread-0'), roster); } catch (error) { probes.push(error); throw error; } };
  const readiness = new RecallReadiness();
  const outcome = readiness.access(read, new AbortController().signal).then(() => 'ran with recall', (error: unknown) => error);
  await views.waitForRecallConstructionIdleForTest(roster);
  await vi.advanceTimersByTimeAsync(50);
  expect(probes).toHaveLength(2);
  expect(probes[1]).toBeInstanceOf(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  // 128 more first turns are refused; the bounded queue pushes this turn's parked demand out.
  for (let n = 1; n <= 128; n++) {
    expect(() => views.resolveRecallView(binding(`late-${n}`, `late-thread-${n}`), roster)).toThrow(RecallPreparationPending);
    await views.waitForRecallConstructionIdleForTest(roster);
  }
  // Every live turn ends. The 128 demands still parked are asked again and built; nothing asks for the pushed-out one.
  for (const release of leases) release();
  await views.waitForRecallConstructionIdleForTest(roster);
  for (let n = 1; n <= 128; n++) expect(hasContext(`late-${n}`, `late-thread-${n}`)).toBe(true);
  expect(hasContext('late-0', 'late-thread-0')).toBe(false);
  expect(viewRows()).toBeLessThanOrEqual(128);
  // The last probe (300 ms): the store has room again, but this turn's view was never built.
  vi.advanceTimersByTime(250);
  const ended = await outcome;
  expect(probes).toHaveLength(3);
  expect(probes[2]).toBeInstanceOf(RecallCapacityPending);
  expect(ended).not.toBeInstanceOf(RecallHeld);
  expect(ended).toBeInstanceOf(RecallCapacityRefused);
  expect((ended as Error).message).toBe(REVIEWED_CARD);
  // That last probe asked again; the view is built without another send, and the resend runs with recall.
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(hasContext('late-0', 'late-thread-0')).toBe(true);
  expect(() => views.resolveRecallView(binding('late-0', 'late-thread-0'), roster)).not.toThrow();
  // Built means no longer refused: when the audience changes, its next view is ordinary preparation again (held path, not the card).
  roster.memoryRosterRevision!++;
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  let rebuilt: unknown;
  try { views.resolveRecallView(binding('late-0', 'late-thread-0'), roster); } catch (error) { rebuilt = error; }
  expect(rebuilt).toBeInstanceOf(RecallPreparationPending);
  expect(rebuilt).not.toBeInstanceOf(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  // The refusal was this turn's alone: a context that was never refused reads as ordinary preparation.
  let first: unknown;
  try { views.resolveRecallView(binding('newcomer', 'first-thread'), roster); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(RecallPreparationPending);
  expect(first).not.toBeInstanceOf(RecallCapacityPending);
});
