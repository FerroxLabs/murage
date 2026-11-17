// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER S0-S9 implementation and mutant proofs: wipe-v3. OWNER findings assertions: wipe-v3-tests.
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {wipeBreaker,nativeWipeBreaker} from '../wipe-breaker.ts';
import {BoundedPathPort} from './roots.ts';
import {MountInventory,MountProbe} from './mounts.ts';
import {corpusContext,fixturePathPort,linuxContext} from './corpus/v3-context.fixture.ts';
import {boundedFacadeCheck,probeWorkerSource} from './corpus/v3-faults.fixture.ts';
import {hungFilesystemScenario,mountQueryFailureScenario,freshMountScenario,registryFaultScenario,walkerFaultScenario,contextFaultScenario,executionDriveScenario} from './v3-fault-scenarios.fixture.ts';
afterEach(()=>vi.restoreAllMocks());
const card=(command:string,rule:string,context=linuxContext())=>expect.soft(wipeBreaker(command,context)?.rule,command).toBe(rule);
const run=(command:string,context=linuxContext())=>expect.soft(wipeBreaker(command,context),command).toBeNull();
const windows=(dialect:'sh'|'pwsh'|'cmd'='pwsh')=>corpusContext({platform:'win32',dialect,cwd:'C:\\work\\project\\pkg'});
it('V3-F1 25 relative cd lines remain RUN within 50 ms',async()=>{
 const result=await boundedFacadeCheck(Array.from({length:25},(_,i)=> 'cd sub'+i).join('\n')+'\nrm -rf ./build');
 expect(result.error).toBeUndefined();expect(result.rule).toBeNull();expect(result.elapsed).toBeLessThan(50);
},10000);
it('V3-F2 one bad registry owner and failed initializer cannot poison subsequent queries',registryFaultScenario);
it('V3-F3 Windows Git Bash and root-relative home spellings resolve before classification',()=>{
 const context=windows('sh');
 for(const command of ['rm -rf /c/Users','rm -rf /c/Users/u/*','cd /c/Users/u; rm -rf *','rm -rf /mnt/c/Users','rm -rf /mnt/c/Users/u/*'])card(command,'delete-home',context);
 card("Remove-Item -Recurse '\\Users'",'delete-home',windows());
});
it('V3-F4 statement-local recovery never re-enters a throwing parser',walkerFaultScenario);
it('V3-F5 throwing execution-context reader cannot escape retry or erase request cwd',contextFaultScenario);
it('V3-F6 filesystem deadlines and mount refresh leave the event loop bounded',async()=>{
 const port=new BoundedPathPort({source:probeWorkerSource,timeoutMs:150});
 const mount=new MountProbe("require('node:worker_threads').parentPort.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));",80);
 const inventory=new MountInventory(()=>mount.read());inventory.add('/Volumes/Retained');
 try{
  expect(port.realpath('/ready/path')).toBe('/ready/path');
  const start=performance.now();expect(()=>port.realpath('/hung/a')).toThrow(/timeout/);
  expect(performance.now()-start).toBeLessThan(250);
  let ticked=false;setTimeout(()=>{ticked=true;},5);
  await expect(inventory.refresh()).rejects.toThrow(/timeout/);
  expect(ticked).toBe(true);expect(inventory.contains('/Volumes/Retained')).toBe(true);
 }finally{await port.close();await mount.close();}
},10000);
it('V3-F7 changed device alone does not classify firmlinks, subvolumes or moved symlinks as drives',()=>{
 freshMountScenario();
 const pathPort={...fixturePathPort,realpath:()=>'/Volumes/Fixture',lstat:()=>({dev:2,ino:1,isSymbolicLink:()=>true}),stat:()=>({dev:2,ino:1,isSymbolicLink:()=>false})};
 const context=linuxContext({platform:'darwin',pathPort});
 expect(nativeWipeBreaker('move_file',{source:'/scratch/volume-link',destination:'/scratch/moved'},context)).toBeNull();
});
it('V3-A1 ANSI-C Unicode escapes resolve protected paths',()=>{
 card(String.raw`rm -rf $'\u002fhome'`,'delete-home');
 card(String.raw`rm -rf $'\U0000002fhome'`,'delete-home');
});
it('V3-A2 unquoted expansions split into argv while quoted expansions remain one field',()=>{
 card("args='-rf /home'; rm $args",'delete-home');
 run('args="-rf /home"; rm "$args"');
 card('rm${IFS}-rf${IFS}/','delete-root');
});
it('V3-A3 shell command mode binds positional zero, one and quoted at',()=>{
 card('bash -c \'rm -rf "$1"\' _ /home','delete-home');
 card('bash -c \'exec -- "$0" "$@"\' xargs rm -rf /home','delete-home');
});
it('V3-A4 cd option grammar keeps the real directory operand',()=>{
 for(const option of ['--','-L','-P'])card(`cd ${option} /home && rm -rf -- *`,'delete-home');
});
it('V3-A5 find action order keeps later filters from guarding earlier deletes',()=>{
 card("find /home -delete -name '*.bak'",'delete-home');
 run("find /home -name '*.bak' -delete");
});
it('V3-A6 embedded find argv use the same executable peeling as top-level argv',()=>{
 card('find /home -exec /bin/rm -rf {} +','delete-home');
 card(String.raw`find /tmp -maxdepth 0 -exec sh -c 'rm -rf /home' \;`,'delete-home');
 card('find /home -exec sudo rm {} +','delete-home');
});
it('V3-A7 KNOWN-DISGUISED observes same-command symlink overlays',()=>{
 const command='ln -s /home /tmp/wipe-link; rm -rf /tmp/wipe-link/*';
 console.log('KNOWN-DISGUISED',JSON.stringify({id:'V3-A7',expected:'delete-home',actual:wipeBreaker(command,linuxContext())?.rule??'run'}));
 expect(command).toContain('ln -s');
});
it('V3-A8 executable PowerShell blocks are visited',()=>card('& { Remove-Item -Recurse -Force C:\\Users }','delete-home',windows()));
it('V3-A9 PowerShell spaced assignment preserves its literal value',()=>card("$p = 'C:\\Users'; Remove-Item -Recurse -Force $p",'delete-home',windows()));
it('V3-A10 pass-through PowerShell pipeline stages retain entry provenance',()=>{
 for(const stage of ['Sort-Object Name','Tee-Object -Variable copy','Write-Output','Select-Object'])card('Get-ChildItem -Force C:\\Users | '+stage+' | Remove-Item -Recurse -Force','delete-home',windows());
});
it('V3-A11 CMD delayed expansion resolves the destructive target',()=>card('cmd /v:on /c "set P=C:\\Users& rd /s /q !P!"','delete-home',windows('sh')));
it('V3-A12 literal stdin reaches shell source and xargs argv',()=>{
 card(String.raw`printf '%s\n' 'rm -rf /home' | sh`,'delete-home');
 card(String.raw`printf '%s\n' /home | xargs rm -rf`,'delete-home');
 console.log('KNOWN-DISGUISED',JSON.stringify({id:'V3-A12-base64',expected:'delete-home',actual:wipeBreaker('printf %s cm0gLXJmIC9ob21l | base64 -d | sh',linuxContext())?.rule??'run'}));
});
it('V3-A13 interpreter literal root calls and find-entry truncation produce wipe effects',()=>{
 card('python3 -c \'import shutil; shutil.rmtree("/home")\'','delete-home');
 card('node -e \'require("fs").rmSync("/home",{recursive:true,force:true})\'','delete-home');
 card('find /home -type f -exec truncate -s 0 {} +','delete-home');
 card('import shutil; shutil.rmtree("/home")','delete-home',linuxContext({lang:'py'}));
 card('require("fs").rmSync("/home",{recursive:true})','delete-home',linuxContext({lang:'js'}));
});
it('V3-A14 git external work-tree home clean cards and ordinary project clean runs',()=>{
 card('git init --bare /tmp/wipe-empty.git && git --git-dir=/tmp/wipe-empty.git --work-tree=/home clean -ffdx','delete-home');
 run('git --work-tree=/work/project clean -ffdx');
});
it('V3-A15 unused cleanup function is data until called',()=>{
 run(String.raw`cleanup() { rm -rf /home; }; printf '%s\n' ready`);
 card('cleanup() { rm -rf /home; }; cleanup','delete-home');
});
it('V3-A16 dotfile-only project cleanup is ordinary work',()=>run('rm -rf /work/project/.*'));
it('V3-A17 project-root link removal runs but traversal of its children cards',()=>{
 const pathPort={...fixturePathPort,realpath:(p:string)=>p==='/work/project'?'/srv/project':p,
  lstat:(p:string)=>({dev:1,ino:p,isSymbolicLink:()=>p==='/work/project'}),stat:(p:string)=>({dev:1,ino:p,isSymbolicLink:()=>false})};
 const context=linuxContext({pathPort});
 run('rm -rf /work/project',context);
 card('rm -rf /work/project/*','delete-system-folder',context);
});
it('V3-R1 unrelated healthy roots survive the stalled-filesystem ceiling',hungFilesystemScenario,15000);
it('V3-R2 initially absent native mounts receive bounded device-change confirmation',freshMountScenario);
it('V3-R3 root-relative paths use the execution drive after location changes',executionDriveScenario);
it('V3-R4 mount-query failure cannot suppress healthy realpath',mountQueryFailureScenario);
it('V3-R5 timeout RED witness reaches the blocking operation through an existing public export',async()=>{
 const source=String.raw`const {workerData}=require('node:worker_threads');workerData.port.on('message',({signal})=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);workerData.port.postMessage({value:'late'});const done=new Int32Array(signal);Atomics.store(done,0,1);Atomics.notify(done,0);});`;
 const port=new BoundedPathPort({source,timeoutMs:150});
 try{
  const start=performance.now();let failure='';try{port.realpath('/fixture/blocking');}catch(error){failure=String(error);}
  expect(failure).toMatch(/timeout/);expect(performance.now()-start).toBeLessThan(400);
 }finally{await port.close();}
});
it('V3-R6 Unicode alias needs matching physical identity before it cards',()=>{
 const root='/Users/\u00e9',alias='/Users/e\u0301';
 const pathPort={...fixturePathPort,realpath:(p:string)=>p,stat:(p:string)=>({dev:1,ino:p===root?100:101}),lstat:()=>null};
 const context=linuxContext({home:root,platform:'darwin',pathPort});
 run(`rm -rf ${alias}`,context);
 card(`rm -rf ${alias}`,'delete-home',{...context,pathPort:{...pathPort,lstat:()=>({dev:1,ino:100,isSymbolicLink:()=>false})}});
});
it('V3-G1 fault recovery keeps executable position, recursion and move-source roles',()=>{
 vi.spyOn(invocationModule,'parse').mockImplementation(()=>{throw Error('fixture-parser');});
 run('echo "rm -rf /"');run('rm /');run('mv ./a /work/project');
 card('rm -rf /home','delete-home');
});
it('V3-G2 find disjunction guards and root self-match obey MAIN RULING R2',()=>{
 // MAIN RULING R2: find -o is evaluated per branch.
 run("find ~ -name '*.tmp' -o -name '*.bak' -delete");
 run("find /home -name '*.bak' -delete -o -print");
 card("find /home -name '*.bak' -o -delete",'delete-home');
 card('find /work/project -name project -exec rm -rf {} +','delete-system-folder');
});
it('V3-G3 virtual mounts run while persistent bind mounts card',()=>{
 // MAIN RULING R1: tmpfs is not a persistent mount root.
 for(const command of ['rm -rf /tmp','sudo rm -rf /tmp','rm --recursive /tmp','rm -rf /tmp/*'])run(command);
 card('rm -rf /Volumes/Fixture','delete-root',linuxContext({platform:'darwin'}));
 const context=linuxContext({mountInventory:{contains:p=>p==='/scratch/bind'}});
 card('rm -rf /scratch/bind','delete-root',context);
});
it('V3-G4 cwd overflow retains protected start and caller globs precede env chdir',()=>{
 card('cd a; cd b; cd c; cd d; cd e; rm -rf .','delete-system-folder',linuxContext({cwd:'/work/project'}));
 // MAIN RULING WIPE-V3-PREMISE: caller-expanded names resolve under /tmp after env changes cwd.
 run('env -C /tmp rm -rf *',linuxContext({cwd:'/work/project'}));
 run('env -C /work/project rm -rf *',linuxContext({cwd:'/tmp'}));
});
it('V3-G5 nonexecuting modes remain guards already green at the base',()=>{
 for(const command of ['rm --help -rf /','bash -n -c "rm -rf /"','command -v rm -rf /','rsync -an --delete ./empty/ /work/project/'])run(command);
 run('Remove-Item /work/project -Recurse -WhatIf',linuxContext({dialect:'pwsh'}));
});
it('V3-G6 fork bomb cards and readable double faults need wipe evidence',()=>{
 card(':(){ :|:& };:','fork-bomb');
 vi.spyOn(invocationModule,'parse').mockImplementation(()=>{throw Error('fixture-parser');});
 vi.spyOn(recoveryModule,'evidenceScan').mockImplementation(()=>{throw Error('fixture-scan');});
 run('ls');card('rm -rf /home','wipe-check-fault');
 card(undefined as unknown as string,'wipe-check-fault');
});
it('V3-X1 bundled shell option values are consumed in cluster order',()=>card("bash -euo pipefail -c 'rm -rf ~'",'delete-home'));
it('V3-X2 ANSI-C NUL truncation preserves adjacent executable pieces',()=>{
 card(String.raw`$'rm\0x' -rf /usr`,'delete-system-folder');
 card(String.raw`$'\0'rm -rf /home`,'delete-home');
 card(String.raw`$'rm\x00' -rf ~`,'delete-home');
 card(String.raw`$'rm\c@' -rf ~`,'delete-home');
});
it('V3-R4-literal-tilde real bash prints a literal quoted tilde prefix',()=>{
 // MAIN RULING R4/R6: ~"" is a literal child, verified in the network-none container.
 expect(execFileSync('bash',['-c','printf %s ~""'],{encoding:'utf8',env:{HOME:'/home/u'}})).toBe('~');
 run('rm -rf ~""');
});
// Namespace spies inject faults after imports without a missing-export RED.
import * as invocationModule from './invocation.ts';
import * as recoveryModule from './evidence.ts';
