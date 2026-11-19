// SPDX-License-Identifier: AGPL-3.0-or-later
// These are permission strings only; no destructive command is executed.
import { expect, it } from 'vitest';
import {mkdtempSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTempDirSync} from './testing/cleanup.ts';
import { wipeBreaker } from './wipe-breaker.ts';
import { d, fixture, baseRun } from './decision/fixture.ts';
import { extractInspectedOperation } from './no-limits-operation.ts';
import { inspectReleaseWipes } from './decision/release-guard.ts';
import { guardEngineRelease } from './decision/provider-release.ts';
import { relayClaudeBash } from './drivers/claude-bash-hook.ts';
const context={cwd:'/work/project',project:'/work/project',home:'/home/owner',env:{HOME:'/home/owner',TARGET:'/home/owner'}};
it('H1 caller expands operands before child env assignments and unsets',()=>{
 for(const command of ['env -u HOME rm -rf "$HOME"','env HOME=/tmp/cache rm -rf "$HOME"','HOME=/tmp/cache rm -rf "$HOME"','env -u TARGET rm -rf "$TARGET"'])
  expect(wipeBreaker(command,context),command).toBeTruthy();
 expect(wipeBreaker('env HOME=/tmp/cache sh -c \'rm -rf "$HOME"\'',context)).toBeNull();
 expect(wipeBreaker('env -u HOME sh -c \'rm -rf "$HOME/"\'',context)).toBeTruthy();
 expect(wipeBreaker('env TARGET=/ rm -rf "$TARGET"',{...context,env:{TARGET:undefined}})).toBeNull();
});
it('H2 capture preserves executable and native fields despite unrelated padding',()=>{
 const f=fixture();try{
  const padding='x'.repeat(17*1024*1024);
  for(const [id,input,extra] of [
   ['command',{padding,command:'rm -rf /'},{}],
   ['native',{padding,path:'/'},{tool:'delete_directory',toolCall:{name:'delete_directory',input:{padding,path:'/'}}}],
   ['safe',{padding,command:'echo ordinary'},{}],
  ] as const)expect(d.decide(f.open(id,input,extra),baseRun).kind).toBe(id==='safe'?'run':'card');
 }finally{f.dispose();}
});
it('H2 recovery inspects a command even after complete capture exceeds its limit',async()=>{
 const result=await relayClaudeBash('/tmp/absent-wipe-review.sock',{command:'rm -rf /',padding:'x'.repeat(17*1024*1024)},new AbortController().signal);
 expect(result).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
});
it('H3 move option operands and rsync redirects do not hide protected targets',()=>{
 for(const command of ['mv -t /tmp /work/project','mv --target-directory /tmp /work/project','mv --target-directory=/tmp /work/project','mv -t/tmp /work/project','mv /work/project /tmp/away >move.log','rsync -a --delete ./empty/ "$HOME/" >sync.log','rsync -a --delete ./empty/ "$HOME/" 2>sync.log','rsync -a --delete ./empty/ "$HOME/" >sync.log 2>&1','rsync -a --delete ./empty/ "$HOME/" <input.list','rsync -a --delete ./empty/ "$HOME/" --quiet','rsync -a --delete ./empty/ "$HOME/" --log-file sync.log','rsync -a --delete ./empty/ "$HOME/" -e ssh','Move-Item -Destination /tmp -Path /work/project','Move-Item -Destination:/tmp -LiteralPath /work/project'])
  expect(wipeBreaker(command,context),command).toBeTruthy();
 for(const command of ['mv -t /work/project /tmp/file','mv --target-directory=/work/project /tmp/file','rsync -a --delete ./empty/ /tmp/cache >sync.log','rm -rf /tmp/cache > /work/project','rsync -a --delete ./empty/ /tmp/cache --log-file "$HOME"','Move-Item -Destination /work/project -Path /tmp/file'])
  expect(wipeBreaker(command,context),command).toBeNull();
});

it('H4 root lookup stays bounded as registered history grows',async()=>{
 const {registeredWipeProjects:roots}=await import('./wipe/registry.ts');
 const fixtureDir=mkdtempSync(join(tmpdir(),'wipe-index-review-'));const target=join(fixtureDir,'project-19999');mkdirSync(target);
 try{
  roots.replace('fixture',Array.from({length:20000},(_,i)=>join(fixtureDir,`project-${i}`)));
  // Query work is independent of registry size: no registry enumeration or
  // filesystem work over registered roots is permitted after registration.
  const {vi}=await import('vitest');
  const walk=vi.spyOn(Map.prototype,'values');
  let root,inside,enumerations=0;
  try{
   root=wipeBreaker('rm -rf '+target,context);
   inside=wipeBreaker('rm -rf '+target+'/tmp',context);
   enumerations=walk.mock.calls.length;
  }finally{walk.mockRestore();}
  expect(root).toBeTruthy();expect(inside).toBeNull();
  expect(enumerations).toBe(0);
  roots.replace('fixture',[]);
  expect(wipeBreaker('rm -rf '+target,context)).toBeNull();
 }finally{roots.clear();removeTempDirSync(fixtureDir);}
});
it('H5 recovery shares registered projects with ordinary admission',async()=>{
 const {registeredWipeProjects:roots}=await import('./wipe/registry.ts');
 const root=mkdtempSync(join(tmpdir(),'wipe-recovery-review-')),target=join(root,'project');mkdirSync(target);
 roots.replace('fixture',[target,'/home/owner/known-project']);
 expect(wipeBreaker('rm -rf /',context)).toMatchObject({rule:'delete-root',what:'This would wipe the whole filesystem. Run it anyway?'});
 expect(wipeBreaker('rm -rf ~',context)).toMatchObject({rule:'delete-home',what:'This would wipe your whole home folder. Run it anyway?'});
 const f=fixture();try{
  expect(d.decide(f.open('other',{command:'rm -rf '+target}),baseRun).kind).toBe('card');
  expect(await relayClaudeBash('/tmp/absent-wipe-review.sock',{command:'rm -rf '+target},new AbortController().signal,context)).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
  expect(await relayClaudeBash('/tmp/absent-wipe-review.sock',{command:'rm -rf '+target+'/tmp'},new AbortController().signal,context)).toMatchObject({hookSpecificOutput:{permissionDecision:'allow'}});
 }finally{f.dispose();roots.clear();removeTempDirSync(root);}
});

