// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER checker and recovery seams: wipe-v3. OWNER fault acceptance: wipe-v3-tests.
import {expect,vi} from 'vitest';
import {wipeBreaker} from '../wipe-breaker.ts';
import {BoundedPathPort} from './roots.ts';
import {MountInventory,mountedRoots} from './mounts.ts';
import {RootRegistry} from './registry.ts';
import * as expansion from './expand.ts';
import * as invocation from './invocation.ts';
import * as recovery from './evidence.ts';
import {installWipeContextReader} from './context.ts';
import {autoVerdict} from '../auto-approve.ts';
import {known,type ShellState} from './types.ts';
import {corpusContext,fixturePathPort,linuxContext} from './corpus/v3-context.fixture.ts';
import {aliasPort,nested,probeWorkerSource,type ConfirmPort} from './corpus/v3-faults.fixture.ts';
const deadline=150;
const state=():ShellState=>({home:'/home/u',env:new Map([['HOME','/home/u']]),cwd:known('/work/project/pkg'),dialect:'sh',depth:0});
export async function hungFilesystemScenario(){
 const port=new BoundedPathPort({source:probeWorkerSource,timeoutMs:deadline});
 const hadHungMount=mountedRoots.has('/hung');
 try{
  // Establish the worker before timing a request; startup is not a filesystem deadline.
  expect(port.realpath('/ready/path')).toBe('/ready/path');
  mountedRoots.add('/hung'); // Six paths share this fixture filesystem key.
  for(const [i,path] of ['a','b','c','d','e','f'].entries()){
   const start=performance.now();expect.soft(()=>port.realpath('/hung/'+path)).toThrow();
   expect.soft(performance.now()-start).toBeLessThan(i===0?deadline+75:50);
  }
  expect.soft(wipeBreaker('rm -rf /scratch/home-link/*',linuxContext({pathPort:port}))?.rule).toBe('delete-home');
  // One initial hung filesystem + fifteen independent keys consumes the cap of 16.
  for(let i=0;i<15;i++){
   const start=performance.now();expect.soft(()=>port.realpath('/stalled/key-'+i+'/path')).toThrow(/timeout/);
   expect.soft(performance.now()-start).toBeLessThan(deadline+75);
  }
  const start=performance.now();expect(()=>port.realpath('/stalled/key-16/path')).toThrow();
  expect.soft(performance.now()-start).toBeLessThan(50);
  expect.soft(wipeBreaker('rm -rf /',linuxContext({pathPort:port}))?.rule).toBe('delete-root');
  expect.soft(wipeBreaker('ls',linuxContext({pathPort:port}))).toBeNull();
 }finally{if(!hadHungMount)mountedRoots.drop('/hung');await port.close();}
}
export function mountQueryFailureScenario(){
 for(const kind of ['throw','timeout']){
  let realpaths=0;
  const port:ConfirmPort={...aliasPort,realpath:p=>{realpaths++;return aliasPort.realpath(p);},mountId:()=>{throw Error('mount-'+kind);},confirmMount:()=>{throw Error('mount-'+kind);}};
  expect.soft(wipeBreaker('rm -rf /scratch/home-link/*',linuxContext({pathPort:port,mountInventory:{contains:()=>false}}))?.rule,kind).toBe('delete-home');
  expect.soft(realpaths,kind+' must retain independent physical resolution').toBeGreaterThan(0);
 }
}
export function freshMountScenario(){
 for(const platform of ['darwin','win32'] as const)for(const outcome of ['yes','no','timeout'] as const){
  let confirms=0;
  const target=platform==='darwin'?outcome==='no'?'/usr/local':'/Volumes/Backup':outcome==='no'?'D:\\ordinary':'D:\\Backup';
  const port:ConfirmPort={...fixturePathPort,
   lstat:p=>({dev:p===target?2:1,ino:p,isSymbolicLink:()=>false}),
   stat:p=>({dev:p===target?2:1,ino:p,isSymbolicLink:()=>false}),
   confirmMount:p=>{confirms++;if(outcome==='timeout')throw Error('wipe-mount-probe-timeout');return p===target&&outcome==='yes';},
  };
  const inventory=new MountInventory(()=>[]);inventory.refresh();
  const ctx=corpusContext({platform,dialect:platform==='win32'?'pwsh':'sh',cwd:platform==='win32'?'C:\\scratch':'/work/project/pkg'},{pathPort:port,mountInventory:inventory});
  const hit=wipeBreaker(platform==='win32'?`Remove-Item -Recurse '${target}'`:`rm -rf ${target}`,ctx);
  expect.soft(hit?.rule??null,platform+' '+outcome).toBe(outcome==='no'?null:'delete-root');
  expect.soft(confirms,platform+' '+outcome).toBe(1);
 }
}
export function registryFaultScenario(){
 const registry=new RootRegistry({...fixturePathPort,realpath:p=>{if(p==='/work/denied')throw Object.assign(Error('denied'),{code:'EACCES'});return p;}});
 registry.replace('bad-owner',['/work/denied']);registry.replace('good-owner',['/work/healthy']);
 expect.soft(wipeBreaker('rm -rf /work/healthy',linuxContext({registry}))?.rule).toBe('delete-system-folder');
 expect.soft(()=>registry.contains('/work/denied')).not.toThrow();
 expect.soft(registry.contains('/work/denied')).toBe(true);
 let initializations=0;registry.lazyBuild(()=>{initializations++;throw Error('fixture-build');});
 let throws=0;for(let i=0;i<1000;i++)try{registry.contains('/work/healthy');}catch{throws++;}
 expect.soft(throws).toBe(0);expect.soft(initializations).toBe(1);
}
export function walkerFaultScenario(){
 // Both versions expose expandWord; S2 adds expandWords. Inject where the active walker resolves words.
 const key='expandWords' in expansion?'expandWords':'expandWord';
 const mod=expansion as unknown as Record<string,(...args:any[])=>any>;
 const original=mod[key]!;let injected=0;
 vi.spyOn(mod,key).mockImplementation((...args:any[])=>{if(args[0]?.raw==='fixture_throw'){injected++;throw Error('fixture-statement');}return original(...args);});
 expect.soft(wipeBreaker('ls; fixture_throw; rm -rf /home',linuxContext())?.rule).toBe('delete-home');
 expect.soft(wipeBreaker('ls; fixture_throw',linuxContext())).toBeNull();
 expect.soft(injected).toBeGreaterThanOrEqual(2);
 vi.restoreAllMocks();
 expect.soft(wipeBreaker(nested('ls'),linuxContext())).toBeNull();
 expect.soft(wipeBreaker(nested('rm -rf /'),linuxContext())?.rule).toBe('delete-root');
}
export function tolerantFaultScenario(){
 let seed=0x5eed,throws=0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const tokens=['a',' ',';',"'",'"','$(','<<EOF\n','\0','`','&','|','(',')','\\'];
 for(let i=0;i<10000;i++){
  let source='';for(let j=0,n=1+random()%32;j<n;j++)source+=tokens[random()%tokens.length];
  if(i%997===0)source+='x'.repeat(64*1024);
  try{recovery.evidenceScan(source,state());}catch{throws++;}
 }
 expect.soft(throws).toBe(0);
 const start=performance.now();let largeError=false;
 try{recovery.evidenceScan('x'.repeat(1024*1024),state());}catch{largeError=true;}
 expect.soft(largeError).toBe(false);expect.soft(performance.now()-start).toBeLessThan(200);
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('fixture-parser');});
 vi.spyOn(recovery,'evidenceScan').mockImplementation(()=>{throw Error('fixture-scanner');});
 expect.soft(wipeBreaker('rm -rf /home',linuxContext())?.rule).toBe('wipe-check-fault');
 expect.soft(wipeBreaker('ls',linuxContext())).toBeNull();
 expect.soft(wipeBreaker(undefined as unknown as string,linuxContext())?.rule).toBe('wipe-check-fault');
}
export function contextFaultScenario(){
 const undo=installWipeContextReader(()=>{throw Error('fixture-reader');});
 const bot={autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
 try{
  for(const [command,rule]of [['rm -rf .','delete-system-folder'],['ls',null]] as const){
   let verdict:ReturnType<typeof autoVerdict>|undefined,error=false;
   try{verdict=autoVerdict(bot,'Bash',command,{ownerStarted:true,fullAccessOrigin:'owner',commandText:command,commandCwd:'/work/project',workFolder:'/work/project',wipeThreadId:'fixture-thread',wipeBotId:'fixture-bot'});}catch{error=true;}
   expect.soft(error,command).toBe(false);
   if(rule){expect.soft(verdict?.approve).toBeNull();expect.soft(verdict?.rule).toBe(rule);}
   else {expect.soft(verdict?.approve).toEqual(expect.any(String));expect.soft(verdict?.source).toBe('no-limits');}
  }
 }finally{undo();}
}
export function executionDriveScenario(){
 const ctx=corpusContext({platform:'win32',dialect:'pwsh',cwd:'C:\\scratch'},{project:'D:\\work\\project',registry:{contains:p=>p.toLowerCase().replace(/\\/g,'/')==='d:/work/project'}});
 expect.soft(wipeBreaker("Set-Location D:\\scratch; Remove-Item -Recurse '\\work\\project'",ctx)?.rule).toBe('delete-system-folder');
 expect.soft(wipeBreaker('cd /d D:\\scratch & rd /s /q \\work\\project',{...ctx,dialect:'cmd'})?.rule).toBe('delete-system-folder');
 expect.soft(wipeBreaker("Remove-Item -Recurse '\\\\share\\ordinary'",ctx)?.rule).toBe('delete-root');
 expect.soft(wipeBreaker("Remove-Item -Recurse '\\\\share\\ordinary\\cache'",ctx)).toBeNull();
}
