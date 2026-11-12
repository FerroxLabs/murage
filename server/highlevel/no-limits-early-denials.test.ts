import {botAccessPolicy} from '../bot-access-role.ts';
import {HighLevelHost,highlevelApprovalBasis} from './host.ts';
import {expect,it} from 'vitest';
import {defaultHighLevelFamilies} from '../../shared/highlevel.ts';
import {bindServiceTurn} from '../service-no-limits.ts';
import {highLevelHarness,scriptCrm} from '../testing/fake-highlevel.ts';
it.each(['HIGHLEVEL_CONTACTS','HIGHLEVEL:contacts.tags.add','HIGHLEVEL:C','permission-writes-off'])('EARLY-HL-DENY persisted owner rule %s runs with provider work and no review',async rule=>{
 const h=highLevelHarness();scriptCrm(h.api);h.api.first('POST',/^\/contacts\/contact_1\/tags$/,{status:200,body:{tags:['vip','newsletter','fixture']}});
 h.bot.highlevelAccess={...(h.bot.highlevelAccess as object),grantsVersion:2,denyRules:rule.startsWith('HIGHLEVEL')?[rule]:[],grants:[{...h.grant(),families:{...defaultHighLevelFamilies(),contacts:'full'}}]};
 if(rule==='permission-writes-off')h.bot.connectedAppAccess={...botAccessPolicy(h.bot),mode:'restricted',allowWrites:false};
 bindServiceTurn(h.claim.generation,h.claim.threadId,h.claim.botId,()=>h.capabilities.isActive(h.claim),()=>({ownerAudience:true,origin:'owner',noLimits:true}));
 const host=new HighLevelHost({...h,bot:()=>h.bot,operationScopes:()=>['contacts.readonly','contacts.write'],approvalBasis:(_claim,spec,risk)=>highlevelApprovalBasis({risk,noLimits:true,operation:spec.id}),onReview:(_claim,review)=>h.reviews.push(review)});
 try{
  const result=await host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.tags.add',args:{contactId:'contact_1',tags:['fixture']}});
  expect(h.api.requests.some(r=>r.method==='POST'),JSON.stringify(result)).toBe(true);expect(h.reviews).toHaveLength(0);
  expect(result.isError,JSON.stringify(result)).not.toBe(true);
 }finally{h.stop();}
});

it.each(['disabled','disconnected'])('EARLY-HL-OFF %s integration never dispatches or cards',async state=>{
 const h=highLevelHarness();scriptCrm(h.api);
 h.bot.highlevelAccess={...(h.bot.highlevelAccess as object),grantsVersion:2,grants:[{...h.grant(),families:{...defaultHighLevelFamilies(),contacts:'full'}}]};
 if(state==='disabled')h.bot.composio=false;else h.leases.views.get(h.grant().accountId)!.state='disconnected';
 bindServiceTurn(h.claim.generation,h.claim.threadId,h.claim.botId,()=>h.capabilities.isActive(h.claim),()=>({ownerAudience:true,origin:'owner',noLimits:true}));
 const host=new HighLevelHost({...h,bot:()=>h.bot,operationScopes:()=>['contacts.readonly','contacts.write'],onReview:(_claim,review)=>h.reviews.push(review)});
 try{
  const result=await host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.tags.add',args:{contactId:'contact_1',tags:['fixture']}});
  expect(result.isError).toBe(true);expect(h.api.requests).toHaveLength(0);expect(h.reviews).toHaveLength(0);
  expect(result.content).toHaveLength(1);expect(JSON.stringify(result.content)).toContain('settings');
 }finally{h.stop();}
});
