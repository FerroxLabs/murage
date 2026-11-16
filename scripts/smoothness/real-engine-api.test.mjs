// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../control-murage.ts';
import { openSse } from '../../server/testing/sse.ts';
import { probeEngine, engineTurn } from './real-engine.mjs';
import { openCards } from './smooth-config.mjs';
import { readFileSync } from 'node:fs';

it('binds terminal receipts to the exact send and owned fixture thread', async () => {
  let change={};
  const options={bot:{id:'fixture',threadId:'owned'},text:'fixture',send:async()=>({status:202}),
    state:async(bot,sendId)=>({status:200,json:{contract:1,botId:bot.id,threadId:bot.threadId,sendId,terminalOutcome:'completed',...change}}),
    wait:async check=>({ok:await check()})};
  await expect(engineTurn(options)).resolves.toEqual({outcome:'turn.completed',stopReason:null});
  for(const invalid of [{sendId:'old'},{threadId:'other'},{botId:'other'},{contract:0}]) {
    change=invalid; await expect(engineTurn(options)).rejects.toThrow('receipt does not match send');
  }
  change={terminalOutcome:null};await expect(engineTurn(options)).rejects.toThrow('did not settle');
  change={terminalOutcome:'failed'};await expect(engineTurn(options)).resolves.toEqual({outcome:'turn.failed',stopReason:null});
  change={terminalOutcome:'stopped'};await expect(engineTurn(options)).resolves.toEqual({outcome:'turn.completed',stopReason:'cancelled'});
  await expect(engineTurn({...options,send:async()=>({status:409})})).rejects.toThrow('send refused');
});

