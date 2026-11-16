import { ownWriteCardAuthorized, sameOwnWriteCard } from "../own-write-holds.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from 'node:sqlite';
import { beginWrite, endWrite, undoWrite } from '../write-tx.ts';
import { PERMISSION_CARD_KINDS, PERMISSION_CARD_KEYS, CARD_TERMINAL_FIELDS, CARD_DISPLAY_FIELDS, QUEUE_REF_PATHS, actionProjection } from '../../shared/permission-card.ts';
import { hash, canonical } from './bounds.ts';
import { afterCommit, onRollback } from '../tx-scope.ts';
import { BACKGROUND_BUSY_MS, setBusy } from '../db-busy.ts';
export const APPROVAL_OBJECTS={triggers:['approval_card_insert','approval_card_presented','approval_card_update'],indexes:['approval_request_once','approval_chat_row','approval_records_settled','approval_open_created','approval_open_thread','approval_queue_ref','decision_continuations_shared_peer'],tables:['approval_records','decision_continuations']} as const;
export const SHARED_PEER_PREDICATE = `key GLOB '{"botId":*","id":"shared-peer:*","kind":"background-job","threadId":*'`;
const sql=(s:string)=>"'"+s.replaceAll("'","''")+"'";
export const cardClassSql=(x:string)=>`CASE WHEN ${x}.kind IN (${PERMISSION_CARD_KINDS.map(sql)}) THEN CASE WHEN json_valid(${x}.json) THEN CASE WHEN json_extract(${x}.json,'$.card.kind')='own-write' THEN 0 ELSE json_extract(${x}.json,${PERMISSION_CARD_KEYS.map(k=>sql('$.card.'+k)).join(',')}) IS NOT ${sql(JSON.stringify(PERMISSION_CARD_KEYS.map(()=>null)))} END ELSE 0 END ELSE 0 END`;
const termSql=(x:string)=>`CASE WHEN json_valid(${x}.json) THEN (${CARD_TERMINAL_FIELDS.map(k=>`json_extract(${x}.json,'$.card.${k}') IS NOT NULL AND json_extract(${x}.json,'$.card.${k}') IS NOT 0 AND json_extract(${x}.json,'$.card.${k}') IS NOT ''`).map(s=>'('+s+')').join(' OR ')}) ELSE 0 END`;
const resultFields=['held','answers','expired','folderTrust.late'];
const sendReceiptSql=(value:string)=>`CASE WHEN json_extract(${value},'$.answerAsSend')=1 THEN json_remove(${value},'$.sendId','$.sentAsMessage') ELSE ${value} END`;
const resultSql=(value:string)=>`json_remove(${sendReceiptSql(value)},${resultFields.map(k=>sql('$.'+k)).join(',')})`;
const projectionSql=(x:string,display=false)=>`json_remove(${sendReceiptSql(`json_extract(${x}.json,'$.card')`)},${[...CARD_TERMINAL_FIELDS,'undone','held','answers','expired','folderTrust.late',...(display?CARD_DISPLAY_FIELDS:[])].map(k=>sql('$.'+k)).join(',')})`;
const invalidSendReceiptSql=(x:string)=>`json_extract(${x}.json,'$.card.answerAsSend')=1 AND (json_extract(${x}.json,'$.card.sendId') IS NOT NULL OR json_extract(${x}.json,'$.card.sentAsMessage') IS NOT NULL) AND
 (NOT (${termSql(x)}) OR json_extract(${x}.json,'$.card.sendId') IS NOT ('ask-'||${x}.id) OR (json_extract(${x}.json,'$.card.sentAsMessage') IS NOT NULL AND (json_extract(${x}.json,'$.card.sentAsMessage') IS NOT 1 OR json_extract(${x}.json,'$.card.expired') IS NOT 1)))`;
