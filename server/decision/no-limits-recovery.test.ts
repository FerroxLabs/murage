// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
import {registerRecoveryScriptRequest,isRecoveryScriptRequest} from '../no-limits-wipe-scripts.ts';
const identity={threadId:'t',providerInstanceId:'p',turnId:'turn',requestId:'recovery'};
it('R4 host recovery marker is scoped and removed at retirement',async()=>{
 const f=fixture(),release=registerRecoveryScriptRequest(identity);
 try{
  const h=f.open('recovery',{command:'bash -e cleanup.sh'}),out=d.decide(h,baseRun);
  expect(out.kind).toBe('run'); // MAIN RULING 2026-11-13 narrow-wipe (Sean)

  if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
  expect(guardEngineRelease(identity)).toBe(true);expect(f.respond).not.toHaveBeenCalled();
  for(const field of ['threadId','providerInstanceId','turnId','requestId'] as const)expect(isRecoveryScriptRequest({...identity,[field]:'other'})).toBe(false);
  release();expect(isRecoveryScriptRequest(identity)).toBe(false);
 }finally{release();f.dispose();}
});
it('R4 serialized recovery flags cannot change the authenticated path',()=>{
 const f=fixture();
 try{
  const input={command:'bash -e cleanup.sh',recoveryScript:true};
  const h=f.open('recovery',input,{recoveryScript:true});
  expect(d.decide(h,baseRun).kind).toBe('run');
 }finally{f.dispose();}
});
it('R4 final writer checks a replacement script on a registered recovery request',()=>{
 const f=fixture(),release=registerRecoveryScriptRequest(identity);
 try{
  const h=f.open('recovery',{command:"bash -c 'echo ok'"});expect(d.decide(h,baseRun).kind).toBe('run');
  expect(guardEngineRelease(identity,{command:'bash -e cleanup.sh'})).toBe(true); // MAIN RULING 2026-11-13 narrow-wipe (Sean)

  expect(d.openApprovals('t')).toHaveLength(0); // MAIN RULING 2026-11-13 narrow-wipe (Sean)
expect(f.respond).not.toHaveBeenCalled();
 }finally{release();f.dispose();}
});
