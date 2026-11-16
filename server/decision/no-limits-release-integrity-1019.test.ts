// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN 2026-11-12 C1 supersedes the protected-path/integrity holds in C7.
// Reader/exact-operation tests remain in release-guard.test.ts; these exercise
// permission at the actual writer, with inert commands and fake transport.
import {mkdtempSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTempDir} from '../testing/cleanup.ts';
import {expect,it} from 'vitest';
import {guardEngineRelease} from './provider-release.ts';
import {fixture,d,baseRun,baseCard} from './fixture.ts';
it.each([false,true])('C7 repeated raw input runs without a visible wipe changed=%s',async changed=>{
 const f=fixture(),metadata='fixture '.repeat(150000);
 const h=f.open('duplicate',{metadata,command:'echo fixture'});expect(d.decide(h,baseRun)).toEqual({kind:'run'});
 f.publish(f.event('duplicate',{metadata,command:changed?'printf x > /etc/hosts':'echo fixture'}));
 await d.deliverRequest(h);expect(f.respond.mock.calls.filter(row=>row[1].behavior==='allow')).toHaveLength(1);
 expect(d.openApprovals('t')).toEqual([]);f.dispose();
});
it.each(['ask','full'] as const)('C7 protected destination runs after mode upgrade from %s',async level=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-upgrade-')),target=join(root,'notes');
 try{
  const f=fixture(level),input={path:target,content:'fake-only'.repeat(200000)};
  const handle=f.open('upgrade',input,{tool:'write_file',toolCall:{name:'write_file',input}}),outcome=d.decide(handle,baseCard);
  expect(outcome.kind).toBe('card');if(outcome.kind!=='card')throw Error('expected base card');
  await d.presentApproval(outcome.ref,{title:'Write',subtitle:'Fixture'});
  symlinkSync('/etc/hosts',target);f.setLevel('unlimited');await d.onLevelChange('b');
  expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toEqual([]);f.dispose();
 }finally{await removeTempDir(root);}
});
it('C7 mode upgrade keeps a visible catastrophe on a card',async()=>{
 const f=fixture('ask'),h=f.open('wipe-upgrade',{command:'rm -rf /'}),outcome=d.decide(h,baseCard);
 expect(outcome.kind).toBe('card');if(outcome.kind!=='card')throw Error('expected base card');await d.presentApproval(outcome.ref,{title:'Delete',subtitle:'Fixture'});
 f.setLevel('unlimited');await d.onLevelChange('b');expect(f.respond).not.toHaveBeenCalled();expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({why:'wipe'}));f.dispose();
});
it.each([false,true])('C7 final release binds current No limits posture changed=%s',async changed=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-final-mode-')),target=join(root,'notes');
 try{const f=fixture('full'),handle=f.open('late-mode',{command:`printf x > '${target}'`,cwd:root});expect(d.decide(handle,baseRun)).toEqual({kind:'run'});f.setLevel('unlimited');if(changed)symlinkSync('/etc/hosts',target);await d.deliverRequest(handle);expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toEqual([]);f.dispose();}finally{await removeTempDir(root);}
});
it('C7 native writer checks updated input for a catastrophe',()=>{
 const f=fixture(),h=f.open('native-update',{command:'printf ok'});expect(d.decide(h,baseRun)).toEqual({kind:'run'});
 const id={threadId:'t',turnId:'turn',requestId:'native-update',providerInstanceId:'p'};
 expect(guardEngineRelease(id,{command:'printf x > /etc/hosts'})).toBe(true);
 expect(guardEngineRelease(id,{command:'rm -rf /'})).toBe(false);
 expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({why:'wipe'}));f.dispose();
});
it('C7 final release retains the current Full access bypass after a mode change',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-final-full-')),target=join(root,'notes');
 try{const f=fixture(),handle=f.open('late-full',{command:`printf x > '${target}'`,cwd:root});expect(d.decide(handle,baseRun)).toEqual({kind:'run'});f.setLevel('full');symlinkSync('/etc/hosts',target);await d.deliverRequest(handle);expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toEqual([]);f.dispose();}finally{await removeTempDir(root);}
});
