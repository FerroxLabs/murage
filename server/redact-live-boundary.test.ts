// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { openSse } from './testing/sse.ts';
let fixture: VerificationServer, headers: Record<string,string>;
const api = async (method:string,path:string,body?:unknown) => {
  const response = await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json() as any};
};
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const fs=await import('node:fs'), path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.verification.environment={...cfg.instances.verification.environment,FAKE_CLAUDE_TEXT_ONLY:'1',FAKE_CLAUDE_REPLY_STATE:path.join(process.env.MURAGE_DATA_DIR,'reply-index'),FAKE_CLAUDE_REPLIES:JSON.stringify([['**password**:','hunter2\\nTAILSECRET'],'A fresh reply stays visible.'])};
    fs.writeFileSync(file,JSON.stringify(cfg));
    const {ClaudeDriver}=await import(${JSON.stringify(new URL('./drivers/claude.ts',import.meta.url).href)});
    const create=ClaudeDriver.create;
    ClaudeDriver.create=async function(...args){const instance=await create.apply(this,args);
      instance.adapter.onEvent(event=>{if(event.type==='item.completed'&&event.itemType==='assistant_text')fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'execution.txt'),event.text+'\\n');});return instance;};
  `});
  headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
},120_000);
afterAll(async()=>{await fixture?.close();});
// q1023-ownermask (MAIN PREPARED OPTION B, "in the OWNER OWN private direct chat: NEVER hold back a reply; mask in place only
// high-precision credential shapes ... show everything else word for word"): this is the owner's own chat and `hunter2` is a label-only
// value, so the stored replies (and the message frames carrying them) are the bot's words; the provider-event frames and the event log
// keep the turn's mask. Replaces the 1.0.21 expectation of two held-back lines and no value in the page or any frame.
it('split items: the owner reads both replies (never held back) while provider-event frames and the event log stay masked; a fresh turn releases clean text',async()=>{
  const engines=(await api('GET','/api/instances')).body.instances;
  const model=engines.find((value:any)=>value.instanceId==='verification').models.options[0].id;
  const made=await api('POST','/api/bots',{name:'Output boundary fixture',modelSelection:{instanceId:'verification',model}});
  expect(made.status).toBe(201);const bot=made.body.bot;
  await api('PATCH',`/api/bots/${bot.id}`,{computer:'off'});
  const stream=await openSse(fixture.info.url+'/api/events',headers);
  try{
    expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Show the split fixture.'})).status).toBe(202);
    await stream.until(frame=>frame.kind==='runtime'&&frame.event.type==='turn.completed'&&frame.event.threadId===bot.threadId,30_000);
    const page=(await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).body;
    const replies = page.messages.filter((row: { role: string; kind: string; provenance?: string }) =>
      row.role === 'bot' && row.kind === 'text' && row.provenance === 'provider');
    // MAIN-RULING 2026-11-27T03:17:37Z labelled-value floor: `hunter2` (7 characters, no credential shape) is the value right after the
    // `**password**:` label, but a labelled value is masked in place in the owner chat only at 16 or more characters: both lines are shown
    // q1023-ownershow: the stored owner row is no longer re-masked by the strict pass (store.ts / transcript-page.ts take the owner-zone
    // rule, redact.ts redactOwnerZone), so the empty value after the label is not turned into a `«redacted 0 chars»` marker either
    // CHANGED ASSERTION, MAIN-RULING ownermask 2026-11-27 (H2; supersedes the 03:17:37Z floor for these labels): password/passphrase/passwd/pwd/pin/secret/private key ALWAYS mask their value in place in the owner's own chat, whatever its length; token and the other labels keep the floor: the value on the line below the label is masked in place, the line after it is kept
    expect(replies.map((row: { text: string }) => row.text)).toEqual(['**password**:', '«redacted 7 chars»\nTAILSECRET']);
    const runtimeFrames=()=>stream.frames.filter((frame:any)=>frame?.kind==='runtime');
    expect(runtimeFrames().length).toBeGreaterThan(0);
    expect(JSON.stringify(runtimeFrames())).not.toMatch(/hunter2|TAILSECRET/);
    expect(readFileSync(join(fixture.info.dataDir,'execution.txt'),'utf8')).toContain('hunter2\nTAILSECRET');
    expect(readFileSync(join(fixture.info.dataDir,'events',`${bot.threadId}.ndjson`),'utf8')).not.toMatch(/hunter2|TAILSECRET/);
    await expect.poll(async()=>!(await api('GET','/api/bots?messages=0')).body.bots.find((value:any)=>value.id===bot.id).busy).toBe(true);
    expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Show a clean fresh reply.'})).status).toBe(202);
    await expect.poll(async()=>JSON.stringify((await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).body),{timeout:30_000}).toContain('A fresh reply stays visible.');
    expect(JSON.stringify(runtimeFrames())).not.toMatch(/hunter2|TAILSECRET/);
  }finally{stream.close();}
},60_000);
