// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { RootRegistry } from './registry.ts';
import { installWipeRootWiring } from './root-wiring.ts';
import { wipeBreaker } from '../wipe-breaker.ts';

it.each(['EACCES','EPERM','EIO','ETIMEDOUT'])('one %s owner preserves every lexical root and the one-time build',code=>{
 let builds=0,probes=0;
 const registry=new RootRegistry({realpath(p){probes++;if(p.includes('unreadable'))throw Object.assign(Error('fixture'),{code});return p.replace('/logical/','/physical/');},isBlockDevice:()=>null});
 const remove=installWipeRootWiring({bots(){builds++;return [{id:'fixture',cwd:'/logical/unreadable',tasks:[{threadId:'blocked',cwd:'/logical/unreadable-task'},{threadId:'healthy',cwd:'/logical/healthy-task'}]},{id:'other',cwd:'/logical/healthy'}];},groups:()=>[{id:'room'}],groupRoots:()=>['/logical/room'],onChange:()=>()=>{}},registry);
 const initial=probes;
 const ctx={registry,home:'/home/fixture',project:'/work/project',cwd:'/work/project',dataDir:'/state/app',pathPort:{realpath:(p:string)=>p,isBlockDevice:()=>null}};
 for(let i=0;i<10;i++){
  for(const path of ['/logical/unreadable','/logical/unreadable-task','/logical/healthy-task','/physical/healthy-task','/logical/healthy','/physical/healthy','/logical/room','/physical/room'])expect(wipeBreaker('rm -rf '+path,ctx),path).toBeTruthy();
  expect(wipeBreaker('rm -rf /scratch/ordinary',ctx)).toBeNull();
 }
 expect(builds).toBe(1);expect(probes).toBe(initial);
 registry.replace('bot:fixture:cwd',['/logical/next']);expect(registry.containsRoot('/logical/next')).toBe(true);expect(registry.containsRoot('/logical/unreadable')).toBe(false);
 registry.dropBot('fixture');expect(registry.containsRoot('/logical/unreadable-task')).toBe(false);expect(registry.containsRoot('/logical/healthy')).toBe(true);remove();
});
