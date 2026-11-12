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
 const s=setup();s.write(name,body);expect(s.run(command)).toBe('card');s.f.dispose();
});
for(const mode of ['safe','missing','unwritten','previous-turn','oversize','echo-data','inline-argument'])it(`W3 script boundary runs: ${mode}`,()=>{
 const s=setup();
 if(mode==='unwritten')writeFileSync(join(s.root,'cleanup.sh'),'rm -rf ~');
 else if(mode!=='missing'){
  const file=s.write('cleanup.sh',mode==='safe'?'echo ok':mode==='oversize'?'#'.repeat(262145)+'\nrm -rf ~':'rm -rf ~');
  if(mode==='previous-turn'){utimesSync(file,new Date(1000),new Date(1000));beginOutsideTurn('t','p','turn',true,Date.now());}
 }
 const command=mode==='echo-data'?'echo bash cleanup.sh':mode==='inline-argument'?"bash -c 'echo cleanup.sh'":'bash cleanup.sh';
 expect(s.run(command)).toBe('run');s.f.dispose();
});
for(const [command,card]of [['eval "$OPAQUE"',false],["X='echo ok'; eval \"$X\"",false],["X='rm -rf ~'; eval \"$X\"",true],['eval "echo ok"',false],["export X='echo ok'; eval \"$X\"",false],['eval "$OPAQUE"; echo remove',false]] as const)it(`W3 final eval resolution: ${command}`,()=>{
 const f=fixture();expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe(card?'card':'run');
 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{fullAccessOrigin:'owner',commandText:command,commandCwd:'/w'}).approve===null).toBe(card);f.dispose();
});

it('W3 shell-written script is checked by the next execution in the same turn',()=>{
 const s=setup(),body='rm -rf ~',command="cat > cleanup.sh <<'SCRIPT'\n"+body+'\nSCRIPT';
 expect(s.run(command)).toBe('run');writeFileSync(join(s.root,'cleanup.sh'),body);
 expect(s.run('bash cleanup.sh')).toBe('card');s.f.dispose();
});

it('W3 written script execution follows command cwd and a resolved file variable',()=>{
 const s=setup();mkdirSync(join(s.root,'scripts'));s.write('scripts/cleanup.sh','rm -rf ~');
 expect(s.run('cd scripts && bash cleanup.sh')).toBe('card');
 expect(s.run('FILE=scripts/cleanup.sh; bash "$FILE"')).toBe('card');s.f.dispose();
});
for(const command of ['node --check cleanup.js','bash -s cleanup.sh','python3 - cleanup.py'])it(`W3 script names used as data stay runs: ${command}`,()=>{
 const s=setup();s.write('cleanup.js',"require('fs').rmSync('/archive/backups', {recursive:true})");s.write('cleanup.sh','rm -rf ~');s.write('cleanup.py',"import shutil; shutil.rmtree('/archive/backups')");
 expect(s.run(command)).toBe('run');s.f.dispose();
});

it('W3 script execution cwd keeps an ordinary subfolder delete a run',()=>{
 const s=setup();mkdirSync(join(s.root,'scripts'));s.write('scripts/cleanup.sh','rm -rf .');
 expect(s.run('cd scripts && rm -rf .')).toBe('run');
 expect(s.run('cd scripts && bash cleanup.sh')).toBe('run');s.f.dispose();
});
