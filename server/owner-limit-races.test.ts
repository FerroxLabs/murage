// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup owns the continuation producer and final dispatch consumer.
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';
import { OwnerLimitContinuations, LimitApplications, type OwnerLimitSnapshot } from './owner-limit-continuation.ts';
import { LimitFailoverStore } from './limit-failovers.ts';
import { TurnSubmissionBoundary } from './turn-dispatch-guard.ts';
import ts from 'typescript';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const snapshot: OwnerLimitSnapshot = { botId: 'bot', threadId: 'thread', generation: 'generation', sourceMessageId: 'source', sourceDigest: 'digest', principal: 'owner', policy: 'unlimited', epoch: 0 };
it.each(['current','hidden','removed','at-limit','downgrade','Stop','replacement','principal-revision','audience'])(
  'listing await rechecks owner authority and live engines: %s', async mode => {
    const db = new DatabaseSync(':memory:'), applications = new LimitApplications(() => db);
    let current = true, usable = true;
    const registry = new OwnerLimitContinuations(() => current);
    const ticket = registry.authorizeRaisedCard(snapshot, true)!;
    let release!: (value: unknown[]) => void;
    const listing = new Promise<unknown[]>(resolve => { release = resolve; });
    const dispatch = vi.fn(), offer = vi.fn();
    const { continueOwnerLimitTurn } = wiring(['continueOwnerLimitTurn', 'continueSelectedOwnerLimitTurn'], {
      ownerLimitContinuations: registry, limitApplications: applications, ownerLimitSnapshotCurrent: () => current,
      limitChoicesFor: () => listing, backupUsable: () => usable,
      limitFailovers: { bySendId: () => undefined }, failOverThread: dispatch, postLimitOffer: offer,
      randomUUID: () => 'fixture',
    });
    const pending = continueOwnerLimitTurn({ botId:'bot',threadId:'thread',selection:{instanceId:'primary',model:'fixture'},sendIds:['send'],ownerContinuation:ticket }, {until:100,resetsAt:null});
    if (['hidden','removed','at-limit'].includes(mode)) usable = false;
    else if (mode !== 'current') current = false;
    if (mode === 'Stop') { registry.cancel('thread'); applications.cancel('thread'); }
    release([{ label:'Backup',selection:{instanceId:'backup',model:'fixture'},billing:'own-key' }]);
    await pending;
    expect(dispatch).toHaveBeenCalledTimes(mode === 'current' ? 1 : 0);
    if (mode === 'current') expect(dispatch.mock.calls[0][0].application).toMatchObject({ sourceKey:'thread:source',kind:'automatic' });
    db.close();
  });
