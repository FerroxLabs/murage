import {confirmedBrowserFields} from './testing/browser-choice.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real isolated server and fake engine; extension connection status is a deliberate fixture.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { beforeAll,afterAll,it,expect } from "vitest";
import { launchVerificationServer,type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
let fixture:VerificationServer;let headers:Record<string,string>={};let model:string;
const launchProof=randomBytes(32).toString('hex');
const instrumentation=`
process.env.MURAGE_COMPANION_TOKEN=${JSON.stringify(launchProof)};
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
const fs=await import('node:fs');const path=await import('node:path');const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(fs.readFileSync(configFile,'utf8'));config.features={...config.features,browser:false};fs.writeFileSync(configFile,JSON.stringify(config));
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){if(url.endsWith('/browser-extension-integration.ts'))return {format:'module',shortCircuit:true,source:\`import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';export class BrowserExtensionIntegration{constructor(){this.approvals={resolve:()=>false};}async start(){return this;}async connectOwner(browser){writeFileSync(join(process.env.MURAGE_DATA_DIR,'setup-browser-choice.txt'),browser);return this;}status(){try{return JSON.parse(readFileSync(join(process.env.MURAGE_DATA_DIR,'browser-setup-status.json'),'utf8'));}catch{return {profiles:[],bindings:[]};}}hostConfigPath(){return 'fixture-helper';}setupProblemKind(){return undefined;}setupProblem(){return undefined;}async bind(){return {bindingId:'fixture-binding',profileId:'fixture-profile'};}async dispatch(){return {tools:[]};}async ownerAction(){}cancelThread(){}async close(){}}export function routineThreadSignal(){return ()=>false;}export function delegatedTurnUnattended(){return false;}\`};return next(url,context);}});
`;
async function api(method:string,path:string,body?:unknown,owner=true){if(method==='PATCH'&&path.startsWith('/api/bots/')&&body&&typeof body==='object'&&('useMyChrome' in body||'browserTransport' in body))body=await confirmedBrowserFields(fixture.info.url,headers,path,body as Record<string,unknown>);const res=await fetch(fixture.info.url+path,{method,headers:{...(owner?headers:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,body:await res.json() as any};}
// Each bot's hold turn is read from the dump log by its own text: another bot's follow-up turn (a declined card resumes its
// request) writes the one latest-turn file too, and can replace this turn there before the poll reads it.
async function start(name:string,extra:Record<string,unknown>={}){const made=await api('POST','/api/bots',{name,modelSelection:{instanceId:'verification',model}});const bot=made.body.bot;if(Object.keys(extra).length)expect((await api('PATCH',`/api/bots/${bot.id}`,extra)).status).toBe(200);await api('PATCH',`/api/bots/${bot.id}`,{browser:false,computer:'off',composio:false});expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'__fixture_hold_authority__ '+name})).status).toBe(202);let dump:any;await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').split('\n').find(l=>l.includes('__fixture_hold_authority__ '+name));if(!line)return undefined;dump=withTurnSecrets(JSON.parse(line));return dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;}catch{return undefined;}},{timeout:15000}).toBeTruthy();return{bot,token:dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN};}
async function request(token:string,body:unknown={reason:'Use the signed-in fixture page'}){const res=await fetch(fixture.info.url+'/api/internal/request-browser-connection',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return{status:res.status,body:await res.json() as any};}
beforeAll(async()=>{fixture=await launchVerificationServer({},undefined,{dumpLog:true,instrumentationSource:instrumentation});const secret=await api('GET','/api/desktop-secret');headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.body.secret};model=(await api('GET','/api/instances')).body.instances.find((i:any)=>i.instanceId==='verification').models.options[0].id;},60000);
afterAll(async()=>{await fixture?.close();});
it('authenticated tool request creates one durable optional card without enabling access',async()=>{expect((await api('GET','/api/config')).body.features.browser).toBe(false);const {bot,token}=await start('Setup request fixture');const first=await request(token);expect(first.status).toBe(201);expect((await request(token)).body.messageId).toBe(first.body.messageId);const state=(await api('GET',`/api/threads/${bot.threadId}/browser-setup/${first.body.messageId}`)).body;expect(state.setup.ownerMessageId).toBeTruthy();expect(state.setup.decision).toBeUndefined();const bots=(await api('GET','/api/bots?messages=0')).body.bots;expect(bots.find((b:any)=>b.id===bot.id).useMyChrome).toBeUndefined();expect((await api('POST',`/api/threads/${bot.threadId}/browser-setup/${first.body.messageId}`,{action:'accept'},false)).status).toBe(404);expect((await request(token,{fromBotId:'foreign',reason:'wrong'})).status).toBe(403);expect((await api('POST',`/api/threads/${bot.threadId}/browser-setup/${first.body.messageId}`,{action:'decline'})).status).toBe(200);expect((await api('GET','/api/config')).body.features.browser).toBe(false);await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});},30000);
it('owner confirmation queues its lasting browser choice while busy, and Not now stays effect free',async()=>{
 const {bot,token}=await start('Setup queued choice fixture');const card=await request(token,{want:'your-chrome'});const path=`/api/threads/${bot.threadId}/browser-setup/${card.body.messageId}`;
 const shown=(await api('GET',path)).body.setup;expect(shown.browserChoice.lines.join(' ')).toContain('From now on');
 expect((await api('POST',path,{action:'accept'})).status).toBe(200);
 const queued=(await api('GET',`/api/bots/${bot.id}`)).body.bot;expect(queued.pendingBrowserChoice).toMatchObject({mode:shown.browserChoice.mode,baseRevision:shown.browserChoice.baseRevision});expect(queued.useMyChrome).toBeUndefined();
 await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
 await expect.poll(async()=>(await api('GET',`/api/bots/${bot.id}`)).body.bot.browserMode,{timeout:15000}).toBe(shown.browserChoice.mode);
 const chosen=(await api('GET',`/api/bots/${bot.id}`)).body.bot;expect(chosen.previousBrowserChoice).toMatchObject({mode:'builtin'});expect(chosen.pendingBrowserChoice).toBeUndefined();
 expect((await api('PATCH',`/api/bots/${bot.id}`,{useMyChrome:false})).status).toBe(200);
},30000);
it('later global disable blocks Continue without silently reenabling',async()=>{const {bot,token}=await start('Setup disabled later fixture');const card=await request(token);const path=`/api/threads/${bot.threadId}/browser-setup/${card.body.messageId}`;expect((await api('POST',path,{action:'accept'})).status).toBe(200);expect((await api('PATCH','/api/config',{features:{browser:false}})).status).toBe(200);const reply=await api('POST',path,{action:'continue',profileId:'fixture-profile'});expect(reply.status).toBe(409);expect(reply.body.error).toContain('Enable them in Settings');expect((await api('GET','/api/config')).body.features.browser).toBe(false);expect((await api('GET',path)).body.setup.resumed).not.toBe(true);await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});},30000);