const credentialSql=(x:string)=>`CASE WHEN ${x}.kind IN ('secret','mcpSignIn','connector') AND json_valid(${x}.json) THEN json_type(${x}.json,'$.card') IS NOT NULL ELSE 0 END`;
export function initializeApprovals(db:DatabaseSync):void {
 // This connection marker is absent in older binaries. Querying the built-in
 // function inventory keeps inherited triggers executable on a plain reinstall;
 // 1.0.19 still enforces both the SQL and application approval boundaries.
 db.function('murage_approval_guard', { deterministic: true }, () => 1);
 beginWrite(db, 'approval_migration');
 try{
 db.exec(`CREATE TABLE IF NOT EXISTS approval_records(id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, service TEXT, thread_id TEXT NOT NULL,
 request_key TEXT NOT NULL, request_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation TEXT, actor_kind TEXT NOT NULL, actor_via TEXT NOT NULL, level TEXT NOT NULL,
 why TEXT NOT NULL CHECK(why IN('deny','wipe','base','question')), evidence TEXT NOT NULL, registration_hash TEXT NOT NULL, deny_rev TEXT NOT NULL,
 input_hash TEXT NOT NULL, action_hash TEXT NOT NULL, presented_action TEXT, chat_message_id TEXT NOT NULL, queue_kind TEXT, queue_ref TEXT,
 state TEXT NOT NULL CHECK(state IN('open','answered','expired','cancelled','superseded')), answer TEXT, answer_id TEXT,
 delivery TEXT NOT NULL DEFAULT 'none' CHECK(delivery IN('none','pending','accepted','failed','unconfirmed')), created_at INTEGER NOT NULL, settled_at INTEGER);
 DROP INDEX IF EXISTS approval_open_request;
 CREATE UNIQUE INDEX IF NOT EXISTS approval_request_once ON approval_records(source_kind,thread_id,request_key);
 CREATE UNIQUE INDEX IF NOT EXISTS approval_chat_row ON approval_records(thread_id,chat_message_id);
 CREATE INDEX IF NOT EXISTS approval_records_settled ON approval_records(settled_at) WHERE state <> 'open';
 CREATE INDEX IF NOT EXISTS approval_open_created ON approval_records(created_at) WHERE state='open';
 CREATE INDEX IF NOT EXISTS approval_open_thread ON approval_records(thread_id,created_at) WHERE state='open';
 CREATE INDEX IF NOT EXISTS approval_queue_ref ON approval_records(thread_id,queue_kind,queue_ref) WHERE queue_ref IS NOT NULL;
 CREATE TABLE IF NOT EXISTS decision_continuations(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS decision_continuations_shared_peer ON decision_continuations(key) WHERE ${SHARED_PEER_PREDICATE};`);
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_card_insert'").get()){
 db.exec(`UPDATE messages SET json=json_set(json,'$.card.emailSend.draft.text','') WHERE kind='options' AND json_valid(json) AND json_extract(json,'$.card.approvalId') IS NULL AND json_type(json,'$.card.emailSend.draft.text') IS NOT NULL AND NOT (${termSql('messages')});`);
 db.exec(`UPDATE messages SET json=json_set(json,'$.card.orphaned',json('true'),'$.card.answered','Expired (upgrade)') WHERE (${cardClassSql('messages')}) AND json_extract(json,'$.card.approvalId') IS NULL AND NOT (${termSql('messages')});`);
 }
 // Refresh older trigger definitions without repeating the legacy migration.
 for(const name of APPROVAL_OBJECTS.triggers){
  const installed=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
  if(installed&&((['approval_card_insert','approval_card_update'].includes(name)&&!String(installed.sql).includes('card-result-v4'))||(name==='approval_card_update'&&!String(installed.sql).includes('undo-progress'))||(name==='approval_card_update'&&!String(installed.sql).includes('answer-send-receipt'))||!String(installed.sql).includes("'$.sentAsMessage'")||!String(installed.sql).includes("'$.undone'")||!String(installed.sql).includes('own-write')||!String(installed.sql).includes('murage_approval_guard')||String(installed.sql).includes('WHEN (EXISTS(SELECT 1 FROM pragma_function_list')))db.exec(`DROP TRIGGER ${name}`);
 }
 const guarded="EXISTS(SELECT 1 FROM pragma_function_list WHERE name='murage_approval_guard')";
 const clsN=cardClassSql('NEW'),clsO=cardClassSql('OLD'),termN=termSql('NEW'),termO=termSql('OLD'),poN=projectionSql('NEW'),poO=projectionSql('OLD');
 const rid="json_extract(NEW.json,'$.card.approvalId')";
 // Generic queue IDs remain stable when a refreshed card receives a new public answer key.
 const queueCase=`CASE R.queue_kind ${Object.entries(QUEUE_REF_PATHS).map(([k,p])=>`WHEN ${sql(k)} THEN json_extract(NEW.json,${sql(p==='$.card.requestId'?'$.card.requestRef':p)})`).join(' ')} END`;
 db.exec(`CREATE TRIGGER IF NOT EXISTS approval_card_insert /* card-result-v4 */ BEFORE INSERT ON messages
 WHEN NEW.kind IN ('options','secret','mcpSignIn','connector') AND ((${clsN}) OR (${credentialSql('NEW')})) AND (${guarded}) BEGIN
 SELECT RAISE(ABORT,'card-without-approval') WHERE (${credentialSql('NEW')}) OR (${invalidSendReceiptSql('NEW')}) OR NOT (
 (${rid} IS NULL AND (${termN})) OR (${rid} IS NOT NULL AND EXISTS(SELECT 1 FROM approval_records R WHERE
 R.id IS ${rid} AND R.thread_id IS NEW.thread_id AND R.chat_message_id IS NEW.id AND R.action_hash IS json_extract(NEW.json,'$.card.actionHash')
 AND R.request_id IS json_extract(NEW.json,'$.card.requestRef') AND (R.queue_kind IS NULL OR R.queue_ref IS ${queueCase})
 AND (R.state='open' OR (${termN})) AND (R.presented_action IS NULL OR ${resultSql("R.presented_action")} IS ${poN})))); END;
 CREATE TRIGGER IF NOT EXISTS approval_card_presented AFTER INSERT ON messages WHEN (${clsN}) AND ${rid} IS NOT NULL AND (${guarded}) BEGIN
 UPDATE approval_records SET presented_action=${poN} WHERE id IS ${rid} AND presented_action IS NULL; END;
 CREATE TRIGGER IF NOT EXISTS approval_card_update /* card-result-v4 undo-progress answer-send-receipt */ BEFORE UPDATE ON messages WHEN (OLD.kind IN ('options') OR NEW.kind IN ('options','secret','mcpSignIn','connector')) AND ((${clsO}) OR (${clsN}) OR (${credentialSql('NEW')})) AND (${guarded}) BEGIN
 SELECT RAISE(ABORT,'card-action-changed') WHERE
 (${invalidSendReceiptSql('NEW')}) OR
 (NOT (${termN}) AND (${['answers','expired','folderTrust.late'].map(k=>`json_extract(NEW.json,'$.card.${k}') IS NOT json_extract(OLD.json,'$.card.${k}')`).join(' OR ')}))
 OR (${credentialSql('NEW')}) OR NOT (
 NEW.id IS OLD.id AND NEW.thread_id IS OLD.thread_id AND NEW.kind IS OLD.kind AND (${clsO}) AND (${clsN})
 AND (CASE WHEN NOT (${termO}) THEN ${poN} IS ${poO} AND json_extract(NEW.json,'$.card.undone') IS json_extract(OLD.json,'$.card.undone') ELSE ${projectionSql('NEW',true)} IS ${projectionSql('OLD',true)} AND (${termN}) END)
 AND (NOT ((${termN}) AND NOT (${termO})) OR ${rid} IS NULL OR EXISTS(SELECT 1 FROM approval_records R WHERE R.id IS ${rid} AND R.state IS NOT 'open'))); END;`);
 endWrite(db, 'approval_migration');
 }catch(e){undoWrite(db, 'approval_migration');throw e;}
}
/** Each send may have several immutable presentations; patch every one. */
export const EMAIL_CARD_MESSAGES_SQL = "SELECT chat_message_id AS messageId FROM approval_records WHERE source_kind='service' AND thread_id=? AND queue_kind='email' AND queue_ref=?";
export function emailCardMessageIds(db:DatabaseSync,threadId:string,ref:string):{messageId:string}[]{
 return db.prepare(EMAIL_CARD_MESSAGES_SQL).all(threadId,ref) as {messageId:string}[];
}
export interface RecordRow {id:string;source_kind:string;service:string|null;thread_id:string;request_key:string;request_id:string;bot_id:string;generation:string|null;actor_kind:string;actor_via:string;level:string;why:string;evidence:string;registration_hash:string;deny_rev:string;input_hash:string;action_hash:string;presented_action:string|null;chat_message_id:string;queue_kind:string|null;queue_ref:string|null;state:string;answer:string|null;answer_id:string|null;delivery:string;created_at:number;settled_at:number|null}
const caches=new WeakMap<DatabaseSync,Map<string,RecordRow>>();
function cache(db:DatabaseSync){let c=caches.get(db);if(!c)caches.set(db,c=new Map());return c;}
export function remember(db:DatabaseSync,r:RecordRow):void{onRollback(()=>cache(db).delete(r.id));afterCommit(()=>{const c=cache(db);c.delete(r.id);c.set(r.id,{...r});let terminal=0;for(const v of c.values())if(v.state!=='open')terminal++;for(const [id,v] of c)if(terminal>1024&&v.state!=='open'){c.delete(id);terminal--;}});}
export function readRecord(db:DatabaseSync,id:string):RecordRow|undefined{const r=db.prepare('SELECT * FROM approval_records WHERE id=?').get(id) as unknown as RecordRow|undefined;if(r)remember(db,r);return r;}
export function findRecord(db:DatabaseSync,source:string,thread:string,key:string):RecordRow|undefined{return db.prepare('SELECT * FROM approval_records WHERE source_kind=? AND thread_id=? AND request_key=?').get(source,thread,key) as unknown as RecordRow|undefined;}
export function openRecords(db:DatabaseSync,thread?:string):RecordRow[]{return db.prepare(`SELECT * FROM approval_records WHERE state='open'${thread?' AND thread_id=?':''} ORDER BY created_at,rowid`).all(...(thread?[thread]:[])) as unknown as RecordRow[];}
export function lookupRecord(db:DatabaseSync,thread:string,message:string){return db.prepare('SELECT * FROM approval_records WHERE thread_id=? AND chat_message_id=?').get(thread,message) as unknown as RecordRow|undefined;}
export function insertRecord(db:DatabaseSync,r:RecordRow){const cols=Object.keys(r);db.prepare(`INSERT INTO approval_records(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(r));remember(db,r);}
export function updateRecord(db:DatabaseSync,id:string,patch:Partial<RecordRow>){const cols=Object.keys(patch);db.prepare(`UPDATE approval_records SET ${cols.map(k=>k+'=?').join(',')} WHERE id=?`).run(...Object.values(patch),id);const r=readRecord(db,id);if(r)remember(db,r);}
export function pruneRecords(db:DatabaseSync,now=Date.now()):number{return Number(db.prepare("DELETE FROM approval_records WHERE id IN(SELECT id FROM approval_records INDEXED BY approval_records_settled WHERE state <> 'open' AND settled_at < ? ORDER BY settled_at LIMIT 500)").run(now-30*86400000).changes);}
export const isPermission=(m:any):boolean=>PERMISSION_CARD_KINDS.includes(m?.kind)&&!!m?.card&&PERMISSION_CARD_KEYS.some(k=>m.card[k]!=null);
export const isTerminal=(m:any):boolean=>CARD_TERMINAL_FIELDS.some(k=>!!m?.card?.[k]);
export class CardAuthorizationViolation extends Error {}
export class CardIdentityChange extends Error {}
function projection(card:any,display=false){
 const action=actionProjection(card??{});
 if(!display)for(const k of CARD_DISPLAY_FIELDS)if(k in (card??{}))action[k]=card[k];
 if(card?.actionHash!==undefined)action.actionHash=card.actionHash;
 return action;
}
function resultProjection(card:any){return [card?.answers,card?.expired,card?.folderTrust?.late];}
function invalidSendReceipt(message:any):boolean {
 const card=message?.card;
 return card?.answerAsSend===true&&(card.sendId!==undefined||card.sentAsMessage!==undefined)
  &&(!isTerminal(message)||card.sendId!==`ask-${message.id}`||card.sentAsMessage!==undefined&&(card.sentAsMessage!==true||card.expired!==true));
}
export function assertCardPatch(before:any,after:any){
 if(before?.card?.kind==='own-write'||after?.card?.kind==='own-write'){if(!sameOwnWriteCard(before,after))throw new CardIdentityChange('writer-card-action-changed');return;}
if(!isPermission(before)&&!isPermission(after))return;
 if(invalidSendReceipt(after))throw new CardIdentityChange('card-action-changed');
 if(!isTerminal(after)&&canonical(resultProjection(before.card))!==canonical(resultProjection(after.card)))throw new CardIdentityChange('card-action-changed');
 if((!isTerminal(before)&&before.card?.undone!==after.card?.undone)||before.id!==after.id||before.kind!==after.kind||!isPermission(before)||!isPermission(after)||canonical(projection(before.card,isTerminal(before)))!==canonical(projection(after.card,isTerminal(before)))||(isTerminal(before)&&!isTerminal(after)))throw new CardIdentityChange('card-action-changed');}
/** Old cards signed their initial status copy too. Their original persisted
 * presentation proves that signature; only the newly defined result fields
 * may differ on a terminal replay. No executable field gets a compatibility bypass. */
function signedActionMatches(r:RecordRow,card:any):boolean {
 const action=actionProjection(card);
 if(r.action_hash===hash(action))return true;
 if(!r.presented_action)return false;
 try{
  const original=JSON.parse(r.presented_action);
  const legacy=Object.fromEntries(Object.entries(original).filter(([key])=>![...CARD_TERMINAL_FIELDS,...CARD_DISPLAY_FIELDS,'actionHash'].includes(key as any)));
  return r.action_hash===hash(legacy)&&canonical(actionProjection(original))===canonical(action);
 }catch{return false;}
}
export function assertCardAuthorized(db:DatabaseSync,thread:string,message:any,prior?:any):void{
 if(message?.card?.kind==='own-write'){if(!ownWriteCardAuthorized(db,thread,message))throw new CardAuthorizationViolation('writer-card-without-hold');if(prior)assertCardPatch(prior,message);return;}
 if(['secret','mcpSignIn','connector'].includes(message.kind)&&message.card!=null)throw new CardAuthorizationViolation('credential-with-card');
 if(prior){assertCardPatch(prior,message);return;}
 if(!isPermission(message))return;
 if(invalidSendReceipt(message))throw new CardAuthorizationViolation('card-without-approval');
 if(!message.card.approvalId&&isTerminal(message))return;
 const r=message.card.approvalId&&readRecord(db,message.card.approvalId);
 if(!r||r.thread_id!==thread||r.chat_message_id!==message.id||r.request_id!==message.card.requestRef||r.action_hash!==message.card.actionHash||!signedActionMatches(r,message.card)||(r.state!=='open'&&!isTerminal(message)))throw new CardAuthorizationViolation('card-without-approval');
}
export function canEmit(db:DatabaseSync,thread:string,message:any,patch:boolean):boolean{
 if(message?.card?.kind==='own-write')return ownWriteCardAuthorized(db,thread,message);
 if(['secret','mcpSignIn','connector'].includes(message.kind)&&message.card!=null)return false;
 if(!isPermission(message))return true;
 const id=message.card.approvalId;
 if(!id)return patch && !!db.prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,message.id) && isTerminal(message);
 const r=readRecord(db,id);
 return !!r&&r.thread_id===thread&&r.chat_message_id===message.id&&(r.state==='open'||isTerminal(message));
}
/** Record first, then same-action row terminalization, used by offline restore/downgrade. */
export function cancelOpenRecords(db:DatabaseSync,label:string):void{
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_records'").get())return;
 db.prepare("UPDATE approval_records SET state='cancelled',settled_at=? WHERE state='open'").run(Date.now());
 // An answer that was pending delivery belongs to the former installation.
 // Keep its outcome history, but never replay the old engine permission.
 db.exec("UPDATE approval_records SET delivery='unconfirmed' WHERE state='answered' AND delivery='pending'");
 db.prepare(`UPDATE messages SET json=json_set(json,'$.card.answered',?,'$.card.dismissed',json('true'),'$.card.orphaned',json('true')) WHERE (${cardClassSql('messages')}) AND json_extract(json,'$.card.approvalId') IN(SELECT id FROM approval_records WHERE state='cancelled')`).run(label);
}
/** Backup display redaction cannot rewrite a hash-bound action. Reject a staged
 * archive containing a mail body there; producers must keep it in display data. */
export function assertBackupEmailActions(db:DatabaseSync):void{
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_records'").get())return;
 if(db.prepare("SELECT 1 FROM approval_records WHERE coalesce(json_extract(evidence,'$.action.emailSend.draft.text'),'') <> '' OR coalesce(json_extract(presented_action,'$.emailSend.draft.text'),'') <> '' LIMIT 1").get())throw new Error('EMAIL_ACTION_REDACTION_REQUIRED');
}
/** Keep the cached first presentation consistent with its redacted terminal
 * transcript. Display bytes must not remain hidden in the staged record. */
export function refreshBackupEmailPresentations(db:DatabaseSync):void{
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_records'").get())return;
 db.exec(`UPDATE approval_records AS R SET presented_action=(SELECT ${projectionSql('M')} FROM messages M WHERE M.thread_id=R.thread_id AND M.id=R.chat_message_id)
 WHERE EXISTS(SELECT 1 FROM messages M WHERE M.thread_id=R.thread_id AND M.id=R.chat_message_id AND CASE WHEN json_valid(M.json) THEN json_type(M.json,'$.card.emailSend') END IS NOT NULL);`);
}
/** Repeated service calls reuse their exact immutable proof without taking
 * the writer. A first persistence attempt shares the serving-thread ceiling;
 * neither a conflict nor contention may widen a stricter caller timeout. */
export function saveContinuationRecord(db:DatabaseSync,key:string,value:string){
 const waitMs=Number(db.prepare('PRAGMA busy_timeout').get()!.timeout);
 let failed=false;
 try{
  setBusy(db,Math.min(waitMs,BACKGROUND_BUSY_MS));
  const existing=readContinuationRecord(db,key);
  if(existing!==undefined){
   if(existing!==value)throw new Error('continuation-conflict');
   return;
  }
  db.prepare('INSERT INTO decision_continuations(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(key,value);
  // Another connection may have established this key after the first read.
  if(readContinuationRecord(db,key)!==value)throw new Error('continuation-conflict');
 }catch(error){failed=true;throw error;}
 finally{
  try{setBusy(db,waitMs);}catch(error){if(!failed)throw error;}
 }
}
export function readContinuationRecord(db:DatabaseSync,key:string):string|undefined{return db.prepare('SELECT value FROM decision_continuations WHERE key=?').get(key)?.value as string|undefined;}
export function deleteContinuationRecord(db:DatabaseSync,key:string){db.prepare('DELETE FROM decision_continuations WHERE key=?').run(key);}
export function recordStats(db:DatabaseSync){const c=cache(db);return {cache:c.size,open:[...c.values()].filter(v=>v.state==='open').length};}

export function pendingEngineAnswers(db:DatabaseSync):RecordRow[]{return db.prepare("SELECT * FROM approval_records WHERE state='answered' AND delivery='pending' AND source_kind='engine'").all() as unknown as RecordRow[];}

/** Lazy historical imports are non-actionable before the INSERT seam. */
export function terminalLegacy(message:any):any {
 if(!isPermission(message)||message.card?.approvalId)return message;
 let card={...message.card,...(!isTerminal(message)?{orphaned:true,answered:'Expired (upgrade)'}:{})};
 if(!isTerminal(message)&&card.emailSend?.draft?.text!==undefined)card={...card,emailSend:{...card.emailSend,draft:{...card.emailSend.draft,text:''}}};
 return {...message,card};
}

export interface QueueDelivery { kind:string; inputHash:string; answerId:string; delivery:'pending'|'accepted'|'failed' }
const queueDeliveryKey=(id:string)=>'queue-answer:'+id;
export function readQueueDelivery(db:DatabaseSync,id:string):QueueDelivery|undefined{const value=readContinuationRecord(db,queueDeliveryKey(id));return value?JSON.parse(value):undefined;}
export function writeQueueDelivery(db:DatabaseSync,id:string,value:QueueDelivery):void{db.prepare('INSERT INTO decision_continuations(key,value) VALUES(?,?),(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(queueDeliveryKey(id),JSON.stringify(value),'queue-required:'+value.kind,'1');}
export function deleteQueueDelivery(db:DatabaseSync,id:string):void{const receipt=readQueueDelivery(db,id);deleteContinuationRecord(db,queueDeliveryKey(id));if(receipt&&!db.prepare("SELECT 1 FROM decision_continuations WHERE key GLOB 'queue-answer:*' AND json_extract(value,'$.kind')=? LIMIT 1").get(receipt.kind))deleteContinuationRecord(db,'queue-required:'+receipt.kind);}
/** The durable queue owns accepted tombstones. Our pending transport receipts
 * leave only after durable acknowledgement, or when that queue no longer waits. */
export function pruneQueueDeliveries(db:DatabaseSync,pending:ReadonlySet<string>):void{for(const row of db.prepare("SELECT key FROM decision_continuations WHERE key GLOB 'queue-answer:*' ORDER BY key LIMIT 500").all())if(!pending.has(String(row.key).slice('queue-answer:'.length)))deleteQueueDelivery(db,String(row.key).slice('queue-answer:'.length));}

export function requiredQueueKinds(db:DatabaseSync):string[]{return db.prepare("SELECT key FROM decision_continuations WHERE key GLOB 'queue-required:*'").all().map(row=>String(row.key).slice('queue-required:'.length));}

export function listSharedPeerContinuations(db:DatabaseSync,after:string,limit:number):string[]{
 return db.prepare(`SELECT key FROM decision_continuations INDEXED BY decision_continuations_shared_peer WHERE ${SHARED_PEER_PREDICATE} AND key > ? ORDER BY key LIMIT ?`).all(after,limit).map(row=>String(row.key));
}
