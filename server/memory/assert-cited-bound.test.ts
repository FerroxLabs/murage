// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULINGS 2026-11-16T19:52Z S12-Q1/Q2 and 2026-11-17T07:44Z s12b-3: the assert path never runs a roster-proportional recompute; while the
// view is behind the roster it answers pending and the certified background path catches up. A scope ensureScope creates leaves an issued
// view valid; a narrowing of a scope the view cites still refuses.
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { assertMemoryAccess, ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { captureScopeId } from './capture.ts';
import { ensureBotScope } from './lessons.ts';
import { RecallPreparationPending, RecallViewLost } from './recall-recovery.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

async function fixture(peers: number) {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = {memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'},...Array.from({length:peers},(_,i)=>({id:`peer-${i}`,threadId:`peer-thread-${i}`}))],groups:[]};
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin('reader','direct','generation');
  const token = registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  await views.prepareRecallContext('reader','direct',roster);
  const access = memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  return {views,roster,access,registry,token};
}
/** Statement runs on this connection while `work` runs. */
function statementRuns(work: () => void): number {
  const db = database(), previous = db.prepare; let runs = 0;
  (db as any).prepare = (sql: string) => new Proxy(previous.call(db, sql), { get(target, key) {
    const value = (target as any)[key];
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { if (key === 'get' || key === 'all' || key === 'run' || key === 'iterate') runs++; return value.apply(target, args); };
  } });
  try { work(); } finally { (db as any).prepare = previous; }
  return runs;
}
async function behindAssert(peers: number) {
  const f = await fixture(peers);
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  // The reader sees a revision before its writer has prepared it; the approved roster-write path now settles live readers synchronously.
  f.roster.bots.push({id:'late',threadId:'late-thread'}); f.roster.memoryRosterRevision = 2;
  const before = f.views.recallViewCounters();
  let refused: unknown;
  const runs = statementRuns(() => { try { assertMemoryAccess(f.access); } catch (error) { refused = error; } });
  const after = f.views.recallViewCounters();
  const cost = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
  return {...f, refused, cost, runs};
}

it('an assert behind the roster refuses pending at a cost flat in roster size and never builds a view on the assert path', async () => {
  const small = await behindAssert(2);
  await small.views.waitForRecallConstructionIdleForTest(small.roster);
  const large = await behindAssert(200);
  for (const run of [small, large]) {
    expect(run.refused).toBeInstanceOf(RecallViewLost);
    expect(run.cost.oracleComputes).toBe(0);
    expect(run.cost.candidateVisits).toBe(0);
  }
  expect(large.cost).toEqual(small.cost);
  expect(large.runs).toBe(small.runs);
  // The certified background path catches up; the same issued access then passes its cited-scope check.
  reconcileMemoryRoster(large.roster);
  await large.views.prepareRecallContext('reader','direct',large.roster);
  expect(() => assertMemoryAccess(large.access)).not.toThrow();
});

it('a scope ensureScope creates for an unrelated owner leaves an issued view valid; a cited-scope narrowing still refuses', async () => {
  const f = await fixture(0), db = database();
  const epoch = () => Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
  const at = epoch();
  ensureScope('room', 'unrelated-room');
  ensureScope('bot', 'unrelated-bot');
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scopes WHERE owner_key IN ('unrelated-room','unrelated-bot')").get()!.n)).toBe(2);
  expect(epoch()).toBe(at);
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  const cited = String(db.prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 LIMIT 1').get(f.access.view.viewId, f.access.view.generation)!.scope_id);
  db.prepare("UPDATE memory_scopes SET audience='[\"narrowed\"]' WHERE id=?").run(cited);
  expect(epoch()).toBeGreaterThan(at);
  expect(() => assertMemoryAccess(f.access)).toThrow();
  expect(() => assertMemoryAccess(f.access, cited)).toThrow();
});

it('production scope creators for an unrelated thread or bot keep the issued reader; a cited-scope narrowing still refuses', async () => {
  const f = await fixture(0), db = database();
  const epoch = () => Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
  const at = epoch();
  const scope = captureScopeId(db, 'independent-capture');
  expect(db.prepare('SELECT owner_key FROM memory_scopes WHERE id=?').get(scope)!.owner_key).toBe('independent-capture');
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  const bot = ensureBotScope(db, 'independent-bot');
  expect(db.prepare('SELECT kind FROM memory_scopes WHERE id=?').get(bot)!.kind).toBe('bot');
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  // No view cites either new scope, and the issued reader was never given them.
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_scopes WHERE scope_id IN (?,?)').get(scope, bot)!.n)).toBe(0);
  expect(() => assertMemoryAccess(f.access, scope)).toThrow();
  expect(epoch()).toBe(at);
  const cited = String(db.prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 LIMIT 1').get(f.access.view.viewId, f.access.view.generation)!.scope_id);
  expect(() => assertMemoryAccess(f.access, cited)).not.toThrow();
  db.prepare("UPDATE memory_scopes SET audience='[\"narrowed\"]' WHERE id=?").run(cited);
  expect(epoch()).toBeGreaterThan(at);
  expect(() => assertMemoryAccess(f.access)).toThrow();
  expect(() => assertMemoryAccess(f.access, cited)).toThrow();
});

it('a scope created after a view was built keeps issued access but holds a new issuance until the view is rebuilt', async () => {
  const f = await fixture(0), db = database();
  const claim = () => f.registry.resolve(`Bearer ${f.token}`)!;
  expect(() => memoryAccess(f.registry, claim(), () => f.roster)).not.toThrow();
  captureScopeId(db, 'independent-capture');
  // Validity: the issued reader goes on. Freshness: a new reader is not handed the view built before the scope existed.
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  expect(() => memoryAccess(f.registry, claim(), () => f.roster)).toThrow(RecallPreparationPending);
  await f.views.prepareRecallContext('reader', 'direct', f.roster);
  const fresh = memoryAccess(f.registry, claim(), () => f.roster);
  expect(() => assertMemoryAccess(fresh)).not.toThrow();
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  // A raw insert that bypasses the creators (another writer) still invalidates everything issued.
  db.prepare("INSERT INTO memory_scopes VALUES('raw-scope','conversation','raw-owner','[]',0)").run();
  expect(() => assertMemoryAccess(f.access)).toThrow();
  expect(() => assertMemoryAccess(fresh)).toThrow();
});
