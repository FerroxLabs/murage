// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: c3-memory-side (authoritative pins); consumer owner: recall-s1s2 (bounded proof regressions).
import ts from 'typescript';
import { TurnSubmissionBoundary } from '../turn-dispatch-guard.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { database, closeDatabase } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, reconcileMemoryRoster, memoryAccess, type MemoryRoster } from './policy.ts';
import { prepareRecallContext, stopRecallViewMaintenance } from './recall-view.ts';
import { buildMemoryBundle, assertMemoryBundle, assertMemoryPinsAtSubmission } from './bundle.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { OWNER_PIN } from './schema.ts';
import { MemoryPinProjectionPending, MemoryPinSetTooLarge } from './recall-recovery.ts';
import { sqlWork } from './testing/sql-work.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});database().exec(OWNER_PIN.sql);});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
const bridge={async search(){return {hits:[],vectorRows:0};}};
async function fixture(room=false){
 const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'},{id:'other',threadId:'private'}],groups:room?[{id:'room',threadId:'room-thread',memberIds:['reader']}]:[]};
 reconcileMemoryRoster(roster);const thread=room?'room-thread':'direct',db=database(),scope=ensureScope('bot','reader'),privateScope=ensureScope('conversation','private');
 const put=(id:string,where=scope)=>db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','Fixture pinned rule','owner-statement','active',1,1,NULL,NULL,1)").run(id,where);
 put('fixture-rule');put('fixture-private',privateScope);
 await prepareRecallContext('reader',thread,roster);stopRecallViewMaintenance();
 const registry=new InternalCapabilities();registry.begin('reader',thread,'generation');const token=registry.mint({botId:'reader',threadId:thread,generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
 const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
 return {access,db,put,scope};
}
const options=()=>({allowance:LineageAllowance.tool(1_000_000_000)});
it('S2: lagging projection still includes authoritative pins and excludes out-of-view pins',async()=>{
 const f=await fixture();f.db.prepare('UPDATE memory_recall_views SET watermark=0').run();
 const bundle=await buildMemoryBundle('',f.access,bridge,options());
 expect(bundle.pinned.map(pin=>pin.id)).toEqual(['fixture-rule']);expect(bundle.text).not.toContain('fixture-private');
});
it('S2: 2049 authoritative pins refuse with the overflow classification',async()=>{
 const f=await fixture();for(let n=0;n<2047;n++)f.put(`fixture-extra-${n}`);
 await expect(buildMemoryBundle('',f.access,bridge,options())).rejects.toBeInstanceOf(MemoryPinSetTooLarge);
});
it('S2: absent pin index refuses current and lagging projections without a table scan',async()=>{
 const f=await fixture();f.db.exec('DROP INDEX memory_records_pinned');
 await expect(buildMemoryBundle('',f.access,bridge,options())).rejects.toBeInstanceOf(MemoryPinProjectionPending);
 f.put('fixture-new');
 const {result,work}=sqlWork(f.db,()=>buildMemoryBundle('',f.access,bridge,options()).catch(error=>error));
 expect(await result).toBeInstanceOf(MemoryPinProjectionPending);
 expect([...work.sqls.keys()].filter(sql=>/FROM memory_records(?!.*(?:json_each|WHERE (?:id|r\.id)))/.test(sql))).toEqual([]);
});
it('S2: room reader never receives an identity-partition pin',async()=>{
 const f=await fixture(true);f.db.prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id='fixture-rule'").run();
 const bundle=await buildMemoryBundle('',f.access,bridge,options());expect(bundle.pinned).toEqual([]);
});
it('S2: forgotten and deleted pins are not hydrated or disclosed',async()=>{
 const f=await fixture();f.db.exec("UPDATE memory_records SET state='deleted' WHERE id='fixture-rule'");
 const bundle=await buildMemoryBundle('',f.access,bridge,options());expect(bundle.pinned).toEqual([]);
});

it('review H1: a current watermark cannot make a 2049-home-pin prefix complete',async()=>{
 const f=await fixture();for(let n=0;n<2047;n++)f.put(`fixture-overflow-${n}`);
 f.db.exec('UPDATE memory_recall_views SET watermark=(SELECT max(sequence) FROM memory_recall_changes)');
 await expect(buildMemoryBundle('',f.access,bridge,options())).rejects.toBeInstanceOf(MemoryPinSetTooLarge);
});
it('review H1: adding a pin after a full bundle was prepared refuses the actual write',async()=>{
 const f=await fixture(),bundle=await buildMemoryBundle('',f.access,bridge,options());f.put('fixture-late-pin');
 expect(()=>assertMemoryPinsAtSubmission(bundle)).toThrow(MemoryPinProjectionPending);
 expect(()=>assertMemoryBundle(bundle,f.access)).not.toThrow();
});
it('review H1: an exhausted pin proof refuses instead of returning a withheld omission',async()=>{
 const f=await fixture(),allowance=LineageAllowance.tool(0);
 await expect(buildMemoryBundle('',f.access,bridge,{allowance})).rejects.toBeInstanceOf(MemoryPinProjectionPending);
});

it('PIN-10: same-stamp cache avoids enumeration and membership probes',async()=>{
 const f=await fixture();await buildMemoryBundle('',f.access,bridge,options());
 const {result,work}=sqlWork(f.db,()=>buildMemoryBundle('',f.access,bridge,options()));await result;
 expect([...work.sqls.keys()].filter(sql=>sql.includes('INDEXED BY memory_records_pinned'))).toEqual([]);
});
it('S2-T4: out-of-view references never cause a memory text read',async()=>{
 const f=await fixture(),prototype=Object.getPrototypeOf(f.db.prepare('SELECT 1'));
 const get=prototype.get,all=prototype.all;let privateTextReads=0;
 for(const method of ['get','all']){
  const original=prototype[method];prototype[method]=function(this:{sourceSQL:string},...args:unknown[]){
   if(/FROM memory_records/.test(this.sourceSQL)&&/SELECT (?:r\.\*|\*|.*\btext\b)/.test(this.sourceSQL)&&JSON.stringify(args).includes('fixture-private'))privateTextReads++;
   return original.apply(this,args);
  };
 }
 try{const bundle=await buildMemoryBundle('',f.access,bridge,options());expect(bundle.text).toContain('Fixture pinned rule');expect(bundle.pinned.map(pin=>pin.id)).toEqual(['fixture-rule']);expect(privateTextReads).toBe(0);}
 finally{prototype.get=get;prototype.all=all;}
});

it('PIN-2: index absence refuses even when the same view has cached pins',async()=>{
 const f=await fixture();await buildMemoryBundle('',f.access,bridge,options());f.db.exec('DROP INDEX memory_records_pinned');
 await expect(buildMemoryBundle('',f.access,bridge,options())).rejects.toBeInstanceOf(MemoryPinProjectionPending);
});

it('S2-T10: actual submission validator permits later writes after a new pin and preserves the running request',async()=>{
 const f=await fixture(),bundle=await buildMemoryBundle('',f.access,bridge,options());
 const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
 let closure:ts.Expression|undefined;
 const walk=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='validateDirectSubmission')closure=node.initializer;ts.forEachChild(node,walk);};walk(ast);
 expect(closure).toBeDefined();
 const boundary=new TurnSubmissionBoundary();
 const env={validateOwnerLimitDispatch:()=>{},dispatchClaimId:'fixture-generation',memoryState:()=>({mode:'active'}),directStoredMemoryMode:'active',submissionBoundary:boundary,opts:{},
  directFencePreparing:false,directFencePreflight:false,recallReadiness:{},memoryReceipt:{bundle,accepted:()=>assertMemoryBundle(bundle,f.access)},assertMemoryPinsAtSubmission,
  limitTurns:{assertCanSubmit:()=>{}},assertCursorNotSealed:()=>{},store:{taskByThread:()=>({})},bot:{id:'reader'},threadId:'direct',instanceId:'fixture-engine',resumeCursor:undefined,
  packGuard:{assertCurrent:()=>{}},providerRouteIsCurrent:()=>true,providerRoute:undefined,assertBackupStillUsable:()=>{},turnSelection:{},trace:{mark:()=>{}}};
 const code=ts.transpileModule('return ('+closure!.getText(ast)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const validate=new Function(...Object.keys(env),code)(...Object.values(env));
 const requests:Array<{turn:number;system:string;integrations:string[];text:string}>=[];
 const write=()=>{boundary.beforeSubmit(validate);requests.push({turn:1,system:'Fixture persona',integrations:['agents'],text:bundle.text});boundary.noteEngineWrite();};
 write();f.put('fixture-postwrite-pin');
 try{write();}catch{/* The provider-write count below must expose any refusal. */}
 expect(requests).toHaveLength(2);expect(new Set(requests.map(request=>request.turn)).size).toBe(1);
 for(const request of requests){expect(request.system).toBe('Fixture persona');expect(request.integrations).toContain('agents');expect(request.text).toContain('Fixture pinned rule');}
 const next=await buildMemoryBundle('',f.access,bridge,options());
 expect(next.pinned.map(pin=>pin.id)).toEqual(['fixture-postwrite-pin','fixture-rule']);
});
