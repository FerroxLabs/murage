// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated production HTTP routes, real turn capabilities, loopback-only provider fakes.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { withTurnSecrets } from '../testing/fixture-dump.ts';
import { raiseLevel } from '../testing/raise-level.ts';
let fixture:VerificationServer, desktop:Record<string,string>, bot:{id:string;threadId:string};
const evidence:unknown[]=[];
const instrumentation=`
// These workflows control admission inputs; shared CI host load is not one.
await import(${JSON.stringify(new URL('../testing/idle-load-preload.mjs', import.meta.url).href)});
process.env.MURAGE_TEST_EMAIL_STORE='memory';
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
process.env.FAKE_CLAUDE_MCP_LIST_LOG=(await import('node:path')).join(process.env.MURAGE_DATA_DIR,'native-mcp-lists.jsonl');
process.env.MURAGE_EMAIL_SECRETS=JSON.stringify({owner:{token:'owner-fixture',keyId:'owner-fixture'}});
process.env.MURAGE_MCP_SERVER_SECRETS=JSON.stringify({'publish-netlify':{env:{NETLIFY_AUTH_TOKEN:'netlify-fixture'}}});
const fs=await import('node:fs'),path=await import('node:path');
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 let source=fs.readFileSync(new URL(url),'utf8');
 const anchor='  const ownerCardRequest = opts?.projectCardRun ? roomRequest(database(), opts.projectCardRun.request.id) : null;';
 if(!source.includes(anchor))return next(url,context);
 source=source.replace(anchor,\`
  const fixtureVariant=text.match(/NL_EMAIL_PROJECT_NEG_([a-z-]+)/)?.[1];
  if(fixtureVariant && opts?.projectCardRun){
   const id=opts.projectCardRun.request.id;
   if(fixtureVariant==='unproven')database().prepare("UPDATE room_requests SET origin='unproven' WHERE id=?").run(id);
   if(fixtureVariant==='bot')database().prepare("UPDATE room_requests SET from_kind='bot' WHERE id=?").run(id);
   if(fixtureVariant==='unattended')database().prepare("UPDATE room_requests SET unattended=1 WHERE id=?").run(id);
   if(fixtureVariant==='other-human')database().prepare("UPDATE room_requests SET not_owner_audience=1 WHERE id=?").run(id);
  }
 \`+anchor);
 const observe='  internalTurnOwners.get(threadId)!.triggerMessageId = userMessage.id;';
 if(!source.includes(observe))throw Error('Project authority observer anchor moved');
 source=source.replace(observe,\`
  const fixtureMarker=text.match(/NL_EMAIL_PROJECT(?:_NEG_[a-z-]+|_CARD)/)?.[0];
  if(fixtureMarker)(await import('node:fs')).appendFileSync(DATA_DIR+'/project-authority.jsonl',JSON.stringify({marker:fixtureMarker,initiator:dispatchProvenance.initiator.k,level:readTurnPolicy({threadId,generation:run.generation})?.level,service:serviceNoLimits(run.generation,threadId,bot.id)})+String.fromCharCode(10));
 \`+observe);
 return {format:'module-typescript',shortCircuit:true,source};
}});
const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
cfg.flux={apiKey:'sk-flux-fixture-only'};fs.writeFileSync(file,JSON.stringify(cfg));
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}),realFetch=globalThis.fetch;
const mail={id:'msg',thread_id:'mail-thread',direction:'inbound',from:'sender@example.test',subject:'Visible fixture subject',text:'Visible fixture body',sender_authenticated:false,blocked:true,held_for_owner:true,injection_scan:{status:'complete',verdict:'clear'}};
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input instanceof Request?input.url:input));if(url.protocol!=='https:')return realFetch(input,init);
 const method=String(init?.method??'GET').toUpperCase(),p=url.pathname;
 fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'provider-calls.jsonl'),JSON.stringify({method,host:url.hostname,path:p})+'\\n');
 if(url.hostname==='fixture.netlify.app')return new Response('<title>Fixture site</title>',{status:200});
 if(url.hostname==='api.netlify.com'){
  if(method==='POST'&&p.endsWith('/deploys'))return json(200,{id:'deploy-fixture',ssl_url:'https://fixture.netlify.app'});
  if(method==='DELETE')return new Response(null,{status:204});
  return json(200,{id:'site-fixture',ssl_url:'https://fixture.netlify.app'});
 }
 if(!/(^|\\.)fluxrouter\\.ai$/.test(url.hostname))throw Error('External network refused by email fixture');
 if(p==='/v1/email/capabilities')return json(200,{enabled:true,available:true,account_state:'active',terms_version:'v1',limits:{max_inboxes:5}});
 if(method==='POST'&&p==='/api/desktop/bot-keys')return json(201,{key:'bot-fixture',key_id:'key-bot-fixture'});
 if(method==='POST'&&p==='/v1/email/inboxes'){const body=JSON.parse(String(init.body));return json(201,{id:'inbox-fixture',bot_id:body.bot_id,address:'fixture@murage.email',state:'active',send_policy:'ask'});}
 if(method==='GET'&&p==='/v1/email/inboxes/inbox-fixture')return json(200,{id:'inbox-fixture',address:'fixture@murage.email',state:'active',send_policy:'ask'});
 if(method==='POST'&&/\\/messages(?:\\/msg\\/reply)?$/.test(p))return json(200,{status:'sent',message_id:'sent-fixture'});
 if(method==='POST'&&p.endsWith('/recipients'))return json(200,{});
 if(method==='GET'&&p.endsWith('/messages'))return json(200,{data:[mail]});
 if(method==='GET'&&p.endsWith('/messages/msg'))return json(200,mail);
 if(method==='GET'&&p.endsWith('/threads/mail-thread'))return json(200,{messages:[mail]});
 if(method==='GET'&&p.endsWith('/approvals'))return json(200,{data:[]});
 return json(404,{error:'not_found'});
};
`;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const answer={status:response.status,body:await response.json() as any};
 if(!/secret|webhooks/.test(path))evidence.push({method,path,status:answer.status,body:answer.body});return answer;
}
const calls=()=>{const path=join(fixture.info.dataDir,'provider-calls.jsonl');return existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
async function duringTurn(marker:string,run:(auth:Record<string,string>,threadId:string,dump:any)=>Promise<void>,webhook:boolean|'routine'=false,ownerThreadId?:string){
 let threadId=ownerThreadId??bot.threadId;
 if(webhook==='routine'){
  const made=await api('POST','/api/routines',{botId:bot.id,name:marker,prompt:marker+' __fixture_hold_authority__',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});expect(made.status,JSON.stringify(made.body)).toBe(201);
  const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status,JSON.stringify(started.body)).toBe(201);
  await expect.poll(async()=>{const found=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id);if(found?.threadId)threadId=found.threadId;return !!found?.threadId;},{timeout:30000}).toBe(true);
 }else if(webhook){
  const hook=await api('POST','/api/webhooks',{name:marker,prompt:marker+' __fixture_hold_authority__',botId:bot.id,runOn:'ember'});expect(hook.status,JSON.stringify(hook.body)).toBe(201);
  const delivered=await fetch(hook.body.credential.url,{method:'POST',headers:{'content-type':'application/json'},body:'{"fixture":"ping"}'});expect(delivered.status).toBe(202);
  const {runId}=await delivered.json() as any;
  await expect.poll(async()=>{const found=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===runId);if(found?.threadId)threadId=found.threadId;return !!found?.threadId;},{timeout:30000}).toBe(true);
 } else expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId,text:marker+' __fixture_hold_authority__'})).status).toBe(202);
 let dump:any;
 try{
  await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(line=>line.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return !!dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;}catch{return false;}},{timeout:30000}).toBe(true);
  await run({authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN},threadId,dump);
 }finally{
  if(dump?.pid)writeFileSync(join(fixture.fixtureFinishGateDir,String(dump.pid)),'');
  await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId});
  await expect.poll(async()=>!(await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:30000}).toBe(true);
 }
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};
 const instances=(await api('GET','/api/instances')).body.instances,model=instances.find((x:any)=>x.instanceId==='verification').models.options[0].id;
 bot=(await api('POST','/api/bots',{name:'No limits email fixture',modelSelection:{instanceId:'verification',model}})).body.bot;
 expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 await vi.waitFor(async()=>{expect((await api('GET','/api/email/status?refresh=1')).status).toBe(200);},{timeout:30000});
 expect((await api('POST',`/api/email/bots/${bot.id}/setup`,{username:'fixture',displayName:'Fixture'})).status).toBe(200);
},120000);
afterAll(async()=>{
 const proof=process.env.SC_ISSUES_EVIDENCE??'.gnl-proof/evidence';
 mkdirSync(proof,{recursive:true});writeFileSync(join(proof,'http-workflows.json'),JSON.stringify({fixture:fixture?.info,evidence},null,2));if(fixture?.info.logPath&&existsSync(fixture.info.logPath))copyFileSync(fixture.info.logPath,join(proof,'http-server.log'));
 if(fixture&&existsSync(join(fixture.info.dataDir,'project-authority.jsonl')))copyFileSync(join(fixture.info.dataDir,'project-authority.jsonl'),join(proof,'project-authority.jsonl'));
 await fixture?.close();
});
const projectObservation=(marker:string)=>readFileSync(join(fixture.info.dataDir,'project-authority.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row)).find(row=>row.marker===marker);
it('F1 HTTP webhook mounts email and sends without an owner message',async()=>{
 await duringTurn('NL_EMAIL_WEBHOOK',async(auth,_thread,dump)=>{
  const sent=await api('POST','/api/internal/email/email_send',{to:['sender@example.test'],subject:'Webhook',text:'Fixture webhook'},auth);
  expect(sent.status,JSON.stringify(sent.body)).toBe(200);expect(sent.body.text).toMatch(/^Sent/);expect(dump.mcpConfig.mcpServers.agents.env.MURAGE_EMAIL).toBe('send');
 },true);
},90000);
it('F2 HTTP reads and replies to blocked, unauthenticated held mail without a card',async()=>{
 await duringTurn('NL_EMAIL_FILTERS',async(auth)=>{
  for(const [tool,body,expected]of [['email_list',{},'Visible fixture subject'],['email_read',{message_id:'msg'},'Visible fixture body'],['email_read',{thread_id:'mail-thread'},'Visible fixture body']]as const){const result=await api('POST','/api/internal/email/'+tool,body,auth);expect(result.status).toBe(200);expect(result.body.text).toContain(expected);}
  expect((await api('POST','/api/internal/email/email_reply',{message_id:'msg',text:'Fixture reply'},auth)).body.text).toMatch(/^Sent/);
 });
},90000);
it('F3 HTTP trust offer RUN accepts without a card or prior earned-trust count',async()=>{
 const before=calls().filter(x=>x.path.endsWith('/recipients')).length;
 await duringTurn('NL_EMAIL_TRUST',async auth=>{const result=await api('POST','/api/internal/email/email_trust_offer',{address:'trust@example.test',reason:'Fixture owner request'},auth);expect(result.status).toBe(200);expect(result.body).toEqual({text:'This address is trusted.'});});
 expect(calls().filter(x=>x.path.endsWith('/recipients'))).toHaveLength(before+1);
},90000);
it('F4 HTTP attaches credentials and registers a memory deliverable',async()=>{
 await duringTurn('NL_EMAIL_FILES',async(auth,threadId)=>{
  const workspace=(await api('GET',`/api/artifacts/workspace?botId=${bot.id}&threadId=${threadId}`)).body.path as string;
  expect(workspace.startsWith(fixture.info.dataDir)).toBe(true);
  for(const dir of ['credentials','memory'])mkdirSync(join(workspace,dir),{recursive:true});
  writeFileSync(join(workspace,'large.txt'),Buffer.alloc(26*1024*1024,65));
  writeFileSync(join(workspace,'credentials','report.txt'),'Fixture attachment');writeFileSync(join(workspace,'memory','report.html'),'<title>Fixture report</title>');
  expect((await api('POST','/api/internal/email/email_send',{to:['sender@example.test'],subject:'Attachment',text:'Fixture files',attachments:['credentials/report.txt']},auth)).body.text).toMatch(/^Sent/);
  const saved=await api('POST','/api/internal/register-artifact',{relativePath:'memory/report.html'},auth);expect(saved.status,JSON.stringify(saved.body)).toBe(201);
  const large=await api('POST','/api/internal/register-artifact',{relativePath:'large.txt'},auth);expect(large.status,JSON.stringify(large.body)).toBe(201);
 });
},90000);
it('F5 HTTP fresh owner turns intentionally repeat identical email while same-turn retries stay one send',async()=>{
 const sentCount=()=>calls().filter(x=>x.method==='POST'&&x.path.endsWith('/messages')).length,before=sentCount();
 const body={to:['sender@example.test'],subject:'Intentional repeat',text:'Identical fixture email'};
 for(const marker of ['NL_EMAIL_REPEAT_1','NL_EMAIL_REPEAT_2'])await duringTurn(marker,async auth=>{for(let i=0;i<2;i++){const result=await api('POST','/api/internal/email/email_send',body,auth);expect(result.body.text,JSON.stringify(result.body)).toMatch(/^Sent/);}});
 expect(sentCount()).toBe(before+2);
},120000);
it('F6 HTTP posts to the requested owner channel without the picker',async()=>{
 const group=(await api('POST','/api/groups',{name:'Fixture launch room',memberIds:[bot.id]})).body.group;
 await duringTurn('NL_EMAIL_VENUE',async(auth,_thread,dump)=>{const result=await api('POST','/api/internal/venue/post',{venueId:group.id,text:'Fixture launch update'},auth);expect(result.status,JSON.stringify(result.body)).toBe(200);expect(result.body.posted).toBe(true);expect(dump.mcpConfig.mcpServers.agents.env.MURAGE_VENUE_POST).toBe('1');});
 const messages=(await api('GET',`/api/threads/${group.threadId}/messages`)).body.messages;expect(messages.some((m:any)=>m.text==='Fixture launch update')).toBe(true);
},90000);
it('F7 HTTP updates an unassigned site from a protected folder and includes protected files',async()=>{
 await duringTurn('NL_EMAIL_PUBLISH',async(auth,threadId)=>{
  const workspace=(await api('GET',`/api/artifacts/workspace?botId=${bot.id}&threadId=${threadId}`)).body.path as string;
  expect(workspace.startsWith(fixture.info.dataDir)).toBe(true);
  mkdirSync(join(workspace,'credentials','site','.well-known'),{recursive:true});writeFileSync(join(workspace,'credentials','site','index.html'),'<title>Fixture site</title>');writeFileSync(join(workspace,'credentials','site','.well-known','proof.txt'),'Fixture proof');
  const result=await api('POST','/api/internal/publish-site',{siteId:'site-fixture',folder:'credentials/site'},auth);expect(result.status,JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({status:'live',fileCount:2});
 });
 const state=(await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id);expect(state.publishedSites).toContainEqual(expect.objectContaining({siteId:'site-fixture',name:'fixture',origin:'assigned'}));
 const rows=(await api('GET',`/api/threads/${bot.threadId}/messages`)).body.messages;expect(rows.filter((m:any)=>m.card&&!m.card.answered&&['email_send','email_reply','email_trust_offer','publish_site','take_down_site','venue_post'].includes(m.card.tool))).toEqual([]);
},90000);

// Observe the real engine's initialized shim. A second, short-lived proxy
// closes the consuming transport before the HTTP assertions can use it.
async function listedTools(dump:any){
 let listed:{pid:number;name:string;tools:string[]}|undefined;
 await expect.poll(()=>{
  try{listed=readFileSync(join(fixture.info.dataDir,'native-mcp-lists.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.pid===dump.pid&&row.name==='agents');return !!listed;}
  catch{return false;}
 },{timeout:30000}).toBe(true);
 expect(dump.wireMcpConfig.mcpServers.agents.args).toContain('--server');
 expect(dump.wireMcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN).toBeUndefined();
 return listed!.tools;
}

it('R1 HTTP owner-only project card turn lists and executes email and venue posting at No limits',async()=>{
 const marker='NL_EMAIL_PROJECT_CARD';
 const group=(await api('POST','/api/groups',{name:'Fixture project',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).body.group;
 expect((await api('PATCH',`/api/groups/${group.id}`,{channelProject:{goal:'Fixture project tools'}})).status).toBe(200);
 const card=(await api('POST',`/api/groups/${group.id}/board/cards`,{clientId:marker,title:marker+' __fixture_hold_authority__',assigneeBotId:bot.id,writes:false})).body.card;
 let dump:any;
 try{
  expect((await api('PATCH',`/api/groups/${group.id}/board/cards/${card.id}`,{expectedRevision:card.revision,action:'start'})).status).toBe(200);
  await expect.poll(()=>{try{const lines=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n');for(const line of lines){const candidate=withTurnSecrets(JSON.parse(line));if(['lead','member'].includes(candidate.mcpConfig?.mcpServers?.agents?.env?.MURAGE_PROJECT_ROLE)){dump=candidate;return true;}}return false;}catch{return false;}},{timeout:45000}).toBe(true);
  const env=dump.mcpConfig.mcpServers.agents.env,auth={authorization:'Bearer '+env.MURAGE_COMMS_TOKEN};
  expect(projectObservation(marker)).toMatchObject({initiator:'owner-typed',level:'unlimited',service:true});
  expect(['lead','member']).toContain(env.MURAGE_PROJECT_ROLE);
  expect(env.MURAGE_EMAIL).toBe('send');expect(env.MURAGE_VENUE_POST).toBe('1');
  expect(await listedTools(dump)).toEqual(expect.arrayContaining(['email_list','email_read','email_send','email_reply','email_trust_offer','venue_post']));
  expect((await api('POST','/api/internal/email/email_send',{to:['sender@example.test'],subject:'Project email',text:'Project fixture'},auth)).body.text).toMatch(/^Sent/);
  const posted=await api('POST','/api/internal/venue/post',{venueId:group.id,text:'Project fixture post'},auth);
  expect(posted.status,JSON.stringify(posted.body)).toBe(200);expect(posted.body.posted).toBe(true);
 }finally{
  if(dump?.pid)writeFileSync(join(fixture.fixtureFinishGateDir,String(dump.pid)),'');
  await api('POST',`/api/groups/${group.id}/project/control/stop`,{});
  await api('POST',`/api/bots/${bot.id}/interrupt`,{});
 }
},120000);

it.each(['unproven','bot','unattended','other-human'] as const)('R5 HTTP %s project request never borrows owner room authority',async variant=>{
 const marker='NL_EMAIL_PROJECT_NEG_'+variant;
 const group=(await api('POST','/api/groups',{name:marker,memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).body.group;
 expect((await api('PATCH',`/api/groups/${group.id}`,{channelProject:{goal:'Fixture project tools'}})).status).toBe(200);
 const card=(await api('POST',`/api/groups/${group.id}/board/cards`,{clientId:marker,title:marker+' __fixture_hold_authority__',assigneeBotId:bot.id,writes:false})).body.card;
 let dump:any;
 try{
  expect((await api('PATCH',`/api/groups/${group.id}/board/cards/${card.id}`,{expectedRevision:card.revision,action:'start'})).status).toBe(200);
  await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(line=>line.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return !!dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_PROJECT_ROLE;}catch{return false;}},{timeout:45000}).toBe(true);
  const env=dump.mcpConfig.mcpServers.agents.env;
  expect(projectObservation(marker)).toMatchObject({initiator:'other-human',level:'ask',service:false});
  expect(env.MURAGE_EMAIL).not.toBe('send');expect(env.MURAGE_VENUE_POST).not.toBe('1');
  expect(await listedTools(dump)).not.toContain('email_send');
  const before=calls().filter(row=>row.method==='POST'&&row.path.endsWith('/messages')).length;
  const result=await api('POST','/api/internal/email/email_send',{to:['sender@example.test'],subject:marker,text:'Must remain held'}, {authorization:'Bearer '+env.MURAGE_COMMS_TOKEN});
  expect(result.body.text??'').not.toMatch(/^Sent/);
  expect(calls().filter(row=>row.method==='POST'&&row.path.endsWith('/messages'))).toHaveLength(before);
 }finally{
  if(dump?.pid)writeFileSync(join(fixture.fixtureFinishGateDir,String(dump.pid)),'');
  await api('POST',`/api/groups/${group.id}/project/control/stop`,{});
  await api('POST',`/api/bots/${bot.id}/interrupt`,{});
 }
},120000);

it.each([false,true,'routine'] as const)('H2 HTTP linked attachments, deliverables and publishing RUN (automation: %s)',async webhook=>{
 // This linked-file control starts a real owner task, separate from the
 // deliberately refused project context above. Its bot and No limits policy
 // are unchanged; create/send HTTP routes still establish all authority.
 let ownerThreadId:string|undefined;
 if(webhook===false){
  const fresh=await api('POST',`/api/bots/${bot.id}/tasks`,{title:'Linked files'});
  expect(fresh.status,JSON.stringify(fresh.body)).toBe(201);
  ownerThreadId=fresh.body.task.threadId;
  expect(ownerThreadId).not.toBe(bot.threadId);
 }
 await duringTurn(webhook==='routine'?'H2_LINK_ROUTINE':webhook?'H2_LINK_WEBHOOK':'H2_LINK_OWNER',async(auth,threadId)=>{
  const workspace=(await api('GET',`/api/artifacts/workspace?botId=${bot.id}&threadId=${threadId}`)).body.path as string;
  expect(workspace.startsWith(fixture.info.dataDir)).toBe(true);
  const site=join(workspace,'linked-site');mkdirSync(site,{recursive:true});
  writeFileSync(join(site,'index.html'),'<title>Fixture site</title>');
  writeFileSync(join(site,'source.txt'),'Linked fixture bytes');
  symlinkSync(join(site,'source.txt'),join(site,'symbolic.txt'));
  linkSync(join(site,'source.txt'),join(site,'hard.txt'));
  const sent=await api('POST','/api/internal/email/email_send',{to:['sender@example.test'],subject:'Linked files',text:'Linked fixture',attachments:['linked-site/symbolic.txt','linked-site/hard.txt']},auth);
  expect(sent.status,JSON.stringify(sent.body)).toBe(200);expect(sent.body.text).toMatch(/^Sent/);
  for(const relativePath of ['linked-site/symbolic.txt','linked-site/hard.txt']){
   const saved=await api('POST','/api/internal/register-artifact',{relativePath},auth);expect(saved.status,JSON.stringify(saved.body)).toBe(201);
  }
  const published=await api('POST','/api/internal/publish-site',{siteId:'site-fixture',folder:'linked-site'},auth);
  expect(published.status,JSON.stringify(published.body)).toBe(200);expect(published.body).toMatchObject({status:'live',fileCount:4});
  const rows=(await api('GET',`/api/threads/${threadId}/messages`)).body.messages;
  expect(rows.filter((m:any)=>m.card&&!m.card.answered&&['email_send','publish_site'].includes(m.card.tool))).toEqual([]);
 },webhook,ownerThreadId);
},120000);
