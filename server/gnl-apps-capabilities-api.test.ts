// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';

// Model macOS Auto capability with a fake descriptor on Linux. The real mount,
// consent, authority and host RPC paths run unchanged; no real host is reached.
const instrumentation = `
const fs = await import('node:fs'), path = await import('node:path');
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
process.env.FAKE_TELEGRAM_DIR = path.join(process.env.MURAGE_DATA_DIR, 'telegram');
fs.mkdirSync(process.env.FAKE_TELEGRAM_DIR);
await import(path.join(process.cwd(), 'server/testing/telegram-fetch-preload.mjs'));
const driver = path.join(process.env.MURAGE_DATA_DIR, 'host.mjs');
fs.writeFileSync(driver, '#!' + process.execPath + '\\n' + \`import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) { const rpc=JSON.parse(line); if(rpc.id===undefined)continue;
const result=rpc.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:rpc.method==='tools/list'?{tools:[{name:'fixture_ping',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'gnl-host-pong'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\\\\n');}\`);
fs.chmodSync(driver, 0o755);
fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'cua-connection.json'), JSON.stringify({mode:'embedded',status:'ready',socketPath:path.join(process.env.MURAGE_DATA_DIR,'fake.sock'),mcpCommand:driver,mcpArgs:['mcp'],mcpEnv:{}}));
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/server/local-routing.ts') || url.endsWith('/server/host-computer-consent.ts') || url.endsWith('/server/local-computer.ts')) {
  return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replaceAll('= process.platform', '= "darwin"').replace('if (!providerSupportsLocal)', 'hostPlatform = "darwin"; if (!providerSupportsLocal)')};
 }
 return next(url,context);
}});
`;
let fixture: VerificationServer;
let desktop: Record<string,string> = {};
const evidence: unknown[] = [];
async function api(method:string,path:string,body?:unknown) {
  const res=await fetch(fixture.info.url+path,{method,headers:{...desktop,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result={status:res.status,body:await res.json() as any};
  if(!path.includes('secret'))evidence.push({method,path,status:result.status,body:result.body});
  return result;
}
async function bot(name:string) {
  const instances=(await api('GET','/api/instances')).body.instances;
  const model=instances.find((x:any)=>x.instanceId==='verification').models.options[0].id;
  const made=await api('POST','/api/bots',{name,modelSelection:{instanceId:'verification',model}});expect(made.status).toBe(201);
  const b=made.body.bot;
  expect((await api('PATCH',`/api/bots/${b.id}`,{computer:null,browser:false,composio:false,autoReview:'off',hostComputerConsent:'declined'})).status).toBe(200);
  expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true,acknowledgeLocalAuto:true,hostComputerConsent:'declined'})).status).toBe(200);
  return b;
}
async function rows(thread:string) { return (await api('GET',`/api/threads/${thread}/messages?limit=200`)).body.messages as any[]; }
async function start(b:any,label:string) {
  expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'__fixture_hold_authority__ '+label})).status).toBe(202);
  let dump:any;
  await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').split('\n').find(l=>l.includes(label));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig);}catch{return false;}},{timeout:30000}).toBe(true);
  return dump.mcpConfig.mcpServers;
}
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});
  desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
},120000);
afterAll(async()=>{
  mkdirSync('evidence/gnl-apps',{recursive:true});
  writeFileSync('evidence/gnl-apps/capabilities.json',JSON.stringify({fixture:fixture?.info,evidence},null,2));
  if(fixture)copyFileSync(fixture.info.logPath,'evidence/gnl-apps/capabilities-server.log');
  await fixture?.close();
});
it('GNL-A5 saved host consent denial does not hide an available Auto mount at No limits',async()=>{
  const b=await bot('GNL host denied');
  try {
    const servers=await start(b,'gnl-host-denied');
    expect(servers.computer).toBeTruthy();
    const token=servers.computer.env.MURAGE_CONTROL_TOKEN;
    const res=await fetch(fixture.info.url+'/api/internal/host-computer',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name:'fixture_ping',arguments:{}}})});
    const body=await res.json();evidence.push({path:'/api/internal/host-computer',status:res.status,body});
    expect(res.status).toBe(200);expect(JSON.stringify(body)).toContain('gnl-host-pong');
    expect((await rows(b.threadId)).filter(m=>m.card?.requestId)).toHaveLength(0);
    expect((await api('GET',`/api/bots/${b.id}`)).body.bot.hostComputerConsent).toBe('declined');
  } finally {await api('POST',`/api/bots/${b.id}/interrupt`,{threadId:b.threadId});}
});
it('GNL-A5 computer Off remains unmounted at No limits',async()=>{
  const b=await bot('GNL host off');
  expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off'})).status).toBe(200);
  try {expect((await start(b,'gnl-host-off')).computer).toBeUndefined();}
  finally {await api('POST',`/api/bots/${b.id}/interrupt`,{threadId:b.threadId});}
});
it('GNL-A3 paired owner channel messages Off gives one plain line and zero engine turns or cards',async()=>{
  const b=await bot('GNL channel off');
  expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',fullAccessChannelMessages:false,chiefOfStaff:true,chiefScope:'workspace'})).status).toBe(200);
  const dir=join(fixture.info.dataDir,'telegram');const updates:unknown[]=[];
  const arrives=(id:number,text:string)=>{updates.push({update_id:id,message:{message_id:id,date:1700000000+id,text,from:{id:777,is_bot:false},chat:{id:777,type:'private'}}});writeFileSync(join(dir,'staged.json'),JSON.stringify(updates));renameSync(join(dir,'staged.json'),join(dir,'updates.json'));};
  expect((await api('PATCH','/api/config',{telegram:{botToken:'123:abcdefghijklmnopqrstuvwxyz123456'}})).status).toBe(200);
  const pair=await api('POST','/api/telegram/pair',{targetBotId:b.id});expect(pair.status).toBe(200);arrives(1,'/pair '+pair.body.code);
  await expect.poll(async()=>(await api('GET','/api/telegram/status')).body.paired,{timeout:15000}).toBe(true);
  const bindings=(await api('POST','/api/memory/action',{action:'humans'})).body.bindings;
  expect((await api('POST','/api/memory/action',{action:'human-link',bindingId:bindings[0].id,expectedRevision:bindings[0].revision,as:'owner'})).status).toBe(200);
  arrives(2,'__fixture_hold_authority__ gnl-channel-off');
  await expect.poll(()=>{try{return readFileSync(join(dir,'sent.jsonl'),'utf8');}catch{return '';}},{timeout:30000}).toContain('Channel messages are off; turn them on in this bot’s Permissions → Channel messages.');
  const runs=(await api('GET','/api/routines')).body.runs.filter((r:any)=>r.botId===b.id&&r.triggerSource==='channel');
  for(const run of runs)if(run.threadId)expect((await rows(run.threadId)).filter(m=>m.card)).toHaveLength(0);
  let log='';try{log=readFileSync(fixture.fixtureDumpLogPath,'utf8');}catch{}
  expect(log).not.toContain('gnl-channel-off');
  // Lowering the same bot keeps the real paired channel route enabled at Ask.
  expect((await api('PATCH',`/api/bots/${b.id}`,{settingsScope:'defaults',autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
  expect((await api('PATCH',`/api/bots/${b.id}/tasks/${b.threadId}`,{autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
  arrives(3,'__fixture_hold_authority__ gnl-channel-ask');
  await expect.poll(()=>{try{return readFileSync(fixture.fixtureDumpLogPath,'utf8');}catch{return '';}},{timeout:30000}).toContain('gnl-channel-ask');
  const askRuns=(await api('GET','/api/routines')).body.runs.filter((r:any)=>r.botId===b.id&&r.triggerSource==='channel');
  for(const run of askRuns)if(run.threadId)await api('POST',`/api/bots/${b.id}/interrupt`,{threadId:run.threadId});

});
