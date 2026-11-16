// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy inputs are inert: no shell, interpreter or destructive call is run.
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {autoVerdict} from './auto-approve.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {beginOutsideTurn} from './email/external-marks.ts';
import {noteToolStartOutside} from './outside-wire.ts';
import {useOutsideStoreFixture} from './testing/outside-store-fixture.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
useOutsideStoreFixture();
for(const command of ['lua < cleanup.lua','bun < cleanup.lua','deno < cleanup.lua','unknown-runtime < cleanup.lua','FILE=cleanup.lua; lua < "$FILE"','cd scripts && lua < cleanup.lua','lua 3<cleanup.lua 0<&3'])it(`review H1 current-turn stdin: ${command}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'review-r9-')),f=fixture();
 try{
  mkdirSync(join(root,'scripts'));
  const cwd=command.startsWith('cd ')?join(root,'scripts'):root,file=join(cwd,'cleanup.lua'),body='os.execute("rm -rf /")';
  d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'stdin'}),executionContext:()=>({cwd:root,project:root})});
  beginOutsideTurn('t','p','turn',false,Date.now()-20);
  noteToolStartOutside('t',{origin:'engine',title:'Write',input:{file_path:file,content:body}},root);writeFileSync(file,body);
  // MAIN RULING NARROW-WIPE 2026-11-14: stdin and recorded files are not recursively inspected; a submitted command without a catastrophe runs.
  expect(noLimitsWipe(command,{cwd:root,writtenScripts:new Set([file])})).toBeNull();
  expect(d.decide(f.open('stdin',{command,cwd:root}),baseRun).kind).toBe('run');
 }finally{f.dispose();removeTempDirSync(root);}
});
for(const mode of ['safe','unwritten','overwritten','previous-turn'])it(`review H1 stdin boundary: ${mode}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'review-r9-')),file=join(root,'cleanup.lua');
 try{
  writeFileSync(file,mode==='safe'?'print("hi")':'os.execute("rm -rf /")');
  expect(noLimitsWipe(mode==='overwritten'?'lua < cleanup.lua < absent.lua':'lua < cleanup.lua',{cwd:root,writtenScripts:mode==='unwritten'||mode==='previous-turn'?new Set():new Set([file])})).toBeNull();
 }finally{removeTempDirSync(root);}
});
for(const command of ['echo platform ready','echo modern model prepared','echo raindrop formatters','printf "%s\\n" platform'])it(`review H2 ordinary command runs: ${command}`,async()=>{
 expect(noLimitsWipe(command,{cwd:'/tmp/fixture-work'})).toBeNull();
 if(command.startsWith('echo ')||command.startsWith('printf '))expect(visibleWipe(command,'/home/fixture')).toBeNull();
 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{fullAccessOrigin:'owner',commandText:command,commandCwd:'/tmp/fixture-work'}).approve).toBeTruthy();
 const f=fixture();try{
  const h=f.open('ordinary',{command,cwd:'/tmp/fixture-work'});
  expect(d.decide(h,baseRun).kind).toBe('run');await d.deliverRequest(h);
  expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toHaveLength(0);
 }finally{f.dispose();}
});
for(const command of ['echo platform ready; rm -rf /','eval "$OPAQUE"; rm -rf ~','nolim_wipe=~; rm -rf "${nolim_wipe:?}"','mkfs.ext4 /dev/fixture','git clean -fdx'])it(`review H2 real wipe still cards: ${command}`,()=>{
 // MAIN RULING NARROW-WIPE 2026-11-14: Git cleanup runs; all four submitted root/home/disk catastrophes retain cards.
 const card=command!=='git clean -fdx';
 expect(Boolean(noLimitsWipe(command,{cwd:'/tmp/fixture-work'}))).toBe(card);
 const f=fixture();try{expect(d.decide(f.open('wipe',{command,cwd:'/tmp/fixture-work'}),baseRun).kind).toBe(card?'card':'run');}finally{f.dispose();}
});
