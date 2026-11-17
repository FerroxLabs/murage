// SPDX-License-Identifier: AGPL-3.0-or-later
// Permission strings only. No command in this table is executed.
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from './testing/cleanup.ts';
import { wipeBreaker, nativeWipeBreaker, type WipeContext } from './wipe-breaker.ts';
import { registeredWipeProjects } from './wipe/registry.ts';
import { autoVerdict } from './auto-approve.ts';
import { d, fixture, baseRun } from './decision/fixture.ts';
const context: WipeContext = { mountInventory:{contains:p=>['/Volumes/External','/mnt/data','/media/owner/data'].includes(p)},pathPort:{realpath:p=>p,isBlockDevice:()=>null}, cwd:'/work/project', project:'/work/project', home:'/home/owner', dataDir:'/private/murage/data', env:{WIPE_NARROW_UNSET:undefined,KNOWN_ROOT:'/work/project',OPAQUE:'somewhere'} };
const roots=['/','~','$HOME','/home','/Users','/Volumes/External','/mnt/data','/media/owner/data','/private/murage/data','/private/murage','/work/project','/work/project/..','/work/project/./','/*','*','./*','~/*','~/.','"$WIPE_NARROW_UNSET/"','"$KNOWN_ROOT"','C:\\','D:\\','C:\\*','C:\\Users','%USERPROFILE%','$env:USERPROFILE'];
const verbs=['rm -rf','rm -R','rm --recursive','Remove-Item -Recurse -Path','rmdir /s /q','rd /s','del /s','shred -r'];
for(const verb of verbs)for(const root of roots)it(`CARD ${verb} ${root}`,()=>{
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.1–4.3/§4.5: shred protects devices;
 // each shell expands only its own variable syntax. Keep every original row.
 const cmd=/^(?:rmdir|rd|del) /.test(verb);
 const shellVariable=root.includes('$')||root.startsWith('~');
 const card=verb!=='shred -r'&&!(cmd&&shellVariable)&&!(verb.startsWith('rm ')&&(root==='%USERPROFILE%'||root==='$env:USERPROFILE'))&&!(verb.startsWith('Remove-Item')&&root==='%USERPROFILE%');
 expect(!!wipeBreaker(`${verb} ${root}`,context)).toBe(card);
});
for(const shell of ['bash','zsh','pwsh','cmd']) {
 const wrap=(s:string)=>shell==='cmd'?`cmd /c ${s}`:shell==='pwsh'?`pwsh -Command '${s}'`:`${shell} -c '${s}'`;
 for(const command of ['rm -rf /','rm -rf ~','rm -rf /work/project','rm -rf /private/murage/data','rm -rf C:\\*','rm -rf "$WIPE_NARROW_UNSET/"','sudo rm -rf /','env TARGET=/ rm -rf "$TARGET"','nohup rm -rf ~','xargs rm -rf /','mv /work/project /tmp/away','find / -delete','find /home -exec rm -rf {} \\;','rsync -a --delete ./empty/ /home/owner/','mkfs.ext4 /dev/sdz9','wipefs -a /dev/sdz9','dd if=/dev/zero of=/dev/sdz9','shred /dev/sdz9','diskutil eraseDisk APFS label /dev/disk9','diskutil eraseVolume APFS label /dev/disk9','diskutil partitionDisk /dev/disk9 1 GPT APFS label 100%','format C:','diskpart','Format-Volume -DriveLetter C','Clear-Disk -Number 1','Initialize-Disk -Number 1'])
  it(`${command==='env TARGET=/ rm -rf "$TARGET"'?'RUN':'CARD'} ${shell} ${command}`,()=>{
   // H1: the caller expands TARGET before env sets the child's value.
   // MAIN RULING 23:15Z(b): Initialize-Disk cannot destroy existing data.
   if(command==='Initialize-Disk -Number 1')expect(wipeBreaker(wrap(command),context)).toBeNull();
   else if(command==='env TARGET=/ rm -rf "$TARGET"')expect(wipeBreaker(wrap(command),{...context,env:{...context.env,TARGET:undefined}})).toBeNull();
   else expect(wipeBreaker(wrap(command),context)).toBeTruthy();
  });
 for(const command of ['rm -rf node_modules','rm -rf ./build','rm -rf ~/project/tmp','git clean -fdx','rm -rf /tmp/x','mv ~/a ~/b','dd if=/dev/zero of=./file','dd of=/dev/null','dd of=/dev/tty','echo data > /dev/unknown-endpoint','shred /dev/shm/fixture-file','rm -rf /work/project/src','rm -rf /private/murage/data/cache','echo "rm -rf /"','eval "$OPAQUE"','bash ./wipe.sh','rm -rf "$OPAQUE"','rm -rf /work/project/.git','git push --force origin main','psql -c "DROP DATABASE prod"'])
  it(`RUN ${shell} ${command}`,()=>expect(wipeBreaker(wrap(command),context)).toBeNull());
}
for(const command of ['rm -rf /','rm -rf /home/owner','rm -rf /work/project','mv /work/project /tmp/away','rm -rf C:\\*','rd /s C:\\','rd /s "C:\\"','Remove-Item -Recurse $env:USERPROFILE','dd of=/dev/sdz9'])it(`owner routes CARD ${command}`,()=>{
 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{fullAccessOrigin:'owner',commandText:command,commandCwd:context.cwd,workFolder:context.project,promptFacts:{home:context.home!,cwd:context.cwd!}}).approve).toBeNull();
 const f=fixture();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Narrow wipe'}),executionContext:()=>context});try{expect(d.decide(f.open(command,{command,cwd:context.cwd}),baseRun).kind).toBe('card');}finally{f.dispose();}
});
for(const tool of ['delete_file','delete_directory','delete_files','move_file','rename_file','write_file','Edit'])for(const path of ['/work/project','/home/owner','/private/murage/data','C:\\'])it(`native CARD ${tool} ${path}`,()=>{
 // MAIN RULING 3 (REDESIGN-WIPE-NARROW §12 D3): writes to root names run.
 // §6.1: a move's path field denotes its source when a destination exists.
 const dest=/move|rename/.test(tool)?{destination:'/tmp/fixture-away'}:{};
 expect(!!nativeWipeBreaker(tool,{path,...dest},context)).toBe(!/write|edit/i.test(tool));
 expect(nativeWipeBreaker(tool,{path:path.replace(/\\$/,'')+'/inside',...dest},context)).toBeNull();
});
it('native array operands and move source use the same breaker',()=>{
 expect(nativeWipeBreaker('move_file',{source:'/work/project',destination:'/tmp/x'},context)).toBeTruthy();
 expect(nativeWipeBreaker('delete_files',{paths:['/tmp/x','/work/project']},context)).toBeTruthy();
 // MAIN RULING 3 (REDESIGN-WIPE-NARROW §12 D3): native edits are writes, not root wipes.
 expect(nativeWipeBreaker('MultiEdit',{edits:[{file_path:'/home/owner'}]},context)).toBeNull();
});
it('one shell level, no aliases, eval, included files, SQL, Git or token floors',()=>{
 for(const command of ["bash -c \"bash -c 'rm -rf /'\"", "eval 'rm -rf /'", "alias zap='rm -rf /'; zap", "source ./wipe.sh", "node -e \"require('fs').rmSync('/')\"", 'DROP DATABASE fixture','rm -rf /etc/cache','rm -rf /archive/backups','echo rm remove delete']){
 // MAIN RULING: REDESIGN-WIPE-NARROW §4.4/§8 N1–N4 scans nested shell/eval bodies.
 if(command.startsWith('bash -c')||command.startsWith("eval 'rm"))expect(wipeBreaker(command,context)).toBeTruthy();else expect(wipeBreaker(command,context)).toBeNull();
 }
 expect(wipeBreaker('echo ok; rm -rf / || true',context)).toBeTruthy();
 expect(wipeBreaker("rm -rf '$WIPE_NARROW_UNSET/'",context)).toBeNull();
 expect(wipeBreaker('rm -f /',context)).toBeNull();
 expect(wipeBreaker('rd /s C:\\ /q',context)).toBeTruthy();
 expect(wipeBreaker("rm -rf '/home/owner/*'",context)).toBeNull();
 expect(wipeBreaker("rm -rf '*'",context)).toBeNull();
 expect(wipeBreaker('rm -rf .')).toBeNull();
 expect(wipeBreaker('cd ./build && rm -rf .',context)).toBeNull();
 expect(wipeBreaker('cd / && rm -rf .',context)).toBeTruthy();
 expect(wipeBreaker('env -u HOME rm -rf \"$HOME\"',context)).toBeTruthy();
 expect(wipeBreaker('env -u HOME rm -rf \"$HOME/\"',context)).toBeTruthy();
 expect(wipeBreaker("cat <<'EOF'\nrm -rf /\nEOF",context)).toBeNull();
 expect(wipeBreaker("echo '<<EOF'\nrm -rf /",context)).toBeTruthy();
 expect(wipeBreaker("cat<<'EOF'\nrm -rf /\nEOF",context)).toBeNull();
 expect(wipeBreaker("cat <<'EOF'\nrm -rf /\nEOF\nrm -rf /",context)).toBeTruthy();
 expect(wipeBreaker('ROOT=/; rm -rf \"$ROOT\"',context)).toBeTruthy();
 expect(wipeBreaker("rm -rf \"$HOME\"/'.'",context)).toBeTruthy();
 expect(wipeBreaker('rm -rf "\\$HOME/"',context)).toBeNull();
});
it('Windows/macOS normalization and existing realpaths',()=>{
 expect(wipeBreaker('rd /s c:\\USERS\\OWNER\\..',{...context,home:'C:\\Users\\owner',cwd:'C:\\work',platform:'win32',pathPort:{realpath:()=> 'C:\\Users',isBlockDevice:()=>null}})).toBeTruthy();
 // MAIN RULING binding v2 DELTA7: case folding requires an existing filesystem alias.
 expect(wipeBreaker('rm -rf /HOME/OWNER',{...context,platform:'darwin',pathPort:{realpath:()=>'/home/owner',isBlockDevice:()=>null}})).toBeTruthy();
 const root=mkdtempSync(join(tmpdir(),'wipe-narrow-'));
 try{mkdirSync(join(root,'project'));symlinkSync(join(root,'project'),join(root,'alias'));// MAIN RULING binding v2 DELTA7: plain rm removes the final link; slash follows it.
 expect(wipeBreaker(`rm -rf ${root}/alias`,{...context,pathPort:undefined,project:join(root,'project')})).toBeNull();expect(wipeBreaker(`rm -rf ${root}/alias/`,{...context,pathPort:undefined,project:join(root,'project')})).toBeTruthy();}finally{removeTempDirSync(root);}
});
it('a command subdirectory is not promoted to a whole project root',()=>{
 expect(wipeBreaker('rm -rf .',{...context,cwd:'/work/project/tmp'})).toBeNull();
 expect(wipeBreaker('rm -rf /work/project',{...context,cwd:'/work/project/tmp'})).toBeTruthy();
});
it('plain one-line copy names the protected scope',()=>{
 expect(wipeBreaker('rm -rf ~',context)?.what).toBe('This would wipe your whole home folder. Run it anyway?');
});

