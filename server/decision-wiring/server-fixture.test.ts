// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { openSse } from '../testing/sse.ts';
import { instrumentation } from './runtime-fixture.ts';

// This is a real isolated server + fake CLI with S0 dependency doubles. It
// does not stand in for S1's SQL/record tests or the live five-engine gate.
describe('S4 real dispatch on the documented isolated fixture', () => {
  let fixture: VerificationServer;
  let headers: Record<string,string>;
  const evidence: unknown[] = [];
  const api = async (method:string,path:string,body?:unknown) => {
    const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const result={status:response.status,body:await response.json() as any};evidence.push({method,path,...result});return result;
  };
  const trace=()=>readFileSync(join(fixture.info.dataDir,'s4-fixture-trace.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  beforeAll(async()=>{
    fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,readyTimeoutMs:120_000});
    const secret=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
    headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.secret};
  },150_000);
  afterAll(async()=>{
    if(fixture){
      evidence.push({fixture:fixture.info,trace:trace()});
      const evidencePath=process.env.S4_FIXTURE_EVIDENCE ?? 's4-fixture-evidence.json';
      writeFileSync(evidencePath,JSON.stringify(evidence,null,2));
      writeFileSync(evidencePath.replace(/\.json$/, '.server.log'),readFileSync(fixture.info.logPath));
      await fixture.close();
    }
  },30_000);
  it('boots with ingress first, recover before live requests, and dispatches a real owner turn',async()=>{
    expect((await api('GET','/api/health')).status).toBe(200);
    const instance=(await api('GET','/api/instances')).body.instances.find((i:any)=>i.instanceId==='verification');
    const made=await api('POST','/api/bots',{name:'S4 fixture owner',modelSelection:{instanceId:'verification',model:instance.models.options[0]?.id||instance.models.default||'fixture-model'}});
    expect(made.status).toBe(201);
    const bot=made.body.bot;
    expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false})).status).toBe(200);
    const preview=await api('POST',`/api/bots/${bot.id}/permissions/refresh`,{scope:'open',targetLevel:'no-limits'});
    expect(preview.status,JSON.stringify(preview.body)).toBe(200);
    const patched=await api('PATCH',`/api/bots/${bot.id}`,{settingsScope:'defaults',previewId:preview.body.previewId,ifRev:preview.body.botRev,autoApprove:true,fullAccess:true,noLimits:true,acknowledgeNoLimits:true});
    expect(patched.status,JSON.stringify(patched.body)).toBe(200);
    expect((await api('POST',`/api/bots/${bot.id}/permissions/refresh`,{scope:'open',rosterId:preview.body.rosterId,targetLevel:'no-limits',afterRev:patched.body.bot.permissionRev})).status).toBe(200);
    expect((await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_permission_tool__',threadId:bot.threadId})).status).toBe(202);
    let rows:any[]=[];
    await expect.poll(async()=>{
      const latest=(await api('GET','/api/bots?messages=50')).body.bots.find((b:any)=>b.id===bot.id);
      rows=latest?.messages??[];
      return rows.some(row=>row.text==='permission: allowed');
    },{timeout:60_000,interval:200}).toBe(true);
    expect(rows.filter(row=>row.card?.requestId)).toHaveLength(0);
    const events=trace();
    expect(events[0].type).toBe('ingress-installed');
    const decided=events.find(e=>e.type==='decided');
    expect(decided).toMatchObject({actor:'owner',level:'unlimited',kind:'run'});
    expect(events.findIndex(e=>e.type==='recovered')).toBeLessThan(events.findIndex(e=>e.type==='captured'));
    expect(events.some(e=>e.type==='delivery'&&e.state==='accepted')).toBe(true);
    expect(events.some(e=>e.type==='policy'&&e.initiator==='owner-typed')).toBe(true);
  },90_000);
  async function openBaseCard(label:string) {
    const instance=(await api('GET','/api/instances')).body.instances.find((i:any)=>i.instanceId==='verification');
    const made=await api('POST','/api/bots',{name:label,modelSelection:{instanceId:'verification',model:instance.models.options[0]?.id||instance.models.default||'fixture-model'}});
    expect(made.status).toBe(201);const bot=made.body.bot;
    expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false})).status).toBe(200);
    expect((await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_permission_tool__',threadId:bot.threadId})).status).toBe(202);
    let card:any;
    await expect.poll(async()=>{const b=(await api('GET','/api/bots?messages=50')).body.bots.find((b:any)=>b.id===bot.id);card=b?.messages.find((m:any)=>m.card?.approvalId&&!m.card.answered);return Boolean(card);},{timeout:30_000,interval:50}).toBe(true);
    return {bot,card};
  }
  async function stream() {
    const ticket=await api('POST','/api/desktop/resource-ticket',{resource:'/api/events'});
    expect(ticket.status).toBe(200);
    return openSse(fixture.info.url+'/api/events?surfaceTicket='+encodeURIComponent(ticket.body.ticket));
  }
  it.each(['allow','deny'])('BASE card %s reaches both durable fake record and the real client terminal patch',async behavior=>{
    const events=await stream();
    try {
      const {bot,card}=await openBaseCard('S4 BASE '+behavior);
      const reply=await api('POST',`/api/bots/${bot.id}/respond`,{requestId:card.card.requestId,behavior,threadId:bot.threadId});
      expect(reply.status,JSON.stringify(reply.body)).toBe(200);
      const patch=await events.until(e=>e.kind==='message.patch'&&e.message?.id===card.id&&e.message.card?.answered===behavior,10_000);
      evidence.push({terminalPatch:patch});
      const records=JSON.parse(readFileSync(join(fixture.info.dataDir,'s4-fake-records.json'),'utf8'));
      expect(records.find((r:any)=>r.ref.approvalId===card.card.approvalId).state).toBe('answered');
    } finally {events.close();}
  },60_000);
  it('expiry reaches the real client after the record becomes terminal (M52 forwarding regression)',async()=>{
    const events=await stream();
    writeFileSync(join(fixture.info.dataDir,'s4-expire-next'),'1');
    try {
      const {card}=await openBaseCard('S4 expiry');
      const patch=await events.until(e=>e.kind==='message.patch'&&e.message?.id===card.id&&e.message.card?.answered==='expired',10_000);
      evidence.push({terminalPatch:patch});
      const records=JSON.parse(readFileSync(join(fixture.info.dataDir,'s4-fake-records.json'),'utf8'));
      expect(records.find((r:any)=>r.ref.approvalId===card.card.approvalId).state).toBe('expired');
    } finally {events.close();unlinkSync(join(fixture.info.dataDir,'s4-expire-next'));}
  },60_000);
  it('restart recovers before the legacy sweep; terminal state survives in the real transcript',async()=>{
    const {bot,card}=await openBaseCard('S4 restart');
    await fixture.restart();
    const secret=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
    headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.secret};
    const latest=(await api('GET','/api/bots?messages=50')).body.bots.find((b:any)=>b.id===bot.id);
    expect(latest.messages.find((m:any)=>m.id===card.id).card.answered).toBe('expired');
    const records=JSON.parse(readFileSync(join(fixture.info.dataDir,'s4-fake-records.json'),'utf8'));
    expect(records.find((r:any)=>r.ref.approvalId===card.card.approvalId).state).toBe('expired');
  },60_000);

  it('R4 queued owner sends retain owner provenance after the original generation is released (M37)',async()=>{
    const instance=(await api('GET','/api/instances')).body.instances.find((i:any)=>i.instanceId==='verification');
    const made=await api('POST','/api/bots',{name:'S4 queued owner',modelSelection:{instanceId:'verification',model:instance.models.options[0]?.id||instance.models.default||'fixture-model'}});
    expect(made.status).toBe(201);const bot=made.body.bot;
    await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
    const preview=await api('POST',`/api/bots/${bot.id}/permissions/refresh`,{scope:'open',targetLevel:'no-limits'});
    const patched=await api('PATCH',`/api/bots/${bot.id}`,{settingsScope:'defaults',previewId:preview.body.previewId,ifRev:preview.body.botRev,noLimits:true,acknowledgeNoLimits:true});
    expect(patched.status).toBe(200);
    await api('POST',`/api/bots/${bot.id}/permissions/refresh`,{scope:'open',rosterId:preview.body.rosterId,targetLevel:'no-limits',afterRev:patched.body.bot.permissionRev});
    expect((await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_hold_authority__',threadId:bot.threadId})).status).toBe(202);
    let pid=0;
    await expect.poll(()=>{try{const dump=JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8'));if(JSON.stringify(dump.prompt).includes('__fixture_hold_authority__'))pid=dump.pid;}catch{}return pid;},{timeout:20_000,interval:50}).toBeGreaterThan(0);
    const one=await api('POST',`/api/bots/${bot.id}/messages`,{text:'queued first __fixture_permission_tool__',threadId:bot.threadId});
    const two=await api('POST',`/api/bots/${bot.id}/messages`,{text:'queued second __fixture_permission_tool__',threadId:bot.threadId});
    expect(one.body.queued).toBe(true);expect(two.body.queued).toBe(true);
    const before=trace().filter(e=>e.type==='decided').length;
    writeFileSync(join(fixture.fixtureFinishGateDir,String(pid)),'finish');
    let rows:any[]=[];
    await expect.poll(async()=>{const b=(await api('GET','/api/bots?messages=50')).body.bots.find((b:any)=>b.id===bot.id);rows=b?.messages??[];return rows.some(row=>row.text==='permission: allowed');},{timeout:30_000,interval:100}).toBe(true);
    expect(rows.filter(row=>row.card?.requestId)).toHaveLength(0);
    const decisions=trace().filter(e=>e.type==='decided').slice(before);
    expect(decisions.some(e=>e.actor==='owner'&&e.level==='unlimited'&&e.kind==='run')).toBe(true);
    expect(decisions.some(e=>e.actor==='unproven'||e.kind==='refuse')).toBe(false);
  },60_000);

});
