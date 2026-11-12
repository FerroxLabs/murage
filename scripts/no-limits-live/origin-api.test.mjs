import { beforeAll, afterAll, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchVerificationServer } from '../control-murage.ts';
import { ProductClient } from './run.mjs';
import { installOriginFixtures } from './origin-fixtures.mjs';
import { scenarios } from './scenarios.mjs';
import { judgeScenario } from './counts.mjs';
import { writeLegacyBot } from './legacy-fixture.mjs';
let fixture,c,bindings;
const out=resolve('scripts/no-limits-live/evidence/origin-api');mkdirSync(out,{recursive:true});
const evidence={mode:'fake inbound transport and inert engine; real server boot',rows:[]};
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    ${process.env.GNL_MUTANT_PRELOAD ? `await import(${JSON.stringify(process.env.GNL_MUTANT_PRELOAD)});` : ""}
    await import(${JSON.stringify(new URL('../../server/testing/idle-load-preload.mjs',import.meta.url).href)});
    const fs=await import('node:fs'),path=await import('node:path');
    const dir=process.env.MURAGE_DATA_DIR;process.env.FAKE_TELEGRAM_DIR=path.join(dir,'channel-fixture');fs.mkdirSync(process.env.FAKE_TELEGRAM_DIR,{recursive:true});
    await import(${JSON.stringify(new URL('../../server/testing/telegram-fetch-preload.mjs',import.meta.url).href)});
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('../../server/drivers/builtIn.ts',import.meta.url).href)});
    const {gateDriver}=await import(${JSON.stringify(new URL('./fakes/gate-driver.mjs',import.meta.url).href)});BUILT_IN_DRIVERS.push(gateDriver);
    const file=path.join(dir,'config.json'),cfg=JSON.parse(fs.readFileSync(file));cfg.instances.verification={driver:'gnlFake'};fs.writeFileSync(file,JSON.stringify(cfg));
  `});
  const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json();
  c=new ProductClient(fixture.info.url,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':proof.secret},fixture.info.dataDir,15000);await c.connect();
  bindings=installOriginFixtures({channelDir:join(fixture.info.dataDir,'channel-fixture'),phoneHeaders:{'content-type':'application/json','x-murage-companion':'1','x-murage-companion-token':'c'.repeat(64)},
    prepareLegacyBot:async id=>{await c.disconnect();await fixture.stop();writeLegacyBot(fixture.info.dataDir,id);await fixture.restart();
      const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json();c.headers['x-murage-surface-secret']=proof.secret;c.streamErrors=[];await c.connect();}});
  evidence.fixture=fixture.info;
},60000);
afterAll(async()=>{if(fixture){evidence.finalFixture=fixture.info;writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));}await c?.disconnect();await fixture?.close();writeFileSync(join(out,'verification.json'),JSON.stringify(evidence,null,2)+'\n');});
it.each(scenarios.filter(s=>s.origin))('$id drives its actual authenticated ingress',async spec=>{
  const bot=await c.bot(spec.id,{id:'verification',model:'fixture'},fixture.info.dataDir,spec.botLevel??spec.level);
  const ids=[bot.id],threads=new Set([bot.threadId]);
  try {
    const {obs,proof,...extra}=await bindings[spec.id]({client:c,bot,spec,command:'printf fixture',threads,ids});
    const row=judgeScenario(spec,{...obs,...extra,actionProven:proof});
    evidence.rows.push({id:spec.id,verdict:row.verdict,cardCount:row.cardCount,cards:row.cards,actionProven:proof,featureOff:extra.featureOff,events:obs.events,messages:obs.messages,botPermissionExplicit:extra.botPermissionExplicit,effectiveLevel:extra.effectiveLevel,originWitness:extra.originWitness,errors:row.errors});
    expect(row.verdict,row.errors.join('; ')).toBe('PASS');
  }catch(error){
    evidence.rows.push({id:spec.id,verdict:'FAIL',error:error.message,events:c.events.filter(e=>threads.has(e.threadId)).map(e=>({type:e.type,ok:e.ok,stopReason:e.stopReason,message:e.message}))});throw error;
  }finally{await c.stop(bot);}
},60000);
