// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: Store/registry authority — wipe-fable; inventory/reader witnesses — pi-roots-b.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DATA_DIR} from './config.ts';
import {closeDatabase,database} from './database.ts';
import {flushCoalesced} from './atomic.ts';
import {Store,RosterPostCommitError} from './store.ts';
import {handleProjectRoute} from './project-routes.ts';
import {channelToProjectRows} from './project-settings.ts';
import {projectSettingsFor} from './project-records.ts';
import {readFileSync} from 'node:fs';
import {RootRegistry} from './wipe/registry.ts';
import {installWipeRootWiring,type WipeRootPort} from './wipe/root-wiring.ts';
import {wipeBreaker} from './wipe-breaker.ts';
import piPermissionGate from './drivers/pi-permission-gate.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
let dir:string,store:Store,dispose:()=>void=()=>{};
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});database();dir=mkdtempSync(join(tmpdir(),'pi-baseline-'));store=new Store(()=>({instanceId:'fixture',model:'model'}));});
afterEach(()=>{vi.useRealTimers();dispose();vi.restoreAllMocks();flushCoalesced();closeDatabase();vi.unstubAllEnvs();delete (globalThis as Record<symbol,unknown>)[Symbol.for('murage.piGate')];removeTempDirSync(dir);});
async function attach(port:WipeRootPort,registry:RootRegistry,path:string){
 const publisher=new URL('./pi-root-inventory.ts',import.meta.url);
 if(existsSync(publisher))dispose=(await import(publisher.href)).installPiRootInventoryWiring(port,registry,{path}).dispose;
 else dispose=installWipeRootWiring(port,registry);
}
function assertInventory(path:string,registry:RootRegistry){
 expect(existsSync(path)).toBe(true);
 const [header,...body]=readFileSync(path,'utf8').split('\n');expect(header).toContain(' R ');
 expect(JSON.parse(body.join('\n')).sort()).toEqual(registry.snapshot().slice().sort());
}
it.each(['add','change','remove'] as const)('real Store independent baseline %s reaches its own verdict',async kind=>{
 const project=join(dir,'cwd'),a=join(dir,'a'),b=join(dir,'b');for(const path of [project,a,b])mkdirSync(path);
 const bot=store.createBot({name:'Fixture'},{seedMessages:false});
 if(kind!=='add')store.patchTask(bot.id,bot.threadId,{cwd:a});
 const registry=new RootRegistry(),path=join(dir,'inventory');
 const port:WipeRootPort={bots:()=>store.bots,groups:()=>store.groups,groupRoots:()=>[],onChange:fn=>store.onChange(fn)};
 // Compatibility setup only: the original checkout has the actual root wiring
 // and launch snapshot transport, but no publisher module. No policy is copied.
 await attach(port,registry,path);
 const descriptor=join(dir,'context');writeFileSync(descriptor,JSON.stringify({context:{project},roots:registry.snapshot(),inventoryPath:path}));
 vi.stubEnv('MURAGE_PI_GATE','fixture-gate');vi.stubEnv('MURAGE_PI_NO_LIMITS','1');vi.stubEnv('MURAGE_PI_WIPE_CONTEXT_FILE',descriptor);
 const handlers=new Map<string,any>();piPermissionGate({on:(name:string,fn:any)=>handlers.set(name,fn)} as never);
 const call=async(command:string)=>(await handlers.get('tool_call')({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}}))?.block===true;
 const command=(root:string)=>`rm -rf "${root}"/*`;
 expect(await call('echo warm')).toBe(false);expect(await call(command(a))).toBe(kind!=='add');
 store.patchTask(bot.id,bot.threadId,{cwd:kind==='remove'?null:kind==='add'?a:b});
 const target=kind==='change'?b:a,text=command(target);
 const approved=wipeBreaker(text,{cwd:project,project,registry,platform:process.platform,env:process.env})!==null;
 expect(approved).toBe(kind!=='remove');expect(await call(text)).toBe(approved);
 if(kind==='change')expect(await call(command(a))).toBe(false);
});

