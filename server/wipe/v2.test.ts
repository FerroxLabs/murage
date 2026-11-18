// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { RootRegistry } from './registry.ts';
import { wipeBreaker,nativeEffectsWipe } from '../wipe-breaker.ts';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { decideFixture,releaseFixture } from './red/fixture-support.ts';
import { MountInventory } from './mounts.ts';
const ctx={cwd:'/work/project',project:'/work/project',home:'/home/u',dataDir:'/home/u/.murage',platform:'linux' as const,env:{HOME:'/home/u'},registry:{contains:(p:string)=>p==='/work/other'},pathPort:{realpath:(p:string)=>p,isBlockDevice:()=>null},mountInventory:new MountInventory(()=>[])};
const win={...ctx,cwd:'C:\\Users\\u\\proj',project:'C:\\Users\\u\\proj',home:'C:\\Users\\u',platform:'win32' as const,env:{HOME:'C:\\Users\\u',USERPROFILE:'C:\\Users\\u'},dialect:'pwsh' as const};
it.each([
 ['M15','rm -Q /work/project',false],['M16','mv -t /work/project ./a',false],['M17','mv -Q -t /work/project ./a',false],['M18','mv -Q ./a /work/project',false],['M19','mv -Q /work/project ./a',true],
 ['Y9','rsync -a --delete ./e/ ~/ -e ssh',true],['Y10','rsync -Q -a --delete /work/project /tmp/out',false],
 ['W24',"find /work/project -name '*' -delete",true],['W25',"find . -name cache -exec rm -rf /work/other \\;",true],
 ['W26','find ~ ! -name keep -delete',true],
 // MAIN RULING R2: each disjunction branch guards its own action; both positive name filters restrict deletion.
 ['W27',"find ~ -name '*.tmp' -o -name '*.bak' -delete",false],['W28',"find /work/project -regex '.*' -delete",true],['W29',"find /work/project -name '*.o' -exec rm -f {} +",false],
 ['H2-root','find /work/project -name project -exec rm -rf {} +',true],
 ['S1','(cd /tmp); rm -rf *',true],['S1b','(cd /tmp && true); rm -rf *',true],['S6b','env -C /tmp rm -rf .',false],['S2','(cd /tmp && rm -rf *)',false],['S4','cd /tmp | true; rm -rf *',true],
 ['S8','cat <<EOF\n$(rm -rf ~)\nEOF',true],['S9',"cat <<'EOF'\n$(rm -rf ~)\nEOF",false],['S10','cd /tmp/nonexist; rm -rf *',true],['S11','cd /tmp/x && rm -rf *',false],['S12','cd /tmp/x || exit 1; rm -rf *',false],
 ['H4-candidates','cd /tmp/a; cd /tmp/b; cd /tmp/c; cd /tmp/d; cd /tmp/e; rm -rf .',true],['H4-background','cd /tmp & rm -rf .',true],
 ['H5-rsync-short','rsync -an --delete ./empty/ /work/project/',false],['H5-rsync-long','rsync -a --dry-run --delete ./empty/ /work/project/',false],
 ['D13','Initialize-Disk -Number 1',false],['D14','diskutil partitionDisk disk2 GPT APFS X 0',true],['T35','rm -f /etc',false],
 ['L9','rm -rf ∕home∕u',false],
] as const)('%s %s',(id,text,card)=>expect(!!wipeBreaker(text,ctx),id).toBe(card));
it.each([
 ['P16','Rename-Item C:\\Users\\u old-u',true],['P17','Rename-Item .\\a.txt b.txt',false],
 ['P18','Remove-Item -Recurse -Path C:\\tmp\\x,C:\\Users',true],['P19',"Remove-Item -Recurse -Path 'C:\\tmp\\x,C:\\Users'",false],
 ['P20','Remove-Item -Recurse -LiteralPath C:\\Users\\u\\*',false],['P21','Remove-Item -Recurse -Path C:\\Users\\u\\*',true],
 ['P22','Get-Item C:\\Users\\u | Remove-Item -Recurse -Force',true],['P23','Get-Item .\\build | Remove-Item -Recurse',false],['P24','Move-Item -Path C:\\a,C:\\Users\\u -Destination D:\\x',true],
 ['H5-whatif','Remove-Item C:\\Users\\u -Recurse -WhatIf',false],['H5-whatif-false','Remove-Item C:\\Users\\u -Recurse -WhatIf:$false',true],
] as const)('%s %s',(id,text,card)=>expect(!!wipeBreaker(text,win),id).toBe(card));
it('C10 cmd rename moves the source root',()=>expect(wipeBreaker('ren C:\\Users\\u old',{...win,dialect:'cmd'})).toBeTruthy());
it.each(['echo hi','echo "rm -rf /"','rm /','mv ./a /work/project','rm -rf ~'])('N11 depth 17 %s',(leaf)=>{
 let text=leaf;for(let i=0;i<17;i++)text=`bash <<E${i}\n${text}\nE${i}`;
 expect(wipeBreaker(text,ctx)?.rule??null).toBe(leaf==='rm -rf ~'?'delete-home':null);
});
it('F2 target filesystem faults use lexical evidence',()=>{
 const pathPort={realpath(){throw Error('fixture');},isBlockDevice:()=>null};
 expect(wipeBreaker('rm -rf /tmp/x',{...ctx,pathPort})).toBeNull();
 expect(wipeBreaker('rm -rf /',{...ctx,pathPort})?.rule).toBe('delete-root');
});
it('F3 readable 65 MiB command runs without a size gate',()=>expect(wipeBreaker('echo '+ ' '.repeat(65*1024*1024),ctx)).toBeNull());
it('F3b a wipe after 65 MiB remains visible',()=>expect(wipeBreaker(' '.repeat(65*1024*1024)+'rm -rf ~',ctx)?.rule).toBe('delete-home'));
it.each([
 ['L1','rm -rf /work/project/link-home',false],['L2','rm -rf /work/project/link-home/',true],['L3','rm -rf /work/project/link-home/*',true],['L4','mv /work/project/link-home /tmp/o',false],
] as const)('%s symlink operation follows only when required',(id,text,card)=>{
 const pathPort={realpath:(p:string)=>p.startsWith('/work/project/link-home')?'/home/u':p,isBlockDevice:()=>null,lstat:(p:string)=>({dev:1,ino:2,isSymbolicLink:()=>p.replace(/\/$/,'')==='/work/project/link-home'}),stat:()=>({dev:1,ino:2})};
 expect(!!wipeBreaker(text,{...ctx,pathPort}),id).toBe(card);
});
it('L5 native unlink does not follow its final symlink',()=>expect(nativeEffectsWipe([{op:'delete',path:'/work/project/link-home',followFinal:false}],{...ctx,pathPort:{...ctx.pathPort,realpath:()=>'/home/u',lstat:()=>({dev:1,ino:2,isSymbolicLink:()=>true})} as any})).toBeNull());
it.each([
 ['X14','delete_directory',{path:'/work/project',recursive:false},'run'],['X16','delete_directory',{path:'/work/project'},'card'],['X18','purge_folder',{path:'/home/u'},'card'],['X20','trash_item',{path:'/work/project'},'card'],['X21','clear_cache',{path:'/work/project/.cache'},'run'],
] as const)('%s native admission preserves semantics',(id,tool,input,kind)=>expect(decideFixture(tool,input,{context:ctx,...(id==='X16'?{event:{toolKind:'delete'}}:{})}).kind,id).toBe(kind));
it.each([
 ['X15','delete_directory',{path:'/work/project',recursive:false},'run'],['X17','delete',{path:'/work/project'},'card'],['X19','purge_folder',{path:'/home/u'},'card'],
] as const)('%s native release preserves semantics',async(id,tool,input,first)=>{
 const result=await releaseFixture(tool,input,input,ctx);expect(result.first,id).toBe(first);expect(result.released).toBe(first==='run');
});
it('X14-extract explicit false survives directory extraction',()=>{
 const op=extractInspectedOperation({tool:'delete_directory',input:{path:'/work/project',recursive:false}});
 expect(op.kind).toBe('operation');if(op.kind==='operation'&&op.exactOperation.kind==='native')expect(op.exactOperation.effects[0]?.recursive).toBe(false);
});
it('H5 robocopy list-only does not mutate its destination',()=>expect(wipeBreaker('robocopy C:\\empty C:\\Users\\u /MIR /L',{...win,dialect:'cmd'})).toBeNull());
it('H4 caller glob expansion precedes a wrapper chdir',()=>{
 expect(wipeBreaker('env -C /work/project rm -rf *',{...ctx,cwd:'/tmp'})).toBeNull();
 expect(wipeBreaker('sudo -D / rm -rf *',{...ctx,cwd:'/tmp'})).toBeNull();
 expect(wipeBreaker('env -C /work/project rm -rf .',{...ctx,cwd:'/tmp'})).toBeTruthy();
 expect(wipeBreaker('sudo -D / rm -rf .',{...ctx,cwd:'/tmp'})).toBeTruthy();
});
it.each(['L6','L8'])('%s nonexistent differently cased targets run',()=>{
 const pathPort={...ctx.pathPort,stat:()=>null,lstat:()=>null};
 expect(wipeBreaker('rm -rf /Home/u',{...ctx,pathPort})).toBeNull();expect(wipeBreaker('rm -rf /users',{...ctx,pathPort})).toBeNull();
});
it('L7 case aliases use filesystem identity, never spelling alone',()=>{
 const pathPort={realpath:(p:string)=>p,stat:(p:string)=>({dev:1,ino:p.toLowerCase()==='/users/u'?100:2}),lstat:(p:string)=>({dev:1,ino:p.toLowerCase()==='/users/u'?100:2,isSymbolicLink:()=>false}),isBlockDevice:()=>null};
 const context={...ctx,home:'/Users/u',project:'/work/project',platform:'darwin' as const,pathPort};
 expect(wipeBreaker('rm -rf /users/u',context)?.rule).toBe('delete-home');
 expect(wipeBreaker('rm -rf /users/u',{...context,pathPort:{...pathPort,lstat:()=>null}})).toBeNull();
});
it('L10 macOS static link spelling remains protected',()=>expect(wipeBreaker('rm -rf /etc',{...ctx,platform:'darwin'})?.rule).toBe('delete-system-folder'));
it.each([
 ['P18-array',"Remove-Item -Recurse -Path @('C:\\tmp\\x','C:\\Users')",true],
 ['P18-spaced','Remove-Item -Recurse -Path C:\\tmp\\x, C:\\Users',true],
 ['P20-inline','Remove-Item -Recurse -LiteralPath:C:\\Users\\u\\*',false],
 ['P21-quoted',"Remove-Item -Recurse -Path 'C:\\Users\\u\\*'",true],
 ['H5-disk-whatif','Clear-Disk -Number 0 -WhatIf',false],
 ['H5-disk-whatif-false','Clear-Disk -Number 0 -WhatIf:$false',true],
] as const)('%s PowerShell preserves array and nonexecuting modes',(id,text,card)=>expect(!!wipeBreaker(text,win),id).toBe(card));
it('H4 a caller glob cannot wipe its old cwd after the child changes cwd',()=>{
 expect(wipeBreaker('env -C /tmp rm -rf *',ctx)).toBeNull();
 expect(wipeBreaker('sudo -D /tmp rm -rf *',ctx)).toBeNull();
 expect(wipeBreaker('env -C /tmp rm -rf /work/project/*',ctx)).toBeTruthy();
});
it('X14 nested explicit false reaches every extracted delete',()=>{
 const operation=extractInspectedOperation({tool:'delete_files',input:{entries:[{recursive:false,entries:[{path:'/work/project'}]}]}});
 expect(operation.kind).toBe('operation');if(operation.kind==='operation'&&operation.exactOperation.kind==='native')expect(operation.exactOperation.effects[0]?.recursive).toBe(false);
 expect(decideFixture('delete_files',{entries:[{recursive:false,entries:[{path:'/work/project'}]}]},{context:ctx}).kind).toBe('run');
});
it('L11 normalization requires an existing alias with matching identity',()=>{
 const root='/Users/\u00e9',alias='/Users/e\u0301';
 const port={realpath:(p:string)=>p,stat:(p:string)=>({dev:1,ino:p===root?100:101}),lstat:()=>null,isBlockDevice:()=>null};
 expect(wipeBreaker(`rm -rf ${alias}`,{...ctx,home:root,platform:'darwin',pathPort:port})).toBeNull();
 const existing={...port,lstat:()=>({dev:1,ino:100,isSymbolicLink:()=>false})};
 expect(wipeBreaker(`rm -rf ${alias}`,{...ctx,home:root,platform:'darwin',pathPort:existing})?.rule).toBe('delete-home');
});
it('L12 registered root aliases compare identity and disappear with their owner',()=>{
 const pathPort={realpath:(p:string)=>p,stat:(p:string)=>({dev:1,ino:p==='/work/other'?42:99}),lstat:()=>({dev:1,ino:42,isSymbolicLink:()=>false}),isBlockDevice:()=>null};
 const registry=new RootRegistry(pathPort);registry.replace('fixture',['/work/other']);
 expect(wipeBreaker('rm -rf /alias-other',{...ctx,pathPort,registry})?.rule).toBe('delete-system-folder');registry.replace('fixture',[]);
 expect(wipeBreaker('rm -rf /alias-other',{...ctx,pathPort,registry})).toBeNull();
});
it.each(['rm -f /etc','cat ~/.ssh/id_ed25519','touch /etc/fixture'])('N-1 fork bomb remains after an ordinary No limits command: %s',prefix=>expect(wipeBreaker(prefix+'; :(){ :|:& };:',ctx)?.rule).toBe('fork-bomb'));
it.each(['mv -Q --suffix=../../.. ./a ./b','mv -Q --target-directory=../../.. ./a','mv -Q -S../../.. ./a ./b'])('M17b known option words retain their nondestructive role: %s',text=>expect(wipeBreaker(text,ctx)).toBeNull());
it.each(['rm -rf -Q /work/project/link-home','mv -Q /work/project/link-home /tmp/away'])('L13 uncertain operands retain final-link semantics: %s',text=>{
 const pathPort={realpath:(p:string)=>p.endsWith('link-home')?'/home/u':p,lstat:(p:string)=>({dev:1,ino:2,isSymbolicLink:()=>p.endsWith('link-home')}),isBlockDevice:()=>null};
 expect(wipeBreaker(text,{...ctx,pathPort})).toBeNull();
});
it('L14 an indexed link is not its project when the operation removes only the link',()=>{
 const path='/work/project/link-home',pathPort={realpath:(p:string)=>p===path?'/home/u':p,lstat:(p:string)=>({dev:1,ino:2,isSymbolicLink:()=>p===path}),isBlockDevice:()=>null};
 const registry=new RootRegistry(pathPort);registry.replace('linked-project',[path]);expect(wipeBreaker('rm -rf '+path,{...ctx,pathPort,registry})).toBeNull();
});
it('L15 a missing indexed project target runs',()=>{
 const pathPort={realpath:(p:string)=>p,lstat:()=>null,isBlockDevice:()=>null},registry=new RootRegistry(pathPort);registry.replace('fixture',['/work/other']);
 expect(wipeBreaker('rm -rf /work/other',{...ctx,pathPort,registry})).toBeNull();
});
it('F2-registry a failed physical lookup retains the new lexical root',()=>{
 const registry=new RootRegistry({realpath(){throw Error('fixture-realpath');},isBlockDevice:()=>null});
 // MAIN RULING WIPE-V3 S8 F2: optional realpath failures retain lexical registration without throwing.
 expect(()=>registry.replace('fixture',['/work/new'])).not.toThrow();
 const pathPort={realpath:(p:string)=>p,lstat:()=>({dev:1,ino:2,isSymbolicLink:()=>false}),isBlockDevice:()=>null};
 expect(wipeBreaker('rm -rf /work/new',{...ctx,pathPort,registry})?.rule).toBe('delete-system-folder');
 expect(wipeBreaker('rm -rf /tmp/safe',{...ctx,pathPort,registry})).toBeNull();
});
it('D13a harmless Initialize-Disk keeps PowerShell parsing for the following command',()=>expect(wipeBreaker('Initialize-Disk -Number 1; Remove-Item -Recurse $env:USERPROFILE',{...win,dialect:undefined})?.rule).toBe('delete-home'));
// secret-scan: fixture (generic fixture home names only; no host data)