// The actual server owns cards, identity, transcript, steer and Stop. Only the
// provider is fake; no model, external service or user's data is reachable.
it('drives public execution cards, live steer, Stop and a bot recovery reply', async () => {
  const instrumentationSource = `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {BUILT_IN_DRIVERS} = await import(${JSON.stringify(new URL('../../server/drivers/builtIn.ts', import.meta.url).href)});
    const {makeLateTerminalDriver} = await import(${JSON.stringify(new URL('../../server/testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    const base = makeLateTerminalDriver();
    BUILT_IN_DRIVERS.push({...base, async create(input) {
      const instance = await base.create(input), listeners = new Set(); let count = 0, current, answered = false;
      const emit = event => { for(const fn of listeners) fn({eventId:crypto.randomUUID(),provider:base.driverKind,providerInstanceId:input.instanceId,createdAt:new Date().toISOString(),...event},current.sourceContext); };
      Object.assign(instance.adapter, {
        capabilities:{queueing:true,sessionModelSwitch:'unsupported'},
        onEvent(fn) {listeners.add(fn); return ()=>listeners.delete(fn);},
        async sendTurn(turn) {
          current=turn; const attempt=turn.beforeSubmit?.();turn.attemptWritten?.(attempt); const turnId='probe-turn-'+(++count); current.turnId=turnId;
          setTimeout(()=>{
            emit({type:'turn.started',threadId:turn.threadId,turnId});
            if(count===1) emit({type:'request.opened',requestType:'permission',tool:'Bash',summary:'Run sleep 45',requestId:'probe-permission',threadId:turn.threadId,turnId});
            else {emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'RECOVERED',threadId:turn.threadId,turnId});emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});}
          },25);
          return {turnId};
        },
        async respondToRequest(_thread,id,decision) {answered=id==='probe-permission'&&decision.behavior==='allow';return answered?'allowed-once':'unavailable';},
        async steer(_thread,_text,beforeWrite) {beforeWrite?.(); return answered;},
        async resetSession() {},
        async interruptTurn(threadId) {emit({type:'turn.completed',ok:false,stopReason:'cancelled',threadId,turnId:current.turnId});},
      });
      // The real decision service requires the answer-id acknowledgement port.
      // Deduplicate only the same answer, as a native provider transport does.
      const answers=new Map();
      instance.decisionAdapter={
        async respondToRequest(thread,id,answer,options) {
          if(answers.has(id))return {state:answers.get(id)===options.answerId?'already':'failed'};
          if(await instance.adapter.respondToRequest(thread,id,answer)==='unavailable')return {state:'failed'};
          answers.set(id,options.answerId);return {state:'accepted'};
        },
        interruptTurn:(...args)=>instance.adapter.interruptTurn(...args),
        onPostureChange:async()=>{},
      };
      return instance;
    }});
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(fs.readFileSync(file,'utf8'));
    config.instances.probe={driver:base.driverKind}; fs.writeFileSync(file,JSON.stringify(config));
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  let stream;
  const evidence = [];
  try {
    const proof = await (await fetch(fixture.info.url+'/api/desktop-secret')).json();
    const call = async (method,path,body) => {
      const res=await fetch(fixture.info.url+path,{method,headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':proof.secret},body:body===undefined?undefined:JSON.stringify(body)});
      const json=await res.json(); evidence.push({method,path,status:res.status,json}); return {status:res.status,json};
    };
    stream=await openSse(fixture.info.url+'/api/events');
    await stream.until(frame=>frame.kind==='hello');
    const messages=async bot=>(await call('GET',`/api/threads/${bot.threadId}/messages`)).json.messages;
    const busy=async bot=>(await call('GET',`/api/bots/${bot.id}`)).json.bot.busy;
    const wait=async(check,{cap=10000}={})=>{
      const end=Date.now()+Math.min(cap,10000);
      do {if(await check())return {ok:true}; await new Promise(r=>setTimeout(r,50));}while(Date.now()<end);
      return {ok:false};
    };
    const result=await probeEngine({
      makeBot:async()=>{
        const created=await call('POST','/api/bots',{name:'Engine probe fixture',modelSelection:{instanceId:'probe',model:'late-1'}});
        expect(created.status).toBe(201);
        await call('PATCH',`/api/bots/${created.json.bot.id}`,{autoReview:'off',computer:'off',browser:false});
        return created.json.bot;
      },
      setLevel:(bot,level)=>call('PATCH',`/api/bots/${bot.id}`,{autoApprove:level!=='ask'}),
      turn:(bot,text)=>engineTurn({bot,text,wait,
        send:(bot,text,sendId)=>call('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text,sendId}),
        state:(bot,sendId)=>call('GET',`/api/bots/${bot.id}/turn-state?${new URLSearchParams({threadId:bot.threadId,sendId})}`),
      }),
      openCards:async bot=>{
        const view=await call('GET',`/api/threads/${bot.threadId}/open-cards`);
        expect(view.status).toBe(200);
        const rows=view.json.openCards??[];
        for(const row of rows) {expect(row.card.requestId).toBeUndefined();expect(row.card.requestHandle).toMatch(/^p\./);}
        // Exercise the exact same selector as the packaged adapter.
        return openCards(rows, { publicExecution: true });
      },
      respond:(bot,answer)=>call('POST',`/api/bots/${bot.id}/respond`,answer),
      send:(bot,text)=>call('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text}),
      busy,
      stop:async bot=>{
        const start=Date.now();const stopped=await call('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
        expect(stopped.status).toBe(200);
        for(let i=0;i<100&&await busy(bot);i++)await new Promise(r=>setTimeout(r,50));
        return {settled:!await busy(bot),ms:Date.now()-start};
      },
      messages,
      wait,
    });
    expect(result).toMatchObject({cards:1,steers:1,stopped:1,completed:1});
    const answer=evidence.find(row=>row.path.endsWith('/respond'));
    expect(answer.status).toBe(200);
    expect(evidence.some(row=>row.json.messages?.some(message=>message.role==='bot'&&message.text==='RECOVERED'))).toBe(true);
    expect(readFileSync(new URL('./smooth.mjs',import.meta.url),'utf8')).toContain('openCardsOf(bot.threadId, { publicExecution: true })');
  } finally {
    console.log('PROBE_FLOW',JSON.stringify({commands:evidence,frames:stream?.frames,logPath:fixture.info.logPath}));
    console.log('PROBE_SERVER_LOG_BASE64',readFileSync(fixture.info.logPath).toString('base64'));
    stream?.close(); await fixture.close();
  }
},45000);
