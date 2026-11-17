// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fixture operations. Historical adapters do not implement argv/path logic.
import { fixture, d, baseRun, baseCard } from '../../decision/fixture.ts';
import { guardEngineRelease } from '../../decision/provider-release.ts';
export { fixture, d, baseRun, baseCard };
export function decideFixture(tool:string,input:unknown,extra:Record<string,any>={}) {
 const f=fixture(extra.level??'unlimited',extra.initiator??{k:'owner-typed'});
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Whole root'}),executionContext:extra.executionContext??(()=>extra.context??{}),...(extra.featureOff?{featureOff:()=>extra.featureOff}:{})});
 d.installEngineApprovalBuilder(r=>({options:r.snapshot?.event.choices??['Allow','Deny']}));
 try{if(extra.owner===false)f.setOwner(false);return d.decide(f.open('request',input,{tool,toolCall:{name:tool,input},...extra.event}),(extra.level&&extra.level!=='unlimited'||extra.initiator?.k==='guest'||extra.owner===false)?baseCard:baseRun);}finally{f.dispose();}
}
export async function releaseFixture(tool:string,input:unknown,updatedInput:unknown,context:object) {
 const f=fixture();
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Release'}),executionContext:()=>context});
 d.installEngineApprovalBuilder(r=>({options:r.snapshot?.event.choices??['Allow','Deny']}));
 try{
  const first=d.decide(f.open('release',input,{tool,toolCall:{name:tool,input}}),baseRun);
  if(first.kind==='card'){await d.presentApproval(first.ref,{title:'Fixture',subtitle:'Release'});await d.answerApproval(first.ref,{behavior:'allow'});}
  const released=guardEngineRelease({threadId:'t',requestId:'release',turnId:'turn',providerInstanceId:'p'},updatedInput as any);
  return {first:first.kind,released};
 }finally{f.dispose();}
}