it('known engine environment resolves roots without turning a nonempty variable into an unset root',()=>{
 const command='rm -rf "$DEST/"', nl={autoApprove:true,fullAccess:true,noLimits:true};
 const facts={fullAccessOrigin:'owner' as const,commandText:command,commandCwd:'/work/project',workFolder:'/work/project'};
 expect(autoVerdict(nl,'Bash',command,{...facts,commandEnv:{DEST:'cache'}}).approve).toBeTruthy();
 expect(autoVerdict(nl,'Bash',command,{...facts,commandEnv:{DEST:'/work/project'}}).approve).toBeNull();
 const f=fixture();try{
  d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Environment'}),executionContext:()=>context});
  for(const [dest,kind] of [['cache','run'],['/work/project','card']] as const)
   expect(d.decide(f.open(dest,{command,cwd:context.cwd},{execEnv:{env:{DEST:dest},absent:[],cwd:context.cwd,shell:['sh'],capture:'session'}}),baseRun).kind).toBe(kind);
 }finally{f.dispose();}
 expect(nativeWipeBreaker('GOOGLEDRIVE_DELETE_FILE',{path:'/'},context)).toBeNull();
});

it('registered project roots include a workspace other than the active folder',()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-registered-')),target=join(root,'project');mkdirSync(target);
 try{registeredWipeProjects.replace('fixture',[target]);
 expect(wipeBreaker('rm -rf '+target,context)).toBeTruthy();
 expect(wipeBreaker('rm -rf '+target+'/tmp',context)).toBeNull();
 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash','rm -rf '+target,{
  fullAccessOrigin:'owner',commandText:'rm -rf '+target,commandCwd:context.cwd,projectRoots:[target]
 }).approve).toBeNull();
 }finally{registeredWipeProjects.clear();removeTempDirSync(root);}
});

