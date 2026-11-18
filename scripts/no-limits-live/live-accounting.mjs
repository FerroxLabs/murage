import {readFixtureLog} from './ndjson-reader.mjs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {hashInput} from './oracle-class.mjs';
import {readFileSync} from 'node:fs';
// A direct service call has a registered decision but no native permission
// dialog. Match it to its actual native MCP start/result, using exact input
// and thread identity. Never infer successful delivery from a policy verdict.
const bare=name=>String(name??'').replace(/^mcp__/,'').split('__').at(-1);
// Email registers its prepared envelope rather than the native tool args.
// Bind every field and the canonical payload digest; unknown shapes fail closed.
export function sameServiceInput(service,native){
 if(hashInput(service.input)===hashInput(native))return true;
 if(service.tool!=='email_send'||!native||Object.keys(native).some(k=>!['to','cc','subject','text','attachments'].includes(k)))return false;
 if(!Array.isArray(native.to)||native.to.some(x=>typeof x!=='string')||native.cc!==undefined&&(!Array.isArray(native.cc)||native.cc.some(x=>typeof x!=='string'))||typeof native.subject!=='string'||typeof native.text!=='string'||native.attachments!==undefined&&(!Array.isArray(native.attachments)||native.attachments.length))return false;
 const addresses=list=>[...new Set(list.map(x=>x.trim().toLowerCase()).filter(Boolean))].sort();
 const to=addresses(native.to),cc=addresses(native.cc??[]),canonical={kind:'send',to,cc,subject:native.subject,text:native.text,attachments:[],reply_to:null};
 const expectedHash=createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),input=service.input;
 return input?.kind==='send'&&typeof service.requestId==='string'&&service.requestId.length>0&&input.sendId===service.requestId&&Object.keys(input).every(k=>['kind','sendId','payloadHash','summary','text'].includes(k))&&input.payloadHash===expectedHash&&input.text===native.text&&hashInput(input.summary)===hashInput({to,cc,subject:native.subject,textLength:native.text.length,attachments:[],replySource:null});
}
// Memory saves register a durable candidate with resolved evidence spans.
// Prove its idempotency key, content and every quoted byte against the actual
// source rows, rather than treating the candidate envelope as native args.
export function sameMemoryInput(service,native,dataDir){
 if(service.tool!=='memory_save'||!native||Object.keys(native).some(k=>!['text','evidence','idempotencyKey'].includes(k))||typeof native.text!=='string'||typeof native.idempotencyKey!=='string'||!Array.isArray(native.evidence))return false;
 const s=service.input;
 if(!s||s.operation!=='save'||s.target!==null||s.version!==1||s.text!==native.text||s.threadId!==service.threadId||s.generation!==service.decisionGeneration||s.candidateId!==createHash('sha256').update(JSON.stringify([s.threadId,native.idempotencyKey])).digest('hex')||!Array.isArray(s.evidence)||s.evidence.length!==native.evidence.length)return false;
 let db;try{
  db=new DatabaseSync(join(dataDir,'messages.db'),{readOnly:true});db.exec('PRAGMA query_only=ON');
  const record=db.prepare('SELECT text,scope_id FROM memory_records WHERE id=? AND version=?').get(s.candidateId,s.version);
  if(!record||record.text!==s.text||record.scope_id!==s.scopeId)return false;
  const saved=db.prepare('SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id,source_revision,start_byte,end_byte').all(s.candidateId,s.version);
  if(hashInput(saved)!==hashInput(s.evidence))return false;
  const used=new Set();
  return native.evidence.every(item=>{
   if(!item||Object.keys(item).some(k=>!['quote','messageId'].includes(k))||typeof item.quote!=='string')return false;
   const matches=s.evidence.flatMap((span,i)=>{
    if(used.has(i)||!Number.isSafeInteger(span.start_byte)||!Number.isSafeInteger(span.end_byte)||span.start_byte<0||span.end_byte<=span.start_byte)return [];
    const row=db.prepare('SELECT s.thread_id,s.message_id,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?').get(span.source_revision,span.source_id);
    if(!row||row.thread_id!==s.threadId||item.messageId!==undefined&&row.message_id!==item.messageId)return [];
    const text=JSON.parse(row.payload).text;
    return typeof text==='string'&&Buffer.from(text).subarray(span.start_byte,span.end_byte).equals(Buffer.from(item.quote.trim()))?[i]:[];
   });
   if(matches.length!==1)return false;used.add(matches[0]);return true;
  });
 }catch{return false;}finally{db?.close();}
}
export function sameRoutineInput(service,native,dataDir){
 if(service.tool!=='manage_routine'||!native||Object.keys(native).some(k=>!['routine_id','action'].includes(k))||native.action!=='run_now'||typeof native.routine_id!=='string')return false;
 const input=service.input;
 if(!input||Object.keys(input).some(k=>!['routineId','action','expectedUpdatedAt'].includes(k))||input.action!==native.action||input.routineId!==native.routine_id||!Number.isSafeInteger(input.expectedUpdatedAt))return false;
 try{
  const disk=JSON.parse(readFileSync(join(dataDir,'routines.json'),'utf8'));
  const rows=disk.routines.filter(r=>r.id===input.routineId);
  return rows.length===1&&rows[0].updatedAt===input.expectedUpdatedAt;
 }catch{return false;}
}
export function normalizeLiveAccounting(snapshot,{dataDir,events,threadIds}){
 let services;
 try{services=readFixtureLog(join(dataDir,'nolim-service-protocol.ndjson'),threadIds);}
 catch{snapshot.complete=false;snapshot.errors.push('missing surface: service protocol');return snapshot;}
 for(const registration of snapshot.registrations??[]){
  if(!registration.unmatched)continue;
  const source=services.filter(s=>s.requestKey===registration.requestKey&&s.threadId===registration.threadId);
  if(source.length!==1)continue;
  const s=source[0];
  if(!/^[a-f0-9]{64}$/.test(registration.inputHash??'')||registration.inputHash!==s.registrationInputHash){snapshot.complete=false;snapshot.errors.push('Registered service input digest mismatch');continue;}
  const expectedTool=s.tool==='manage_routine'?'propose_routine_action':bare(s.tool);
  const starts=events.filter(e=>e.type==='item.started'&&e.itemType==='tool'&&e.threadId===s.threadId&&bare(e.toolIdentity?.name??e.tool??e.title)===expectedTool&&(sameServiceInput(s,e.input)||sameMemoryInput(s,e.input,dataDir)||sameRoutineInput(s,e.input,dataDir)));
  if(starts.length!==1)continue;
  const start=starts[0],ends=events.filter(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.threadId===s.threadId&&e.itemId===start.itemId&&e.turnId===start.turnId&&e.provider===start.provider&&e.providerInstanceId===start.providerInstanceId);
  if(ends.length!==1||ends[0].ok!==true)continue;
  registration.generation=start.turnId;registration.requestId=start.itemId;registration.decisionGeneration=s.decisionGeneration;registration.unmatched=false;
  const identity={threadId:s.threadId,generation:start.turnId,requestId:start.itemId,providerInstanceId:start.providerInstanceId};
  snapshot.taps??=[];snapshot.taps.push({...identity,type:'request',engine:start.provider,tool:s.tool==='manage_routine'?expectedTool:s.tool,inputHash:hashInput(start.input),nativeItem:true},
   {...identity,type:'answer',state:'accepted',behavior:'allow',nativeItem:true});
 }
 const questions=(snapshot.records??[]).filter(r=>r.why==='question');
 if(questions.length){let db;try{
  db=new DatabaseSync(join(dataDir,'messages.db'),{readOnly:true});db.exec('PRAGMA query_only=ON');
  for(const record of questions)if(!(snapshot.messages??[]).some(m=>m.id===record.chat_message_id&&m.threadId===record.thread_id)){
   const message=db.prepare("SELECT id,thread_id,json FROM messages WHERE thread_id=? AND id=? AND kind='text'").get(record.thread_id,record.chat_message_id);
   if(!message)throw Error('Question presentation missing');
   snapshot.messages.push({...JSON.parse(message.json),id:message.id,threadId:message.thread_id,kind:'text'});
  }
 }catch{snapshot.complete=false;snapshot.errors.push('Question presentation unavailable');}finally{db?.close();}}
 for(const record of snapshot.records??[]){
  const service=services.find(s=>s.threadId===record.thread_id&&s.requestId===record.request_id);
  const matches=(snapshot.registrations??[]).filter(r=>r.threadId===record.thread_id&&(r.requestId===record.request_id||service&&r.requestKey===service.requestKey)&&r.decisionGeneration===record.generation);
  if(matches.length===1){record.decisionGeneration=record.generation;record.generation=matches[0].generation;record.request_id=matches[0].requestId;}
 }
 for(const tap of snapshot.taps??[])if(tap.type==='answer'&&!tap.nativeItem){
  const resolved=events.filter(e=>e.type==='request.resolved'&&e.threadId===tap.threadId&&e.requestId===tap.requestId);
  if(resolved.length===1)tap.behavior=resolved[0].behavior;
 }
 return snapshot;
}