it('a companion-forwarded answer may decline but cannot accept, which registers the helper on this computer',async()=>{const {bot,token}=await start('Setup companion fixture');const card=await request(token);const path=`/api/threads/${bot.threadId}/browser-setup/${card.body.messageId}`;
  const companion=async(body:unknown)=>{const res=await fetch(fixture.info.url+path,{method:'POST',headers:{'x-murage-companion-token':launchProof,'content-type':'application/json'},body:JSON.stringify(body)});return{status:res.status,body:await res.json() as any};};
  const refused=await companion({action:'accept'});expect(refused.status).toBe(403);expect(refused.body.error).toBe('This needs the Murage app on your computer.');
  expect((await api('GET',path)).body.setup.decision).not.toBe('accepted');
  expect((await companion({action:'decline'})).status).toBe(200);});

it('a remembered card offers Not now, and its Continue never turns the bot browser toggle back on',async()=>{
  const {bot,token}=await start('Setup remembered fixture',{useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:'fixture-profile'});
  expect((await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id).browser).toBe(false);
  await api('POST',`/api/bots/${bot.id}/browser-extension`,{action:'connect',browser:'chrome'});
  writeFileSync(join(fixture.info.dataDir,'browser-setup-status.json'),JSON.stringify({profiles:[{profileId:'fixture-profile',browser:'chromium'}],bindings:[]}));
  // Workspace browser tools on, this bot's own toggle off: only the bot toggle is under test.
  expect((await api('PATCH','/api/config',{features:{browser:true}})).status).toBe(200);
  try{
    const card=await request(token);const path=`/api/threads/${bot.threadId}/browser-setup/${card.body.messageId}`;
    expect((await api('GET',path)).body.setup).toMatchObject({decision:'accepted',remembered:true});
    const reply=await api('POST',path,{action:'continue'});
    expect(reply.status).toBe(409);expect(reply.body.error).toMatch(/browser tools are off for/i);
    expect((await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id).browser).toBe(false);
    const declined=await api('POST',path,{action:'decline'});
    expect(declined.status,JSON.stringify(declined.body)).toBe(200);expect(declined.body.setup.decision).toBe('declined');
    expect((await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id).browser).toBe(false);
  }finally{writeFileSync(join(fixture.info.dataDir,'browser-setup-status.json'),JSON.stringify({profiles:[],bindings:[]}));await api('PATCH','/api/config',{features:{browser:false}});await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});}
},30000);

