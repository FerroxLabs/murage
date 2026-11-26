// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Historical test IDs are retained for exact release comparison. Assertions follow the later Sean/MAIN 12:40Z guest-Ask ruling.
import { randomUUID } from 'node:crypto';
import { fixture } from './decision/fixture.ts';
import * as registry from './decision/index.ts';
import { describe, expect, it } from 'vitest';
import { installPermissionInheritance } from './permission-inheritance.ts';
import { noLimitsAppliesTo, type NoLimitsOrigin } from './no-limits-origin.ts';
import { bindServiceTurn, serviceFolderTrust, serviceNoLimits, serviceThreadNoLimits, type ServiceTurnFacts } from './service-no-limits.ts';
const bot = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };
describe('G-NL service origin rule', () => {
  it.each(['owner','owner-channel','routine','owner-routine','webhook','unattended'] as NoLimitsOrigin[])('O1 %s keeps effective No limits', origin => {
    expect(noLimitsAppliesTo(origin, bot)).toBe(true);
    for (const lower of [{ autoApprove: false }, { fullAccess: false }, { noLimits: false }, { draftOnly: true }]) expect(noLimitsAppliesTo(origin, { ...bot, ...lower })).toBe(false);
  });
  it.each(['guest','other-human','other'] as NoLimitsOrigin[])('O2 %s never inherits and applies a recorded No limits selection', origin => {
    expect(noLimitsAppliesTo(origin, bot)).toBe(false); // A bot level never authorizes a stranger.
    expect(noLimitsAppliesTo(origin, { ...bot, permissionExplicit: false })).toBe(false);
    expect(noLimitsAppliesTo(origin, { ...bot, permissionExplicit: true })).toBe(false);
    expect(noLimitsAppliesTo(origin, { ...bot, permissionRev: 1 })).toBe(false);
  });
  it('O2 inherited owner defaults never open guest threads, while explicit bot choices apply', () => {
    const restore=installPermissionInheritance(()=>true);
    try {
      const inherited={autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:false};
      expect(noLimitsAppliesTo('owner',inherited)).toBe(true);
      expect(noLimitsAppliesTo('webhook',inherited)).toBe(true);
      expect(noLimitsAppliesTo('guest',inherited)).toBe(false);
      expect(noLimitsAppliesTo('guest',{...bot,permissionExplicit:true})).toBe(false);
      expect(noLimitsAppliesTo('owner-channel',{...inherited,fullAccessChannelMessages:false})).toBe(false);
      const generation=randomUUID(),thread=randomUUID();
      bindServiceTurn(generation,thread,'bot',()=>true,()=>({ownerAudience:false,origin:'guest',noLimits:true,explicitNoLimits:false}));
      expect(serviceNoLimits(generation,thread,'bot')).toBe(false);
    } finally {restore();}
  });
  it('O3 channel off and unproven starts never gain relief', () => {
    expect(noLimitsAppliesTo('owner-channel', { ...bot, permissionExplicit: true, fullAccessChannelMessages: false })).toBe(false);
    expect(noLimitsAppliesTo('unproven', { ...bot, permissionExplicit: true })).toBe(false);
  });
  it('O4 authority follows live level and exact generation, bot and thread', () => {
    const generation = randomUUID(), thread = randomUUID(); let active = true;
    const facts: ServiceTurnFacts = { ownerAudience: true, origin: 'webhook', noLimits: true };
    bindServiceTurn(generation, thread, 'bot', () => active, () => facts);
    expect(serviceNoLimits(generation, thread, 'bot')).toBe(true);
    expect(serviceNoLimits(generation, thread, 'wrong')).toBe(false);
    expect(serviceNoLimits(generation, 'wrong', 'bot')).toBe(false);
    expect(serviceThreadNoLimits(thread, 'bot')).toBe(true);
    facts.draftOnly = true; expect(serviceNoLimits(generation)).toBe(false);
    facts.draftOnly = false;
    facts.noLimits = false; expect(serviceNoLimits(generation)).toBe(false);
    facts.noLimits = true; active = false; expect(serviceNoLimits(generation)).toBe(false);
    bindServiceTurn('next', thread, 'bot', () => true, () => facts);
    expect(serviceNoLimits(generation)).toBe(false);
  });
  it('O6 automated origins keep the bot level; guest inheritance and unproven starts stay Ask', () => {
    const generation=randomUUID(), thread=randomUUID();
    const facts:ServiceTurnFacts={ownerAudience:true,origin:'webhook',noLimits:true,explicitNoLimits:false};
    bindServiceTurn(generation,thread,'bot',()=>true,()=>facts);
    expect(serviceNoLimits(generation)).toBe(true);
    facts.ownerAudience=false;
    // MAIN RULING GROK-FUPRUL FIXTURE (No limits fail-open): automated origins also require the live owner audience.
    expect(serviceNoLimits(generation)).toBe(false);
    facts.origin='guest';expect(serviceNoLimits(generation)).toBe(false);
    facts.explicitNoLimits=true;expect(serviceNoLimits(generation)).toBe(false);
    facts.origin='unproven';expect(serviceNoLimits(generation)).toBe(false);
  });
  it('O5 room event limits follow the exact live producer identity', () => {
    // MAIN RULING GROK-FUPRUL: verify the real opaque claim, including rejected bindings, instead of mocking an accepted authority.
    const f=fixture(),threadId='t',botId='b';
    const remove=registry.installProducerBindings({authorityFor:(thread,bot)=>thread===threadId&&bot===botId?{claim:f.claim,proof:{}}:undefined,registerQueue:()=>()=>{}});
    try {
      expect(serviceThreadNoLimits(threadId,botId)).toBe(true);
      expect(serviceThreadNoLimits(threadId,'wrong-bot')).toBe(false);
      expect(serviceThreadNoLimits('wrong-thread',botId)).toBe(false);
      f.setLevel('ask');
      expect(serviceThreadNoLimits(threadId,botId)).toBe(false);
      f.setLevel('unlimited');f.setGeneration('next');
      expect(serviceThreadNoLimits(threadId,botId)).toBe(false);
    } finally {remove();f.dispose();}
  });
  it('S3 undecided folders and saved rejects remain unchanged at No limits', () => {
    const generation = randomUUID(), thread = randomUUID();
    const facts: ServiceTurnFacts = { ownerAudience: true, origin: 'routine', noLimits: true };
    bindServiceTurn(generation, thread, 'bot', () => true, () => facts);
    const gate = { key: '/fixture', folder: '/fixture', sources: ['AGENTS.md'], rejects: [{ key:'/other',folder:'/other' }] };
    const trusted = serviceFolderTrust(generation, thread, 'bot', gate);
    expect(trusted).toBe(gate);
    expect(gate).not.toHaveProperty('decision');
    expect(gate.rejects).toEqual([{key:'/other',folder:'/other'}]);
    facts.noLimits = false; expect(serviceFolderTrust(generation, thread, 'bot', gate)).toBe(gate);
  });
  it.each(['record','exact reject','ancestor reject','native no'] as const)('service-turn-keeps-saved-decline (W-T03, N7 %s)', mode => {
    const generation = randomUUID(), thread = randomUUID();
    bindServiceTurn(generation, thread, 'bot', () => true, () => ({ownerAudience:true,origin:'owner',noLimits:true}));
    const gate = { key:mode==='ancestor reject'?'/fixture':'/fixture/child', folder:'/fixture/child/grand', sources:['AGENTS.md'],
      ...(mode==='record'?{decision:'reject' as const,fromRecord:true as const}:{}),
      ...(mode==='native no'?{storedNoPick:true as const}:{}),
      rejects:mode==='exact reject'?[{key:'/fixture/child',folder:'/fixture/child'}]:mode==='ancestor reject'?[{key:'/fixture/child',folder:'/fixture/child'}]:[] };
    const before=JSON.stringify(gate);
    expect(serviceFolderTrust(generation,thread,'bot',gate)).toBe(gate);
    expect(JSON.stringify(gate)).toBe(before);
  });
  it.each(['record','exact reject','ancestor reject','native no'] as const)('N7 a saved Do not trust stays untrusted below No limits: %s', mode => {
    const generation = randomUUID(), thread = randomUUID();
    bindServiceTurn(generation, thread, 'bot', () => true, () => ({ownerAudience:true,origin:'owner',noLimits:false}));
    const gate = { key:mode==='ancestor reject'?'/fixture':'/fixture/child', folder:'/fixture/child/grand', sources:['AGENTS.md'],
      ...(mode==='record'?{decision:'reject' as const,fromRecord:true as const}:{}),
      ...(mode==='native no'?{storedNoPick:true as const}:{}),
      rejects:mode==='exact reject'?[{key:'/fixture/child',folder:'/fixture/child'}]:mode==='ancestor reject'?[{key:'/fixture/child',folder:'/fixture/child'}]:[] };
    expect(serviceFolderTrust(generation,thread,'bot',gate)).toBe(gate);
  });
});

it('R1 non-owner webhook/unattended bindings refuse the inherited bot level',()=>{
 for(const origin of ['webhook','unattended'] as const){const generation=randomUUID(),thread=randomUUID();
  bindServiceTurn(generation,thread,'bot',()=>true,()=>({ownerAudience:false,origin,noLimits:true,explicitNoLimits:false}));
  // MAIN RULING GROK-FUPRUL FIXTURE (No limits fail-open): stored level never overrides a non-owner live turn.
  expect(serviceNoLimits(generation,thread,'bot')).toBe(false);
 }
});
