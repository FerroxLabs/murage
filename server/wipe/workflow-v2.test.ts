// SPDX-License-Identifier: AGPL-3.0-or-later
// Real decision admission and release, inert transport, isolated DATA_DIR.
import {expect,it} from 'vitest';
import {decideFixture,releaseFixture} from './red/fixture-support.ts';
import {installWipeContextReader} from './context.ts';
import type {WipeContext} from './types.ts';
const context:WipeContext={cwd:'/work/project',project:'/work/project',home:'/home/u',dataDir:'/home/u/.murage',env:{HOME:'/home/u'},pathPort:{realpath:p=>p,isBlockDevice:()=>null}};
const windows:WipeContext={...context,home:'C:\\Users\\u',cwd:'C:\\Users\\u\\proj',project:'C:\\Users\\u\\proj',platform:'win32'};
const link:WipeContext={...context,pathPort:{realpath:p=>p.endsWith('link-home')?'/home/u':p,lstat:p=>({dev:1,ino:2,isSymbolicLink:()=>p.endsWith('link-home')}),isBlockDevice:()=>null}};
// The mount classifier requires mount evidence; a device-number change alone is not a mount.
const mount:WipeContext={...context,mountInventory:{contains:p=>p==='/srv/volume'},pathPort:{realpath:p=>p,isBlockDevice:()=>null,lstat:p=>({dev:p==='/srv/volume'?2:1,ino:2,isSymbolicLink:()=>false}),stat:p=>({dev:p==='/srv/volume'?2:1,ino:2})}};
it.each([
 ['T1','Bash',{command:'rm -rf /'},true,context],['T7','Bash',{command:'rm -rf /work/project'},true,context],
 ['M16','Bash',{command:'mv -t /work/project ./a'},false,context],['W24','Bash',{command:"find /work/project -name '*' -delete"},true,context],
 ['S1','Bash',{command:'(cd /tmp && true); rm -rf .'},true,context],['P16','Bash',{command:'Rename-Item C:\\Users\\u old'},true,windows],
 ['P22','Bash',{command:'Get-Item C:\\Users\\u | Remove-Item -Recurse'},true,windows],
 ['X14','delete_directory',{path:'/work/project',recursive:false},false,context],['X18','purge_folder',{path:'/home/u'},true,context],
 ['L1','Bash',{command:'rm -rf /work/project/link-home'},false,link],['K1','Bash',{command:'rm -rf /srv/volume'},true,mount],['K3','Bash',{command:'rm -rf /mnt/scratch'},false,mount],
 ['N-1a','Bash',{command:'rm -rf /'},true,context],['N-1b','Bash',{command:'rm -rf ~'},true,context],['N-1c','Bash',{command:':(){ :|:& };:'},true,context],
 ['N-1d','Bash',{command:'dd if=/dev/zero of=/dev/sda'},true,context],['N-1e','Bash',{command:'mkfs.ext4 /dev/sda1'},true,context],
 ['N-1f','Bash',{command:'Remove-Item -Recurse -Force C:\\'},true,windows],['N-1g','Bash',{command:'Format-Volume -DriveLetter C'},true,windows],['N-1h','Bash',{command:'Clear-Disk -Number 0 -RemoveData'},true,windows],['N-1i','Bash',{command:'bash ./b.sh; rm -rf /'},true,context],
] as const)('FIXTURE %s admission and fresh release',async(id,tool,input,card,ctx)=>{
 const undo=installWipeContextReader(()=>ctx);
 try{
  expect(decideFixture(tool,input,{context:ctx}).kind,id+' admission').toBe(card?'card':'run');
  const initial=card?(tool==='Bash'?{command:'echo fixture'}:{path:'/tmp/fixture-child'}):input;
  const release=await releaseFixture(tool,initial,input,ctx);
  expect(release.first,id+' initial safe admission').toBe('run');expect(release.released,id+' release').toBe(!card);
 }finally{undo();}
});
