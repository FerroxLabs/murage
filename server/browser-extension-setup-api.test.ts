import {confirmedBrowserFields} from './testing/browser-choice.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real isolated server and fake engine; extension connection status is a deliberate fixture.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
// W3r (DESIGN-JOURNEY-1024 section 6, P3: setup starts only from an owner click; MAIN-RULING 2026-11-27T15:16:59Z SEAN YES).
// REPLACED: the six tests that lived here drove the bot-raised setup card (request_browser_connection) through its owner answers;
// a bot can no longer raise that card, so those flows are unreachable from a bot. The owner-click setup is W7 (not built yet).
// RED on base b99bdb6a0e: the owner turn's bot request answered 201 and posted the optional card.
// Mutant M-W3r (restore the request call in the route): RED at the 410 assertion.
async function threadMessages(threadId:string){return (await api('GET',`/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];}
it('W3r: an owner turn\'s bot cannot raise the browser setup card; the route answers 410 and posts nothing',async()=>{
 const {bot,token}=await start('Setup request fixture');
 try{
  const result=await request(token);
  expect(result.status,'W3r route retired').toBe(410);
  expect(result.body.error).toMatch(/^Bots no longer ask for browser setup\./);
  expect((await threadMessages(bot.threadId)).filter((m:any)=>m.card?.browserSetup),'W3r no setup card').toEqual([]);
  expect((await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id).useMyChrome).toBeUndefined();
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});}
},60000);
