// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {installProducerBindings} from '../decision/index.ts';
import {serviceQueue} from '../narrow-denials.ts';
import {EmailSendService} from './send-service.ts';
it('H6 email startup reuses the queue already registered by the decision host',()=>{
 const queue=serviceQueue('email');
 const dispose=installProducerBindings({authorityFor:()=>undefined,registerQueue:()=>()=>{}});
 try {
  // Queue construction is independent of the store/client; no send is made.
  let service:EmailSendService|undefined;
  expect(()=>{service=new EmailSendService({} as ConstructorParameters<typeof EmailSendService>[0]);}).not.toThrow();
  expect(service!.approvalQueue()).toBe(queue);
 }finally{dispose();}
});

it('H5 email runtime hands the registered owner-turn authority to its send service',async()=>{
 const {EmailRuntime}=await import('./runtime.ts');
 const {FakeFlux}=await import('../testing/fake-flux-email.ts');
 const {fixture}=await import('../decision/fixture.ts');
 const f=fixture();
 const authority={claim:f.claim,proof:'trusted',identity:{threadId:'t',generation:'g'}};
 const fake=new FakeFlux();fake.always('GET',/^\/v1\/email\/capabilities$/,{status:200,body:{object:'email.capabilities',enabled:true,available:true,account_state:'active',terms_version:'v1',limits:{}}});
 const runtime=new EmailRuntime({accountKey:()=> 'sk-flux-fixture',database:()=>f.db,transaction:fn=>fn(),fetch:fake.fetch,apiBase:'https://api.flux.test',appBase:'https://app.flux.test',workspaceRoot:()=>undefined,bot:()=>undefined,
  authorityFor:(threadId,botId)=>threadId==='t'&&botId==='b'?authority:undefined});
 await runtime.probe.refresh();
 expect(runtime.services()!.send.authorityFor('t','b')).toBe(authority);
 expect(runtime.services()!.send.authorityFor('guest','b')).toBeUndefined();f.dispose();
});
