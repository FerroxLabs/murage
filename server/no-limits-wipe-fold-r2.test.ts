// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are permission inputs only; none of the deletion text executes.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { d, fixture, baseRun } from './decision/fixture.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { beginOutsideTurn } from './email/external-marks.ts';
import { noteToolStartOutside } from './outside-wire.ts';
import { autoVerdict } from './auto-approve.ts';

useOutsideStoreFixture();
for (const [command, card] of [
  ["bash -o pipefail -c 'git clean -fdx'", true],
  ["bash -euo pipefail -c 'rm -rf ~'", true],
  ["bash -o pipefail -c 'ls'", false],
  ["bash -o pipefail -c 'git clean -ndx'", true],
  // The whole argument tail is inspected, even with unknown option syntax.
  ["bash --unknown value 'git clean -f'", true],
  ["python3 --unknown value 'rm -rf ~'", true],
  ["bash -o pipefail -c 'echo git clean -fdx'", true],
  ["bash -o pipefail -c 'find /x -delete'", true],
  ["pwsh -Unknown value 'Remove-Item /x -Recurse'", true],
  ["cmd /unknown 'rd /s C:\\archive'", true],
  ["bash -unknown 'mkfs.ext4 /x'", true],
  ["bash -unknown 'dd if=/x of=/y'", true],
  ["bash -unknown 'truncate -s 0 /x'", true],
  ["bash -unknown 'shred /x'", true],
  ["bash -c 'rm -rf /home/alice/project/cache'", true],
  ["bash -o pipefail -c 'rm -rf /home/alice/project/cache'", true],
  ["bash -c 'rm -rf /tmp/murage-safe-cache'", true],
  ["bash -c 'rm -rf /home/alice/project'", true],
  ["bash -c 'rm -rf /home/alice/project/backups'", true],
  ["bash -c 'rm -rf /home/alice/project/.git'", true],
  ["bash -c 'rm -rf /home/alice/project/cache /tmp/cache'", true],
  ["bash -c 'rm -rf /home/alice/project/cache; echo hi'", true],
  ["bash -c 'eval rm -rf /home/alice/project/cache'", true],
  ["bash -c 'echo rm -rf /home/alice/project/cache'", true],
] as const) it(`r2 entire interpreter tail card=${card}: ${command}`, () => {
  const cwd='/home/alice/project', f=fixture();
  try {
    d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Project'}),executionContext:()=>({cwd,project:cwd})});
    // MAIN RULING NARROW-WIPE 2026-11-14: ordinary cleanup, logging, unknown code slots and Git cleanup run; home and registered whole-project wipes still card.
    const narrowCard=command==="bash -euo pipefail -c 'rm -rf ~'"||command==="bash -c 'rm -rf /home/alice/project'";
    expect(d.decide(f.open(command,{command,cwd},{executionCwd:cwd}),baseRun).kind).toBe(narrowCard?'card':'run');
    expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,
      {fullAccessOrigin:'owner',commandText:command,commandCwd:cwd,workFolder:cwd}).approve===null).toBe(narrowCard);
  } finally { f.dispose(); }
});

for(const body of ['rmtree("/x")','shutil.rmtree("/x")','os.remove("/x")','os.unlink("/x")','os.rmdir("/x")',
  'unlink("/x")','rm -r /x','rm -f /x','Remove-Item /x','del /s C:\\x','rd /s C:\\x','rimraf("/x")',
  'fs.rm("/x")','fs.rmSync("/x")','rmSync("/x")','deleteMany({})','DROP TABLE x','TRUNCATE TABLE x','git clean -f',
  '# SHUTIL.RMTREE("/x")',"print('os.remove(/x)')"])
it(`r2 every language primitive cards before shebang parsing: ${body}`,()=>{
  const root=mkdtempSync(join(tmpdir(),'wipe-fold-r2-')),f=fixture();
  try{
    d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Script'}),executionContext:()=>({cwd:root,project:root})});
    beginOutsideTurn('t','p','turn',false,Date.now()-20);
    const file=join(root,'cleanup'),input={file_path:file,content:'#!/weird/interp\n'+body};
    noteToolStartOutside('t',{origin:'engine',title:'Write',input},root);writeFileSync(file,input.content);
    // MAIN RULING NARROW-WIPE 2026-11-14: bodies read from disk are outside the submitted-command breaker; preserve every language input.
    expect(d.decide(f.open('execute',{command:'./cleanup',cwd:root}),baseRun).kind).toBe('run');
  }finally{f.dispose();removeTempDirSync(root);}
});

for (const header of ['#!/usr/bin/env -vSpython3','#!/weird/interp',''])
for (const body of ["import shutil; shutil.rmtree('/archive/backups')","os.remove('/x')","print('hi')"])
it(`r2 raw current-turn file ${header || 'no shebang'}: ${body}`, () => {
  const root=mkdtempSync(join(tmpdir(),'wipe-fold-r2-')), f=fixture();
  try {
    d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Script'}),executionContext:()=>({cwd:root,project:root})});
    beginOutsideTurn('t','p','turn',false,Date.now()-20);
    const file=join(root,'cleanup'), input={file_path:file,content:header+'\n'+body};
    noteToolStartOutside('t',{origin:'engine',title:'Write',input},root);
    writeFileSync(file,input.content);
    // MAIN RULING NARROW-WIPE 2026-11-14: interpreter/shebang recognition does not scan bodies on disk.
    expect(d.decide(f.open('execute',{command:'./cleanup',cwd:root}),baseRun).kind).toBe('run');
  } finally { f.dispose(); removeTempDirSync(root); }
});