const producerPaths=['initial','package reset','bot creation','bot cwd','task list','pin','clear','patch','committed patch','create task','delete task','reconciled deletion','delete bot','project add','project change','project remove','delete group'] as const;
it.each(producerPaths)('real Store baseline publication reaches %s',async kind=>{
 const a=join(dir,'root-a'),b=join(dir,'root-b');mkdirSync(a);mkdirSync(b);
 const bot=store.createBot({name:'Fixture'},{seedMessages:false});if(kind!=='pin')store.pinTaskCwd(bot.id,bot.threadId,a);
 const group=store.createGroup('Fixture',[bot.id]);
 store.patchGroup(group.id,{channelProject:{goal:'Fixture',status:'active',startedAt:1,updatedAt:1}});
 channelToProjectRows(database(),{groupId:group.id,leadBotId:bot.id,now:1,bulletin:''});
 database().prepare('UPDATE project_settings SET work_roots=? WHERE group_id=?').run(JSON.stringify([{path:a}]),group.id);
 const registry=new RootRegistry(),path=join(dir,'inventory');
 await attach({bots:()=>store.bots,groups:()=>store.groups,groupRoots:id=>store.group(id)?.channelProject?(projectSettingsFor(database(),id)?.workRoots??[]).map(root=>root.path):[],onChange:fn=>store.onChange(fn)},registry,path);
 switch(kind){
 case 'initial':expect(registry.snapshot()).toContain(a);break;
 case 'package reset':store.preparePackageAddition([],[]).publish();break;
 case 'bot creation':expect(store.createBot({name:'Created'},{seedMessages:false})).toBeTruthy();break;
 case 'bot cwd':store.patchBot(bot.id,{cwd:b});expect(registry.rootForOwner(`bot:${bot.id}:cwd`)).toBe(b);break;
 case 'task list':store.patchBot(bot.id,{tasks:[{...bot.tasks![0]!,cwd:b}]});expect(registry.rootForOwner(`task:${bot.id}:${bot.threadId}:cwd`)).toBe(b);break;
 case 'pin':store.pinTaskCwd(bot.id,bot.threadId,b);expect(store.taskByThread(bot.id,bot.threadId)?.cwd).toBe(b);break;
 case 'clear':store.pinTaskCwd(bot.id,bot.threadId,a,{none:true});expect(registry.rootForOwner(`task:${bot.id}:${bot.threadId}:cwd`)).toBeUndefined();break;
 case 'patch':store.patchTask(bot.id,bot.threadId,{cwd:b});expect(registry.rootForOwner(`task:${bot.id}:${bot.threadId}:cwd`)).toBe(b);break;
 case 'committed patch':vi.spyOn(store as unknown as {afterRosterSave:()=>void},'afterRosterSave').mockImplementationOnce(()=>{throw Error('fixture committed fault');});expect(()=>store.patchTask(bot.id,bot.threadId,{cwd:b})).toThrow(RosterPostCommitError);expect(registry.rootForOwner(`task:${bot.id}:${bot.threadId}:cwd`)).toBe(b);break;
 case 'create task':expect(store.createTask(bot.id,'Created',true,undefined,undefined,{teamId:'fixture',createdAt:1})?.cwd).toBeTruthy();break;
 case 'delete task':case 'reconciled deletion':{
  const thread=bot.threadId;store.createTask(bot.id,'Retained');
  if(kind==='reconciled deletion')vi.spyOn(store as unknown as {afterRosterSave:()=>void},'afterRosterSave').mockImplementationOnce(()=>{throw Error('fixture delete fault');});
  if(kind==='reconciled deletion')expect(()=>store.deleteTask(bot.id,thread)).toThrow(RosterPostCommitError);else store.deleteTask(bot.id,thread);
  expect(registry.rootForOwner(`task:${bot.id}:${thread}:cwd`)).toBeUndefined();break;
 }
 case 'delete bot':store.deleteBot(bot.id);expect(registry.rootForOwner(`task:${bot.id}:${bot.threadId}:cwd`)).toBeUndefined();break;
 case 'project add':case 'project change':case 'project remove':{
  const roots=kind==='project remove'?[]:kind==='project add'?[a,b]:[b];
  const result=handleProjectRoute(database(),{origin:'desktop',method:'PUT',path:`/api/groups/${group.id}/project/work-roots`,query:new URLSearchParams(),body:{expectedRevision:projectSettingsFor(database(),group.id)!.revision,roots:roots.map(path=>({path}))},group,now:2,workRootsCommitted:(id,paths)=>store.workRootsCommitted(id,paths)});
  expect(result?.status).toBe(200);expect(registry.rootForOwner(`group:${group.id}`)).toBe(roots[0]);break;
 }
 case 'delete group':store.deleteGroup(group.id);expect(registry.rootForOwner(`group:${group.id}`)).toBeUndefined();break;
 }
 assertInventory(path,registry);
});
it.each(['explicit','timer'] as const)('baseline publication reaches completed %s build retry',async kind=>{
 vi.useFakeTimers();let fail=true;
 const registry=new RootRegistry(),path=join(dir,'inventory');
 await attach({bots:()=>{if(fail)throw Error('fixture build fault');return[];},groups:()=>[],groupRoots:()=>[],onChange:()=>()=>{}},registry,path);
 fail=false;if(kind==='timer')await vi.advanceTimersByTimeAsync(60_000);else registry.retryBuild();
 expect(registry.snapshot()).toEqual([]);assertInventory(path,registry);
});
