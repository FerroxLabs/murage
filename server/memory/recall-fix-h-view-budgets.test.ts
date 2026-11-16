// Producer owner: recall-fix-h (view transactions); consumer owner: recall-fix-h (budget and hydration witnesses).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, databaseGeneration } from '../database.ts';
import { BACKGROUND_BUSY_MS, DEFAULT_BUSY_MS } from '../db-busy.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); views.stopRecallViewMaintenance(); closeDatabase(); });

const paths = ['startBuild', 'buildRecallViewSlice', 'publishRecallView', 'hydrateRecallViewSteps', 'maintainRecallViewSlice', 'collectRecallViewSlice'] as const;

it('each view writer uses the background lock budget, including certified hydration and obsolete reclamation', () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), waits = new Map<string, number[]>(), exec = db.exec;
  const spy = vi.spyOn(db, 'exec').mockImplementation(sql => {
    if (sql === 'BEGIN IMMEDIATE') {
      const stack = new Error().stack!;
      const path = paths.find(name => stack.includes(name));
      if (path) { const seen = waits.get(path) ?? []; seen.push(Number(db.prepare('PRAGMA busy_timeout').get()!.timeout)); waits.set(path, seen); }
    }
    return exec.call(db, sql);
  });
  views.prepareRecallContextSync('reader', 'direct', roster);
  views.stopRecallViewMaintenance();
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: threadHumanPrincipal('direct'), notOwnerAudience: false };
  const live = views.resolveRecallView(binding, roster).handle;
  const certificate = { databaseGeneration: databaseGeneration(), epoch: views.recallAuthorityEpoch(db), rosterRevision: 1 };
  const certified = { ...roster, recallRosterCertificate: () => certificate };
  views.evictRecallViewsForTest(db);
  const hydration = views.hydrateRecallViewSteps(binding, certified);
  let result; do { result = hydration.next(); } while (!result.done);
  expect(result.value, 'certified hydration must reach publication').toBe(true);
  expect(views.resolveRecallView(binding, certified).handle).toEqual(live);
  views.maintainRecallViewSlice(live);

  db.prepare("INSERT INTO memory_recall_views VALUES('obsolete','generation',?,1,'building',300,'digest',0,0)").run(certificate.epoch);
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300) INSERT INTO memory_recall_view_scopes SELECT 'obsolete','generation',printf('scope-%03d',i),0,0 FROM n");
  const remaining = () => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_scopes WHERE view_id='obsolete'").get()!.n);
  expect(views.collectRecallViewSlice(db)).toBe(false);
  expect(remaining()).toBe(44);
  expect(views.collectRecallViewSlice(db)).toBe(false);
  expect(remaining()).toBe(0);
  expect(views.collectRecallViewSlice(db)).toBe(false);
  expect(db.prepare("SELECT 1 FROM memory_recall_views WHERE view_id='obsolete'").get()).toBeUndefined();
  expect(views.collectRecallViewSlice(db)).toBe(true);
  expect(() => views.assertRecallView(db, live, binding)).not.toThrow();
  spy.mockRestore();
  for (const path of paths) {
    expect(waits.get(path)?.length, `${path} reached BEGIN`).toBeGreaterThan(0);
    expect([...new Set(waits.get(path))], `${path} lock budget`).toEqual([BACKGROUND_BUSY_MS]);
  }
  expect(Number(db.prepare('PRAGMA busy_timeout').get()!.timeout)).toBe(DEFAULT_BUSY_MS);
});