it('H2 oversized refreshed executable input is checked again at provider release',()=>{
 const f=fixture();try{
  const handle=f.open('release-padding',{command:'echo ordinary'});
  expect(d.decide(handle,baseRun).kind).toBe('run');
  expect(guardEngineRelease({threadId:'t',requestId:'release-padding',turnId:'turn',providerInstanceId:'p'},{padding:'x'.repeat(17*1024*1024),command:'rm -rf /'})).toBe(false);
  expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
it('H2 the reduced wipe sidecar never replaces the delivered service payload',async()=>{
 const f=fixture();try{
  const input={command:'echo ordinary',padding:'x'.repeat(17*1024*1024)};
  const handle=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall(input)});
  expect(d.decide(handle,baseRun).kind).toBe('run');
  let delivered=false;
  const result=await d.executeService(handle,async call=>{
   const received=call.input as typeof input;
   expect(received.command).toBe(input.command);expect(received.padding?.length).toBe(input.padding.length);
   delivered=true;return 'inert fixture';
  });
  expect(result.kind).toBe('executed');expect(delivered).toBe(true);
 }finally{f.dispose();}
});
// Keep the integration release fingerprint guard aligned with the native
// operands selected by the narrow breaker; the transport remains a fake.
it.each(['write_file','move_file'])('H3 native root %s can use its explicit Run approval',async tool=>{
 const f=fixture();try{
  const input=tool==='move_file'?{source:'/',destination:'/tmp/fixture-away'}:{path:'/',content:'inert fixture'};
  const handle=f.open('native-run',input,{tool,toolCall:{name:tool,input}});
  const outcome=d.decide(handle,baseRun);
  // MAIN RULING 3 (REDESIGN-WIPE-NARROW §12 D3): native root writes run.
  expect(outcome.kind).toBe(tool==='write_file'?'run':'card');
  if(outcome.kind==='card'){
   await d.presentApproval(outcome.ref,{title:'Fixture',subtitle:'Native root'});
   await d.answerApproval(outcome.ref,{behavior:'allow'});
  }else await d.deliverRequest(handle);
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect(f.respond.mock.calls[0]![1].behavior).toBe('allow');
 }finally{f.dispose();}
});

it('H3 native move release preserves the recursive-only operating-system ruling',()=>{
 const operation=extractInspectedOperation({tool:'move_file',input:{source:'/etc',destination:'/tmp/fixture-away'}});
 expect(operation.kind).not.toBe('incomplete');
 if(operation.kind==='incomplete')throw Error('expected exact native move');
 // MAIN RULING 1 (REDESIGN-WIPE-NARROW §12 D1): native moves of OS roots card at release too.
 expect(inspectReleaseWipes(operation.exactOperation)).toHaveLength(1);
});

it('H3 rsync independently retains its destination across redirects and option values',()=>{
 expect(wipeBreaker('rsync -a --delete ./empty/ "$HOME/" >sync.log',context)).toBeTruthy();
 expect(wipeBreaker('rsync -a --delete ./empty/ "$HOME/" --log-file sync.log',context)).toBeTruthy();
 expect(wipeBreaker('rsync -a --filter "--delete" ./empty/ "$HOME/"',context)).toBeNull();
 expect(wipeBreaker('rsync -a --log-file "--delete" ./empty/ "$HOME/"',context)).toBeNull();
});

it('H3 physical parent traversal selects the actual protected root',()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-physical-review-'));
 try{
  mkdirSync(join(root,'out'));mkdirSync(join(root,'nested/inner'),{recursive:true});mkdirSync(join(root,'project'));
  symlinkSync('../nested/inner',join(root,'out/branch'));symlinkSync('../project',join(root,'nested/target'));
  // MAIN RULING binding v2 DELTA7: the final target is a link, even after physical parent traversal.
  expect(wipeBreaker('rm -rf out/branch/../target',{...context,cwd:root,project:join(root,'project')})).toBeNull();
  expect(wipeBreaker('rm -rf out/branch/../target/',{...context,cwd:root,project:join(root,'project')})).toBeTruthy();
 }finally{removeTempDirSync(root);}
});

it.each([
 ['camel-path',{filePath:'/'}],
 ['change-map',{fileChanges:{'/':'delete'}}],
 ['change-array',{fileChanges:[{path:'/',kind:{type:'delete'}}]}],
] as const)('H2 native normalization retains visible roots after capacity: %s',(_name,fields)=>{
 const f=fixture();try{
  const input={padding:'x'.repeat(17*1024*1024),...fields};
  // MAIN RULING 3 (REDESIGN-WIPE-NARROW §12 D3): an edit path alone is not a delete.
  expect(d.decide(f.open('native-capacity',input,{tool:'edit_files',toolCall:{name:'edit_files',input}}),baseRun).kind).toBe(_name==='camel-path'?'run':'card');
 }finally{f.dispose();}
});