it('the physical beforeSubmit hook refuses a cancellation after spend authorized adapter invocation', () => {
  const db = new DatabaseSync(':memory:'), applications = new LimitApplications(() => db);
  const tickets = new OwnerLimitContinuations(() => true), ticket = tickets.authorizeRaisedCard(snapshot,true)!;
  const application = applications.prepare(snapshot,{instanceId:'backup',model:'fixture'},'raised'); tickets.select(ticket,application); tickets.claim(ticket,application); applications.claim(application);
  const globals = {
    limitActiveDispatches: new Map([['successor',{ticket,application}]]),
    limitApplications: applications, ownerLimitContinuations: tickets, ownerLimitSelectionCurrent: () => true,
    ownerLimitSnapshot: () => ({...snapshot,epoch:applications.epoch('thread')}), DirectTurnSetupCancelled: Error,
    limitFailovers:{get:()=>({rowId:application.rowId,resendSendId:application.sendId,botId:'bot',threadId:'thread',sourceMessageId:'source',hop:1,state:'applied',to:application.to,from:{instanceId:'primary',model:'fixture'}})},
    store:{taskByThread:()=>({limitFailover:application.rowId,modelSelection:application.to})},assertBackupStillUsable(){},
  };
  const { validateOwnerLimitDispatch } = wiring(['validateOwnerLimitDispatch'],globals);
  const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8'), ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  let initializer: ts.Expression | undefined;
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='validateDirectSubmission')initializer=node.initializer;ts.forEachChild(node,visit);};visit(ast);
  expect(initializer).toBeDefined();
  const accepted=vi.fn();
  const context=vm.createContext({validateOwnerLimitDispatch,dispatchClaimId:'successor',threadId:'thread',limitTurns:{assertCanSubmit(){}},
    assertCursorNotSealed(){},store:{taskByThread(){}},bot:{id:'bot'},instanceId:'backup',resumeCursor:undefined,packGuard:{assertCurrent(){}},providerRouteIsCurrent:()=>true,
    providerRoute:undefined,assertBackupStillUsable(){},turnSelection:{},opts:undefined,trace:{mark(){}},memoryReceipt:{accepted},
    memoryState:()=>({mode:'off'}),directStoredMemoryMode:'off',submissionBoundary:new TurnSubmissionBoundary(),
    assertMemoryPinsAtSubmissionOrRevoked(){},directFencePreparing:false,directFencePreflight:false});
  vm.runInContext(ts.transpileModule(`globalThis.submit=${initializer!.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
  context.submit(); expect(accepted).toHaveBeenCalledOnce(); accepted.mockClear();
  applications.cancel('thread');
  expect(()=>context.submit()).toThrow(); expect(accepted).not.toHaveBeenCalled(); db.close();
});
it('production failover lookup and mutations use indexed rows rather than retained JSON history', () => {
  const db=new DatabaseSync(':memory:');
  const rows=new LimitFailoverStore(()=>'/nonexistent-neutral-fixture',()=>100,()=>db);
  for(let i=0;i<2000;i++)rows.create({rowId:`row-${i}`,botId:'bot',threadId:'thread',sourceMessageId:`source-${i}`,from:{instanceId:'primary',model:'fixture'},to:{instanceId:'backup',model:'fixture'},was:'following',resetsAt:1000,at:1});
  const last=rows.get('row-1999')!;
  expect(rows.bySendId(last.resendSendId)?.rowId).toBe(last.rowId);
  expect(rows.setState(last.rowId,'applied')?.state).toBe('applied');
  for(const [column,key] of [['row_id',last.rowId],['send_id',last.resendSendId]]){
    const plan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT value FROM limit_failover_rows WHERE ${column}=?`).all(key));
    expect(plan).toContain('INDEX'); expect(plan).not.toContain('SCAN');
  }
  db.close();
});

it('idle-card Stop commits cancellation before its first await; an exact old-generation Stop leaves a successor alone', async () => {
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE approval_records(id TEXT PRIMARY KEY,thread_id TEXT,service TEXT,queue_kind TEXT,state TEXT)');
  const applications=new LimitApplications(()=>db);applications.epoch('thread');db.exec("INSERT INTO approval_records VALUES('card','thread','event-limit',NULL,'open')");
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  const owners=new Map(),cancel=vi.fn();
  const {interruptDirectThread}=wiring(['interruptDirectThread'],{
    internalTurnOwners:owners,directRuns:{get:()=>undefined},botForDirectThread:()=>({modelSelection:{instanceId:'fixture'}}),
    ownerLimitContinuations:{cancel},limitApplications:applications,ownWriteHolds:{stop(){}},bus:{cancelTurn(){}},callSpeech:{invalidate(){}},replyState:{invalidate(){}},cancelDirectTurnDispatch:()=>undefined,
    stopEmailForTurn:async()=>{},emailRuntime:{},emailGeneration:{},releaseBrowserCapabilityForThread:()=>waiting,
  });
  const stopped=interruptDirectThread('bot','thread');
  expect(applications.cardCurrent('card','thread')).toBe(false);expect(cancel).toHaveBeenCalledOnce();
  owners.set('thread',{generation:'successor'});release();await stopped;
  const epoch=applications.epoch('thread');cancel.mockClear();
  await interruptDirectThread('bot','thread','old-generation');
  expect(applications.epoch('thread')).toBe(epoch);expect(cancel).not.toHaveBeenCalled();db.close();
});

