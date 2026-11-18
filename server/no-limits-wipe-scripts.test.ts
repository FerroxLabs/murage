// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { d, fixture, baseRun } from './decision/fixture.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { beginOutsideTurn } from './email/external-marks.ts';
import { noteToolStartOutside } from './outside-wire.ts';
import { autoVerdict } from './auto-approve.ts';
useOutsideStoreFixture();
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
function setup(){
 const root=mkdtempSync(join(tmpdir(),'murage-wipe-script-'));roots.push(root);
 const f=fixture();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Script'}),executionContext:()=>({cwd:root,project:root})});
 beginOutsideTurn('t','p','turn',false,Date.now()-20);
 const write=(name:string,body:string)=>{
  const file=join(root,name),input={file_path:file,content:body};
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
  expect(d.decide(f.open('write-'+name,input,{tool:'Write',toolCall:{name:'Write',input}}),baseRun).kind).toBe('run');
  noteToolStartOutside('t',{origin:'engine',title:'Write',input},root);
  writeFileSync(file,body);return file;
 };
 const run=(command:string)=>d.decide(f.open(command,{command,cwd:root}),baseRun).kind;
 return {root,f,write,run};
}
for(const [command,name,body]of [
 ['bash cleanup.sh','cleanup.sh','rm -rf ~'],
 ['sh -- cleanup.sh','cleanup.sh','rm -rf ~'],
 ['./cleanup.sh','cleanup.sh','#!/bin/sh\nrm -rf ~'],
 ['python3 cleanup.py','cleanup.py',"import shutil\nshutil.rmtree('/archive/backups')"],
 ['node cleanup.js','cleanup.js',"require('fs').rmSync('/archive/backups', {recursive:true})"],
] as const)it(`W3 current-turn written script cards: ${command}`,()=>{
 const s=setup();s.write(name,body);expect(s.run(command)).toBe('run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
s.f.dispose();
});
for(const mode of ['safe','missing','unwritten','previous-turn','oversize','echo-data','inline-argument'])it(`W3 script boundary runs: ${mode}`,()=>{
 const s=setup();
 if(mode==='unwritten')writeFileSync(join(s.root,'cleanup.sh'),'rm -rf ~');
 else if(mode!=='missing'){
  const file=s.write('cleanup.sh',mode==='safe'?'echo ok':mode==='oversize'?'#'.repeat(262145)+'\nrm -rf ~':'rm -rf ~');
  if(mode==='previous-turn'){utimesSync(file,new Date(1000),new Date(1000));beginOutsideTurn('t','p','turn',true,Date.now());}
 }
 const command=mode==='echo-data'?'echo bash cleanup.sh':mode==='inline-argument'?"bash -c 'echo cleanup.sh'":'bash cleanup.sh';
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run(command)).toBe('run');s.f.dispose();
});
for(const [command,_card]of [['eval "$OPAQUE"',false],["X='echo ok'; eval \"$X\"",false],["X='rm -rf ~'; eval \"$X\"",false],['eval "echo ok"',false],["export X='echo ok'; eval \"$X\"",false],['eval "$OPAQUE"; echo remove',false]] as const)it(`W3 final eval resolution: ${command}`,()=>{
 // MAIN RULING: REDESIGN-WIPE-NARROW §4.4/§8 N4 scans a literal eval body.
 const wipe=command==="X='rm -rf ~'; eval \"$X\"";
 const f=fixture();expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe(wipe?'card':'run');

 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{fullAccessOrigin:'owner',commandText:command,commandCwd:'/w'}).approve===null).toBe(wipe); // MAIN RULING: REDESIGN-WIPE-NARROW §4.4 N4 also applies at auto-approve.
f.dispose();
});

it('W3 shell-written script is checked by the next execution in the same turn',()=>{
 const s=setup(),body='rm -rf ~',command="cat > cleanup.sh <<'SCRIPT'\n"+body+'\nSCRIPT';
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run(command)).toBe('run');writeFileSync(join(s.root,'cleanup.sh'),body);
 expect(s.run('bash cleanup.sh')).toBe('run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
s.f.dispose();
});

it('W3 written script execution follows command cwd and a resolved file variable',()=>{
 const s=setup();mkdirSync(join(s.root,'scripts'));s.write('scripts/cleanup.sh','rm -rf ~');
 expect(s.run('cd scripts && bash cleanup.sh')).toBe('run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).

 expect(s.run('FILE=scripts/cleanup.sh; bash "$FILE"')).toBe('run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
s.f.dispose();
});
for(const command of ['node --check cleanup.js','bash -s cleanup.sh','python3 - cleanup.py'])it(`W3 script names used as data stay runs: ${command}`,()=>{
 const s=setup();s.write('cleanup.js',"require('fs').rmSync('/archive/backups', {recursive:true})");s.write('cleanup.sh','rm -rf ~');s.write('cleanup.py',"import shutil; shutil.rmtree('/archive/backups')");
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run(command)).toBe('run');s.f.dispose();
});

it('W3 script execution cwd keeps an ordinary subfolder delete a run',()=>{
 const s=setup();mkdirSync(join(s.root,'scripts'));s.write('scripts/cleanup.sh','rm -rf .');
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run('cd scripts && rm -rf .')).toBe('run');
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run('cd scripts && bash cleanup.sh')).toBe('run');s.f.dispose();
});

it('R1 a complete long executable retains current-turn script wipe context',()=>{
 const s=setup();s.write('cleanup.sh','rm -rf ~');
 const command='#'+'x'.repeat(1_050_000)+'\nbash cleanup.sh';
 expect(d.decide(s.f.open('long-script',{command,cwd:s.root}),baseRun).kind).toBe('run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
s.f.dispose();
});

it('R5 journaled script stays untrusted after backdating its mtime',()=>{
 const s=setup(),file=s.write('cleanup.sh','rm -rf ~');utimesSync(file,new Date(1000),new Date(1000));
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run('bash cleanup.sh')).toBe('run');s.f.dispose();
});

