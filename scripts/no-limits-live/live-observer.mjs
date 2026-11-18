import {createRequestIndex} from './request-index.mjs';
import {createNdjsonReader} from './ndjson-reader.mjs';
// Gate-only preload. Record actual decision registrations and actual outbound
// approval transports; never manufacture request or delivery receipts.
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {installDecisionObserver} from '../../server/decision/index.ts';
const dir=process.env.MURAGE_DATA_DIR;
if(!dir||process.env.MURAGE_GATE_TAP!=='1')throw Error('Live observer requires an isolated gate fixture');
const nativeEvents=join(dir,'nolim-native-events.ndjson');
// The audience rail gives a request only an opaque envelope (no requestId or
// turnId), so the answer tap's behavior is joined here: identity, kind and the
// resolved behavior/source only, never the ask's summary, choices or input.
const REQUEST_FIELDS={'request.opened':['requestType'],'request.resolved':['behavior','source']};
const requestRow=event=>Object.fromEntries(['type','eventId','provider','providerInstanceId','threadId','turnId','requestId','createdAt',...REQUEST_FIELDS[event.type]].filter(k=>event[k]!==undefined).map(k=>[k,event[k]]));
globalThis[Symbol.for('gnl.native.operation')]=event=>{
 if(event.origin!=='murage'&&event.itemType==='tool'&&['item.started','item.completed'].includes(event.type))appendFileSync(nativeEvents,JSON.stringify(event)+'\n');
 else if(Object.hasOwn(REQUEST_FIELDS,event.type)&&typeof event.requestId==='string'&&event.requestId)appendFileSync(nativeEvents,JSON.stringify(requestRow(event))+'\n');
};
registerHooks({load(url,context,next){const result=next(url,context);
 if(url.endsWith('/server/web-documents.ts')){
  const original=readFileSync(new URL(url),'utf8'),anchor='    return this.read(scope, { handle, length: range.length });';
  if(!original.includes(anchor))throw Error('Saved browser page observation seam unavailable');
  const observed=original.replace(anchor,`    const saved = this.read(scope, { handle, length: range.length });
    gnlBrowserPageAppend(gnlBrowserPageDir+'/gnl-browser-pages.ndjson',JSON.stringify({scope,url,handle,next_offset:saved.next_offset})+'\\n');
    return saved;`);
  return {format:'module',shortCircuit:true,source:stripTypeScriptTypes("import {appendFileSync as gnlBrowserPageAppend} from 'node:fs';const gnlBrowserPageDir=process.env.MURAGE_DATA_DIR;\n"+observed)};
 }
 if(!url.endsWith('/server/index.ts'))return result;
 // Native operation evidence observes the execution rail, before the fold;
 // the audience rail deliberately replaces provider identities and payloads.
 const source=typeof result.source==='string'?result.source:Buffer.from(result.source??readFileSync(new URL(url))).toString('utf8'),seam='bus.subscribeExecution(foldRuntimeEvent);';
 if(!source.includes(seam))throw Error('Native operation observation seam unavailable');
 return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(source.replace(seam,"bus.subscribeExecution(event=>globalThis[Symbol.for('gnl.native.operation')](event));"+seam))};
}});
const registrations=join(dir,'nolim-registrations.ndjson');
const requests=createRequestIndex();
const readProtocol=createNdjsonReader(join(dir,'nolim-protocol.ndjson'),{onReset:()=>requests.clear(),onRow:t=>requests.add(t)});
installDecisionObserver(event=>{
 if(event.type!=='registered')return;
 const file=join(dir,'nolim-protocol.ndjson');
 if(existsSync(file))readProtocol([]);
 const request=requests.find(event.threadId,event.requestKey);
 appendFileSync(registrations,JSON.stringify({at:Date.now(),...event,...(request?{generation:request.generation,requestId:request.requestId,decisionGeneration:event.requestKey.slice(request.providerInstanceId.length+1,-request.requestId.length-1)}:{unmatched:true})})+'\n');
});
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 if(url.startsWith('https://api.telegram.org/bot')&&url.endsWith('/sendMessage')){
  const body=JSON.parse(String(init?.body??'{}'));
  if(body.reply_markup){
   let row={at:Date.now(),destination:String(body.chat_id),transport:'telegram',unmatched:true};
   const keys=new Set((body.reply_markup.inline_keyboard??[]).flat().map(button=>String(button.callback_data??'').split(':')[0]).filter(Boolean).map(nonce=>createHash('sha256').update(nonce).digest('hex')));
   const offers=readFileSync(join(dir,'nolim-mirror-offers.ndjson'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(o=>keys.has(o.nonceHash));
   if(offers.length===1){const offer=offers[0],db=new DatabaseSync(join(dir,'messages.db'),{readOnly:true});try{
    db.exec('PRAGMA query_only=ON');const record=db.prepare('SELECT id,thread_id,request_id,chat_message_id FROM approval_records WHERE id=?').get(offer.approvalId);
    if(record&&record.chat_message_id===offer.messageId&&record.request_id===offer.requestRef)row={...row,unmatched:false,approvalId:record.id,threadId:record.thread_id,requestId:record.request_id};
   }finally{db.close();}}
   appendFileSync(join(dir,'channel-mirror-outbox.ndjson'),JSON.stringify(row)+'\n');
  }
 }
 return original(input,init);
};