// DELTA 1: approved root/disk robustness; these strings are never executed.
for (const shell of ['bash','zsh','pwsh','cmd']) {
 const wrap=(s:string)=>shell==='cmd'?`cmd /c ${s}`:shell==='pwsh'?`pwsh -Command '${s}'`:`${shell} -c '${s}'`;
 for(const root of ['/etc','/usr','/var','/bin','/sbin','/boot','/lib','/lib64','/opt','/System','/Library','/root','"C:\\Windows"','"C:\\Program Files"','"C:\\Program Files (x86)"','"C:\\ProgramData"'])
  it(`DELTA CARD ${shell} ${root}`,()=>expect(wipeBreaker(wrap(`rm -rf ${root}`),context)).toBeTruthy());
 for(const wrapper of ['setsid','setsid -c','exec','exec -a fixture','timeout 5','nice -n 5','ionice -c 3','doas','doas -n','sudo -n','sudo -u fixture'])
  it(`DELTA CARD wrapper ${shell} ${wrapper}`,()=>expect(wipeBreaker(wrap(`${wrapper} rm -rf /`),context)).toBeTruthy());
 for(const command of ['echo data >/dev/sdz','echo data > /dev/nvme9n1','> /dev/rdisk9','rm -rf ／','rm −rf ∕','rm -rf /e\u0000tc'])
  it(`DELTA CARD normalized/disk ${shell} ${command}`,()=>{
   // MAIN RULING binding v2 DELTA7 L9: Unicode lookalikes are literal filenames.
   if(command.includes('／')||command.includes('∕'))expect(wipeBreaker(wrap(command),context)).toBeNull();else expect(wipeBreaker(wrap(command),context)).toBeTruthy();
  });
 for(const command of ['rm -f /etc','mv /etc /tmp/fixture','rm -rf /etc/cache','echo "> /dev/sdz"','echo data > ./file','echo data > /dev/null'])
  it(`DELTA RUN ${shell} ${command}`,()=>{
   // MAIN RULING 1 (REDESIGN-WIPE-NARROW §12 D1): moving a whole OS folder cards.
   if(command==='mv /etc /tmp/fixture')expect(wipeBreaker(wrap(command),context)).toBeTruthy();else expect(wipeBreaker(wrap(command),context)).toBeNull();
  });
}
it('DELTA checks lexical roots even when an existing symlink resolves elsewhere',()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-lexical-'));
 try { mkdirSync(join(root,'real'));symlinkSync(join(root,'real'),join(root,'project'));
  expect(wipeBreaker(`rm -rf ${root}/project`,{...context,project:join(root,'project')})).toBeTruthy();
 } finally {removeTempDirSync(root);}
 expect(wipeBreaker('rm -rf /\u001b[31metc\u001b[0m',context)).toBeTruthy();
});

it('an escaped redirect is ordinary shell data',()=>expect(wipeBreaker('echo \\>/dev/sdz',context)).toBeNull());
it('direct PowerShell commands use their declared dialect',()=>{
 expect(wipeBreaker('$p=$HOME; ri -Recurse $p',{...context,lang:'pwsh'})).toBeTruthy();
 expect(wipeBreaker('$p="cache"; ri -Recurse $p',{...context,lang:'pwsh'})).toBeNull();
});
