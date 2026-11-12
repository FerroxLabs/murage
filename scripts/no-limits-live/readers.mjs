// Independent read-only surface readers. No product module is imported here.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,realpathSync,existsSync,readdirSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
export const ELECTRON_ENDPOINT='/api/desktop/attention'; // electron/attention-items.mjs (read only).
export const MESSAGE_COLUMNS=['thread_id','id','at','role','kind','text','json'];
// Minimum named read contract, not a positional pin of the full product DDL.
export const APPROVAL_COLUMNS=['id','source_kind','service','thread_id','request_id','bot_id','generation','actor_kind','actor_via','level','why','evidence','registration_hash','deny_rev','chat_message_id','queue_kind','queue_ref','state','answer','created_at','settled_at'];
export const schemaPin=createHash('sha256').update(JSON.stringify({messages:MESSAGE_COLUMNS,approval_records:APPROVAL_COLUMNS})).digest('hex');
export const QUEUE_STORES=['email','bot-access','phones','room-shares','memory','browser-extension','host-computer','peer','event-limit','image','routine','mcp-bot','publish','skill'];
// Pins are copied from the stores' persistence boundaries, never supplied by
// candidate code or a fixture manifest. Memory-only waiters are represented by
// their durable message cards; there is no invented empty queue file.
export const STORE_MAPPINGS={
 email:{file:'messages.db',table:'email_sends',where:"state IN ('prepared','awaiting_owner','dispatching','held','approving','approved_unsent','unknown','unknown_expired','withdraw_pending')"},
 'bot-access':{file:'bots.json',format:'bot-requests'},
 phones:{file:'messages.db',tools:/^phone_/},
 'room-shares':{file:'messages.db',table:'room_shares',where:"status IN ('pending','sharing')"},
 memory:{file:'messages.db',table:'memory_records',where:"state='candidate'"},
 'browser-extension':{file:'browser-extension/approvals.json',format:'browser-v1'},
 'host-computer':{file:'messages.db',tools:/^local_computer_consent$/},
 peer:{file:'messages.db',tools:/^(ask_bot|delegate_bot)$/},
 'event-limit':{file:'messages.db',tools:/^(more_handoffs|more_new_bots)$/},
 image:{file:'messages.db',table:'image_operations',where:"state IN ('awaiting','running','uncertain','publish-pending')"},
 routine:{file:'messages.db',tools:/^(schedule_routine|manage_routine|create_webhook|manage_webhook)$/},
 'mcp-bot':{file:'config.json',format:'mcp-config'},
 publish:{file:'messages.db',tools:/^publish_site$/},
 skill:{file:'skill-state',format:'staged-skills'},
};
const object=value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid object');return value;};
function storeRows(dataDir,name){
 const spec=STORE_MAPPINGS[name],path=ownedPath(dataDir,spec.file);
 const json=()=>JSON.parse(readFileSync(path,'utf8'));
 let values;
 if(spec.table||spec.tools){
  if(!existsSync(path))throw Error('missing db');
  const db=new DatabaseSync(path,{readOnly:true});
  try{
   db.exec('PRAGMA query_only=ON');
   values=spec.table?db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.where}`).all():
    db.prepare("SELECT thread_id,id,json FROM messages WHERE kind='options'").all().map(r=>({...object(JSON.parse(r.json)),threadId:r.thread_id,messageId:r.id})).filter(r=>r.card&&!r.card.answered&&!r.card.dismissed&&spec.tools.test(r.card.tool??''));
  }finally{db.close();}
 }else if(spec.format==='browser-v1'){
  const root=object(json());if(root.version!==1)throw Error('unknown browser version');
  values=rows(root.records).filter(r=>r.status==='waiting');
 }else if(spec.format==='bot-requests'){
  values=rows(json()).flatMap(bot=>{const access=bot.connectedAppAccess;if(access===undefined)return [];return rows(object(access).requests).map(r=>({...object(r),botId:bot.id}));});
 }else if(spec.format==='mcp-config'){
  values=Object.entries(object(object(json()).mcpServers??{})).flatMap(([serverName,raw])=>{const r=object(raw);return (r.enabled===false&&typeof r.rev==='string'||r.pendingEnv?.length||r.pendingHeaders?.length)?[{serverName,rev:r.rev,enabled:r.enabled,pendingEnv:r.pendingEnv,pendingHeaders:r.pendingHeaders}]:[];});
 }else if(spec.format==='staged-skills'){
  // Enumerate the actual per-bot staged store; a missing directory or file is
  // a missing surface, including for a known bot. Never assume it is empty.
  const bots=rows(JSON.parse(readFileSync(ownedPath(dataDir,'bots.json'),'utf8')));
  const ids=new Set([...readdirSync(path),...bots.map(b=>b.id)]);
  values=[...ids].flatMap(id=>{if(!/^[\w-]+$/.test(id))throw Error('invalid bot id');const root=object(JSON.parse(readFileSync(ownedPath(dataDir,`skill-state/${id}/staged.json`),'utf8')));return Object.values(object(root.writes)).map(r=>({...object(r),botId:id}));});
 }else throw Error('unmapped store');
 return values.map(r=>({...r,queueKind:name,queueRef:r.send_id??r.requestId??r.card?.requestId??r.id??r.serverName,approvalId:r.approvalId??r.approval_id??r.card?.approvalId,requestId:r.requestId??r.request_id??r.card?.requestId,threadId:r.threadId??r.thread_id}));
}
function ownedPath(dir,file){const root=realpathSync(dir),path=resolve(root,file);if(!path.startsWith(root+sep))throw Error('path outside fixture');if(existsSync(path)&&!realpathSync(path).startsWith(root+sep))throw Error('symlink outside fixture');return path;}
const rows=value=>{if(!Array.isArray(value))throw Error('invalid row array');return value;};
const ndjson=path=>readFileSync(path,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
export function requireColumns(db,table,required){
 const present=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
 const missing=required.filter(name=>!present.has(name));
 if(missing.length)throw Error(`missing required columns: ${table}.${missing.join(',')}`);
}
export async function readSurfaces({dataDir,url,headers={},window={}}){
 const snapshot={complete:true,errors:[],readerSchemaPin:schemaPin};
 const read=async(name,fn)=>{try{return await fn();}catch(error){snapshot.complete=false;snapshot.errors.push(`missing surface: ${name}`);if(error.message.startsWith('missing required columns:'))snapshot.errors.push(error.message);return undefined;}};
 const dbPath=ownedPath(dataDir,'messages.db');let db;
 await read('messages',()=>{if(!existsSync(dbPath))throw Error('missing db');db=new DatabaseSync(dbPath,{readOnly:true});db.exec('PRAGMA query_only=ON');
  requireColumns(db,'messages',MESSAGE_COLUMNS);
  snapshot.messages=db.prepare("SELECT thread_id,id,at,role,kind,text,json FROM messages WHERE kind IN ('options','secret','mcpSignIn','connector') AND at>=? AND at<=?").all(window.start??0,window.end??Number.MAX_SAFE_INTEGER).map(r=>({...JSON.parse(r.json),id:r.id,threadId:r.thread_id,kind:r.kind}));});
 await read('records',()=>{if(!db)throw Error('missing db');requireColumns(db,'approval_records',APPROVAL_COLUMNS);snapshot.records=db.prepare(`SELECT ${APPROVAL_COLUMNS.join(',')} FROM approval_records WHERE created_at>=? AND created_at<=?`).all(window.start??0,window.end??Number.MAX_SAFE_INTEGER);});db?.close();
 snapshot.queues=[];
 for(const name of QUEUE_STORES){const value=await read(`queues:${name}`,()=>storeRows(dataDir,name));if(value)snapshot.queues.push(...value);}
 // Older durable formats (notably browser records) carry the native queue
 // reference, not approvalId. Bind them through the independently read ledger.
 snapshot.queues=snapshot.queues.map(row=>{
  const matches=(snapshot.records??[]).filter(r=>r.queue_kind===row.queueKind&&r.queue_ref===row.queueRef);
  return matches.length===1?{...row,approvalId:matches[0].id,threadId:row.threadId??matches[0].thread_id}:row;
 });
 if(snapshot.errors.some(x=>x.startsWith('missing surface: queues:')))delete snapshot.queues;
 snapshot.electron=await read('electron',async()=>{const endpoint=new URL(ELECTRON_ENDPOINT,url);if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('not fixture loopback');const response=await fetch(endpoint,{headers,signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('missing endpoint');return rows((await response.json()).open);});
 for(const [name,file] of [['mirrors','channel-mirror-outbox.ndjson'],['taps','nolim-protocol.ndjson'],['registrations','nolim-registrations.ndjson']])snapshot[name]=await read(name,()=>ndjson(ownedPath(dataDir,file)).filter(r=>(r.at??0)>=(window.start??0)&&(r.at??0)<=(window.end??Number.MAX_SAFE_INTEGER)));
 if(window.threadIds){
  const ids=new Set(window.threadIds),belongs=row=>{const t=row.threadId??row.thread_id;return !t||ids.has(t);};
  for(const name of ['messages','records','taps','registrations','queues','electron','mirrors'])if(Array.isArray(snapshot[name]))snapshot[name]=snapshot[name].filter(belongs);
 }
 return snapshot;
}

// Only canonical rows bound to a displayed card may supply missing UI metadata.
export function readApprovalRecords(dataDir,threadId){
 const db=new DatabaseSync(ownedPath(dataDir,'messages.db'),{readOnly:true});
 try{db.exec('PRAGMA query_only=ON');return db.prepare('SELECT id,source_kind,thread_id,request_id,chat_message_id,why,evidence FROM approval_records WHERE thread_id=?').all(threadId);}
 finally{db.close();}
}