it.each(['direct','extension'])('queued card acceptance enables tools after commit and HTTP Continue resumes exactly once: %s',async route=>{
 await fixture.close();fixture=await launchVerificationServer({},undefined,{dumpLog:true,instrumentationSource:instrumentation});const proof=await api('GET','/api/desktop-secret');headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.body.secret};
 console.log('S3 queued setup HTTP fixture',JSON.stringify(fixture.info));
 const {bot,token}=await start('Queued setup completes once');
 if(route==='extension'){writeFileSync(join(fixture.info.dataDir,'browser-setup-status.json'),JSON.stringify({profiles:[{profileId:'fixture-profile',browser:'chrome'}],bindings:[]}));expect((await api('POST',`/api/bots/${bot.id}/browser-extension`,{action:'connect',browser:'chrome'})).status).toBe(200);expect((await api('GET','/api/config')).body.features.browser).toBe(false);}
 const card=await request(token,{want:'your-chrome'}),path=`/api/threads/${bot.threadId}/browser-setup/${card.body.messageId}`;
 const accepted=await api('POST',path,{action:'accept'});expect(accepted.status,JSON.stringify(accepted.body)).toBe(200);
 expect((await api('GET',`/api/bots/${bot.id}`)).body.bot.pendingBrowserChoice).toBeTruthy();
 await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
 await expect.poll(async()=>(await api('GET',`/api/bots/${bot.id}`)).body.bot.browser,{timeout:15000}).toBe(true);
 expect((await api('GET','/api/config')).body.features.browser).toBe(true);
 const setup=(await api('GET',path)).body.setup;
 expect(setup.selectedMode).toBe(route==='extension'?'chrome-extension':'chrome-direct');
 expect(setup.selectionRevision).toBe((await api('GET',`/api/bots/${bot.id}`)).body.bot.selectionRevision);
 const replies=await Promise.all([api('POST',path,{action:'continue'}),api('POST',path,{action:'continue'})]);
 expect(replies.some(r=>r.status===200)).toBe(true);
 await expect.poll(async()=>(await api('GET',path)).body.setup.resumed,{timeout:15000}).toBe(true);
 const continuations=()=>readFileSync(fixture.fixtureDumpLogPath,'utf8').split('\n').filter(line=>line.includes(setup.ownerMessageId)&&line.includes('Resume their original request')).length;
 await expect.poll(continuations,{timeout:15000}).toBe(1);
 await api('POST',path,{action:'continue'});await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
 expect(continuations()).toBe(1);
 if(route==='extension'){const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').split('\n').find(line=>line.includes(setup.ownerMessageId)&&line.includes('Resume their original request'))!;expect(Object.values((JSON.parse(line) as any).mcpConfig.mcpServers).some((server:any)=>server.env?.MURAGE_BROWSER_TRANSPORT==='extension')).toBe(true);}
 console.log('S3 queued setup result',JSON.stringify({botId:bot.id,tools:true,resumed:true,continuations:continuations()}));
},45000);
