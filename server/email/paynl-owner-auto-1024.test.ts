// SPDX-License-Identifier: AGPL-3.0-or-later
// MONEY #6 (MAIN, 1.0.24): with sending set to "auto", the owner's own typed turn sends to an approved contact without waiting on an attachment or
// more than 8,000 characters. Email-triggered, routine and webhook turns keep both holds. Entry: SendService.submit (send-service.ts) on the real
// decision fixture, so the origin proof (decision/trust-origin.ts) is the production one.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, d } from '../decision/fixture.ts';
import { createMemoryEmailRuntime } from '../testing/email-store-fixture.ts';
import { EmailRuntime } from './runtime.ts';
import { FakeFlux, type FakeReply } from '../testing/fake-flux-email.ts';
import { forgetAllEmailTurns, emailGeneration } from './email-turns.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { BotRecord } from '../store.ts';
let root = '', runtime: EmailRuntime | undefined;
afterEach(() => { runtime?.stop(); if(root)removeTempDirSync(root); root=''; forgetAllEmailTurns(); });
async function setup(level: 'unlimited' | 'ask' = 'unlimited', initiator?: Parameters<typeof fixture>[1], sendReply?: FakeReply) {
  const f=fixture(level, initiator), fake=new FakeFlux();
  let generation='g', offered=true;
  const issue=d.installClaimVerifier(proof=>proof==='trusted'?{threadId:'t',botId:'b',generation}:undefined);
  root=mkdtempSync(join(tmpdir(),'email-nl-1019-'));
  const bot={id:'b',threadId:'t',name:'Fixture'} as BotRecord;
  const authority=()=>({claim:issue('trusted')!,proof:'trusted',identity:{threadId:'t',generation}});
  const appendCard=vi.fn();
  fake.always('GET', /\/capabilities$/, {status:200,body:{enabled:true,available:true}});
  fake.always('GET', /\/approvals$/, {status:200,body:{data:[]}});
  fake.always('POST', /\/messages(?:\/msg\/reply)?$/, sendReply ?? {status:200,body:{status:'sent',message_id:'sent'}});
  runtime=createMemoryEmailRuntime({authorityFor:authority,offered:()=>offered,accountKey:()=> 'account-fixture',database:()=>f.db,transaction:fn=>fn(),fetch:fake.fetch,
    apiBase:'https://api.flux.test',appBase:'https://app.flux.test',workspaceRoot:()=>root,bot:()=>bot,
    cardHost:{botName:()=> 'Fixture',threadExists:()=>true,card:()=>null,appendCard,patchCard:vi.fn(),outcome:vi.fn(),activity:vi.fn(),notify:vi.fn()}});
  await runtime.start(); runtime.stop();
  runtime.secrets.setBotKey('b',{token:'bot-fixture',keyId:'bot-key'});
  runtime.secrets.setOwner({token:'owner-fixture',keyId:'owner-key'});
  const services=runtime.services()!;
  services.store.insertBinding({botId:'b',inboxId:'ibx',address:'fixture@murage.email',username:'fixture',displayName:'Fixture',emailKeyRef:'bot-key',fluxAccountId:null,state:'active',step:null,opId:null,opStartedAt:null,policy:'ask',failure:null,updatedAt:Date.now()});
  fake.always('GET', /\/inboxes\/ibx$/, { status: 200, body: { id: 'ibx', state: 'active' } });
  expect(await services.bindings.proveOwner('b')).toBe('proven');
  const input={driverKind:'claudeAgent',agentsMcp:true,surfacesForOwner:true,directOwnerAudience:true,origin:'desktop',automationThread:false,bot,threadId:'t'};
  const live={bot:()=>bot,ownerSurface:()=>true,notOwnerAudience:()=>false,ownerThread:()=>true,boundRequest:()=>false};
  const call=(tool:string,body:unknown,generation='g')=>runtime!.call(tool,{botId:'b',threadId:'t',generation},body,live);
  return {f,fake,services,input,live,call,appendCard,off:()=>{offered=false;},setGeneration:(next:string)=>{generation=next;f.setGeneration(next);}};
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const draft = (patch: object = {}) => ({ kind: 'send' as const, to: ['jane@acme.test'], cc: [], subject: 'Thursday', text: 'Hi Jane', attachments: [], replyTo: null, ...patch });
const ROWS: Array<{ row: string; patch: object }> = [
  { row: 'attachment', patch: { attachments: [{ name: 'chart.png', contentType: 'image/png', bytes: PNG }] } },
  { row: 'long text (9,000 chars)', patch: { text: 'a'.repeat(9_000) } },
];
const INITIATORS: Array<{ who: string; initiator: Parameters<typeof fixture>[1]; goes: boolean }> = [
  { who: 'owner typed turn', initiator: { k: 'owner-typed' }, goes: true },
  { who: 'webhook-triggered turn', initiator: { k: 'webhook' }, goes: false },
];
for (const { row, patch } of ROWS) for (const { who, initiator, goes } of INITIATORS) it(`M6 policy auto, approved contact, ${row}: ${who} ${goes ? 'sends without waiting' : 'still waits for the owner'}`, async () => {
  const x = await setup('ask', initiator);
  const binding = x.services.store.getBinding('b')!;
  x.services.store.casBinding('b', binding.revision, { policy: 'auto' }, Date.now());
  x.services.store.addTrusted('b', 'jane@acme.test', 'allow', 'approval', Date.now());
  const result = await x.services.send.submit({ botId: 'b', generation: emailGeneration('g'), threadId: 't', draft: draft(patch) });
  expect(result.status).toBe('accepted');
  if (goes) {
    expect(result.status === 'accepted' && result.row.state).toBe('sent');
    expect(x.fake.calls('POST', /\/messages$/)).toHaveLength(1);
  } else {
    expect(result.status === 'accepted' && result.row.state).toBe('awaiting_owner');
    expect(x.fake.calls('POST', /\/messages$/)).toHaveLength(0);
  }
});
it('M6 the owner turn still waits for a contact the owner has not approved (policy auto, attachment)', async () => {
  const x = await setup('ask', { k: 'owner-typed' });
  const binding = x.services.store.getBinding('b')!;
  x.services.store.casBinding('b', binding.revision, { policy: 'auto' }, Date.now());
  const result = await x.services.send.submit({ botId: 'b', generation: emailGeneration('g'), threadId: 't', draft: draft({ attachments: [{ name: 'chart.png', contentType: 'image/png', bytes: PNG }] }) });
  expect(result.status === 'accepted' && result.row.state).toBe('awaiting_owner');
  expect(x.fake.calls('POST', /\/messages$/)).toHaveLength(0);
});
it('M6 a row made by an earlier turn does not borrow the live owner turn (row generation != the live authority generation)', async () => {
  const x = await setup('ask', { k: 'owner-typed' });
  const binding = x.services.store.getBinding('b')!;
  x.services.store.casBinding('b', binding.revision, { policy: 'auto' }, Date.now());
  x.services.store.addTrusted('b', 'jane@acme.test', 'allow', 'approval', Date.now());
  const result = await x.services.send.submit({ botId: 'b', generation: emailGeneration('an-earlier-turn'), threadId: 't', draft: draft({ text: 'a'.repeat(9_000) }) });
  expect(result.status === 'accepted' && result.row.state).toBe('awaiting_owner');
  expect(x.fake.calls('POST', /\/messages$/)).toHaveLength(0);
});
it('M6 policy ask: the owner turn still waits (attachment, approved contact)', async () => {
  const x = await setup('ask', { k: 'owner-typed' });
  x.services.store.addTrusted('b', 'jane@acme.test', 'allow', 'approval', Date.now());
  const result = await x.services.send.submit({ botId: 'b', generation: emailGeneration('g'), threadId: 't', draft: draft({ attachments: [{ name: 'chart.png', contentType: 'image/png', bytes: PNG }] }) });
  expect(result.status === 'accepted' && result.row.state).toBe('awaiting_owner');
});
