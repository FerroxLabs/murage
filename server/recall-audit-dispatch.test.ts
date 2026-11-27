// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: recall-audit owns mandatory projection failures and their dispatch consumer.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
const source=(name:string)=>JSON.stringify(pathToFileURL(resolve('server',name)).href);

for(const unknown of [false,true])for(const venue of ['bot','channel'] as const)it(`audit 1: ${venue} ${unknown?'refuses unknown pins':'sends proven pins despite'} persistent pin lag before engine submission, including restart and crash`,async()=>{
  const instrumentationSource=`
    const { registerHooks } = await import('node:module');
    registerHooks({load(url,context,next){
      const result=next(url,context),text=String(result.source);
      if(url.endsWith('/server/memory/recall-view.ts')) {
        const needle='export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster, issued = false): Held {';
        if(!text.includes(needle))throw Error('fixture admission injection missing');
        // Settle cold admission before the pin-lag experiment. Production's
        // earlier lineage admission otherwise masks whether this fault ran.
        return {...result,source:text.replace(needle,needle+\`try { const current=cache(database(),roster).get(recallContextKey(binding)); if(!current)throw Error('fixture cold'); assertRecallView(database(),current.handle,binding); } catch { prepareRecallContextSync(binding.botId,binding.threadId,roster,binding.notOwnerAudience); }\`)};
      }
      if(url.endsWith('/server/index.ts')) {
        const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
        if(!text.includes(needle))throw Error('fixture dispatch injection missing');
        return {...result,source:text.replace(needle,needle+\`if(!built.memoryContext?.text.includes('Keep the owner constraint.'))throw Error('fixture pin missing at dispatch'); console.warn('fixture authoritative pin dispatched');\`)};
      }
      if(url.endsWith('/server/memory/bundle.ts')) {
        const needle='const pinAt = pinStamp();';
        if(!text.includes(needle))throw Error('fixture projection injection missing');
        return {...result,source:text.replace(needle,\`
          db.prepare("INSERT OR IGNORE INTO memory_records SELECT 'fixture-constraint',1,scope_id,'constraint','Keep the owner constraint.','owner-statement','active',1,1,NULL,NULL,1 FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 LIMIT 1").run(access.view.viewId,access.view.generation);
          db.prepare('UPDATE memory_recall_views SET watermark=0 WHERE view_id=? AND generation=?').run(access.view.viewId,access.view.generation);
          ${unknown ? `db.prepare('DROP INDEX IF EXISTS memory_records_pinned').run();` : ''}
          console.warn('fixture persistent pin projection lag');
        \`+needle)};
      }
      return result;
    }});
    await import(${source('memory/settle-target.ts')});
    const { setMemoryMode } = await import(${source('memory/repository.ts')});
    setMemoryMode('active');
  `;
  const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture reply.','Fixture reply.','Fixture reply.']},instrumentationSource});
  const env={MURAGE_DATA_DIR:fixture.info.dataDir};
  const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env}) as Promise<any>;
  try {
    expect((await run(['doctor'])).ok).toBe(true);
    const bot=(await run(['new-bot','--name','Fixture reader'])).bot;
    const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id;
    const destination=[`--${venue}`,id];
    const pinRefusals=(page:{messages:Array<{text?:string;tool?:{name?:string}}>})=>page.messages.filter(message=>/pinned memory.*Send it again/.test(message.text??message.tool?.name??'')).length;
    let dispatchedPins=0;
    for(const phase of ['initial','restart','crash']) {
      if(phase==='crash')await new Promise<void>(resolve=>{fixture.child.once('close',()=>resolve());fixture.child.kill('SIGKILL');});
      if(phase!=='initial')await fixture.restart();
      const before=pinRefusals(await run(['messages',...destination,'--limit','20']));
      const lagBefore=(readFileSync(fixture.info.logPath,'utf8').match(/fixture persistent pin projection lag/g)??[]).length;
      const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
      const sent=await fetch(fixture.info.url+`/api/${venue==='bot'?'bots':'groups'}/${id}/messages`,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':proof.secret},body:JSON.stringify({text:'Please keep the pinned constraint.'})});
      expect(sent.status).toBe(202);
      expect((await run(['wait',...destination,'--timeout','30'])).status,readFileSync(fixture.info.logPath,'utf8').slice(-12000)).toBe(unknown && venue==='bot'?'failed':'settled');
      const transcript=await run(['messages',...destination,'--limit','20']);
      expect((readFileSync(fixture.info.logPath,'utf8').match(/fixture persistent pin projection lag/g)??[]).length).toBeGreaterThan(lagBefore);
      if(unknown){expect(JSON.stringify(transcript)).toMatch(/pinned memory.*Send it again/);expect(pinRefusals(transcript)).toBe(before+1);}else expect(pinRefusals(transcript)).toBe(before);
      const turns=existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim():'';
      if(unknown)expect(turns).toBe('');else {expect(turns.split('\n'),readFileSync(fixture.info.logPath,'utf8').slice(-12000)).toHaveLength(['initial','restart','crash'].indexOf(phase)+1);const phasePins=(readFileSync(fixture.info.logPath,'utf8').match(/fixture authoritative pin dispatched/g)??[]).length;expect(phasePins).toBe(1);dispatchedPins+=phasePins;}
    }
    const log=readFileSync(fixture.info.logPath,'utf8');
    expect(log).toContain('fixture persistent pin projection lag');
    expect(log).not.toContain('starting turn without recalled memory');
    if(!unknown)expect(dispatchedPins).toBe(3);
  } finally {await fixture.close();}
},120_000);
