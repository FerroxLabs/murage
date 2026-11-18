// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { wipeBreaker,nativeWipeBreaker } from '../wipe-breaker.ts';
const ctx={home:'/home/fixture',cwd:'/work/project',project:'/work/project',dataDir:'/state/app',mountInventory:{contains:()=>false}};
it.each([['darwin','/usr/local'],['linux','/srv/subvolume']] as const)('%s device change at %s alone is ordinary', (platform,path)=>{
 const pathPort={realpath:(p:string)=>p,isBlockDevice:()=>null,stat:(p:string)=>({dev:p===path?2:1,ino:1}),lstat:(p:string)=>({dev:p===path?2:1,ino:1,isSymbolicLink:()=>false}),mountId:()=> 'same'};
 expect(wipeBreaker('rm -rf '+path,{...ctx,platform,pathPort})).toBeNull();
 expect(wipeBreaker('rm -rf /usr',{...ctx,platform,pathPort})).toBeTruthy();
});
it('a native move of a final symlink does not classify its cross-volume referent',()=>{
 let follows=0;
 const pathPort={realpath(){follows++;return '/srv/volume';},isBlockDevice:()=>null,stat:()=>({dev:2,ino:1}),lstat:()=>({dev:1,ino:2,isSymbolicLink:()=>true}),mountId:(p:string)=>p==='/scratch/link'?'volume':'parent'};
 const mountInventory={contains:(p:string)=>p==='/srv/volume'};
 expect(nativeWipeBreaker('move_file',{source:'/scratch/link',destination:'/scratch/away'},{...ctx,pathPort,mountInventory})).toBeNull();
 expect(follows).toBe(0);
 expect(wipeBreaker('rm -rf /scratch/link/',{...ctx,pathPort,mountInventory})).toBeTruthy();
});
