// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean 2026-11-12 02:05Z: default records follow live owner No limits;
// an explicit lower choice survives. These records never run a command.
import {afterEach,expect,it} from 'vitest';
import {Store} from './store.ts';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {RoutineManager} from './routines.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
import {join} from 'node:path';
import {DATA_DIR} from './config.ts';
import {installPermissionInheritance, inheritedPermissions} from './permission-inheritance.ts';
import {autoVerdict,hasNoLimits} from './auto-approve.ts';
import {applyRoutinePermissionMode,botPermissionMode,effectiveRoutinePermissionMode} from './routine-permissions.ts';
const dirs:string[]=[];
let dispose=()=>{};afterEach(()=>{dispose();for(const dir of dirs.splice(0))removeTempDirSync(dir);});
const lower={autoApprove:true,fullAccess:false,noLimits:false};
it('F7 reads the global default on every bot decision without copying it',()=>{
 let global=false;dispose=installPermissionInheritance(()=>global);
 expect(hasNoLimits(lower)).toBe(false);global=true;
 expect(hasNoLimits(lower)).toBe(true);
 expect(botPermissionMode(lower)).toBe('unlimited');
 expect(autoVerdict(lower,'Bash','touch notes.md',{outsideRead:['web page'],fullAccessOrigin:'owner'}).approve).toBeTruthy();
 expect(lower).toEqual({autoApprove:true,fullAccess:false,noLimits:false});
 global=false;expect(botPermissionMode(lower)).toBe('auto');
});
for(const flags of [{...lower,permissionExplicit:true},{...lower,permissionRev:2},{autoApprove:false,permissionExplicit:true},{autoApprove:true,fullAccess:true,noLimits:false}])it(`F7 preserves explicit lower ${JSON.stringify(flags)}`,()=>{
 dispose=installPermissionInheritance(()=>true);expect(hasNoLimits(flags)).toBe(false);
});
it('F7 the use-all action can clear a previous explicit choice',()=>{
 dispose=installPermissionInheritance(()=>true);
 expect(hasNoLimits({...lower,permissionRev:2,permissionExplicit:false})).toBe(true);
});
it('F7 routine defaults follow live bot No limits and explicit ceilings remain lower',()=>{
 dispose=installPermissionInheritance(()=>true);
 for(const routine of [{},{permissionMode:'ask' as const,permissionExplicit:false},{permissionMode:'auto' as const,permissionExplicit:false},{permissionMode:'full' as const,permissionExplicit:false}])
  expect(effectiveRoutinePermissionMode(routine,lower)).toBe('unlimited');
 // Explicit ceilings retain their original assertions below No limits.
 dispose();dispose=installPermissionInheritance(()=>({autoApprove:true,fullAccess:true,noLimits:false}));
 for(const permissionMode of ['ask','auto','full'] as const){
  const mode=effectiveRoutinePermissionMode({permissionMode,permissionExplicit:true},lower);
  expect(mode).toBe(permissionMode);
  expect(botPermissionMode(applyRoutinePermissionMode(lower,mode))).toBe(permissionMode);
 }
});
it('F7 draft-only remains an explicit read-only actor',()=>{
 dispose=installPermissionInheritance(()=>true);expect(inheritedPermissions({...lower,draftOnly:true})).toMatchObject(lower);
 expect(botPermissionMode({...lower,draftOnly:true})).toBe('ask');
});

it('F7 use-all saves inheritance before publishing it and preserves stored fallback levels',()=>{
 dispose=installPermissionInheritance(()=>true);
 const store=new Store();const bot=store.createBot({name:'Inheritance fixture'},{seedMessages:false});
 store.patchBot(bot.id,{autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:true});
 expect(hasNoLimits(store.bot(bot.id))).toBe(false);
 store.inheritAllPermissions();
 expect(store.bot(bot.id)?.permissionExplicit).toBe(false);
 expect(hasNoLimits(store.bot(bot.id))).toBe(true);
 const saved=JSON.parse(readFileSync(join(DATA_DIR,'bots.json'),'utf8'));
 const records=Array.isArray(saved)?saved:saved.bots;
 expect(records.find((row:{id:string})=>row.id===bot.id)).toMatchObject({permissionExplicit:false,autoApprove:false});
});