it('source application and failover lookup counts are unchanged at 10 and 2000 retained attempts', () => {
  const counts=[10,2000].map(history=>{
    const db=new DatabaseSync(':memory:'),apps=new LimitApplications(()=>db),rows=new LimitFailoverStore(()=>'/nonexistent-neutral-fixture',()=>100,()=>db);
    for(let i=0;i<history;i++){
      apps.prepare({...snapshot,threadId:`history-${i}`,sourceMessageId:`history-${i}`},{instanceId:'backup',model:'fixture'},'explicit');
      rows.create({rowId:`history-${i}`,botId:'bot',threadId:`history-${i}`,sourceMessageId:`history-${i}`,from:{instanceId:'primary',model:'fixture'},to:{instanceId:'backup',model:'fixture'},was:'following',resetsAt:1000,at:1});
    }
    const app=apps.prepare(snapshot,{instanceId:'backup',model:'fixture'},'automatic');
    const row=rows.create({rowId:'latest',botId:'bot',threadId:'thread',sourceMessageId:'source',from:{instanceId:'primary',model:'fixture'},to:app.to,was:'following',resetsAt:1000,at:1});
    const prepare=db.prepare.bind(db);let lookups=0;db.prepare=(sql:string)=>{lookups++;return prepare(sql);};
    expect(apps.get('thread','source')).toEqual(app);expect(apps.current(app)).toBe(true);expect(apps.epoch('thread')).toBe(0);expect(apps.claim(app)).toBe(true);
    expect(rows.get('latest')?.rowId).toBe('latest');expect(rows.bySendId(row.resendSendId)?.rowId).toBe('latest');expect(rows.setState('latest','applied')?.state).toBe('applied');
    db.close();return lookups;
  });
  expect(counts).toEqual([10,10]);
});

it.each([false,true])('a consumed backup cannot automatically replay after a late unwritten refusal (durable owner-send gate=%s)', hasGate => {
  const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8'), ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  let initializer:ts.Expression|undefined;
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='directFence')initializer=node.initializer;ts.forEachChild(node,visit);};visit(ast);
  expect(initializer).toBeDefined();
  for(const consumed of [false,true]) {
    const boundary=new TurnSubmissionBoundary();
    if(hasGate)boundary.setPersistenceGate({invocation(){},write(){}});
    const context=vm.createContext({submissionBoundary:boundary,directReader:{audience:null},turnLineage:{},dispatchClaimId:'successor',
      limitActiveDispatches:new Map(consumed?[['successor',{application:{sourceKey:'thread:source'}}]]:[]),instance:{adapter:{capabilities:{fencedWrites:true}}}});
    vm.runInContext(ts.transpileModule(`globalThis.fence=${initializer!.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
    context.fence.invoked();boundary.refuse(new Error('MEMORY_CONTEXT_REVOKED'));
    expect(boundary.hasReleasedSubmission).toBe(false);
    expect(boundary.canRetry).toBe(!consumed);
  }
});

it('Stop fences a same-thread completed history with constant durable writes', () => {
  const counts = [10, 2000].map(history => {
    const db = new DatabaseSync(':memory:'), apps = new LimitApplications(() => db);
    try {
      for (let i = 0; i < history; i++) {
        const app = apps.prepare({ ...snapshot, sourceMessageId: `history-${i}` }, { instanceId: 'backup', model: 'fixture' }, 'automatic');
        expect(apps.claim(app)).toBe(true);
      }
      const app = apps.prepare(snapshot, { instanceId: 'backup', model: 'fixture' }, 'automatic');
      const before = Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
      apps.cancel('thread');
      const writes = Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n) - before;
      expect(apps.current(app)).toBe(false);
      expect(apps.claim(app)).toBe(false);
      expect(apps.pending('thread')).toEqual([]);
      const restarted = new LimitApplications(() => db);
      expect(restarted.current(app)).toBe(false);
      expect(() => restarted.prepare(snapshot, app.to, 'raised')).toThrow();
      const fresh = restarted.prepare({ ...snapshot, sourceMessageId: 'fresh', epoch: 1 }, app.to, 'automatic');
      expect(restarted.claim(fresh)).toBe(true);
      return writes;
    } finally { db.close(); }
  });
  expect(counts).toEqual([1, 1]);
});
