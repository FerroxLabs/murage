// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RoutineManager, type RoutineRun } from '../routines.ts';
import { historyInside } from '../testing/routine-history-fixture.ts';
import { historyWorkProbe } from '../testing/routine-history-work.ts';
import { collectionWorkProbe, type CollectionWork } from '../testing/collection-work-probe.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
const fixtures: Array<{manager: RoutineManager; root: string}> = [];
afterEach(() => { for (const {manager, root} of fixtures.splice(0)) { manager.stop(); removeTempDirSync(root); } });
function fixture(size: number) {
  const root = mkdtempSync(join(tmpdir(), 'murage-channel-history-'));
  const manager = new RoutineManager({file:join(root,'routines.json'), botState:()=>'ready', createTask:()=>null, startTurn:async()=>{}, channelThread:()=>({threadId:'shared-thread'})});
  fixtures.push({manager, root});
  const inside = historyInside(manager);
  const template: RoutineRun = {id:'live', routineId:'routine', routineName:'Fixture', botId:'bot', target:'bot', prompt:'Fixture', runOn:'ember', manual:false,
    triggerSource:'channel', threadId:'shared-thread', status:'running', createdAt:1, scheduledFor:1};
  inside.replaceStore([...Array.from({length:size}, (_,n) => ({...template, id:`past-${n}`, status:'completed' as const, channelTurnId:`past-turn-${n}`, finishedAt:2})), template]);
  manager.recoverPersistence();
  const canonical = (id: string) => inside.indexes.runsById.get(id)!;
  const start = (turnId: string, threadId = 'shared-thread') => manager.handleRuntimeEvent({type:'turn.started', threadId, turnId} as never);
  return {manager, inside, template, canonical, start};
}
it('historic channel turn rejection has equal reads with 10 and 10,000 settled runs', () => {
  const counts: CollectionWork[] = [];
  // Keep prior fixture managers out of the next sample's async-context copy work.
  const inContext = AsyncLocalStorage.snapshot();
  for (const size of [10, 10_000]) inContext(() => {
    const {manager, inside, canonical, start} = fixture(size);
    const reads = collectionWorkProbe(); reads.discover(manager, 'manager');
    const work = historyWorkProbe(manager); work.install(); reads.install();
    let measured;
    try { for (let n=0; n<8; n++) expect(start('past-turn-9')).toBeNull(); }
    finally { reads.uninstall(); measured = work.stop(); }
    expect(canonical('live').channelTurnId).toBeUndefined();
    expect(inside.runStore.size).toBe(size + 1);
    expect(measured.storeTraversals).toBe(0); expect(measured.storeVisits).toBe(0);
    expect(measured.retainedMapVisits).toBe(0); expect(measured.runsMaterialized).toBe(0);
    expect(measured.runArrayVisits).toBe(0); expect(measured.indexVisits).toBe(0);
    const membership = reads.counts['routines.indexes.channelTurns'];
    expect(membership?.get).toBe(8);
    counts.push(reads.counts);
    process.stdout.write('CHANNEL_HISTORY_READS ' + JSON.stringify({size, reads:reads.counts, work:measured}) + '\n');
  });
  expect(counts[1]).toEqual(counts[0]);
});
it('channel membership follows append, terminal transition, key mutation, removal, replacement and rollback', () => {
  const {manager, inside, template, canonical, start} = fixture(10);
  const key = (thread: string, turn: string) => JSON.stringify([thread,turn]);
  const members = () => (inside.indexes as typeof inside.indexes & {channelTurns: Map<string, Set<RoutineRun>>}).channelTurns;
  const rejects = (turn: string) => { expect(start(turn)).toBeNull(); expect(canonical('live').channelTurnId).toBeUndefined(); };
  rejects('past-turn-9');
  const added = inside.appendRun({...template, id:'added', channelTurnId:'appended'});
  added.status = 'completed'; rejects('appended');
  added.channelTurnId = 'changed';
  expect(members().has(key('shared-thread','appended'))).toBe(false); rejects('changed');
  added.threadId = 'moved';
  expect(members().has(key('shared-thread','changed'))).toBe(false);
  expect(members().get(key('moved','changed'))?.has(added)).toBe(true);
  added.threadId = 'shared-thread';
  const duplicate = inside.appendRun({...template, id:'duplicate', status:'completed', channelTurnId:'changed'});
  inside.removeRun(added); rejects('changed');
  expect(members().get(key('shared-thread','changed'))?.size).toBe(1);
  inside.removeRun(duplicate); expect(members().has(key('shared-thread','changed'))).toBe(false);
  expect(() => (manager as unknown as {commitMutation(f:()=>void):void}).commitMutation(() => {
    canonical('past-9').channelTurnId = 'wrong'; throw Error('rollback');
  })).toThrow('rollback');
  rejects('past-turn-9'); expect(members().has(key('shared-thread','wrong'))).toBe(false);
  const detached = canonical('past-9');
  inside.replaceStore([template]); manager.recoverPersistence(); detached.channelTurnId = 'ghost';
  expect(members().size).toBe(0); expect(manager.verifyRunIndexes()).toEqual([]);
  // The current run alone is not a prior owner; tuple keys must not collide.
  canonical('live').channelTurnId = 'own'; start('own'); expect(canonical('live').channelTurnId).toBe('own');
  inside.appendRun({...template,id:'tuple',status:'completed',threadId:'shared-thread,x',channelTurnId:'y'});
  canonical('live').channelTurnId = undefined;
  start('x,y'); expect(canonical('live').channelTurnId).toBe('x,y');
});
it('history retirement removes channel membership while preserving another retained owner', () => {
  const {manager, inside, canonical} = fixture(2001);
  canonical('past-0').channelTurnId = 'shared-past'; canonical('past-2000').channelTurnId = 'shared-past';
  inside.save();
  expect(manager.runById('past-0')).toBeNull();
  const turns = (inside.indexes as typeof inside.indexes & {channelTurns: Map<string, Set<RoutineRun>>}).channelTurns;
  expect(turns.has(JSON.stringify(['shared-thread','past-turn-1']))).toBe(false);
  expect(turns.get(JSON.stringify(['shared-thread','shared-past']))?.size).toBe(1);
  expect(manager.verifyRunIndexes()).toEqual([]);
});
