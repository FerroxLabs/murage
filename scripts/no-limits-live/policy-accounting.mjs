// Read the app's actual durable decision/message stores independently of its
// API verdict. No hypothetical tap file, queue export or UI endpoint is needed.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export function readPolicyAccounting({dataDir,threadIds,spec,start=0,end=Date.now()}) {
  const errors=[];let db;
  try {
    if(!Array.isArray(threadIds)||!threadIds.length)throw Error('Owned thread scope missing');
    const file=join(dataDir,'messages.db');if(!existsSync(file))throw Error('Durable database missing');
    db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON');
    const slots=threadIds.map(()=>'?').join(',');
    const records=db.prepare(`SELECT id,thread_id,request_id,why,state,chat_message_id,created_at FROM approval_records WHERE thread_id IN (${slots}) AND created_at>=? AND created_at<=?`).all(...threadIds,start,end);
    const messages=db.prepare(`SELECT id,thread_id,at,json FROM messages WHERE kind='options' AND thread_id IN (${slots}) AND at>=? AND at<=?`).all(...threadIds,start,end);
    const shown=[];
    for(const message of messages) {
      const card=JSON.parse(message.json)?.card;if(!card||card.intake||card.setup)continue;
      const record=records.find(r=>r.id===card.approvalId&&r.chat_message_id===message.id&&r.thread_id===message.thread_id);
      if(!record){errors.push('Presentation without matching authoritative record');shown.push({why:'unknown',id:message.id});}
      else shown.push({why:record.why,id:record.id});
    }
    const permissions=records.filter(r=>r.why!=='question');
    const presented=shown.filter(r=>r.why!=='question');
    const hiddenHolds=permissions.filter(r=>!shown.some(s=>s.id===r.id)).length;
    const eligible=spec.level==='unlimited'&&!['guest','non-owner'].includes(spec.actor);
    const nonwipeCards=eligible?presented.filter(r=>spec.why!=='wipe'||r.why!=='wipe').length:0;
    if(hiddenHolds)errors.push('Permission held without a matching visible card');
    if(spec.expected==='RUN'&&(permissions.length||presented.length))errors.push('RUN operation created a permission record or presentation');
    if(spec.expected==='CARD') {
      if(permissions.length!==1||presented.length!==1)errors.push('Expected exactly one durable permission record and presentation');
      if(spec.why&&permissions.some(r=>r.why!==spec.why))errors.push('Durable permission class differs from independent expectation');
    }
    if(nonwipeCards)errors.push('Non-wipe No limits presentation');
    return {verdict:errors.length?'FAIL':'PASS',complete:true,records:records.length,permissions:permissions.length,
      presentations:shown.length,questions:shown.filter(r=>r.why==='question').length,hiddenHolds,nonwipeCards,errors};
  }catch {
    return {verdict:'FAIL',complete:false,errors:['Durable policy accounting unavailable or unreadable']};
  }finally{db?.close();}
}
