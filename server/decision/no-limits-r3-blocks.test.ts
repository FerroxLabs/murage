// SPDX-License-Identifier: AGPL-3.0-or-later
// Mounted code tools reach the real decision and final provider writer. No code executes.
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
const mounts={toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]};
const cases=[['python',"import shutil; shutil.rmtree('/')",'print("safe")'],['node',"require('fs').rmSync('/', {recursive:true})",'console.log("safe")']] as const;
for(const [lang,wipe,safe]of cases)for(const dangerous of [false,true])it(`B1 mounted ${lang} ingress wipe=${dangerous}`,async()=>{
 const f=fixture(),tool=`mcp__fixture__${lang}`,input={code:dangerous?wipe:safe};
 try{
  const h=f.open('code',input,{tool,toolCall:{name:tool,input},...mounts}),out=d.decide(h,baseRun);
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: mounted literal interpreter
  // deletion of / is a wipe; the original safe-code twin still runs.
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
  expect(out.kind).toBe(dangerous?'card':'run');
  if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});await d.answerApproval(out.ref,{behavior:'allow'});}
  else await d.deliverRequest(h);
  expect(f.respond.mock.calls.map(call=>call[1].behavior)).toEqual(['allow']);
 }finally{f.dispose();}
});
for(const [lang,wipe,safe]of cases)for(const mode of ['replacement','refreshed'] as const)it(`B1 mounted ${lang} release ${mode} blocks fresh wipe`,()=>{
 const f=fixture(),tool=`mcp__fixture__${lang}`,input={code:safe};
 try{
  const h=f.open('code-release',input,{tool,toolCall:{name:tool,input},...mounts});expect(d.decide(h,baseRun).kind).toBe('run');
  if(mode==='refreshed')f.publish(f.event('code-release',{code:wipe},{tool,toolCall:{name:tool,input:{code:wipe}},...mounts}));
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: a fresh literal root wipe
  // must stop at release as well as ingress, including retained mount metadata.
  expect(guardEngineRelease({threadId:'t',requestId:'code-release',turnId:'turn',providerInstanceId:'p'},mode==='replacement'?{code:wipe}:undefined)).toBe(false);
  expect(d.openApprovals('t')).toHaveLength(1);
expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
