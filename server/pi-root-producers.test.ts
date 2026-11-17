// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: registry authority — wipe-fable / wg-final; publisher and reader — pi-roots-b.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DATA_DIR} from './config.ts';
import {closeDatabase,database} from './database.ts';
import {flushCoalesced} from './atomic.ts';
import {Store,RosterPostCommitError} from './store.ts';
import {RootRegistry} from './wipe/registry.ts';
import {wipeBreaker} from './wipe-breaker.ts';
import {installPiRootInventoryWiring} from './pi-root-inventory.ts';
import piPermissionGate from './drivers/pi-permission-gate.ts';
import {handleProjectRoute} from './project-routes.ts';
import {channelToProjectRows} from './project-settings.ts';
import {projectSettingsFor} from './project-records.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
let dir:string,store:Store,registry:RootRegistry,wiring:ReturnType<typeof installPiRootInventoryWiring>;
beforeEach(()=>{
 closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});database();
 dir=mkdtempSync(join(tmpdir(),'pi-producers-'));store=new Store(()=>({instanceId:'fixture',model:'model'}));registry=new RootRegistry();
});
afterEach(()=>{wiring?.dispose();vi.restoreAllMocks();flushCoalesced();closeDatabase();vi.unstubAllEnvs();delete (globalThis as Record<symbol,unknown>)[Symbol.for('murage.piGate')];removeTempDirSync(dir);});
function wire(options:Parameters<typeof installPiRootInventoryWiring>[2]={}){
 wiring=installPiRootInventoryWiring({bots:()=>store.bots,groups:()=>store.groups,groupRoots:id=>store.group(id)?.channelProject?(projectSettingsFor(database(),id)?.workRoots??[]).map(root=>root.path):[],onChange:fn=>store.onChange(fn)},registry,{path:join(dir,'inventory'),...options});
 return wiring;
}
function folder(name:string){const path=join(dir,name);mkdirSync(path,{recursive:true});return path;}
function assertPublished(before:number,root?:string,present=true){
 expect(wiring.stats.publications).toBeGreaterThan(before);
 const [header,...body]=readFileSync(wiring.inventoryPath(),'utf8').split('\n');expect(header).toContain(' R ');
 const roots=JSON.parse(body.join('\n'));expect(roots.slice().sort()).toEqual(registry.snapshot().slice().sort());
 if(root)expect(roots.includes(root)).toBe(present);
}
const bot=()=>store.createBot({name:'Fixture'},{seedMessages:false});
function projectGroup(botId:string){
 const group=store.createGroup('Fixture',[botId]);
 store.patchGroup(group.id,{channelProject:{goal:'Fixture',status:'active',startedAt:1,updatedAt:1}});
 channelToProjectRows(database(),{groupId:group.id,leadBotId:botId,now:1,bulletin:''});
 return group;
}
it('producer initial bot/task/group inventory publishes all retained roots',()=>{
 const b=bot(),a=folder('bot'),t=folder('task'),g=folder('group');store.patchBot(b.id,{cwd:a});store.patchTask(b.id,b.threadId,{cwd:t});
 const group=projectGroup(b.id);
 database().prepare('UPDATE project_settings SET work_roots=? WHERE group_id=?').run(JSON.stringify([{path:g}]),group.id);
 wire();assertPublished(0,a);expect(wiring.stats.publications).toBe(1);expect(registry.snapshot()).toEqual(expect.arrayContaining([a,t,g]));
});
it('producer package addition/full reset publishes once after the whole rebuild',()=>{
 const b=bot(),a=folder('package');const imported={...structuredClone(b),id:'fixture-imported',threadId:'fixture-imported-thread',tasks:[{...b.tasks![0]!,threadId:'fixture-imported-thread',cwd:a}],composio:false,browser:false,computer:'off' as const};
 wire();const before=wiring.stats.publications;store.preparePackageAddition([imported],[]).publish();assertPublished(before,a);expect(wiring.stats.publications-before).toBe(1);
});
it('producer bot creation publishes bot and task owners',()=>{wire();const before=wiring.stats.publications;const b=store.createBot({name:'Created'},{seedMessages:false});assertPublished(before,b.cwd!);expect(registry.rootForOwner(`bot:${b.id}:cwd`)).toBe(b.cwd);});
it('producer bot cwd change publishes',()=>{const b=bot();wire();const before=wiring.stats.publications;const a=folder('changed');store.patchBot(b.id,{cwd:a});assertPublished(before,a);});
it('producer replacement task list publishes additions and removals',()=>{
 const b=bot(),a=folder('old-task'),c=folder('new-task');store.pinTaskCwd(b.id,b.threadId,a);wire();const before=wiring.stats.publications;
 store.patchBot(b.id,{tasks:[{...b.tasks![0]!,cwd:c}]});assertPublished(before,c);expect(registry.snapshot()).not.toContain(a);
});
it.each(['pin','clear'] as const)('producer task cwd %s publishes',kind=>{
 const b=bot(),a=folder('pinned');if(kind==='clear')store.pinTaskCwd(b.id,b.threadId,a);wire();const before=wiring.stats.publications;
 store.pinTaskCwd(b.id,b.threadId,a,kind==='clear'?{none:true}:{});assertPublished(before,a,kind==='pin');
});
it.each([false,true])('producer task cwd patch publishes (committed error %s)',committedError=>{
 const b=bot(),a=folder('patched');wire();const before=wiring.stats.publications;
 if(committedError)vi.spyOn(store as unknown as {afterRosterSave:()=>void},'afterRosterSave').mockImplementationOnce(()=>{throw Error('fixture post commit');});
 const patch=()=>store.patchTask(b.id,b.threadId,{cwd:a});if(committedError)expect(patch).toThrow(RosterPostCommitError);else patch();assertPublished(before,a);
});
it('producer task creation publishes its root event',()=>{const b=bot();wire();const before=wiring.stats.publications;const task=store.createTask(b.id,'Created',true,undefined,undefined,{teamId:'fixture-team',createdAt:1})!;assertPublished(before,task.cwd!);expect(task).toBeTruthy();expect(task.cwd).toBeTruthy();});
it.each([false,true])('producer task deletion publishes (error reconciliation %s)',error=>{
 const b=bot(),a=folder('deleted');store.pinTaskCwd(b.id,b.threadId,a);const thread=b.threadId;store.createTask(b.id,'Retained');wire();const before=wiring.stats.publications;
 if(error)vi.spyOn(store as unknown as {afterRosterSave:()=>void},'afterRosterSave').mockImplementationOnce(()=>{throw Error('fixture deletion save');});
 const drop=()=>store.deleteTask(b.id,thread);if(error)expect(drop).toThrow(RosterPostCommitError);else drop();assertPublished(before,a,false);
});
it('producer bot deletion publishes once after dropping every task owner',()=>{
 const b=bot(),a=folder('deleted-bot');store.patchBot(b.id,{cwd:a});for(let i=0;i<4;i++){const t=store.createTask(b.id,'Task')!;store.pinTaskCwd(b.id,t.threadId,folder('task-'+i));}
 wire();const before=wiring.stats.publications;store.deleteBot(b.id);assertPublished(before,a,false);expect(wiring.stats.publications-before).toBe(1);expect(registry.snapshot()).toEqual([]);
});
it.each(['add','change','remove'] as const)('producer project work-root %s route publishes',kind=>{
 const b=bot(),group=projectGroup(b.id),a=folder('project-a'),c=folder('project-b');
 const call=(paths:string[])=>handleProjectRoute(database(),{origin:'desktop',method:'PUT',path:`/api/groups/${group.id}/project/work-roots`,query:new URLSearchParams(),body:{expectedRevision:projectSettingsFor(database(),group.id)!.revision,roots:paths.map(path=>({path}))},group,now:2,workRootsCommitted:(id,paths)=>store.workRootsCommitted(id,paths)});
 if(kind!=='add')expect(call([a])?.status).toBe(200);wire();const before=wiring.stats.publications;expect(call(kind==='remove'?[]:[kind==='add'?a:c])?.status).toBe(200);assertPublished(before,kind==='change'?c:a,kind!=='remove');
});
it('producer group deletion publishes removal',()=>{const b=bot(),group=projectGroup(b.id),a=folder('group');wire();store.workRootsCommitted(group.id,[a]);const before=wiring.stats.publications;store.deleteGroup(group.id);assertPublished(before,a,false);});
it('real producer live add/change/remove matches approved checker in one extension turn',async()=>{
 const b=bot(),a=folder('live-a'),c=folder('live-b');wire();const project=folder('cwd'),descriptor=join(dir,'context');writeFileSync(descriptor,JSON.stringify({context:{project},inventoryPath:wiring.inventoryPath()}));
 vi.stubEnv('MURAGE_PI_GATE','fixture-gate');vi.stubEnv('MURAGE_PI_NO_LIMITS','1');vi.stubEnv('MURAGE_PI_WIPE_CONTEXT_FILE',descriptor);
 const handlers=new Map<string,any>();piPermissionGate({on:(name:string,fn:any)=>handlers.set(name,fn)} as never);
 const call=async(command:string)=>(await handlers.get('tool_call')({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}}))?.block===true;
 expect(await call('echo fixture')).toBe(false);
 for(const [patch,paths] of [[a,[a]],[c,[a,c]],[null,[c]]] as const){store.patchTask(b.id,b.threadId,{cwd:patch});for(const path of paths){const command=`rm -rf "${path}"/*`;expect(await call(command)).toBe(wipeBreaker(command,{cwd:project,project,registry,platform:process.platform,env:process.env})!==null);}}
});