it('F7 derived routine handoff ceilings remain lower after inheritance resolution',()=>{
 // Preserve the lower-level ceiling assertions under the owner's Full access default.
 dispose=installPermissionInheritance(()=>({autoApprove:true,fullAccess:true,noLimits:false}));
 for(const permissionMode of ['ask','auto','full']as const)
  expect(effectiveRoutinePermissionMode({permissionMode},lower)).toBe(permissionMode);
});

function managerFixture(){
 const dir=mkdtempSync(join(tmpdir(),'nolim-routine-inherit-'));dirs.push(dir);
 const file=join(dir,'routines.json');
 const options={file,botMode:()=>botPermissionMode(lower),botState:()=> 'ready' as const,createTask:()=>{throw Error('No dispatch in fixture');},startTurn:async()=>{throw Error('No dispatch in fixture');}};
 return {file,load:()=>new RoutineManager(options)};
}
const routineInput={name:'Inheritance fixture',botId:'fixture',prompt:'No execution',enabled:false,schedule:{type:'interval' as const,everyMinutes:60,anchorAt:Date.now()}};
it('F7 new routines inherit live and owner can restore inheritance after an explicit lower choice',()=>{
 let enabled=false;dispose=installPermissionInheritance(()=>enabled);
 const f=managerFixture(),manager=f.load(),routine=manager.create(routineInput);
 expect(routine.permissionMode).toBeUndefined();expect(routine.permissionExplicit).toBe(false);
 expect(effectiveRoutinePermissionMode(routine,lower)).toBe('auto');enabled=true;
 expect(effectiveRoutinePermissionMode(f.load().listRoutines()[0]!,lower)).toBe('unlimited');
 // The saved ceiling still binds below No limits.
 enabled=false;
 const chosen=manager.update(routine.id,{permissionMode:'ask'})!;
 expect(effectiveRoutinePermissionMode(chosen,lower)).toBe('ask');
 enabled=true;
 const inherited=manager.update(routine.id,{permissionMode:'inherit'})!;
 expect(inherited.permissionMode).toBeUndefined();expect(effectiveRoutinePermissionMode(inherited,lower)).toBe('unlimited');
});
it('F7 legacy default ceilings migrate to inherit; a recorded owner choice is preserved',()=>{
 dispose=installPermissionInheritance(()=>true);const f=managerFixture(),manager=f.load();
 for(const permissionMode of ['ask','auto','full']as const)manager.create({...routineInput,name:permissionMode,permissionMode});
 const original=JSON.parse(readFileSync(f.file,'utf8'));
 for(const routine of original.routines)delete routine.permissionExplicit;
 writeFileSync(f.file,JSON.stringify(original));
 const migrated=f.load().listRoutines();
 expect(migrated.find(row=>row.name==='ask')?.permissionExplicit).toBe(false);
 expect(migrated.find(row=>row.name==='auto')?.permissionExplicit).toBe(false);
 expect(migrated.find(row=>row.name==='full')?.permissionExplicit).toBe(true);
 for(const routine of migrated)expect(effectiveRoutinePermissionMode(routine,routine.name==='full'?{autoApprove:true,fullAccess:true,noLimits:false,permissionExplicit:true}:lower)).toBe(routine.name==='full'?'full':'unlimited');
 const again=f.load().listRoutines();expect(again.map(row=>row.permissionExplicit)).toEqual(migrated.map(row=>row.permissionExplicit));
});

