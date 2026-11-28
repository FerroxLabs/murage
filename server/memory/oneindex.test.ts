// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: q1023-oneindex (reader scope set + page readers). R1 of designs/ONEINDEX-DESIGN.md: each scope-set reader answers exactly what the
// view reader it replaces answered, for the same reader, on the same rows (in-set, out-of-set, deleted, superseded, pinned, pending).
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const roster = (): MemoryRoster => ({memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:[{threadId:'task'}]},{id:'other',threadId:'private'}],groups:[{id:'room',threadId:'room-thread',memberIds:['reader']}]});
function issue(r: MemoryRoster, threadId: string, notOwnerAudience: boolean) {
  const registry = new InternalCapabilities(); registry.begin('reader',threadId,'generation');
  const token = registry.mint({botId:'reader',threadId,generation:'generation',depth:0,kind:'memory',skillAuthoring:false,...notOwnerAudience?{notOwnerAudience:true as const}:{}});
  return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>r);
}
function seed(): void {
  const put = database().prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement',?,?,0,NULL,NULL,1)");
  const receipt = database().prepare("INSERT INTO memory_projection_receipts VALUES(?,?,1,?,'done',NULL)");
  const scopes = [ensureScope('bot','reader'),ensureScope('conversation','direct'),ensureScope('conversation','task'),ensureScope('room','room'),
    ensureScope('conversation','room-thread'),ensureScope('conversation','private'),ensureScope('bot','other')];
  let n = 0;
  for (const scope of scopes) {
    put.run(`r${++n}`,1,scope,'constraint',`fixture words ${n}`,'active',n%2);
    put.run(`r${++n}`,1,scope,'constraint',`fixture words ${n}`,'superseded',0);put.run(`r${n}`,2,scope,'constraint',`fixture words ${n}`,'active',0);
    put.run(`r${++n}`,1,scope,'constraint',`fixture words ${n}`,'deleted',0);
    put.run(`r${++n}`,1,scope,'preference',`fixture words ${n}`,'candidate',0);receipt.run(`r${n}`,1,'pending');
    put.run(`r${++n}`,1,scope,'constraint',`fixture words ${n}`,'archived',0);receipt.run(`r${n}`,1,'pending-archive');
  }
}
for (const thread of ['direct','room-thread']) for (const notOwner of [false,true]) {
  it(`R1 ${thread}${notOwner?' not-owner':''}: the computed scope set and every scope-set page equal the view's`, async () => {
    const views = await import('./recall-view.ts'), pages = await import('./recall-view-index.ts'), oneindex = await import('./oneindex.ts');
    const r = roster(); reconcileMemoryRoster(r); seed();
    views.prepareRecallContextSync('reader',thread,r,notOwner);
    issue(r,thread,notOwner);
    const db = database();
    // The built view R1 compares against (the 1.0.22 reader); the access itself is now issued from the computed set (oneindex-issue.test.ts).
    const access = { view: views.resolveRecallView({botId:'reader',threadId:thread,humanPrincipal:threadHumanPrincipal(thread),notOwnerAudience:notOwner},r).handle };
    const set = oneindex.computeRecallScopes(db,{botId:'reader',threadId:thread,humanPrincipal:threadHumanPrincipal(thread),notOwnerAudience:notOwner},r);
    const viewScopes = db.prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 ORDER BY scope_id').all(access.view.viewId,access.view.generation).map(row=>String(row.scope_id));
    expect(set.scopes.length).toBeGreaterThan(0);
    expect([...set.scopes]).toEqual(viewScopes);
    expect(oneindex.recallScopesHave(set,ensureScope('conversation','private'))).toBe(views.recallViewHasScope(db,access.view,ensureScope('conversation','private')));
    const strip = (refs: Array<{id:string;version:number}>) => refs.map(({id,version})=>[id,version]);
    expect(strip(oneindex.recentScopePage(db,set,Number.MAX_SAFE_INTEGER,100))).toEqual(strip(pages.recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,100)));
    expect(strip(oneindex.recentScopePage(db,set,Number.MAX_SAFE_INTEGER,3))).toEqual(strip(pages.recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,3)));
    expect(strip(oneindex.eligibleScopePage(db,set,'',100))).toEqual(strip(pages.eligibleViewPage(db,access.view,'',100)));
    expect(strip(oneindex.eligibleScopePage(db,set,'["r3",1]',4))).toEqual(strip(pages.eligibleViewPage(db,access.view,'["r3",1]',4)));
    const budget = () => new pages.RecallWorkBudget();
    expect(strip(oneindex.frameScopePage(db,set,null,100,budget()))).toEqual(strip(pages.frameViewPage(db,access.view,null,100,budget())));
    expect(strip(oneindex.frameScopePage(db,set,['preference'],100,budget()))).toEqual(strip(pages.frameViewPage(db,access.view,['preference'],100,budget())));
    expect(strip(oneindex.pendingScopePage(db,set,'',100))).toEqual(strip(pages.pendingViewPage(db,access.view,'',100)));
    // non-vacuous: the reader sees some rows and is refused the other bot's private thread
    expect(oneindex.eligibleScopePage(db,set,'',100).length).toBeGreaterThan(0);
    expect(oneindex.pendingScopePage(db,set,'',100).length).toBeGreaterThan(0);
  });
}
it('R1 computing the scope set writes nothing (no build, no scope row, no view row)', async () => {
  const oneindex = await import('./oneindex.ts'), r = roster(); reconcileMemoryRoster(r); seed();
  const db = database(), before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
  for (const thread of ['direct','room-thread','task']) oneindex.computeRecallScopes(db,{botId:'reader',threadId:thread,humanPrincipal:threadHumanPrincipal(thread),notOwnerAudience:false},r);
  expect(Number(db.prepare('SELECT total_changes() AS n').get()!.n)).toBe(before);
});
// OPUS/ASTRA 88ff14d103 H1/H2 (MAIN-RULING ADDENDUM 16:12Z). A throw is caught and compared, so a base that throws fails AT the assertion.
const attempt = <T,>(read: () => T): T | string => { try { return read(); } catch (error) { return String((error as Error).message); } };
async function builtAndSet(thread: string) {
  const views = await import('./recall-view.ts'), oneindex = await import('./oneindex.ts');
  const r = roster(); reconcileMemoryRoster(r); seed();
  const binding = {botId:'reader',threadId:thread,humanPrincipal:threadHumanPrincipal(thread),notOwnerAudience:false};
  views.prepareRecallContextSync('reader',thread,r,false);
  return {view:views.resolveRecallView(binding,r).handle,set:oneindex.computeRecallScopes(database(),binding,r),oneindex};
}
it('W-OPUS-H1 capped budget over several scopes: the recent page answers what the one-statement view page answered, never MEMORY_RECALL_WORK_LIMIT', async () => {
  const pages = await import('./recall-view-index.ts'), {view,set,oneindex} = await builtAndSet('room-thread'), db = database();
  expect(set.scopes.length).toBeGreaterThan(2);
  const strip = (refs: Array<{id:string;version:number}>) => refs.map(({id,version})=>[id,version]);
  const viewPage = strip(pages.recentViewPage(db,view,Number.MAX_SAFE_INTEGER,3,new pages.RecallWorkBudget(3)));
  expect(viewPage.length).toBe(3);
  const scopePage = attempt(() => strip(oneindex.recentScopePage(db,set,Number.MAX_SAFE_INTEGER,3,new pages.RecallWorkBudget(3+4*set.scopes.length)))), capped = attempt(() => strip(oneindex.recentScopePage(db,set,Number.MAX_SAFE_INTEGER,3,new pages.RecallWorkBudget(3)))); // MAIN :7904 (a) + ASTRA r10 precheck: a list's look-ahead row is a raw row read, so it is charged (one per list); a budget of 3 over more lists is a cut page, never a throw
  expect({scopePage,capped}).toEqual({scopePage:viewPage,capped:[]});
});
// FABLE/OPUS b50b7c3cdc H4/H1 (MAIN :7563 "cap the TOTAL"): the rows the (scope, state) seeks hand back are counted at the statement, so
// per-list reads that are never charged show up here. With L non-empty lists and a page of n, at most L + n rows may be read (lazy merge).
it('W-H4-ROWS the recent scope page reads at most lists + n rows across all scope lists, and still answers the n newest', async () => {
  const {set,oneindex} = await builtAndSet('room-thread'), db = database(), pages = await import('./recall-view-index.ts');
  expect(set.scopes.length).toBeGreaterThan(2);
  const add = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,0,NULL,NULL,1)");
  for (const scope of set.scopes) for (let k = 0; k < 6; k++) add.run(`rows-${scope}-${k}`, scope, `rows fixture ${k}`);
  const lists = Number(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT scope_id,state FROM memory_records WHERE scope_id IN (SELECT value FROM json_each(?)) AND state IN ('active','candidate','superseded','archived'))`).get(JSON.stringify(set.scopes))!.n);
  const newest = db.prepare(`SELECT id,version FROM memory_records WHERE scope_id IN (SELECT value FROM json_each(?)) AND state='active' ORDER BY rowid DESC LIMIT 3`).all(JSON.stringify(set.scopes)).map(row => [String(row.id), Number(row.version)]);
  let rows = 0;
  const real = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const statement = real(sql);
    if (!sql.includes('INDEXED BY memory_records_scope')) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (key === 'all') return (...args: never[]) => { const out = (value as (...a: never[]) => unknown[]).apply(target, args); rows += out.length; return out; };
      if (key === 'get') return (...args: never[]) => { const out = (value as (...a: never[]) => unknown).apply(target, args); if (out) rows++; return out; };
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
  }) as typeof db.prepare);
  let page: unknown;
  try { page = attempt(() => oneindex.recentScopePage(db, set, Number.MAX_SAFE_INTEGER, 3, new pages.RecallWorkBudget(lists + 3)).map(({id,version}) => [id,version])); } // MAIN :7904 (a): the look-ahead rows are charged, so the budget that bounds the rows read is lists + n
  finally { spy.mockRestore(); }
  expect(page).toEqual(newest);
  expect(rows).toBeLessThanOrEqual(lists + 3);
});
it('W-OPUS-H2 two kinds under a cap: the identity page selects in (kind, record_id, version) order, as the view kind index did', async () => {
  const pages = await import('./recall-view-index.ts'), {set,oneindex} = await builtAndSet('direct'), db = database();
  // an id that sorts first by id but last by kind: only (kind, id, version) order leaves it out of a capped page
  database().prepare("INSERT INTO memory_records VALUES('a-first',1,?,'preference','fixture words a','owner-statement','active',0,0,NULL,NULL,1)").run(ensureScope('bot','reader'));
  const views = await import('./recall-view.ts'), r = roster();
  views.prepareRecallContextSync('reader','direct',r,false);
  const view = views.resolveRecallView({botId:'reader',threadId:'direct',humanPrincipal:threadHumanPrincipal('direct'),notOwnerAudience:false},r).handle;
  const strip = (refs: Array<{id:string;version:number}>) => refs.map(({id,version})=>[id,version]);
  const viewPage = strip(pages.frameViewPage(db,view,['preference','constraint'],2,new pages.RecallWorkBudget()));
  expect(viewPage.map(([id])=>id)).not.toContain('a-first');
  const scopePage = strip(oneindex.frameScopePage(db,set,['preference','constraint'],2,new pages.RecallWorkBudget()));
  expect(scopePage).toEqual(viewPage);
});
// ASTRA 6820c76ca4 High 2 (pendingScopePage, oneindex.ts; the eligible half is OPEN, see oneindex.ts): the LIMIT came after the join and HELD, so a
// statement stepped over every row it refused (another reader's receipts) without charging one: the rows read were uncapped while
// the budget saw only the page. Entered through the production page readers (recall-view-index.ts pendingViewPage) on a real
// issued MemoryAccess, whose handle is a scope set. INVARIANT: every row read is charged, so with a budget of 64 and 300 refused rows ahead
// of the reader's own, the page stops at the budget (remaining 0, 64 charged); the base read 300+ rows and charged only the few it returned.
async function scanFixture() {
  const pages = await import('./recall-view-index.ts'), r = roster(); reconcileMemoryRoster(r);
  const access = issue(r,'direct',false), db = database();
  return {pages,access,db};
}
it('W-SCAN-PEND the pending scope page charges every raw receipt it reads: other readers\' backlog stays within the budget', async () => {
  const {pages,access,db} = await scanFixture(), mine = ensureScope('bot','reader'), other = ensureScope('conversation','private');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','fixture pending','owner-statement','candidate',0,0,NULL,NULL,1)");
  const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','done',NULL)");
  // 300 receipts owed for another bot's private thread, keyed ahead of the reader's own five
  for (let k = 0; k < 300; k++) { const id = `a-other-${String(k).padStart(3,'0')}`;put.run(id,other);receipt.run(id); }
  for (let k = 1; k <= 5; k++) { put.run(`b-mine-${k}`,mine);receipt.run(`b-mine-${k}`); }
  const budget = new pages.RecallWorkBudget(64);
  const page = pages.pendingViewPage(db,access.view,'',256,budget);
  expect({cut:budget.remaining===0,charged:budget.raw}).toEqual({cut:true,charged:64});
  expect(page.map(ref=>ref.id).filter(id=>id.startsWith('a-other'))).toEqual([]);
  const all = pages.pendingViewPage(db,access.view,'',256,new pages.RecallWorkBudget(4096)).map(ref=>ref.id);
  expect(all).toEqual(['b-mine-1','b-mine-2','b-mine-3','b-mine-4','b-mine-5']);
});
// ASTRA 6820c76ca4 High 2, eligible half (eligibleScopePage, oneindex.ts) + MAIN-RULING 2026-11-26T21:32Z "short page = cut". The base applied
// HELD and scope membership before the LIMIT: it stepped over every row of other readers uncharged and reported the reader's rows as one
// full, finished page. INVARIANT: every row read is charged; a page the raw budget ends returns what it has plus a continuation cursor (the
// last key EXAMINED), and following that cursor reaches every row of the reader in (id, version) order: a cut is never the end of the set.
function eligibleFixture(db: ReturnType<typeof database>, others: number, text = 'fixture eligible') {
  const mine = ensureScope('bot','reader'), other = ensureScope('conversation','private');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,0,NULL,NULL,1)");
  db.exec('SAVEPOINT eligible_fixture');
  try {
    for (let k = 0; k < others; k++) put.run(`a-other-${String(k).padStart(5,'0')}`,other,'fixture other');
    for (let k = 1; k <= 5; k++) put.run(`b-mine-${k}`,mine,text);
  } finally { db.exec('RELEASE eligible_fixture'); }
}
const MINE = ['b-mine-1','b-mine-2','b-mine-3','b-mine-4','b-mine-5'];
it('W-SCAN-ELIG the eligible scope page charges every raw row it reads; a page the budget ends is a cut with a continuation cursor', async () => {
  const {pages,access,db} = await scanFixture(); eligibleFixture(db,300);
  const budget = new pages.RecallWorkBudget(64), cut: {next?: string} = {};
  const page = pages.eligibleViewPage(db,access.view,'',256,budget,cut);
  expect({cut:budget.remaining===0,charged:budget.raw,rows:page.map(ref=>ref.id),next:cut.next}).toEqual({cut:true,charged:64,rows:[],next:'["a-other-00063",1]'});
  // the cursor continues the walk: every page charged within its budget, nothing skipped, key order kept, and the last page is not a cut
  const seen: string[] = []; let cuts = 0, worst = 0;
  for (let cursor = '', guard = 0; guard < 20; guard++) {
    const b = new pages.RecallWorkBudget(64), c: {next?: string} = {};
    const rows = pages.eligibleViewPage(db,access.view,cursor,256,b,c);
    seen.push(...rows.map(ref=>ref.id)); worst = Math.max(worst,b.raw);
    if (c.next === undefined) break;
    cuts++; cursor = c.next;
  }
  expect({seen,cuts,worst}).toEqual({seen:MINE,cuts:4,worst:64});
  // (id, version) order, not insertion order: a row written last whose key sorts first leads the page (eligibility.ts encodeEligibleCursor)
  const full = new pages.RecallWorkBudget(4096), none: {next?: string} = {}; db.prepare("INSERT INTO memory_records VALUES('b-mine-0',1,?,'fact','fixture eligible','owner-statement','active',0,0,NULL,NULL,1)").run(ensureScope('bot','reader'));
  expect(pages.eligibleViewPage(db,access.view,'',2,full,none).map(ref=>ref.id)).toEqual(['b-mine-0','b-mine-1']);
  expect({next:none.next,charged:full.raw}).toEqual({next:undefined,charged:302});
});
// The helper's own reader (worker-query.ts answerQuery on a real MemoryEligibility over the real file, as worker.ts runs it; only the vector
// index is a double). 9,000 records of another reader lie ahead of the reader's five: one helper answer may read 8,192 raw rows.
it('W-CUT-HELPER a helper scan the raw budget ends reports where it stopped (resumeAfter), keeps the words\' allowance, and the walk from there reaches the reader\'s rows', async () => {
  const {pages,access,db} = await scanFixture(); eligibleFixture(db,9000,'fixture kettle words');
  const views = await import('./recall-view.ts'), {MemoryEligibility} = await import('./eligibility.ts'), {answerQuery} = await import('./worker-query.ts'), {join} = await import('node:path');
  const input = {view:access.view,reader:{botId:access.botId,threadId:access.threadId,humanPrincipal:access.humanPrincipal,notOwnerAudience:false},scopeIds:[],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:false,cursor:'',query:'kettle',limit:10,semantic:true};
  const scored: string[] = [];
  const index = {search(_query: string, allowed: Array<{id:string}>){ scored.push(...allowed.map(ref=>ref.id));return {hits:[],vectorRows:allowed.length,lexicalRanked:[],vectorRanked:[],unvectored:[],unvectoredMore:false,timings:{}}; }} as unknown as import('./index.ts').MemoryIndex;
  const eligibility = new MemoryEligibility(join(DATA_DIR,'messages.db'));
  let result: ReturnType<typeof answerQuery>['result'], visits: number;
  try { const before = views.recallViewCounters().candidateVisits; result = answerQuery(index,eligibility,input,[1,0],'fixture').result; visits = views.recallViewCounters().candidateVisits-before; }
  finally { eligibility.close(); }
  expect({stopped:typeof result.resumeAfter,scored,bounded:visits<=8192}).toEqual({stopped:'string',scored:[],bounded:true});
  expect((result.lexicalRanked ?? []).map(ref=>ref[0]).sort()).toEqual(MINE);
  const rest = pages.eligibleViewPage(db,access.view,result.resumeAfter!,256,new pages.RecallWorkBudget(4096)).map(ref=>ref.id);
  expect(rest).toEqual(MINE);
},120_000);
// A cut page that HOLDS rows of the reader (self-review Medium): the rows read before the budget ended are returned, the cursor is the last
// key examined (here a row of the reader), and the continuation returns the rest once: nothing dropped, nothing twice. Page reader and helper.
it('W-CUT-ROWS a cut page returns the reader\'s rows it reached, and the continuation returns the rest exactly once (page reader and helper reader)', async () => {
  const {pages,access,db} = await scanFixture(); eligibleFixture(db,300);
  const {MemoryEligibility} = await import('./eligibility.ts'), {join} = await import('node:path');
  const cut: {next?: string} = {}, first = pages.eligibleViewPage(db,access.view,'',256,new pages.RecallWorkBudget(302),cut).map(ref=>ref.id);
  const rest = cut.next === undefined ? [] : pages.eligibleViewPage(db,access.view,cut.next,256,new pages.RecallWorkBudget(302)).map(ref=>ref.id);
  expect({first,next:cut.next,rest}).toEqual({first:['b-mine-1','b-mine-2'],next:'["b-mine-2",1]',rest:['b-mine-3','b-mine-4','b-mine-5']});
  const input = {view:access.view,reader:{botId:access.botId,threadId:access.threadId,humanPrincipal:access.humanPrincipal,notOwnerAudience:false},scopeIds:[],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:false};
  const eligibility = new MemoryEligibility(join(DATA_DIR,'messages.db'));
  try {
    const one = eligibility.read({...input,cursor:''},new pages.RecallWorkBudget(302));
    const two = eligibility.read({...input,cursor:one.nextCursor ?? ''},new pages.RecallWorkBudget(302));
    expect({one:[one.allowed.map(ref=>ref.id),one.capacity,one.nextCursor],two:[two.allowed.map(ref=>ref.id),two.capacity,two.nextCursor]})
      .toEqual({one:[['b-mine-1','b-mine-2'],true,'["b-mine-2",1]'],two:[['b-mine-3','b-mine-4','b-mine-5'],false,undefined]});
  } finally { eligibility.close(); }
});
// MAIN-RULING 2026-11-26T22:06Z (a): the SAME short-page = cut contract for recentScopePage and frameScopePage (oneindex.ts). The base applied
// HELD (and, for the frame, the kind filter) before the LIMIT: rows of the reader's own scopes that the page refuses (a record resting on a
// deleted source, a record of another kind) were stepped uncharged, and the short page read as the end of the reader's records.
// INVARIANT: every raw row the walk steps is charged, refused ones as well; a page the raw budget ends returns what it has plus a cut
// cursor, and following the cursor reaches every row of the reader: a cut is never the end. Entered through the production page readers
// (recall-view-index.ts recentViewPage / frameViewPage) and their callers on a real issued MemoryAccess, whose handle is a scope set.
// 5 held rows of the reader, then `refused` NEWER rows of the same scope that rest on a deleted source (HELD refuses them).
function refusedFixture(db: ReturnType<typeof database>, refused: number, pinned = 0) {
  const mine = ensureScope('bot','reader');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',?,0,NULL,NULL,1)");
  db.exec('SAVEPOINT refused_fixture');
  try {
    for (let k = 1; k <= 5; k++) put.run(`b-mine-${k}`,mine,'fixture kettle words',pinned);
    db.prepare("INSERT INTO memory_sources(id,scope_id,revision,content_hash,kind,speaker,outcome,state) VALUES('ended',?,1,'hash','text','owner','completed','deleted')").run(mine);
    db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('ended',1,'hash','{}',1)").run();
    const rest = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,'ended',1,0,1)");
    for (let k = 0; k < refused; k++) { const id = `a-ended-${String(k).padStart(5,'0')}`; put.run(id,mine,'fixture kettle words',pinned); rest.run(id); }
  } finally { db.exec('RELEASE refused_fixture'); }
  const rowid = (id: string) => Number(db.prepare('SELECT rowid AS n FROM memory_records WHERE id=?').get(id)!.n);
  return {mine,rowid};
}
const NEWEST_MINE = ['b-mine-5','b-mine-4','b-mine-3','b-mine-2','b-mine-1'];
it('W-CUT-RECENT the recent scope page charges every raw row it steps, refused ones too; a page the budget ends is a cut with a cursor that reaches the rest', async () => {
  const {pages,access,db} = await scanFixture(), {rowid} = refusedFixture(db,300);
  const budget = new pages.RecallWorkBudget(64), cut: {before?: number} = {};
  const page = pages.recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,256,budget,cut);
  expect({charged:budget.raw,rows:page.map(ref=>ref.id),before:cut.before}).toEqual({charged:64,rows:[],before:rowid('a-ended-00236')});
  // the cursor continues the walk: every page within its budget, nothing skipped or twice, newest first, and the last page is not a cut
  const seen: string[] = []; let cuts = 0, worst = 0;
  for (let before = Number.MAX_SAFE_INTEGER, guard = 0; guard < 20; guard++) {
    const b = new pages.RecallWorkBudget(64), c: {before?: number} = {};
    seen.push(...pages.recentViewPage(db,access.view,before,256,b,c).map(ref=>ref.id)); worst = Math.max(worst,b.raw);
    if (c.before === undefined) break;
    cuts++; before = c.before;
  }
  expect({seen,cuts,worst}).toEqual({seen:NEWEST_MINE,cuts:4,worst:64});
  // a cut page that holds rows of the reader returns them, and the continuation returns the rest once
  const held: {before?: number} = {}, first = pages.recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,256,new pages.RecallWorkBudget(303),held).map(ref=>ref.id);
  const rest = held.before === undefined ? [] : pages.recentViewPage(db,access.view,held.before,256,new pages.RecallWorkBudget(303)).map(ref=>ref.id);
  expect({first,before:held.before,rest}).toEqual({first:['b-mine-5','b-mine-4','b-mine-3'],before:rowid('b-mine-3'),rest:['b-mine-2','b-mine-1']});
  // a full page is not a cut, and a walk that reaches the end is not a cut: the rows stepped are what is charged
  const full = new pages.RecallWorkBudget(4096), none: {before?: number} = {};
  expect(pages.recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,2,full,none).map(ref=>ref.id)).toEqual(['b-mine-5','b-mine-4']);
  expect({before:none.before,charged:full.raw}).toEqual({before:undefined,charged:302});
  const whole = new pages.RecallWorkBudget(4096), end: {before?: number} = {};
  expect(pages.recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,256,whole,end).map(ref=>ref.id)).toEqual(NEWEST_MINE);
  expect({before:end.before,charged:whole.raw}).toEqual({before:undefined,charged:305});
});
it('W-CUT-RECENT-CALLERS a recent page the budget ends is never read as the end: the sliced scan, the keyword scan and the cold word page all say not complete', async () => {
  const {pages,access,db} = await scanFixture(); refusedFixture(db,300);
  const recent = await import('./recent.ts');
  const sliced = await recent.recentMemoryHitsSliced('kettle',access,{deadlineAt:performance.now()+60_000,workBudget:new pages.RecallWorkBudget(64)});
  expect({complete:sliced.complete,hits:sliced.hits.map(hit=>hit.id)}).toEqual({complete:false,hits:[]});
  const keyword = await recent.keywordMemoryHits('kettle',access,{workBudget:new pages.RecallWorkBudget(64)});
  expect({complete:keyword.complete,hits:keyword.hits.map(hit=>hit.id)}).toEqual({complete:false,hits:[]});
  const cold = pages.lexicalViewPage(db,'kettle',access.view,10,0,new pages.RecallWorkBudget(64));
  expect({partial:cold.partial,hits:cold.hits.map(hit=>hit.id)}).toEqual({partial:true,hits:[]});
  // non-vacuous: with room for the whole walk each reader reaches the reader's five rows and says complete
  const all = await recent.recentMemoryHitsSliced('kettle',access,{deadlineAt:performance.now()+60_000,workBudget:new pages.RecallWorkBudget(4096)});
  expect({complete:all.complete,hits:all.hits.map(hit=>hit.id).sort()}).toEqual({complete:true,hits:[...NEWEST_MINE].sort()});
  const words = await recent.keywordMemoryHits('kettle',access,{workBudget:new pages.RecallWorkBudget(4096),budgetMs:250});
  expect({complete:words.complete,hits:words.hits.map(hit=>hit.id).sort()}).toEqual({complete:true,hits:[...NEWEST_MINE].sort()});
  const warm = pages.lexicalViewPage(db,'kettle',access.view,10,0,new pages.RecallWorkBudget(4096));
  expect({partial:warm.partial,hits:warm.hits.map(hit=>hit.id).sort()}).toEqual({partial:false,hits:[...NEWEST_MINE].sort()});
  // a cut page that holds rows of the reader: the keyword scan keeps them as candidates and still says not complete
  const some = await recent.keywordMemoryHits('kettle',access,{workBudget:new pages.RecallWorkBudget(303),budgetMs:250});
  expect({complete:some.complete,hits:some.hits.map(hit=>hit.id).sort()}).toEqual({complete:false,hits:['b-mine-3','b-mine-4','b-mine-5']});
});
// 5 records of the wanted kind, then 300 NEWER records of another kind in the reader's own scope: no (scope_id, kind) index exists, so each
// is a raw row of the walk, which reads a scope newest first.
function kindFixture(db: ReturnType<typeof database>) {
  const mine = ensureScope('bot','reader');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,'fixture frame','owner-statement','active',0,0,NULL,NULL,1)");
  db.exec('SAVEPOINT kind_fixture');
  try {
    for (let k = 1; k <= 5; k++) put.run(`b-mine-${k}`,mine,'preference');
    for (let k = 0; k < 300; k++) put.run(`a-fact-${String(k).padStart(5,'0')}`,mine,'fact');
  } finally { db.exec('RELEASE kind_fixture'); }
  return {mine,rowid:(id: string) => Number(db.prepare('SELECT rowid AS n FROM memory_records WHERE id=?').get(id)!.n)};
}
it('W-CUT-FRAME-KINDS the identity frame page charges every raw row of the reader\'s scopes it reads; a walk the budget ends is a cut with a cursor that reaches the rest', async () => {
  const {pages,access,db} = await scanFixture(), {mine,rowid} = kindFixture(db);
  const budget = new pages.RecallWorkBudget(64), cut: {next?: string} = {};
  const page = pages.frameViewPage(db,access.view,['preference'],256,budget,cut);
  expect({charged:budget.raw,rows:page.map(ref=>ref.id),next:cut.next}).toEqual({charged:64,rows:[],next:JSON.stringify([mine,'active',rowid('a-fact-00236')])});
  const seen: string[] = []; let cuts = 0, worst = 0;
  for (let after = '', guard = 0; guard < 20; guard++) {
    const b = new pages.RecallWorkBudget(64), c: {next?: string} = {};
    seen.push(...pages.frameViewPage(db,access.view,['preference'],256,b,c,after).map(ref=>ref.id)); worst = Math.max(worst,b.raw);
    if (c.next === undefined) break;
    cuts++; after = c.next;
  }
  expect({seen,cuts,worst}).toEqual({seen:MINE,cuts:4,worst:64});
  // a walk that reaches the end is whole (no cut), in the order the one statement gave, and the rows read are what is charged
  const whole = new pages.RecallWorkBudget(4096), end: {next?: string} = {};
  expect(pages.frameViewPage(db,access.view,['preference'],2,whole,end).map(ref=>ref.id)).toEqual(['b-mine-1','b-mine-2']);
  expect({next:end.next,charged:whole.raw}).toEqual({next:undefined,charged:305});
});
it('W-CUT-FRAME-PINS the owner pin page charges every pinned row it reads, refused ones too; a walk the budget ends is a cut with a cursor that reaches the rest', async () => {
  const {pages,access,db} = await scanFixture(), {mine,rowid} = refusedFixture(db,300,1);
  const budget = new pages.RecallWorkBudget(64), cut: {next?: string} = {};
  const page = pages.frameViewPage(db,access.view,null,256,budget,cut);
  expect({charged:budget.raw,rows:page.map(ref=>ref.id),next:cut.next}).toEqual({charged:64,rows:[],next:JSON.stringify([mine,'active',rowid('a-ended-00236')])});
  const rest = new pages.RecallWorkBudget(4096), end: {next?: string} = {};
  expect(pages.frameViewPage(db,access.view,null,256,rest,end,cut.next).map(ref=>ref.id)).toEqual(MINE);
  expect({next:end.next,charged:rest.raw}).toEqual({next:undefined,charged:241});
  const whole = new pages.RecallWorkBudget(4096), none: {next?: string} = {};
  expect(pages.frameViewPage(db,access.view,null,256,whole,none).map(ref=>ref.id)).toEqual(MINE);
  expect({next:none.next,charged:whole.raw}).toEqual({next:undefined,charged:305});
});
// Two scopes of the reader, each 40 records of another kind and one of the wanted kind: the walk crosses lists, so a cut cursor names the
// list it stopped in. Following it reaches every row of every list exactly once (frame), in newest-first order across the lists (recent).
it('W-CUT-LISTS a cut that falls inside one of several lists resumes in that list: every list is walked once, none skipped, none walked twice', async () => {
  const {pages,access,db} = await scanFixture(), scopes = [ensureScope('bot','reader'),ensureScope('conversation','direct')];
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,'fixture lists','owner-statement','active',0,0,NULL,NULL,1)");
  for (let k = 0; k < 41; k++) for (const [n,scope] of scopes.entries()) put.run(`${k === 20 ? 'b-mine' : 'a-fact'}-${n}-${String(k).padStart(2,'0')}`,scope,k === 20 ? 'preference' : 'fact'); put.run('b-other-20',ensureScope('conversation','private'),'preference');
  const seen: string[] = []; let cuts = 0, worst = 0;
  for (let after = '', guard = 0; guard < 20; guard++) {
    const b = new pages.RecallWorkBudget(30), c: {next?: string} = {};
    seen.push(...pages.frameViewPage(db,access.view,['preference'],256,b,c,after).map(ref=>ref.id)); worst = Math.max(worst,b.raw);
    if (c.next === undefined) break;
    cuts++; after = c.next;
  }
  expect({seen:seen.sort(),cuts,worst}).toEqual({seen:['b-mine-0-20','b-mine-1-20'],cuts:2,worst:30});
  // `within` narrows the walk to one scope of the set and never widens it: a scope outside the set adds nothing
  const one = new pages.RecallWorkBudget(4096);
  expect(pages.frameViewPage(db,access.view,['preference'],256,one,undefined,'',[scopes[1],ensureScope('conversation','private')]).map(ref=>ref.id)).toEqual(['b-mine-1-20']);
  expect(one.raw).toBe(41);
  // a cursor that names no list of this walk is refused
  expect(attempt(() => pages.frameViewPage(db,access.view,['preference'],256,new pages.RecallWorkBudget(30),undefined,JSON.stringify([scopes[0],'active',5]),[scopes[1]]))).toBe('INVALID_MEMORY_CURSOR');
  const newest = db.prepare("SELECT id FROM memory_records WHERE id<>'b-other-20' ORDER BY rowid DESC").all().map(row=>String(row.id)), recent: string[] = []; let recentCuts = 0;
  for (let before = Number.MAX_SAFE_INTEGER, guard = 0; guard < 20; guard++) {
    const c: {before?: number} = {};
    recent.push(...pages.recentViewPage(db,access.view,before,256,new pages.RecallWorkBudget(30),c).map(ref=>ref.id));
    if (c.before === undefined) break;
    recentCuts++; before = c.before;
  }
  expect({recent,recentCuts}).toEqual({recent:newest,recentCuts:2});
});
// The turn's own reader (bundle.ts buildMemoryBundle; an empty query, so no search runs and the identity frame is the only scope-set read).
// 5,000 records of the bot's own scope and no identity record: the base stepped them all uncharged and called the frame whole. The identity
// frame uses the bot's own scope only, so 5,000 records of another scope of the reader cost the walk nothing and the bundle is whole.
it('W-CUT-IDENTITY a turn whose identity walk the budget ends reports a partial bundle, and the walk leaves half of the frame budget for recall', async () => {
  const {access,db} = await scanFixture(), mine = ensureScope('bot','reader');
  const views = await import('./recall-view.ts'), {buildMemoryBundle} = await import('./bundle.ts'), {LineageAllowance} = await import('./lineage-allowance.ts');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','fixture frame','owner-statement','active',0,0,NULL,NULL,1)");
  db.exec('SAVEPOINT identity_fixture');
  try { for (let k = 0; k < 5000; k++) put.run(`a-fact-${String(k).padStart(5,'0')}`,mine); } finally { db.exec('RELEASE identity_fixture'); }
  const before = views.recallViewCounters().candidateVisits;
  const bundle = await buildMemoryBundle('',access,{search:async()=>({hits:[],vectorRows:0})} as never,{allowance:LineageAllowance.turn()});
  expect({partial:bundle.recallPartial,visits:views.recallViewCounters().candidateVisits-before}).toEqual({partial:true,visits:4097});
  db.exec("UPDATE memory_records SET scope_id='"+ensureScope('conversation','direct')+"' WHERE scope_id='"+mine+"'");
  const mid = views.recallViewCounters().candidateVisits;
  const whole = await buildMemoryBundle('',access,{search:async()=>({hits:[],vectorRows:0})} as never,{allowance:LineageAllowance.turn()});
  expect({partial:whole.recallPartial,visits:views.recallViewCounters().candidateVisits-mid}).toEqual({partial:undefined,visits:2});
},120_000);
// ASTRA r10 precheck High 1: a cut frame page is never cut to `limit` (the cursor has passed every row it read, so a row left out would be
// lost for good). Six rows of the wanted kind, a raw budget of 3 and a limit of 1: the walk by cursor returns all six, each once.
for (const count of [6,5]) it(`W-CUT-LIMIT ${count} rows: a cut frame page and its continuation return every hit they reached, whatever the limit: the walk loses none`, async () => {
  const {pages,access,db} = await scanFixture(), mine = ensureScope('bot','reader');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'preference','fixture limit','owner-statement','active',0,0,NULL,NULL,1)");
  for (let k = 1; k <= count; k++) put.run(`b-mine-${k}`,mine); // 6: both pages end on the budget; 5: the last page reaches the end (ASTRA r10 pass 2)
  const seen: string[] = []; let cuts = 0;
  for (let after = '', guard = 0; guard < 20; guard++) {
    const c: {next?: string} = {};
    seen.push(...pages.frameViewPage(db,access.view,['preference'],1,new pages.RecallWorkBudget(3),c,after).map(ref=>ref.id));
    if (c.next === undefined) break;
    cuts++; after = c.next;
  }
  expect({seen:seen.sort(),cuts}).toEqual({seen:['b-mine-1','b-mine-2','b-mine-3','b-mine-4','b-mine-5','b-mine-6'].slice(0,count),cuts:count===6?2:1});
});
// ASTRA r10 precheck High 2: every raw row the recent walk READS is charged, a list's look-ahead row too. One walk reads each row once: the
// caller's cut object carries the rows already read (and paid for) to the next page, so the lists are looked at once per walk, not per page.
it('W-CUT-WALK one recent walk reads and charges each raw row exactly once across its pages, and steps even on a budget below the number of lists', async () => {
  const {pages,access,db} = await scanFixture(), scopes = [ensureScope('bot','reader'),ensureScope('conversation','direct')];
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','fixture kettle words','owner-statement','active',0,0,NULL,NULL,1)");
  for (let k = 0; k < 41; k++) for (const [n,scope] of scopes.entries()) put.run(`a-fact-${n}-${String(k).padStart(2,'0')}`,scope);
  const newest = db.prepare('SELECT id FROM memory_records ORDER BY rowid DESC').all().map(row=>String(row.id));
  // a budget of ONE raw row per page over two lists: the walk still steps, and the whole of it costs one charge per row
  const cut: import('./oneindex.ts').RecentCut = {}, seen: string[] = []; let charged = 0, pagesRead = 0;
  for (let before = Number.MAX_SAFE_INTEGER; pagesRead < 200; pagesRead++) {
    const b = new pages.RecallWorkBudget(1), rows = pages.recentViewPage(db,access.view,before,256,b,cut);
    seen.push(...rows.map(ref=>ref.id)); charged += b.raw;
    if (cut.before === undefined) break;
    before = cut.before;
  }
  expect({seen,charged}).toEqual({seen:newest,charged:82});
  // the sliced reader (64-row pages) pays for the 82 rows once, not for each list's top again on every page
  const recent = await import('./recent.ts'), whole = new pages.RecallWorkBudget(4096);
  const all = await recent.recentMemoryHitsSliced('kettle',access,{deadlineAt:performance.now()+60_000,workBudget:whole});
  expect({complete:all.complete,hits:all.hits.length,charged:whole.raw}).toEqual({complete:true,hits:82,charged:82});
});
