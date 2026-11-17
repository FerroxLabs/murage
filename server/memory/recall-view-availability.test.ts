// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2c (typed throws only). Consumer owner: recall-smoke (availability/authority boundary).
import { mkdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setExecutionStore, type ExecutionStorePort } from '../execution-audience.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { assertMemoryAccess, ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { prepareRecallContextSync, stopRecallViewMaintenance } from './recall-view.ts';
import { RecallPreparationPending, recallPreparationFailure } from './recall-recovery.ts';
import { MemoryEligibility } from './eligibility.ts';
import { answerQuery } from './worker-query.ts';
import { setMemoryMode } from './repository.ts';

// Exercise the shipped private construction functions without adding production test exports.
// Imports and function bodies are unchanged; each case uses the real isolated database.
const source = readFileSync(new URL('./recall-view.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('recall-view.ts', source, ts.ScriptTarget.Latest, true);
const imports = new Map<string, unknown>();
for (const node of ast.statements) if (ts.isImportDeclaration(node)) {
  const name = (node.moduleSpecifier as ts.StringLiteral).text;
  imports.set(name, await import(name.startsWith('.') ? new URL(name, import.meta.url).href : name));
}
function viewModule(overrides = new Map<string, unknown>()): any {
  const compiled = ts.transpileModule(source + '\nexport const fixturePrivate={startBuild,prepareContextSteps};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('require', 'exports', compiled + ';return exports;')((name: string) => overrides.get(name) ?? imports.get(name), {});
}
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); stopRecallViewMaintenance(); closeDatabase(); setExecutionStore(undefined); });
function fixture(partitioned = false) {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }, { id: 'other', threadId: 'private' }], groups: [] };
  if(partitioned) { Object.assign(roster.bots[0], { partitionedAt: 1 }); setExecutionStore(roster as unknown as ExecutionStorePort); }
  reconcileMemoryRoster(roster); setMemoryMode('active');
  prepareRecallContextSync('reader', 'direct', roster); stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: threadHumanPrincipal('direct'), notOwnerAudience: false };
  const views = viewModule(), db = database();
  return { roster, registry, access, binding, views, db, deniedScope: ensureScope('conversation', 'private') };
}
type World = ReturnType<typeof fixture>;
function buildAt(w: World, phase: string) {
  const build = w.views.fixturePrivate.startBuild(w.binding, w.roster);
  while (build.phase !== phase) w.views.buildRecallViewSlice(build);
  return build;
}
// Each throw is paired with a real out-of-view authority refusal and a revoked capability.
// These metadata routines do not grant access themselves: policy must reject before they are reached.
const sites: Array<[string, (w: World) => unknown]> = [
  ['recallAuthorityEpoch: missing epoch', w => { w.db.exec('DELETE FROM memory_recall_epoch'); return w.views.recallAuthorityEpoch(w.db); }],
  ['assertRecallView: invalid current view', w => w.views.assertRecallView(w.db, { ...w.access.view, generation: 'absent' })],
  ['assertRecallView: wrong reader binding', w => w.views.assertRecallView(w.db, w.access.view, { ...w.binding, threadId: 'private' })],
  ['startBuild: unrevisioned roster', w => w.views.fixturePrivate.startBuild(w.binding, { ...w.roster, memoryRosterRevision: undefined })],
  ['constructMembership: uncertified roster', w => {
    const build = w.views.fixturePrivate.startBuild(w.binding, w.roster);
    w.roster.bots[0].name = 'Changed audience';
    // Same revision but a different granted roster is rejected by the real certificate oracle.
    w.roster.bots[0].threadId = 'different';
    while (!w.views.buildRecallViewSlice(build)) { /* bounded fixture construction */ }
  }],
  ['buildRecallViewSlice: scope metadata mismatch', w => {
    const build = buildAt(w, 'verify');
    w.db.prepare('UPDATE memory_recall_view_scopes SET person_scope=1-person_scope WHERE view_id=?').run(build.handle.viewId);
    w.views.buildRecallViewSlice(build);
  }],
  ['buildRecallViewSlice: wrong verified count', w => {
    const build = buildAt(w, 'verify');
    w.db.prepare('DELETE FROM memory_recall_view_scopes WHERE view_id=?').run(build.handle.viewId);
    w.views.buildRecallViewSlice(build);
  }],
  ['publishRecallView: unfinished build', w => w.views.publishRecallView(w.views.fixturePrivate.startBuild(w.binding, w.roster))],
  ['publishRecallView: lost publication row', w => {
    const build = buildAt(w, 'done');
    w.db.prepare("UPDATE memory_recall_views SET state='ready' WHERE view_id=?").run(build.handle.viewId);
    w.views.publishRecallView(build);
  }],
  ['waitForRecallConstructionIdleForTest: expired wait', async w => {
    const now = Date.now(); let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now + (calls++ ? 21_000 : 0));
    await w.views.waitForRecallConstructionIdleForTest(w.roster);
  }],
  ['assertIssuedRecallView: lost issued view', w => w.views.assertIssuedRecallView(w.db, { ...w.access.view, generation: 'absent' })],
  ['MemoryEligibility.read: missing reader', w => {
    const file = String(w.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!.file);
    const eligibility = new MemoryEligibility(file);
    try { eligibility.read({ view: w.access.view, scopeIds: [], policyRevision: w.access.policyRevision, deletionEpoch: w.access.deletionEpoch, historical: false, cursor: '' }); }
    finally { eligibility.close(); }
  }],
  ['answerQuery: missing reader', w => answerQuery(null as any, null as any, { view: w.access.view } as any, null, 'fixture')],
  ['serveQueries: missing view', async () => {
    const worker = ts.createSourceFile('worker.ts', readFileSync(new URL('./worker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const fn = worker.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'serveQueries')!;
    const compiled = ts.transpileModule(fn.getText(worker), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const serve = new Function('queries', 'cancelled', 'expired', 'RecallPreparationPending', 'captures', 'wakeCaptures', 'activeQueries', compiled + ';return serveQueries;')(
      [{ requestId: 'fixture', input: { semantic: false } }], new Set(), () => false, RecallPreparationPending, [], vi.fn(), []);
    await serve();
  }],
];
for (const [name, invoke] of sites) {
  it(`${name}: availability is typed and genuine denials remain terminal`, async () => {
    const w = fixture();
    let denial: unknown;
    try { assertMemoryAccess(w.access, w.deniedScope); } catch (error) { denial = error; }
    expect(denial).toMatchObject({ message: 'MEMORY_SCOPE_DENIED' });
    expect(denial).not.toBeInstanceOf(RecallPreparationPending);
    expect(recallPreparationFailure(denial)).toBe(denial);
    w.registry.begin('reader', 'direct', 'replacement');
    expect(() => assertMemoryAccess(w.access)).toThrow('MEMORY_UNAUTHORIZED');
    await expect(Promise.resolve().then(() => invoke(w))).rejects.toBeInstanceOf(RecallPreparationPending);
  });
}
it('inventories every availability throw so a new untyped reader site cannot escape review', () => {
  const converted = source.match(/throw new RecallPreparationPending\(\)/g) ?? [];
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: retain all 13 S1 sites and include the four merged S4 background sites.
  expect(converted).toHaveLength(17);
  for (const file of ['recall-view.ts', 'worker.ts', 'eligibility.ts', 'worker-query.ts']) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/throw new Error\(['"]MEMORY_RECALL_UNAVAILABLE['"]\)/);
  }
});

// S4 added four background availability branches. Observe their real typed
// throws even where hydration deliberately catches them and returns false.
for (const site of ['missing hydration scope', 'publication authority fence', 'publication metadata fence', 'certificate wait expired'] as const) {
  it(`S4 ${site}: availability is typed and genuine denials remain terminal`, async () => {
    const w = fixture(site === 'missing hydration scope');
    expect(() => assertMemoryAccess(w.access, w.deniedScope)).toThrow('MEMORY_SCOPE_DENIED');
    w.registry.begin('reader', 'direct', 'replacement');
    expect(() => assertMemoryAccess(w.access)).toThrow('MEMORY_UNAUTHORIZED');
    const observed: RecallPreparationPending[] = [];
    class ObservedPending extends RecallPreparationPending { constructor() { super(); observed.push(this); } }
    const overrides = new Map<string, unknown>([['./recall-recovery.ts', { ...imports.get('./recall-recovery.ts') as object, RecallPreparationPending: ObservedPending }]]);
    const databaseModule = imports.get('../database.ts') as typeof import('../database.ts');
    const certificate = { databaseGeneration: databaseModule.databaseGeneration(), epoch: w.views.recallAuthorityEpoch(w.db), rosterRevision: w.roster.memoryRosterRevision };
    const roster = { ...w.roster, recallRosterCertificate: () => site === 'certificate wait expired' ? undefined : certificate };
    if (site === 'missing hydration scope') overrides.set('./scope-id.ts', { ...imports.get('./scope-id.ts') as object, scopeRow: () => undefined });
    if (site.startsWith('publication')) overrides.set('../database.ts', { ...databaseModule, transaction: (work: (db: typeof w.db) => unknown) => databaseModule.transaction(db => {
      if (site === 'publication authority fence') db.exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");
      else db.prepare('UPDATE memory_recall_thread_readers SET eligible=1-eligible WHERE view_id=?').run(w.access.view.viewId);
      return work(db);
    }) });
    const module = viewModule(overrides);
    if (site === 'certificate wait expired') {
      const start = Date.now(); let calls = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => start + (calls++ ? 21000 : 0));
      const steps = module.fixturePrivate.prepareContextSteps(w.binding, roster);
      expect(() => steps.next()).toThrow(RecallPreparationPending);
    } else {
      const steps = module.hydrateRecallViewSteps(w.binding, roster);
      let result; do { result = steps.next(); } while (!result.done);
      expect(result.value).toBe(false);
    }
    expect(observed).toHaveLength(1);
    expect(recallPreparationFailure(observed[0])).toBe(observed[0]);
  });
}
