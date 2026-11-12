// Fake inbound transports, real app pairing, identity, scheduling and message
// routes. Installed only in the newly launched gate server. No external
// Telegram service or phone is contacted.
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { shellActionProven } from './action-proof.mjs';
import { scenarios } from './scenarios.mjs';
const check=(value,why)=>{if(!value)throw Error(why);};
async function poll(read) {const until=Date.now()+45000;while(Date.now()<until){const value=await read();if(value)return value;await sleep(100);}throw Error('Origin fixture deadline');}
export const ingressMessages=(messages,priorIds)=>messages.filter(m=>!priorIds.has(m.id));
export function taskLevel(task,bot) {
  const flags=Object.fromEntries(['autoApprove','fullAccess','noLimits'].map(k=>[k,task?.[k]??bot[k]]));
  return !flags.autoApprove?'ask':!flags.fullAccess?'auto':flags.noLimits?'unlimited':'full';
}
export function installOriginFixtures(f) {
  const bindings={};let updateId=0;
  const sendUpdate=(text)=>{
    const id=++updateId;
    const next=join(f.channelDir,'updates-next.json');
    writeFileSync(next,JSON.stringify([{update_id:id,message:{message_id:id,date:1700000000+id,text,
      from:{id:777,is_bot:false},chat:{id:777,type:'private'}}}]));
    renameSync(next,join(f.channelDir,'updates.json'));
  };
  const channel=async({client:c,bot,spec,command,cwd,threads})=>{
    if(spec.legacy) {
      check(f.prepareLegacyBot,'UNPROVEN legacy fixture preparation is not bound');
      await f.prepareLegacyBot(bot.id);
      check((await c.api('GET',`/api/bots/${bot.id}`)).bot?.permissionExplicit===undefined,'Legacy profile still carries explicit-permission metadata');
    }
    await c.api('POST','/api/telegram/revoke',{});
    await c.api('PATCH',`/api/bots/${bot.id}`,{chiefOfStaff:true,chiefScope:'workspace',fullAccessChannelMessages:spec.channelMessages!==false});
    await c.api('PATCH','/api/config',{telegram:{botToken:'123:abcdefghijklmnopqrstuvwxyz123456'}});
    const pairing=await c.api('POST','/api/telegram/pair',{targetBotId:bot.id});
    const sentFile=join(f.channelDir,'sent.jsonl'),before=existsSync(sentFile)?readFileSync(sentFile,'utf8').length:0;
    sendUpdate(`/pair ${pairing.code}`);
    await poll(async()=>{
      const status=await c.api('GET','/api/telegram/status');
      return status.targetBotId===bot.id&&status.paired&&existsSync(sentFile)&&readFileSync(sentFile,'utf8').length>before;
    });
    const humans=await c.api('POST','/api/memory/action',{action:'humans'});
    check(humans.bindings?.length===1,'Pairing did not produce exactly one fixture identity');
    const human=humans.bindings[0];
    await c.api('POST','/api/memory/action',{action:'human-link',bindingId:human.id,expectedRevision:human.revision,as:spec.actor==='owner'?'owner':'person'});
    const priorRuns=new Set((await c.api('GET','/api/routines')).runs?.map(r=>r.id));
    const priorMessageIds=spec.expected==='OFF_WITH_LINE'?new Set((await c.messages(bot.threadId)).map(m=>m.id)):new Set();
    const mark=c.events.length;
    const replyStart=existsSync(sentFile)?readFileSync(sentFile,'utf8').length:0;
    sendUpdate(`Run exactly this shell command once: ${command}. If denied, stop.`);
    if (spec.expected === 'OFF_WITH_LINE') {
      const result=await poll(async()=>{
        const run=(await c.api('GET','/api/routines')).runs?.find(r=>!priorRuns.has(r.id)&&r.botId===bot.id&&r.triggerSource==='channel'&&r.threadId);
        const replied=existsSync(sentFile)&&readFileSync(sentFile,'utf8').length>replyStart;
        return run||replied?{run,replied}:null;
      });
      let obs;
      if(result.run){
        threads.add(result.run.threadId);const prior=c.events.splice(mark);
        obs=await c.observe({...bot,threadId:result.run.threadId},async()=>{c.events.push(...prior);});
      }else{
        // An off-line reply completes the ingress disposition without a turn.
        const threadIds=[...threads];const messages=ingressMessages((await Promise.all(threadIds.map(t=>c.messages(t)))).flat(),priorMessageIds);
        obs={complete:true,ended:true,events:c.events.slice(mark),messages,cards:c.ledger.forThreads(threadIds),threadIds,errors:[]};
      }
      const current=(await c.api('GET',`/api/bots/${bot.id}`)).bot;
      check(current.fullAccessChannelMessages===false,'Channel capability unexpectedly enabled');
      const ownerLines=existsSync(sentFile)?readFileSync(sentFile,'utf8').slice(replyStart).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).text):[];
      const actionExecuted=obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.ok===true);
      return {obs,proof:ownerLines.length>0,featureOff:{feature:spec.feature,actionExecuted,actionNotRunProven:!actionExecuted,continued:obs.ended===true,ownerLines},
        channelFlag:current.fullAccessChannelMessages,originWitness:{kind:'telegram-fixture',suppressed:!result.run,runId:result.run?.id}};
    }
    const run=await poll(async()=>(await c.api('GET','/api/routines')).runs?.find(r=>!priorRuns.has(r.id)&&r.botId===bot.id&&r.triggerSource==='channel'&&r.threadId));
    threads.add(run.threadId);const prior=c.events.splice(mark);
    const obs=await c.observe({...bot,threadId:run.threadId},async()=>{c.events.push(...prior);});
    const current=(await c.api('GET',`/api/bots/${bot.id}`)).bot;
    const task=current.tasks?.find(t=>t.threadId===run.threadId);check(task,'Channel task is missing');
    if (spec.legacy) check(current.permissionExplicit === undefined, 'Legacy fixture acquired an explicit permission marker during ingress setup');
    if (spec.permissionExplicit) check(current.permissionExplicit === true, 'Owner explicit bot setting is missing');
    const effectiveLevel=taskLevel(task,current);
    return {obs,proof:spec.expected==='CARD'?obs.cards.length>0:shellActionProven(obs,command,cwd),
      effectiveLevel,botPermissionExplicit:current.permissionExplicit,channelFlag:current.fullAccessChannelMessages,originWitness:{kind:'telegram-fixture',runId:run.id,threadId:run.threadId,humanKind:spec.actor==='owner'?'owner':'person'}};
  };
  const phone=async({client:c,bot,spec,command,cwd})=>{
    check(f.phoneHeaders,'Paired phone fixture credential absent');
    const obs=await c.observe(bot,()=>c.api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:`Run exactly this shell command once: ${command}`,sendId:randomUUID()},f.phoneHeaders));
    return {obs,proof:shellActionProven(obs,command,cwd),originWitness:{kind:'authenticated-companion',threadId:bot.threadId}};
  };
  for(const s of scenarios)if(s.origin==='channel-dm')bindings[s.id]=channel;else if(s.origin==='phone')bindings[s.id]=phone;
  return bindings;
}
