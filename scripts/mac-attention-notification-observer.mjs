// Private fixture diagnostic. No trigger, credentials, bodies or acceptance changes.
export function notificationFrameMetadata(frame,botId,threadId){
 if(frame?.kind!=='notify'||frame.notification?.botId!==botId||frame.notification?.threadId!==threadId)return null;
 const value=frame.notification,shape=name=>{const x=value[name];return{present:x!==undefined,type:typeof x,length:typeof x==='string'?x.length:null,valid:typeof x==='string'&&x.length>0&&x.length<=512&&/^[\w.:-]+$/.test(x)};};
 return{kind:value.kind==='approval'?'approval':'other',requestId:shape('requestId'),messageId:shape('messageId'),requestTurnId:shape('requestTurnId'),title:{type:typeof value.title,length:typeof value.title==='string'?value.title.length:null},body:{type:typeof value.body,length:typeof value.body==='string'?value.body.length:null},privatePreview:value.privatePreview===true};
}
export async function startNotificationObserver({port,botId,threadId,record,fetchImpl=fetch,readyMs=5000,lifetimeMs=60000,stopMs=1000,maxBytes=8*1024*1024,maxFrameBytes=2*1024*1024}){
 if(!Number.isInteger(port)||port<1||port>65535||typeof botId!=='string'||typeof threadId!=='string')throw Error('NOTIFICATION_OBSERVER_INPUT');
 const controller=new AbortController();let reader=null,readySeen=false,closed=false,bytes=0,frames=0,matched=0,reason=null,buffer='',stopPromise=null;
 let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const emit=(step,value)=>record(step,value);
 const abort=why=>{if(!reason)reason=why;controller.abort();if(!readySeen)readyReject(Error(reason));};
 const readyTimer=setTimeout(()=>abort('OBSERVER_READY_TIMEOUT'),readyMs),lifeTimer=setTimeout(()=>abort('OBSERVER_LIFETIME_LIMIT'),lifetimeMs);
 const work=(async()=>{
  try{
   // Same read-only loopback transport as fixture api(); no injected desktop authority.
   const res=await fetchImpl('http://127.0.0.1:'+port+'/api/events?screens=off',{signal:controller.signal,redirect:'error'});
   if(res.status!==200||!res.headers.get('content-type')?.startsWith('text/event-stream')||!res.body)throw Error('OBSERVER_STREAM_PROTOCOL');
   reader=res.body.getReader();const decoder=new TextDecoder();
   for(;;){
    const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes)throw Error('OBSERVER_BYTE_LIMIT');buffer+=decoder.decode(part.value,{stream:true});
    for(;;){
     const boundary=/\r?\n\r?\n/.exec(buffer);if(!boundary)break;
     const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);if(block.length>maxFrameBytes)throw Error('OBSERVER_FRAME_LIMIT');
     const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(!data)continue;
     let frame;try{frame=JSON.parse(data);}catch{throw Error('OBSERVER_JSON_INVALID');}frames++;
     if(frame.kind==='hello'&&!readySeen){readySeen=true;clearTimeout(readyTimer);emit('notification-observer-ready',{hello:true,resumed:frame.resumed===true,readOnly:true});readyResolve();}
     const metadata=notificationFrameMetadata(frame,botId,threadId);
     if(metadata){matched++;if(matched>8)throw Error('OBSERVER_MATCH_LIMIT');emit('approval-notify-frame',{ordinal:matched,...metadata});}
    }
    if(buffer.length>maxFrameBytes)throw Error('OBSERVER_FRAME_LIMIT');
   }
   if(!reason)reason='OBSERVER_STREAM_ENDED';
  }catch(error){if(!reason)reason=/^OBSERVER_[A-Z_]+$/.test(error?.message??'')?error.message:'OBSERVER_TRANSPORT_FAILED';}
  finally{
   clearTimeout(readyTimer);clearTimeout(lifeTimer);if(!readySeen)readyReject(Error(reason??'OBSERVER_NO_HELLO'));
   controller.abort();try{await reader?.cancel();}catch{}closed=true;
   emit('notification-observer-ended',{hello:readySeen,reason,bytes,frames,matched,closed:true});
  }
 })();
 void work.catch(()=>{reason='OBSERVER_EVIDENCE_UNAVAILABLE';if(!readySeen)readyReject(Error(reason));});
 // Stop observes completion, never masks the original journey failure.
 const stop=()=>stopPromise??=(async()=>{
  clearTimeout(readyTimer);clearTimeout(lifeTimer);abort('OBSERVER_STOPPED');try{void reader?.cancel().catch(()=>{});}catch{}
  let timer;try{await Promise.race([work.catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,stopMs);})]);}finally{clearTimeout(timer);}
  return{closed,hello:readySeen,reason,bytes,frames,matched};
 })();
 try{await ready;return{stop};}catch(error){await stop();throw error;}
}
export function notificationLifecycleMetadata(redacted){
 const entries=[];
 for(const line of redacted.split(/\r?\n/)){
  // Retain only exact native lifecycle grammar; never an arbitrary log line.
  const match=/^(\[[^\]\r\n]{1,300}\]\s*)?(Notification authorization granted: [01]|Error requesting notification authorization: .+|Error scheduling notification \([A-Za-z0-9:.-]{1,160}\) .+|Notification (?:created|scheduled|displayed|activated|dismissed|button clicked|replied to) \([A-Za-z0-9:.-]{1,160}\))$/.exec(line);
  if(!match)continue;const prefix=(match[1]??'').trim(),body=match[2];let value;
  if(body.startsWith('Notification authorization granted:'))value={event:'authorization',granted:body.endsWith('1')};
  else if(body.startsWith('Error requesting notification authorization:'))value={event:'authorization-error',error:body.slice('Error requesting notification authorization: '.length).slice(0,240)};
  else{const item=/^(?:Notification (created|scheduled|displayed|activated|dismissed|button clicked|replied to)|Error scheduling notification) \(([A-Za-z0-9:.-]{1,160})\)(?: (.+))?$/.exec(body);value={event:item[1]??'schedule-error',nativeId:item[2],...(item[3]?{error:item[3].slice(0,240)}:{})};}
  entries.push({prefix,...value});if(entries.length>=128)break;
 }
 return entries;
}