it('failed invalidation after a committed Store patch holds a warm offline extension',async()=>{
 const {writeFileAtomic}=await import('./atomic.ts');let reject=false;
 const b=bot(),a=folder('committed-root');
 wire({write:(path,data)=>{if(reject)throw Error('fixture invalidation denied');writeFileAtomic(path,data,{mode:0o600});}});
 const project=folder('cwd'),descriptor=join(dir,'context');writeFileSync(descriptor,JSON.stringify({context:{project},inventoryPath:wiring.inventoryPath()}));
 vi.stubEnv('MURAGE_PI_GATE','fixture-gate');vi.stubEnv('MURAGE_PI_NO_LIMITS','1');vi.stubEnv('MURAGE_PI_WIPE_CONTEXT_FILE',descriptor);
 const handlers=new Map<string,any>();piPermissionGate({on:(name:string,fn:any)=>handlers.set(name,fn)} as never);
 let runs=0;
 const call=async(command:string)=>{const result=await handlers.get('tool_call')({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}});if(!result?.block)runs++;return result?.block===true;};
 expect(await call('echo warm')).toBe(false);const before=runs;
 reject=true;store.patchTask(b.id,b.threadId,{cwd:a});
 expect(store.taskByThread(b.id,b.threadId)?.cwd).toBe(a); // Store swallowed the listener failure after commit.
 expect(await call(`rm -rf "${a}"/*`)).toBe(true);expect(runs).toBe(before);
 expect(await call('echo harmless')).toBe(true);expect(runs).toBe(before);
 reject=false;store.workRootsCommitted('unrelated',[]);
 assertPublished(1,a);expect(await call(`rm -rf "${a}"/*`)).toBe(true);
});
it('failed reset stays pending through unrelated events until the full project rebuild succeeds',()=>{
 const b=bot(),group=projectGroup(b.id),a=folder('retained-project');
 database().prepare('UPDATE project_settings SET work_roots=? WHERE group_id=?').run(JSON.stringify([{path:a}]),group.id);
 wire();const before=wiring.stats.publications;
 const real=projectSettingsFor; // Fault after bot/task reconstruction, before the project root.
 const groupLookup=vi.spyOn(store,'group').mockImplementation(id=>{if(id===group.id)throw Error('fixture project lookup');return undefined;});
 store.preparePackageAddition([],[]).publish();
 expect(readFileSync(wiring.inventoryPath(),'utf8')).toContain(' P ');
 store.workRootsCommitted('unrelated',[]);
 expect(wiring.stats.publications).toBe(before);expect(readFileSync(wiring.inventoryPath(),'utf8')).toContain(' P ');
 groupLookup.mockRestore();store.workRootsCommitted('unrelated',[]);
 assertPublished(before,a);expect(real(database(),group.id)?.workRoots.map(root=>root.path)).toContain(a);
});

