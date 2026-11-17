// This adapter runs only in the private worker. The production decision core,
// delivery and final native writer guard see recorded arguments as inert data.
import {registerHooks,stripTypeScriptTypes,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
export async function privateProductionAdapter({home}){
 // Keep the real database module, transactions and schema. Replace only its
 // storage location; no product policy or release function is transformed.
 const hooks=registerHooks({load(url,context,next){
  const result=next(url,context);
  if(url.endsWith('/server/database.ts')){
   let source=String(result.source??fs.readFileSync(new URL(url),'utf8'));
   const seam='export function database(): DatabaseSync {';
   if(!source.includes(seam))throw Error('Private memory database seam unavailable');
   source=source.replace(seam,`let privateReplayDatabase: DatabaseSync | undefined;\n${seam}\n if(!privateReplayDatabase){privateReplayDatabase=new DatabaseSync(':memory:');initializeMessageTables(privateReplayDatabase);}\n return privateReplayDatabase;`);
   return {format:'module',source:stripTypeScriptTypes(source),shortCircuit:true};
  }
  return result;
 }});
 // Install wrappers before any product module can cache a filesystem writer.
 let sealed=false;
 const denied=()=>{throw Error('Private replay persistence prohibited');};
 const mutations=['writeFileSync','appendFileSync','writeSync','writevSync','copyFileSync','renameSync','createWriteStream','writeFile','appendFile','write','writev','copyFile','rename','mkdirSync','mkdir','rmSync','rm','rmdirSync','rmdir','unlinkSync','unlink','linkSync','link','symlinkSync','symlink','truncateSync','truncate','chmodSync','chmod','utimesSync','utimes','cpSync','cp','mkdtempSync','mkdtemp','chownSync','chown','ftruncateSync','ftruncate','fchmodSync','fchmod','fchownSync','fchown','futimesSync','futimes','lutimesSync','lutimes','lchownSync','lchown'];
 for(const name of mutations)if(typeof fs[name]==='function'){const original=fs[name];fs[name]=function(...args){if(sealed)denied();return original.apply(this,args);};}
 for(const name of ['writeFile','appendFile','copyFile','rename','open','mkdir','rm','rmdir','unlink','link','symlink','truncate','chmod','utimes','cp','mkdtemp','chown','lutimes','lchown'])if(typeof fsp[name]==='function'){
  const original=fsp[name];fsp[name]=async function(...args){if(sealed)denied();return original.apply(this,args);};
 }
 const originalOpen=fs.openSync;fs.openSync=function(path,flags,...args){
  const writable=typeof flags==='string'?/[wa+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
  if(sealed&&writable)denied();return originalOpen(path,flags,...args);
 };
 const originalAsyncOpen=fs.open;fs.open=function(path,flags,...args){
  const writable=typeof flags==='string'?/[wa+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
  if(sealed&&writable)denied();return originalAsyncOpen.call(this,path,flags,...args);
 };
 const createStream=fs.createWriteStream;fs.createWriteStream=function(...args){
  const stream=createStream.apply(this,args);
  for(const name of ['write','end']){const original=stream[name];stream[name]=function(...values){if(sealed)denied();return original.apply(this,values);};}
  return stream;
 };
 syncBuiltinESMExports();
 const probePath=join(home,'.gnl-filehandle-probe');
 const probe=await fsp.open(probePath,'wx',0o600),prototype=Object.getPrototypeOf(probe);
 for(const name of ['writeFile','appendFile','write','writev','truncate','chmod','chown','utimes'])if(typeof prototype[name]==='function'){
  const original=prototype[name];prototype[name]=async function(...args){if(sealed)denied();return original.apply(this,args);};
 }
 await probe.close();fs.unlinkSync(probePath);
 const d=await import('../../server/decision/index.ts');
 const {openReplayRequest}=await import('../../server/testing/replay-source.ts');
 const {guardEngineRelease}=await import('../../server/decision/provider-release.ts');
 const {autoVerdict}=await import('../../server/auto-approve.ts');
 const {database}=await import('../../server/database.ts');
 const db=database();
 // The caller may now read private input; every product writer is sealed.
 sealed=true;
 let messages=[];
 const bot={id:'private-replay',threadId:'private-replay-thread',autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,cwd:home};
 const store={bot:id=>id===bot.id?bot:undefined,
  appendMessage(threadId,input,id=randomUUID()){
   const message={...input,id,at:Date.now()};messages.push(message);
   db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)').run(threadId,id,message.at,input.role,input.kind,input.text??null,JSON.stringify(message));return message;
  },
  appendApprovalCard(threadId,ref,view){
   const row=db.prepare('SELECT * FROM approval_records WHERE id=?').get(ref.approvalId);
   return this.appendMessage(threadId,{role:'bot',kind:'options',card:{...JSON.parse(row.evidence).action,...view}},row.chat_message_id);
  },
  messageById:(threadId,id)=>messages.find(m=>m.id===id),
  patchMessagePoint(threadId,id,patch){const m=messages.find(m=>m.id===id);if(m)Object.assign(m,patch);return m;},
 };
 return {async decide(row,input){
  messages=[];db.exec('DELETE FROM approval_records;DELETE FROM messages');
  // Sean's corpus records his own No limits operations. Legacy card origin
  // metadata is diagnostic only; it cannot replace the authenticated owner.
  const generation=randomUUID(),turnId=randomUUID(),requestId=randomUUID();
  const initiator={k:'owner-typed'};
  const event={type:'request.opened',providerInstanceId:'private-data-only',threadId:bot.threadId,turnId,requestId,tool:row.tool,requestType:'permission',summary:'Recorded private operation',toolEngine:'claude',toolCall:{name:row.tool,input},toolInputTruncated:Boolean(row.toolInputTruncated)};
  const provenance={generation,botId:bot.id,threadId:bot.threadId,principal:'private-owner',initiator,roomOwnerOnly:true,at:Date.now()};
  let delivered=false,refusals=0,deliveries=0;
  d.installDecisionHost({store,view:()=>({title:'Private replay',subtitle:'In-memory policy operation'}),executionContext:()=>({cwd:home,home})});
  d.installEngineApprovalBuilder(()=>({options:['Allow','Deny']}));
  d.installDenySources({revision:()=>['private'],resolve:()=>[]});
  d.installDecisionTransport({respond:async(target,answer)=>{
   deliveries++;
   if(answer.behavior==='allow')delivered=guardEngineRelease(target,row.updatedInput);
   if(!delivered)refusals++;
   return {state:delivered?'accepted':'failed'};
  },interrupt:async()=>{refusals++;}});
  const handle=openReplayRequest({event,provenance,level:'unlimited'});
  const base=autoVerdict(bot,row.tool,row.boundedToolInput??'Recorded private operation',{
   noLimitsOrigin:'owner',fullAccessOrigin:'owner',ownerStarted:true,unattended:false,automated:false,
   routineLevel:false,channelOwner:false,outsideRead:null,workFolder:home,commandCwd:home,
   commandText:typeof input?.command==='string'?input.command:undefined,inputTruncated:Boolean(row.toolInputTruncated),
   call:{engine:'claude',toolCall:{name:row.tool,input},truncated:Boolean(row.toolInputTruncated)},promptFacts:{cwd:home,home},
  });
  const outcome=d.decide(handle,()=>base);
  await d.deliverRequest(handle);
  const cards=Math.max(d.openApprovals(bot.threadId).filter(a=>a.why!=='question').length,base.approve===null?1:0);
  const refused=outcome.kind==='refuse'||refusals>0||outcome.kind==='run'&&(!delivered||deliveries!==1);
  return {kind:refused?'refuse':cards?'card':outcome.kind,cards,refusals:refused?1:0,actionExecuted:delivered&&deliveries===1,
   why:cards?(d.openApprovals(bot.threadId)[0]?.why??'base'):undefined};
 },writeCounts(out,report){
  const keys=new Set(['rows','pass','nonwipe_cards','refusals','skipped','unavailable','failed','seals_verified','harness_errors','original_input_proven','nonowner_origin_hints']);
  const numeric=v=>Number.isSafeInteger(v)&&v>=0;
  if(!['PASS','FAIL'].includes(report.verdict))throw Error('Invalid private count report');
  const safe={verdict:report.verdict};
  for(const [key,value]of Object.entries(report)){
   if(key==='verdict')continue;
   if(key==='controls'){if(!numeric(value?.rows)||!numeric(value?.pass)||Object.keys(value).some(k=>!['rows','pass'].includes(k)))throw Error('Invalid private control counts');safe.controls={rows:value.rows,pass:value.pass};}
   else {if(!keys.has(key)||!numeric(value))throw Error('Invalid private count field');safe[key]=value;}
  }
  // A synchronous, validated aggregate write cannot interleave product work.
  sealed=false;try{fs.writeFileSync(out,JSON.stringify(safe)+'\n',{mode:0o600,flag:'wx'});}finally{sealed=true;}
 },close(){hooks.deregister();db.close();}};
}
