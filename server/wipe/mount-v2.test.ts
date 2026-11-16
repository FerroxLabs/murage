// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { RootRegistry } from './registry.ts';
import { wipeBreaker } from '../wipe-breaker.ts';
const base={home:'/home/u',cwd:'/work/project',project:'/work/project',dataDir:'/home/u/.murage',platform:'linux' as const};
it.each([
 ['K1','/srv/volume',true],['K2','/srv',true],['K3','/mnt/scratch',false],['K4','/Volumes/Backup',true],['H3-tmpfs','/tmp',true],['H3-bind','/srv/bind',true],['H3-removed','/mnt/removed',false],
] as const)('%s actual mount inventory, including bind and virtual filesystems',(id,path,card)=>{
 const paths=['/srv/volume','/srv/bind','/Volumes/Backup','/tmp'];
 const mountInventory={contains:(p:string)=>paths.some(root=>root===p||root.startsWith(p+'/')),add:()=>{}};
 const pathPort={realpath:(p:string)=>p,isBlockDevice:()=>null,lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),stat:(p:string)=>({dev:p==='/srv/volume'||p==='/tmp'?2:1,ino:1}),statfs:()=>({type:0x01021994})};
 expect(!!wipeBreaker('rm -rf '+path,{...base,pathPort,mountInventory} as any),id).toBe(card);
});
it('K6 mount pathname fallback is reserved for filesystem errors',()=>{
 const pathPort={realpath(){throw Object.assign(Error('fixture'),{code:'EACCES'});},isBlockDevice:()=>null,stat(){throw Object.assign(Error('fixture'),{code:'EACCES'});}};
 // MAIN RULING 23:15Z(d), WIPE-V3 S8: a pathname plus probe failure cannot invent a mount.
 expect(wipeBreaker('rm -rf /mnt/data',{...base,pathPort,mountInventory:{contains:()=>false}} as any)).toBeNull();
});
it('K7 H3 new same-device bind mounts are detected before inventory refresh',()=>{
 let adds=0;const pathPort={realpath:(p:string)=>p,isBlockDevice:()=>null,lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),stat:()=>({dev:1,ino:1}),mountId:(p:string)=>p==='/srv/new'?'new':'parent'};
 const mountInventory={contains:()=>false,add:()=>{adds++;}};
 expect(wipeBreaker('rm -rf /srv/new',{...base,pathPort,mountInventory})?.rule).toBe('delete-root');expect(adds).toBe(1);
});
it('K8 P-6 ordinary admissions never refresh the mount inventory',()=>{
 let refreshes=0;const pathPort={realpath:(p:string)=>p,isBlockDevice:()=>null,lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),stat:()=>({dev:1,ino:1}),mountId:()=> 'same'};
 const mountInventory={contains:()=>false,add:()=>{refreshes++;}};
 for(let i=0;i<1000;i++)expect(wipeBreaker('rm -rf /scratch/ordinary',{...base,pathPort,mountInventory})).toBeNull();expect(refreshes).toBe(0);
});
it('H3 removed exact mounts leave the index on a fresh equality check',()=>{
 let present=true;const pathPort={realpath:(p:string)=>p,isBlockDevice:()=>null,lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),stat:()=>({dev:1,ino:1}),mountId:()=> 'same'};
 const mountInventory={has:()=>present,contains:()=>present,drop:()=>{present=false;}};
 expect(wipeBreaker('rm -rf /mnt/removed',{...base,pathPort,mountInventory})).toBeNull();expect(present).toBe(false);
});
it('K9 a realpath-only failure does not invent a pathname mount',()=>{
 const pathPort={realpath(){throw Object.assign(Error('fixture'),{code:'EACCES'});},lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),stat:()=>({dev:1,ino:1}),isBlockDevice:()=>null};
 expect(wipeBreaker('rm -rf /mnt/scratch',{...base,pathPort,mountInventory:{contains:()=>false}})).toBeNull();
});
it('K7-count registry exposes mount refresh work with resettable counters',()=>{
 const counts={mountRefreshes:1},registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>null},counts);
 counts.mountRefreshes++;expect(registry.stats.mountRefreshes).toBe(1);registry.resetStats();expect(registry.stats.mountRefreshes).toBe(0);counts.mountRefreshes++;expect(registry.stats.mountRefreshes).toBe(1);
});
