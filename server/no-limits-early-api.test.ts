// Fake requests only. The server boots with fresh HOME/data and executes no tool.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { openSse } from './testing/sse.ts';
let fixture:VerificationServer,headers:Record<string,string>;
const out=new URL('../.nolim-evidence/early/regressions/',import.meta.url);mkdirSync(out,{recursive:true});
async function api(method:string,path:string,body?:unknown):Promise<any>{
 const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 expect(res.ok).toBe(true);return res.json();
}
beforeAll(async()=>{
 const anchor='emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
 const replacement=`
  const variant=JSON.stringify(turn.prompt??turn.text);
  earlyMarks.markHighLevelThread(earlyDb.database(),turn.threadId);
  const command=variant.includes('wipe-control')?'rm -rf ~':'printf fixture';
  const tool=variant.includes('host-denied')?'host_computer':variant.includes('browser-off')?'agent_browser_click':'Bash';
  emit({type:'request.opened',requestType:'permission',toolEngine:'claude',tool,summary:command,toolCall:{name:tool,input:{command,cwd:turn.cwd}},requestId:turnId+'-early',threadId:turn.threadId,turnId});return;`;
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  await import(${JSON.stringify(new URL('./testing/idle-load-preload.mjs',import.meta.url).href)});
  const fs=await import('node:fs'),path=await import('node:path');const {registerHooks}=await import('node:module');
  registerHooks({load(url,ctx,next){
   if(!url.endsWith('/fake-late-terminal-driver.ts'))return next(url,ctx);
   let source=${JSON.stringify("import * as earlyMarks from '../highlevel/thread-marks.ts'; import * as earlyDb from '../database.ts';\n")}+fs.readFileSync(new URL(url),'utf8');
   if(!source.includes(${JSON.stringify(anchor)}))throw Error('early fixture anchor changed');
   source=source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)});
   source=source.replace('respondToRequest: async () => "unavailable" as const,','respondToRequest: async (threadId,requestId,response)=>{const entry=active.get(threadId);if(!entry)return "unavailable" as const;emit({type:"request.resolved",threadId,turnId:entry.turnId,requestId,behavior:response.behavior,source:"user"});emit({type:"item.completed",itemType:"assistant_text",origin:"engine",text:"early "+response.behavior,threadId,turnId:entry.turnId});active.delete(threadId);emit({type:"turn.completed",ok:true,threadId,turnId:entry.turnId});return "applied" as const;},');
   return {format:'module-typescript',shortCircuit:true,source};
  }});
  const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('./drivers/builtIn.ts',import.meta.url).href)});
  const {makeLateTerminalDriver}=await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts',import.meta.url).href)});const driver=makeLateTerminalDriver();BUILT_IN_DRIVERS.push({...driver,create:async(input)=>{const instance=await driver.create(input);Object.defineProperty(instance,'decisionAdapter',{value:{respondToRequest:async(t,r,a)=>{const result=await instance.adapter.respondToRequest(t,r,a);return{state:result==='applied'?'accepted':'failed'};},interruptTurn:(...args)=>instance.adapter.interruptTurn(...args)}});return instance;}});
  const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.instances.early={driver:'fakeLateTerminal'};fs.writeFileSync(file,JSON.stringify(cfg));
 `});
 const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.secret};
},60000);
afterAll(async()=>{try{if(fixture)writeFileSync(new URL('server.log',out),readFileSync(fixture.info.logPath));}finally{await fixture?.close();}});
it.each(['ordinary','wipe-control','host-denied','browser-off'])('EARLY-HL marked conversation %s reaches the No limits decision',async variant=>{
 const {bot}=await api('POST','/api/bots',{name:'Early fixture',modelSelection:{instanceId:'early',model:'late-1'}});
 await api('PATCH',`/api/bots/${bot.id}`,{cwd:fixture.info.dataDir,computer:'off',browser:false,composio:false,autoReview:'off'});
 await api('PATCH',`/api/bots/${bot.id}/tasks/${bot.threadId}`,{noLimits:true,acknowledgeNoLimits:true});
 if(variant==='host-denied')await api('PATCH',`/api/bots/${bot.id}`,{hostComputerConsent:'declined',computer:null});
 const stream=await openSse(fixture.info.url+'/api/events');
 try{
  await stream.until(frame=>frame.kind==='hello');
  await api('POST',`/api/bots/${bot.id}/messages`,{text:variant,threadId:bot.threadId});
  await stream.until(frame=>frame.kind==='runtime'&&frame.event?.type==='request.opened'&&frame.event?.threadId===bot.threadId);
  const waited=await runControlMurage(['wait','--bot',bot.id,'--timeout','5','--url',fixture.info.url]);
  const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`);
  writeFileSync(new URL(variant+'.json',out),JSON.stringify({waited,messages},null,2)+'\n');
  expect(waited).toMatchObject({status:variant==='wipe-control'?'needs-user':'settled'});
  expect(messages.messages.filter((m:any)=>m.card?.requestId)).toHaveLength(variant==='wipe-control'?1:0);
  if(variant==='ordinary')expect(messages.messages.some((m:any)=>m.text==='early allow')).toBe(true);
  if(variant==='browser-off'){
   expect(messages.messages.some((m:any)=>m.text==='early allow')).toBe(false);
   expect(messages.messages.filter((m:any)=>m.text==='Browser control is off. Turn it on in the bot’s Browser settings.')).toHaveLength(1);
  }
  if(variant==='host-denied'){
   expect(messages.messages.some((m:any)=>m.text==='early allow')).toBe(true);
   expect(messages.messages.filter((m:any)=>m.text==='The owner has denied this action. It was not run.')).toHaveLength(0);
  }
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});stream.close();}
},30000);