it('failed invalidation and denied file revocation stop all execution consumers and fence launches',async()=>{
 const {writeFileAtomic}=await import('./atomic.ts');
 const {registerPiInventoryConsumer,assertPiInventoryAvailable}=await import('./pi-root-inventory.ts');
 let reject=false;const b=bot(),a=folder('committed-denied');
 wire({write:(path,data)=>{if(reject)throw Error('fixture invalidation denied');writeFileAtomic(path,data,{mode:0o600});}});
 const path=wiring.inventoryPath(),old=readFileSync(path,'utf8');
 const first=vi.fn(()=>{throw Error('fixture consumer callback');}),second=vi.fn();
 const releaseFirst=registerPiInventoryConsumer(first,path),releaseSecond=registerPiInventoryConsumer(second,path);
 const unlink=vi.spyOn(fs,'unlinkSync').mockImplementation(()=>{throw Error('fixture unlink denied');});
 try{
  reject=true;store.patchTask(b.id,b.threadId,{cwd:a});expect(store.taskByThread(b.id,b.threadId)?.cwd).toBe(a);
  expect(readFileSync(path,'utf8')).toBe(old); // Stale ready bytes really survive both failures.
  expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce();
  expect(()=>assertPiInventoryAvailable(path)).toThrow('wipe-root-inventory-unavailable');
  expect(()=>registerPiInventoryConsumer(vi.fn(),path)).toThrow('wipe-root-inventory-unavailable');
 }finally{unlink.mockRestore();releaseFirst();releaseSecond();}
 reject=false;store.workRootsCommitted('unrelated',[]);assertPublished(1,a);
 expect(()=>assertPiInventoryAvailable(path)).not.toThrow();
});