it('F7 imported routines omit a level and follow their bot without an owner level choice',()=>{
 let enabled=false;dispose=installPermissionInheritance(()=>enabled);const f=managerFixture(),manager=f.load();
 const routine=manager.create(routineInput);
 expect(effectiveRoutinePermissionMode(routine,lower)).toBe('auto');enabled=true;
 expect(effectiveRoutinePermissionMode(routine,lower)).toBe('unlimited');
 expect(effectiveRoutinePermissionMode(f.load().listRoutines()[0]!,lower)).toBe('unlimited');
 const addition={...routine,id:'packaged',enabled:false,nextRunAt:null,permissionExplicit:undefined};
 manager.preparePackageAddition([addition]).publish();
 expect(effectiveRoutinePermissionMode(manager.listRoutines().find(row=>row.id==='packaged')!,lower)).toBe('unlimited');
 enabled=false;expect(effectiveRoutinePermissionMode(manager.listRoutines().find(row=>row.id==='packaged')!,lower)).toBe('auto');
});

it('F7 an old default owner thread follows a newly No limits bot; explicit lower threads survive',()=>{
 dispose=installPermissionInheritance(()=>true);const store=new Store(),bot=store.createBot({name:'Owner defaults'},{seedMessages:false});
 const old=store.createTask(bot.id,'Old default',false)!;
 store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true});
 expect(hasNoLimits(store.projectBotForTask(bot.id,old.threadId))).toBe(true);
 store.patchTask(bot.id,old.threadId,{autoApprove:false,fullAccess:false,noLimits:false});
 expect(hasNoLimits(store.projectBotForTask(bot.id,old.threadId))).toBe(false);
});
it('F7 a new copied Full access default is not an explicit thread-level choice',()=>{
 let global=false;dispose=installPermissionInheritance(()=>global);
 const store=new Store(),bot=store.createBot({name:'Copied Full default'},{seedMessages:false});
 store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:false,permissionExplicit:false});
 const task=store.createTask(bot.id,'Default',false)!;
 expect(hasNoLimits(store.projectBotForTask(bot.id,task.threadId))).toBe(false);global=true;
 expect(hasNoLimits(store.projectBotForTask(bot.id,task.threadId))).toBe(true);
});

it('F7 a copied No limits thread drops to the owner-chosen lower bot level',()=>{
 dispose=installPermissionInheritance(()=>true);const store=new Store(),bot=store.createBot({name:'Lower bot choice'},{seedMessages:false});
 store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true});
 const task=store.createTask(bot.id,'Copied No limits',false)!;
 store.patchBot(bot.id,{autoApprove:true,fullAccess:false,noLimits:false,permissionExplicit:true});
 expect(botPermissionMode(store.projectBotForTask(bot.id,task.threadId))).toBe('auto');
});

it('M4 an implicit follower tracks each chief level after No limits is lowered',()=>{
 let chief:any={autoApprove:true,fullAccess:true,noLimits:true};
 dispose=installPermissionInheritance(()=>chief);
 const follower={autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:false};
 for(const flags of [{autoApprove:true,fullAccess:true,noLimits:true},{autoApprove:true,fullAccess:true,noLimits:false},{autoApprove:true,fullAccess:false,noLimits:false},{autoApprove:false,fullAccess:false,noLimits:false}]){
  chief=flags;expect(inheritedPermissions(follower)).toMatchObject({...flags,permissionExplicit:false});
  expect(inheritedPermissions({...follower,permissionExplicit:true})).toMatchObject({...follower,permissionExplicit:true});
  expect(inheritedPermissions({...follower,draftOnly:true})).toMatchObject(follower);
 }
});


it('No limits overrides migrated and explicitly saved routine ceilings while inherited',()=>{
 dispose=installPermissionInheritance(()=>true);
 for(const permissionMode of ['ask','auto','full'] as const) {
  expect(effectiveRoutinePermissionMode({permissionMode,permissionExplicit:true},lower)).toBe('unlimited');
 }
});
