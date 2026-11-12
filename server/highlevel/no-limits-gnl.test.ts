// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { highLevelHarness, scriptCrm, until, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { bindServiceTurn } from '../service-no-limits.ts';
import { createHighLevelRuntime } from './runtime.ts';
import { HighLevelHost } from './host.ts';
import { FileRpcApprovalJournal } from './rpc-approval-replay.ts';
import { accessRoleBinding } from '../bot-access-role.ts';
import { defaultHighLevelFamilies } from '../../shared/highlevel.ts';
import { fixtureSpec } from '../testing/highlevel-r4-fixtures.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { z } from 'zod';
const cleanups: Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const clean of cleanups.splice(0).reverse())await clean();});
function fixture(noLimits=true){
 const h=highLevelHarness();cleanups.push(h.stop);scriptCrm(h.api);
 const access:any={revision:1,roleBinding:accessRoleBinding(h.bot),grantsVersion:2,denyRules:[],grants:[{...h.grant(),families:{...defaultHighLevelFamilies(),contacts:'full'}}]};
 h.bot.highlevelAccess=access;
 bindServiceTurn(h.claim.generation,h.claim.threadId,h.claim.botId,()=>h.capabilities.isActive(h.claim),()=>({ownerAudience:true,origin:'owner',noLimits}));
 let written=false;
 h.api.first('GET',/^\/contacts\/contact_1$/,()=>({status:200,body:{contact:{id:'contact_1',locationId:FAKE_LOCATION_ID,firstName:written?'Reviewed':'Before'}}}));
 h.api.always('PUT',/^\/contacts\/contact_1$/,()=>{written=true;return {status:200,body:{contact:{id:'contact_1',firstName:'Reviewed'}}};});
 const host=new HighLevelHost({...h,bot:()=>h.bot,operationScopes:()=>['contacts.readonly','contacts.write'],onReview:(_claim,r)=>h.reviews.push(r)});
 const call=()=>host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.update',args:{contactId:'contact_1',firstName:'Reviewed'}});
 return {...h,host,access,call};
}
it.each(['read','operation','empty-operations','ceiling','restricted'] as const)('F1 No limits runs through %s grant restriction without review',async restriction=>{
 const h=fixture();const g=h.access.grants[0];
 if(restriction==='read')g.families.contacts='read';
 if(restriction==='operation')g.operations={contacts:['contacts.get']};
 if(restriction==='empty-operations'){g.operations={contacts:[]};g.families=Object.fromEntries(Object.keys(g.families).map(f=>[f,f==='contacts'?'change':'off']));}
 if(restriction==='ceiling')g.ceiling='read';
 if(restriction==='restricted')h.bot.connectedAppAccess={revision:1,roleBinding:accessRoleBinding(h.bot),mode:'restricted',allowWrites:false,grants:[],requests:[]};
 const listed:any=await h.host.handle(h.claim,{id:1,method:'tools/list'});
 expect(listed.result.tools.find((t:any)=>t.name==='HIGHLEVEL_CONTACTS')?.inputSchema.properties.operation.enum).toContain('contacts.update');
 expect(await h.call()).not.toMatchObject({isError:true});expect(h.api.calls('PUT')).toHaveLength(1);expect(h.reviews).toHaveLength(0);
});
it.each(['bulk','sixth-send','identical-loop'] as const)('F1 No limits runs %s escalation on Can change',async escalation=>{
 const h=fixture();h.access.grants[0].families.contacts='change';
 const spec=fixtureSpec({id:'contacts.update',family:'contacts',risk:'C',send:escalation==='sixth-send',title:'Fixture',endpoint:HIGHLEVEL_ENDPOINTS['contacts.update'],nested:false,preflight:[],args:z.object({contactId:z.string(),message:z.string()}),recordRefs:(a:any)=>[a.contactId],fields:()=>['message'],targets:()=>escalation==='bulk'?2:1,project:(v:any)=>v},a=>({path:`/contacts/${a.contactId}`,resource:'',body:{kind:'json',value:{message:a.message}}}));
 const host=new HighLevelHost({...h,bot:()=>h.bot,operationSpec:()=>spec,operationScopes:()=>['contacts.readonly','contacts.write']});
 const count=escalation==='sixth-send'?6:escalation==='identical-loop'?4:1;
 for(let i=0;i<count;i++)expect(await host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.update',args:{contactId:'contact_1',message:escalation==='sixth-send'?String(i):'same'}})).not.toMatchObject({isError:true});
 expect(h.api.calls('PUT')).toHaveLength(count);expect(h.reviews).toHaveLength(0);
});
it.each(['off','apps-off','draft','no-grant','disconnected'] as const)('F1 disabled %s stays off with no card',async off=>{
 const h=fixture();
 if(off==='off')h.access.grants[0].families.contacts='off';
 if(off==='apps-off')h.bot.composio=false;
 if(off==='draft')h.bot.draftOnly=true;
 if(off==='no-grant')h.access.grants=[];
 if(off==='disconnected')h.leases.views.get('hl_conn_1')!.state='needs_reconnect';
 const result=await h.call();expect(result.isError).toBe(true);expect(result.content).toHaveLength(1);expect(h.api.requests).toHaveLength(0);expect(h.reviews).toHaveLength(0);
});
it.each([['not-a-rule'],[null],{broken:true}] as unknown[])('F2 malformed deny rules retain real runtime mounts and No limits dispatch: %j',async denyRules=>{
 const h=fixture();h.access.denyRules=denyRules;Object.assign(h.bot,{autoApprove:true,fullAccess:true,noLimits:true});
 const dataDir=mkdtempSync(join(tmpdir(),'gnl-runtime-'));cleanups.push(()=>removeTempDir(dataDir));
 const rt=createHighLevelRuntime({dataDir,capabilities:h.capabilities,signals:h.signals,bot:()=>h.bot,leases:h.leases,fetch:h.api.fetch,threadMarkState:()=> 'marked',operationScopes:()=>['contacts.readonly','contacts.write']});cleanups.push(rt.close);
 expect(await rt.mountsFor(h.bot.id)).toBe(true);
 const result=await rt.host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.update',args:{contactId:'contact_1',firstName:'Reviewed'}});
 expect(result).not.toMatchObject({isError:true});expect(h.api.calls('PUT')).toHaveLength(1);
});
it.each([['not-a-rule'],[null],{broken:true}] as unknown[])('F2 malformed deny rules below No limits preserve invalid access: %j',async denyRules=>{
 const h=fixture(false);h.access.denyRules=denyRules;
 const dataDir=mkdtempSync(join(tmpdir(),'gnl-below-runtime-'));cleanups.push(()=>removeTempDir(dataDir));
 const rt=createHighLevelRuntime({dataDir,capabilities:h.capabilities,signals:h.signals,bot:()=>h.bot,leases:h.leases,fetch:h.api.fetch,threadMarkState:()=> 'marked',operationScopes:()=>['contacts.readonly','contacts.write']});cleanups.push(rt.close);
 expect(await rt.mountsFor(h.bot.id)).toBe(false);
 expect(await rt.host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.get',args:{contactId:'contact_1'}})).toMatchObject({isError:true});
 expect(await rt.host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.update',args:{contactId:'contact_1',firstName:'Reviewed'}})).toMatchObject({isError:true});
 expect(h.api.requests).toHaveLength(0);expect(h.reviews).toHaveLength(0);
});
it.each(['lease','provider'] as const)('F4 settings save during %s wait re-evaluates No limits',async boundary=>{
 const h=fixture();let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});let waiting=false;
 if(boundary==='lease')h.leases.hold=hold;
 else h.api.first('PUT',/^\/contacts\/contact_1$/,async()=>{waiting=true;await hold;return {status:200,body:{contact:{id:'contact_1',firstName:'Reviewed'}}};});
 const pending=h.call();await until(()=>boundary==='lease'?h.leases.leaseRequests.length>0:waiting);
 h.access.revision++;h.access.grants[0].revision++;h.access.denyRules=['HIGHLEVEL:C'];
 h.bot.connectedAppAccess={revision:3,roleBinding:accessRoleBinding(h.bot),mode:'restricted',allowWrites:false,grants:[],requests:[]};
 release();expect(await pending).not.toMatchObject({isError:true});expect(h.api.calls('PUT')).toHaveLength(1);expect(h.reviews).toHaveLength(0);
});
it('F1 bulk destructive delete reaches the wipe review while bulk updates run',async()=>{
 const h=fixture();
 const spec=fixtureSpec({id:'contacts.delete',family:'contacts',risk:'D',title:'Fixture wipe',endpoint:HIGHLEVEL_ENDPOINTS['contacts.delete'],nested:false,preflight:[],args:z.object({contactId:z.string()}),recordRefs:(a:any)=>[a.contactId],fields:()=>[],targets:()=>30,project:(v:any)=>v},a=>({path:`/contacts/${a.contactId}`,resource:''}));
 const host=new HighLevelHost({...h,bot:()=>h.bot,operationSpec:()=>spec,operationScopes:()=>['contacts.readonly','contacts.write'],onReview:(_claim,r)=>h.reviews.push(r)});
 const pending=host.call(h.claim,'HIGHLEVEL_CONTACTS',{operation:'contacts.delete',args:{contactId:'contact_1'}});
 await until(()=>h.reviews.length>0);expect(h.api.calls('DELETE')).toHaveLength(0);
 h.actions.deny(h.reviews[0]!.actionId);expect(await pending).toMatchObject({isError:true});
});

it('F1 No limits removes two followers from one opportunity without wipe review',async()=>{
 const h=fixture();h.access.grants[0].families.opportunities='change';let removed=false;
 const dataDir=mkdtempSync(join(tmpdir(),'gnl-followers-'));cleanups.push(()=>removeTempDir(dataDir));
 const approvalJournal=new FileRpcApprovalJournal(join(dataDir,'approvals'));
 h.api.always('GET',/^\/opportunities\/pipelines$/,()=>({status:200,body:{pipelines:[{id:'pipe_A',stages:[]}]}}));
 h.api.always('GET',/^\/opportunities\/opp_A$/,()=>({status:200,body:{opportunity:{id:'opp_A',pipelineId:'pipe_1',followers:removed?[]:['user_A','user_B']}}}));
 h.api.always('GET',/^\/users\/(user_A|user_B)$/,req=>({status:200,body:{id:req.path.split('/').at(-1),roles:{locationIds:[FAKE_LOCATION_ID]}}}));
 h.api.always('DELETE',/^\/opportunities\/opp_A\/followers$/,()=>{removed=true;return {status:200,body:{followersRemoved:['user_A','user_B']}};});
 const host=new HighLevelHost({...h,approvalJournal,bot:()=>h.bot,operationScopes:()=>['opportunities.readonly','opportunities.write','users.readonly'],onReview:(_claim,r)=>{h.reviews.push(r);h.actions.deny(r.actionId);}});
 const result=await host.call(h.claim,'HIGHLEVEL_OPPORTUNITIES',{operation:'opportunities.followers.remove',args:{opportunityId:'opp_A',followers:['user_A','user_B']}});
 expect(h.reviews).toHaveLength(0);expect(result,JSON.stringify({result,requests:h.api.requests.map(({method,path,body})=>({method,path,body}))})).not.toMatchObject({isError:true});expect(h.api.calls('DELETE')).toHaveLength(1);expect(h.api.unexpected).toEqual([]);
});
