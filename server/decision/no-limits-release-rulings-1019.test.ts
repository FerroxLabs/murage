// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN 2026-11-12 C1: retain receiver/operand fixtures, but only wipes hold.
// Pure destination interpretation remains covered by release-guard.test.ts.
import {mkdirSync,mkdtempSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {fixture,d,baseRun} from './fixture.ts';
import {removeTempDir} from '../testing/cleanup.ts';
it.each([false,true])('C7 R-CARD final receiver basis refresh changed=%s',async changed=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-card-'));for(const dir of ['src','out','safe'])mkdirSync(join(root,dir));
 for(const path of ['src/hosts','safe/hosts'])writeFileSync(join(root,path),'fake-only');symlinkSync(join(root,'safe'),join(root,'out/ref'));
 try{
  const f=fixture(),h=f.open('receiver',{command:'rsync -a --files-from=list --link-dest=ref src/ out/hosts; printf x > out/hosts',cwd:root});
  expect(d.decide(h,baseRun)).toEqual({kind:'run'});
  if(changed){unlinkSync(join(root,'out/ref'));symlinkSync('/etc',join(root,'out/ref'));}
  await d.deliverRequest(h);
  expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toEqual([]);
 }finally{await removeTempDir(root);}
});
it.each([false,true])('C7 R-OPERAND literal -t pipeline refresh changed=%s',async changed=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-operand-'));mkdirSync(join(root,'out'));writeFileSync(join(root,'-t'),'fake-only');writeFileSync(join(root,'safe'),'fake-only');symlinkSync(join(root,'safe'),join(root,'out/-t'));
 try{
  const f=fixture(),h=f.open('operand',{command:"'-t' | Copy-Item -Destination ./out",cwd:root},{tool:'pwsh',commandShell:'pwsh',toolCall:{name:'pwsh',input:{command:"'-t' | Copy-Item -Destination ./out",cwd:root}}});
  expect(d.decide(h,baseRun)).toEqual({kind:'run'});
  if(changed){unlinkSync(join(root,'out/-t'));symlinkSync('/etc/hosts',join(root,'out/-t'));}
  await d.deliverRequest(h);
  expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toEqual([]);
 }finally{await removeTempDir(root);}
});
it.each(['/etc','/tmp'])('C7 cumulative tar -C uses the previous root %s',async root=>{
 // MAIN 23:30Z: GNU tar and bsdtar -C options are cumulative; ./w is
 // relative to the previous -C directory, per their -C manual entries.
 const f=fixture(),h=f.open('tar',{command:`tar -xf /tmp/a -C ${root} -C ./w`,cwd:'/tmp'});
 const outcome=d.decide(h,baseRun);expect(outcome.kind).toBe('run');
 if(outcome.kind==='run'){await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledTimes(1);}
});
it.each(['python','node'].flatMap(tool=>[false,true].map(changed=>({tool,changed}))))('C7 exact code API refresh $tool changed=$changed',async({tool,changed})=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-code-')),target=join(root,'notes');
 try{
  const f=fixture(),command=`printf x > '${target}'`,code=tool==='python'?`import os; os.system(${JSON.stringify(command)})`:`require('child_process').execSync(${JSON.stringify(command)})`;
  const h=f.open('code',{}, {tool,toolCall:{name:tool,input:{code,cwd:root}}});expect(d.decide(h,baseRun)).toEqual({kind:'run'});
  if(changed)symlinkSync('/etc/hosts',target);await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toEqual([]);
 }finally{await removeTempDir(root);}
});
