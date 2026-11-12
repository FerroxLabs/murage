// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTempDir, waitForExit } from '../../testing/cleanup.ts';
import { assertSafeToWipe } from '../../testing/safe-wipe.mjs';
import { freePortBlock } from '../../testing/ports.ts';
import { raiseLevel } from '../../testing/raise-level.ts';
import { claudeMcpLaunch } from '../../testing/fake-custom-tool.ts';
import { BehavioralRed, journal, requireFact, Surface } from './surface.ts';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const evidence=resolve(process.env.FIELD_REPLAY_EVIDENCE??join(root,'server/memory/evidence/field-replay'));
export const tree=process.env.FIELD_REPLAY_TREE??'T0';
export const sha=process.env.FIELD_REPLAY_SHA??execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
export class Blocked extends Error {constructor(message:string){super(message);this.name='ReplayInfrastructureError';}}
export const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function poll<T>(read:()=>Promise<T|undefined>|T|undefined,label:string,ms=25_000):Promise<T>{
 const end=Date.now()+ms;
 do{const value=await read();if(value!==undefined)return value;await delay(100);}while(Date.now()<end);
 throw new Blocked(`timeout: ${label}`);
}
export function record(row:Record<string,unknown>){mkdirSync(evidence,{recursive:true});appendFileSync(join(evidence,'field-replay.jsonl'),JSON.stringify({tree,sha,mutant:process.env.FIELD_REPLAY_MUTANT??null,...row})+'\n');}
export type Bot={id:string;threadId:string};
export type Turn={bot:Bot;threadId:string;dump:any;startedAt:number;surface:Surface;mark?:any;priorMark?:any};
export class Harness {
 home='';data='';base='';headers:Record<string,string>={};child?:ChildProcess;log='';
 lastTurn?:Turn;facts:Record<string,unknown>={};gate='';dump='';clone='';clean='';surfaces:Surface[]=[];proxies=new Set<ChildProcess>();
 async start(registerClone=true){
  mkdirSync(evidence,{recursive:true});
  this.home=mkdtempSync(join(tmpdir(),'murage-field-replay-'));assertSafeToWipe(this.home);
  this.data=join(this.home,'data');this.gate=join(this.home,'release');this.dump=join(this.home,'turns.jsonl');
  this.clean=mkdtempSync(join(tmpdir(),'murage-field-clean-'));assertSafeToWipe(this.clean);mkdirSync(this.data);
  const seed=join(this.home,'seed');mkdirSync(seed);writeFileSync(join(seed,'README.md'),'Synthetic cloned fixture.\n');
  const gitEnv={...process.env,GIT_CONFIG_GLOBAL:join(this.home,'git-global'),GIT_CONFIG_SYSTEM:join(this.home,'git-system')};
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL,'');writeFileSync(gitEnv.GIT_CONFIG_SYSTEM,'');
  const git=(args:string[],cwd=seed)=>execFileSync('git',args,{cwd,env:gitEnv,stdio:'pipe'});
  git(['init']);git(['add','README.md']);git(['-c','user.name=ci','-c','user.email=sean@seandonahoe.com','commit','-m','Synthetic clone source']);
  this.clone=join(this.home,'clone');git(['clone',seed,this.clone]);
  // Wrapper is the fake CLI. Do not chmod or edit the shared engine fixtures.
  const wrapper=join(this.home,'claude');writeFileSync(wrapper,`#!/bin/sh\nexec '${process.execPath}' '${join(root,'server/testing/fake-claude-cli.ts')}' "$@"\n`,{mode:0o755});
  const acp=join(this.home,'acp');writeFileSync(acp,`#!/bin/sh\nexec '${process.execPath}' '${join(root,'server/memory/field-replay/engine.mjs')}' "$@"\n`,{mode:0o755});
  const env={FAKE_CLAUDE_DUMP:join(this.home,'latest.json'),FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_DUMP_HISTORY:this.dump,FAKE_CLAUDE_HOLD_MARKER:'FIELD_REPLAY_HOLD',FAKE_CLAUDE_HOLD_GATE:this.gate,FAKE_CLAUDE_REPLIES:JSON.stringify(['Synthetic done.'])};
  writeFileSync(join(this.data,'config.json'),JSON.stringify({instances:{source:{driver:'claudeAgent',config:{cli:wrapper},environment:{...env,FAKE_CLAUDE_HOLD_GATE:join(this.home,'sourceRelease')}},clone:{driver:'claudeAgent',config:{cli:wrapper},environment:{...env,FAKE_CLAUDE_PERM_TOOL:'Bash',FAKE_CLAUDE_PERM_INPUT:JSON.stringify({command:`git clone '${seed}' '${this.clone}'`})}},field:{driver:'claudeAgent',config:{cli:wrapper},environment:env},web:{driver:'grokAgent',config:{cli:acp,fullAuto:false},environment:{FIELD_REPLAY_DUMP:this.dump,FIELD_REPLAY_GATE:this.gate}}}}));
  const port=await freePortBlock([0,1],19001,200);this.base=`http://127.0.0.1:${port}`;
  this.child=spawn(process.execPath,['--experimental-strip-types',join(root,'server/index.ts')],{cwd:root,env:{PATH:process.env.PATH,HOME:this.home,USERPROFILE:this.home,MURAGE_DATA_DIR:this.data,MURAGE_PORT:String(port),MURAGE_WEBHOOK_PORT:String(port+1),MURAGE_ALLOW_DEV_DESKTOP_SECRET:'1',...(process.env.FIELD_REPLAY_RESOURCES?{MURAGE_RESOURCES_PATH:process.env.FIELD_REPLAY_RESOURCES}:{})},stdio:['ignore','pipe','pipe']});
  const save=(chunk:Buffer)=>{this.log+=chunk.toString();appendFileSync(join(evidence,'server.log'),chunk);};
  this.child.stdout!.on('data',save);this.child.stderr!.on('data',save);
  await poll(async()=>{
   if(this.child?.exitCode!==null||this.child?.signalCode)throw new Blocked(`real server exited: ${this.log.slice(-4000)}`);
   try{const r=await fetch(`${this.base}/api/health`,{signal:AbortSignal.timeout(1500)});return r.ok?true:undefined;}catch{return undefined;}
  },'real server health');
  const proof=await this.call('GET','/api/desktop-secret');this.headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.body.secret};
  await this.call('POST','/api/memory/action',{action:'configure',mode:'active',extractorInstanceId:null});
  if(!registerClone)return;
  // A remote in .git/config alone is not a registry entry. Let the real
  // server observe the fake engine's clone tool before testing cwd marking.
  // Registry time windows include two seconds before the tool. This folder
  // must predate that window so the web and carry cases have only their own mark.
  await delay(2200);
  const bootstrap=await this.bot('Clone registration','clone');
  const bootstrapCwd=join(this.home,'bootstrap');mkdirSync(bootstrapCwd);await this.cwd(bootstrap,bootstrapCwd);
  await this.call('POST',`/api/bots/${bootstrap.id}/messages`,{text:'__fixture_permission_tool__ Register the synthetic local clone.'});
  await poll(()=>journal(join(this.data,'outside-state.jsonl')).some(r=>r.k==='reg'&&r.add.some((e:any)=>e.path===this.clone.toLowerCase()))?true:undefined,'server-observed clone registration');
  await this.call('POST',`/api/bots/${bootstrap.id}/interrupt`,{threadId:bootstrap.threadId});
 }
 call=async(method:string,path:string,body?:unknown,owner=true):Promise<{status:number;body:any}>=>{
  if(path.startsWith('/api/internal/'))throw new Error('Replay cannot post internal routes');
  const r=await fetch(this.base+path,{method,headers:{...(owner?this.headers:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20_000)});
  const value=await r.json();if(r.status>=500||/NotBuilt/.test(JSON.stringify(value)))throw new Blocked(`HTTP ${r.status} ${path}: ${JSON.stringify(value)}`);
  return {status:r.status,body:value};
 };
 async bot(name:string,instanceId='field',level:'unlimited'|'full'='unlimited'){
  const created=await this.call('POST','/api/bots',{name,section:'Field replay',modelSelection:{instanceId,model:'fake-model'}});
  if(created.status!==201)throw new Blocked(`create bot: ${JSON.stringify(created)}`);
  const bot=created.body.bot as Bot;
  await this.call('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
  const raised=await raiseLevel(this.call,bot.id,level==='unlimited'?{noLimits:true,acknowledgeNoLimits:true}:{autoApprove:true,fullAccess:true,acknowledgeFullAccess:true});
  if(raised.status!==200)throw new Blocked(`raise permissions: ${JSON.stringify(raised)}`);
  return bot;
 }
 async cwd(bot:Bot,path:string){const r=await this.call('PATCH',`/api/bots/${bot.id}/tasks/${bot.threadId}`,{cwd:path});if(r.status!==200)throw new Blocked(`cwd: ${JSON.stringify(r)}`);}
 dumps(){return journal(this.dump);}
 async held(bot:Bot,owner=true,threadId=bot.threadId,send=true):Promise<Turn>{
  const surface=await Surface.open(this.base,this.headers,this.call,this.data);this.surfaces.push(surface);
  const before=this.dumps().length,startedAt=Date.now();
  if(send){const r=await this.call('POST',`/api/bots/${bot.id}/messages`,{threadId,text:'FIELD_REPLAY_HOLD Please remember the synthetic field replay note. Schedule the requested synthetic check.'},owner);if(r.status!==202)throw new Blocked(`send: ${JSON.stringify(r)}`);}
  const dump=await poll(()=>this.dumps().slice(send?before:0).find(d=>Object.values(d.mcpConfig?.mcpServers??{}).some((s:any)=>s.env?.MURAGE_THREAD_ID===threadId)),'engine mounted turn');
  return this.lastTurn={bot,threadId,dump,surface,startedAt};
 }
 async stopTurn(turn:Turn,keepSurface=false){
  // A desktop interruption closes exactly this isolated turn, revoking its mounts.
  await this.call('POST',`/api/bots/${turn.bot.id}/interrupt`,{threadId:turn.threadId});
  await poll(async()=>{const bot=(await this.call('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===turn.bot.id);const task=bot?.tasks?.find((t:any)=>t.threadId===turn.threadId);return task&&!task.busy?true:undefined;},'turn stopped');
  await delay(200);if(!keepSurface)turn.surface.close();
 }
 async mark(turn:Turn,expected:string|readonly string[]){
  const sources=typeof expected==='string'?[expected]:expected;
  // ACP emits its fetch just after dumping the mounts; allow that frame to
  // reach the real outside journal before asserting its precondition.
  const until=Date.now()+3000;
  while(Date.now()<until&&!journal(join(this.data,'outside-state.jsonl')).some(r=>r.k==='mark'&&r.row.threadId===turn.threadId&&sources.includes(r.row.source)))await delay(50);
  const rows=journal(join(this.data,'outside-state.jsonl'));
  const marks=rows.filter(r=>r.k==='mark'&&r.row.threadId===turn.threadId);
  const mark=marks.at(-1)?.row;
  const cred=turn.dump.credFile?.content??{};
  const turnId=Object.values(cred).map((v:any)=>v?.MURAGE_TURN_ID).find(Boolean);
  const generation=rows.filter(r=>r.k==='turn'&&r.row.threadId===turn.threadId&&r.row.turnId===(mark?.turnId??`${turn.threadId}#${mark?.at}`)).at(-1)?.row;
  const session=rows.filter(r=>r.k==='session'&&r.row.threadId===turn.threadId&&r.row.instanceId===generation?.instanceId).at(-1)?.row;
  const open=rows.filter(r=>r.k==='open'&&r.threadId===turn.threadId).at(-1);
  requireFact(sources.includes(mark?.source)&&mark.at>=turn.startedAt&&generation?.instanceId&&generation.gen!==undefined&&generation.gen===session?.gen&&session.gen===open?.gen&&generation.sessionKey===open?.sessionKey,'R10 expected outside mark for current turn/generation',{expected,mark,generation,session,open,providerTurnId:turnId,startedAt:turn.startedAt});
  turn.mark={...mark,generation,providerTurnId:turnId,open};return turn.mark;
 }
 async outside(source:'cloned folder'|'earlier turn'|'web page',options:{level?:'unlimited'|'full';owner?:boolean;instanceId?:string}={}){
  const bot=await this.bot(`Field ${source}`,options.instanceId??(source==='web page'?'web':'field'),options.level);
  await this.cwd(bot,source==='web page'?this.clean:this.clone);
  let priorMark:any;
  if(source==='earlier turn'){
   const first=await this.held(bot);priorMark=await this.mark(first,'cloned folder');await this.stopTurn(first);first.surface.close();
   await this.cwd(bot,this.clean);
  }
  const turn=await this.held(bot,options.owner!==false);turn.priorMark=priorMark;try{await this.mark(turn,source);this.facts={...this.facts,mark:turn.mark,priorMark:turn.priorMark};return turn;}catch(error){await this.stopTurn(turn);throw error;}
 }
 async peer(){
  const source=await this.outside('cloned folder',{instanceId:'source'}),target=await this.bot('Peer BASE target');
  const reply=await this.tool(source,'agents','delegate_bot',{bot_id:target.id,message:'FIELD_REPLAY_HOLD Please remember the synthetic field replay note and propose the synthetic recurring check.'});
  requireFact(!reply.isError&&/Task id:/.test(reply.text),'peer delegation effect missing',reply);
  writeFileSync(join(this.home,'sourceRelease'),'');
  // This source instance has its own gate; normal completion drains the
  // queued peer while the target remains held on the field engine's gate.
  const dump=await poll(()=>this.dumps().find(d=>Object.values(d.mcpConfig?.mcpServers??{}).some((s:any)=>s.env?.MURAGE_BOT_ID===target.id)),'real peer dispatch');
  const threadId=Object.values(dump.mcpConfig.mcpServers).map((s:any)=>s.env?.MURAGE_THREAD_ID).find(Boolean) as string;
  source.surface.close();const turn=await this.held(target,true,threadId,false);turn.startedAt=0;
  await this.mark(turn,'cloned folder');this.facts={...this.facts,mark:turn.mark,peerReply:reply.text,peerThread:threadId};return turn;
 }
 async tool(turn:Turn,mount:'agents'|'memory'|'permission',name:string,args:unknown):Promise<any>{
  const servers=turn.dump.mcpConfig?.mcpServers??{};
  let entry:any;
  if(mount==='permission'){
   const argv=turn.dump.argv??[];const prompt=argv[argv.indexOf('--permission-prompt-tool')+1];const match=/^mcp__(.+?)__(.+)$/.exec(prompt??'');
   if(match){entry=servers[match[1]];name=match[2];}
  }else entry=Object.entries(servers).find(([key,value]:[string,any])=>key===mount||key.includes(`murage-${mount}-`)||value.args?.some((a:string)=>a.endsWith(`/${mount}-proxy.ts`)))?.[1];
  if(!entry)throw new Blocked(`missing mounted ${mount} MCP server (${Object.keys(servers).join(',')})`);
  const launch=claudeMcpLaunch({command:entry.command,args:entry.args??[],env:entry.env??{}},turn.dump.env??{});
  const child=spawn(launch.command,launch.args,{cwd:turn.dump.cwd,env:{PATH:process.env.PATH,HOME:this.home,USERPROFILE:this.home,...turn.dump.env,...launch.env},stdio:['pipe','pipe','pipe']});this.proxies.add(child);
  try{
   const answer=await new Promise<any>((resolve,reject)=>{
    let buffer='',stderr='',settled=false;
    const timer=setTimeout(()=>finish(new Blocked(`MCP timeout ${mount}/${name}: ${stderr.slice(-1000)}`)),20_000);
    const finish=(error?:Error,value?:any)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const send=(message:unknown)=>child.stdin!.write(JSON.stringify({jsonrpc:'2.0',...message as object})+'\n');
    child.on('error',e=>finish(e));child.on('exit',code=>finish(new Blocked(`MCP exited ${code} ${mount}/${name}: ${stderr.slice(-1000)}`)));
    child.stderr!.on('data',c=>stderr+=String(c));child.stdout!.on('data',c=>{
     buffer+=String(c);let nl;while((nl=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let m;try{m=JSON.parse(line);}catch{continue;}
      if(m.id===1){send({method:'notifications/initialized'});send({id:2,method:'tools/list',params:{}});}
      if(m.id===2)send({id:3,method:'tools/call',params:{name,arguments:args}});
      if(m.id===3){if(m.error)finish(new Blocked(`MCP error ${JSON.stringify(m.error)}`));else finish(undefined,m.result);}
     }
    });
    send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'field-replay',version:'1'}}});
   });
   const text=answer?.content?.map((c:any)=>c.text??'').join('\n')??'';
   if(/NotBuilt|HTTP 5\d\d|\b500\b/.test(text))throw new Blocked(`${mount}/${name}: ${text}`);
   return {...answer,text};
  }finally{await waitForExit(child,{signal:'SIGTERM'});this.proxies.delete(child);}
 }
 async proposal(turn:Turn,options:{forBot?:Bot;update?:string;instructions?:string}={}){
  const name=`Field ${Date.now()} ${Math.random().toString(16).slice(2,8)}`;
  const fields={name,instructions:options.instructions??'FIELD_REPLAY_HOLD Please remember the synthetic field replay note.',schedule:{type:'interval',every_minutes:60}};
  const result=await this.tool(turn,'agents',options.update?'propose_routine_action':'propose_routine',options.update?{routine_id:options.update,action:'update',changes:{name,instructions:fields.instructions}}:{...fields,...(options.forBot?{for_bot_id:options.forBot.id}:{})});
  this.facts.toolReply=result.text;
  const state=(await this.call('GET','/api/routines')).body;
  const routine=state.routines?.find((r:any)=>r.name===name);this.facts.routineId=routine?.id;
  return {result,routine,name};
 }
 async applied(turn:Turn,proposal:Awaited<ReturnType<Harness['proposal']>>){
  const counts=await turn.surface.assert([turn.threadId],0);
  requireFact(!proposal.result.isError&&/applied|automatically/i.test(proposal.result.text)&&proposal.routine,'proposal effect missing',{...proposal,counts});
  requireFact(proposal.routine.permissionMode==='unlimited','routine must inherit unlimited',{routine:proposal.routine,counts});
  requireFact(counts.decisions.some((d:any)=>d.decision==='auto-approved'&&d.source==='no-limits'),'missing auto-approved/no-limits decision',{counts,proposal});
  return counts;
 }
 async memory(turn:Turn,operation:'save'|'correction',target?:string){
  const evidence=[{quote:'synthetic field replay note'}];
  const result=await this.tool(turn,'memory',operation==='save'?'memory_save':'memory_propose_correction',operation==='save'?{text:'Synthetic remembered field note.',evidence,idempotencyKey:`field-${Date.now()}`}:{id:target,version:1,replacement:'Synthetic corrected field note.',evidence,idempotencyKey:`field-${Date.now()}`});
  let body:any;try{body=JSON.parse(result.text);}catch{}
  if(result.isError&&/NotBuilt/.test(result.text))throw new Blocked(result.text);
  const counts=await turn.surface.assert([turn.threadId],0);
  requireFact(!result.isError&&body?.state==='active'&&body.pendingReview===false,'memory effect must be active',{result,body,counts});
  requireFact(counts.decisions.some((d:any)=>d.decision==='auto-approved'&&d.source==='no-limits'),'missing memory auto-approved/no-limits decision',counts);
  const owner=await this.call('POST','/api/memory/action',{action:'inspect',id:body.candidateId,version:1});
  requireFact(owner.status===200&&owner.body.record?.state==='active','owner API must confirm active memory',{body,owner,counts});
  return {result:body,counts};
 }
 async close(){
  for(const s of this.surfaces)s.close();
  for(const child of this.proxies)await waitForExit(child,{signal:'SIGTERM'});
  if(this.child)await waitForExit(this.child,{signal:'SIGTERM'});
  if(this.home)await removeTempDir(this.home,{strict:true});
  if(this.clean)await removeTempDir(this.clean,{strict:true});
 }
}
export function verdict(error:unknown){
 if(error instanceof BehavioralRed)return 'RED';
 // Only the published decision stub, or NotBuilt returned by the mounted
 // memory service that calls it, establishes the S1 dependency. Status codes,
 // missing mounts, timeouts and arbitrary exceptions do not identify S1.
 const message=error instanceof Error?error.message:String(error);
 if(error instanceof Blocked&&/\bNotBuilt\b/.test(message)&&/decision[./]|memory\/memory_(?:save|propose_correction):/.test(message))return 'BLOCKED-BY-S1';
 return 'ERROR';
}