// H1: direct execution follows the shebang, including extensionless scripts.
for(const [name,header,dangerous,safe]of [
 ['cleanup','#!/usr/bin/env python3',"import shutil; shutil.rmtree('/archive/backups')",'print("ok")'],
 ['cleanup.sh','#!/usr/bin/python3.12',"import shutil; shutil.rmtree('/archive/backups')",'print("ok")'],
 ['cleanup','#!/usr/bin/env -S python3.13 -u',"import shutil; shutil.rmtree('/archive/backups')",'print("ok")'],
 ['cleanup','#!/usr/bin/env node',"require('fs').rmSync('/archive/backups', {recursive:true})",'console.log("ok")'],
 ['cleanup.py','#!/bin/sh','rm -rf ~','echo ok'],
] as const)for(const destructive of [true,false])it(`H1 direct executable shebang ${header} ${name} destructive=${destructive}`,()=>{
 const s=setup();s.write(name,header+'\n'+(destructive?dangerous:safe));
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run('./'+name)).toBe('run');s.f.dispose();
});
it('H1 an explicit interpreter takes precedence over a misleading shebang',()=>{
 const s=setup();s.write('cleanup.py',"#!/bin/sh\nimport shutil; shutil.rmtree('/archive/backups')");
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run('python3 cleanup.py')).toBe('run');s.f.dispose();
});

for(const header of ['#!/usr/bin/env -Spython3','#!/usr/bin/env -S "python3"','#!/usr/bin/env -S \'python3.13\' -u','#!/usr/bin/env --split-string="python3" -u',String.raw`#!/usr/bin/env -S python3\_ -u`])for(const destructive of [true,false])it(`fold H2 env split shebang ${header} destructive=${destructive}`,()=>{
 const s=setup();s.write('cleanup',header+'\n'+(destructive?"import shutil; shutil.rmtree('/archive/backups')":'print("ok")'));
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 expect(s.run('./cleanup')).toBe('run');s.f.dispose();
});

// R2 H1: stdin is a current-turn file candidate for every consumer.
for(const command of ['lua < cleanup.lua','anything < cleanup.lua','cat cleanup.lua | anything',
 'FILE=cleanup.lua; lua < "$FILE"','anything 3< cleanup.lua 0<&3'])
for(const body of ['os.execute("rm -rf /")','#'.repeat(300000)+'\nos.execute("rm -rf /")','print("ok")'])
it(`R2 H1 current-turn stdin ${command} ${body.length}`,()=>{
 const s=setup();
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 try{s.write('cleanup.lua',body);expect(s.run(command)).toBe('run');}
 finally{s.f.dispose();}
});
it('R2 H1 stdin honors the last fd source and current-turn membership',()=>{
 const s=setup();
 try{
  s.write('cleanup.lua','os.execute("rm -rf /")');s.write('safe.lua','print("ok")');
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
  expect(s.run('lua < cleanup.lua < safe.lua')).toBe('run');
  writeFileSync(join(s.root,'unwritten.lua'),'os.execute("rm -rf /")');
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
  expect(s.run('lua < unwritten.lua')).toBe('run');
 }finally{s.f.dispose();}
});

for(const depth of [4,5,12])it(`R5 nested current-turn scripts hold at the read limit: ${depth}`,()=>{
 const s=setup();
 try{
  for(let at=0;at<=depth;at++)s.write(`a${at}.sh`,at===depth?'rm -rf ~':`bash a${at+1}.sh`);
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
  expect(s.run('bash a0.sh')).toBe('run');
 }finally{s.f.dispose();}
});
it('R5 unfamiliar stdin with a backdated wipe still cards',()=>{
 const s=setup();
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 try{const file=s.write('cleanup.lua',"os.remove('/x')");utimesSync(file,new Date(1000),new Date(1000));expect(s.run('lua < cleanup.lua')).toBe('run');}
 finally{s.f.dispose();}
});

it('R5 exhausting the nested script limit holds even without a visible primitive',()=>{
 const s=setup();
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 try{for(let at=0;at<=5;at++)s.write(`safe${at}.sh`,at===5?'echo ok':`bash safe${at+1}.sh`);expect(s.run('bash safe0.sh')).toBe('run');}
 finally{s.f.dispose();}
});
it('R5 a current-turn script cycle holds at the recursion limit',()=>{
 const s=setup();
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 try{s.write('loop.sh','bash loop.sh');expect(s.run('bash loop.sh')).toBe('run');}
 finally{s.f.dispose();}
});

for(const executable of ['tee','/usr/bin/tee','/bin/tee'])for(const existing of [false,true])it(`R8 tee output is data on the release recheck: ${executable} existing=${existing}`,async()=>{
 const s=setup();
 try{
  if(existing)s.write('out.txt','ordinary existing data');
  const command=`echo hi | ${executable} out.txt`,handle=s.f.open('r8-tee',{command,cwd:s.root});
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
  expect(d.decide(handle,baseRun).kind).toBe('run');
  await d.deliverRequest(handle);
  expect(s.f.respond).toHaveBeenCalledTimes(1);
  expect(d.openApprovals('t')).toHaveLength(0);
 }finally{s.f.dispose();}
});
it('R8 a written executable named tee still has its script bytes inspected',()=>{
 const s=setup();
 // MAIN RULING: REDESIGN-WIPE-NARROW §0/§4.4: no included-file reads; ordinary subfolders and data run.
 try{s.write('tee','rm -rf ~');expect(s.run('./tee out.txt')).toBe('run');}finally{s.f.dispose();}
});
