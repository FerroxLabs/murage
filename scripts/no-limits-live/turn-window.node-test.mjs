import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CardLedger} from './counts.mjs';
import {readApprovalRecords} from './readers.mjs';

test('same-thread history growth does not increase current message correlation work',()=>{
 for(const history of [10,10000]){
  const ledger=new CardLedger();
  for(let i=0;i<history;i++)ledger.observe('t',{id:`old-${i}`,kind:'options',at:1,card:{requestId:`old-${i}`,approvalId:`old-${i}`}});
  ledger.observe('t',{id:'new',kind:'options',at:2,card:{requestId:'new',approvalId:'new'}});
  const record={id:'new',source_kind:'engine',thread_id:'t',request_id:'new',chat_message_id:'new',why:'base',evidence:JSON.stringify({items:[],initiator:{k:'other-human'}})};
  const get=ledger.cards.get.bind(ledger.cards);let reads=0;ledger.cards.get=key=>{reads++;return get(key);};
  ledger.correlate([record],{threadId:'t',messageIds:['new']});
  assert.ok(reads<=2,`visited ${reads} cards with ${history} prior cards in the same thread`);
  assert.equal(get('t:new').recordId,'new');assert.equal(get('t:old-0').recordId,undefined);
 }
});

test('approval reader returns only current message/request identities as history grows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gnl-window-db-')),db=new DatabaseSync(join(dir,'messages.db'));
 try{
  db.exec('CREATE TABLE approval_records(id TEXT PRIMARY KEY,source_kind TEXT,thread_id TEXT,request_id TEXT,chat_message_id TEXT,why TEXT,evidence TEXT)');
  const insert=db.prepare('INSERT INTO approval_records VALUES(?,?,?,?,?,?,?)');
  db.exec('BEGIN');for(let i=0;i<10000;i++)insert.run(`old-${i}`,'engine','t',`old-${i}`,`old-${i}`,'base','{}');db.exec('COMMIT');
  insert.run('new','engine','t','new','new','base','{}');
  const window={messageIds:['new'],approvalIds:['new']};
  assert.deepEqual(readApprovalRecords(dir,'t',window).map(r=>r.id),['new']);
  assert.deepEqual(readApprovalRecords(dir,'t',{messageIds:['swapped'],approvalIds:['new']}),[]);
  assert.deepEqual(readApprovalRecords(dir,'t',{messageIds:[],approvalIds:[]}),[]);
  assert.throws(()=>readApprovalRecords(dir,'t'),/window/i);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('ProductClient reads the current turn without walking older same-thread pages',async()=>{
 const {ProductClient}=await import('./run.mjs');
 for(const history of [10,10000]){
  const client=new ProductClient('http://fixture',{},'/unused');
  const old=Array.from({length:history},(_,i)=>({id:`old-${i}`,kind:'text',text:'old'}));
  const current=Array.from({length:205},(_,i)=>({id:`new-${i}`,kind:'text',text:'current'}));
  let sent=false,calls=0;
  client.api=async(method,path)=>{
   assert.equal(method,'GET');const q=new URL(path,'http://fixture').searchParams;
   const all=sent?[...old,...current]:old,limit=Number(q.get('limit')),before=q.get('before');
   const end=before?all.findIndex(m=>m.id===before):all.length,start=Math.max(0,end-limit);calls++;
   return {messages:all.slice(start,end),hasMore:start>0};
  };
  // Capture a durable message boundary before sending, including when timestamps tie.
  const window=await client.beginMessageWindow('t');sent=true;
  const rows=await client.messages('t',window);
  assert.deepEqual(rows.map(r=>r.id).sort(),current.map(r=>r.id).sort());
  assert.equal(calls,3,`walked historical pages with ${history} prior messages`);
 }
});

test('a missing durable message boundary fails instead of accepting an incomplete turn',async()=>{
 const {ProductClient}=await import('./run.mjs');
 const client=new ProductClient('http://fixture',{},'/unused');
 client.api=async()=>({messages:[{id:'new',kind:'text'}],hasMore:false});
 await assert.rejects(client.messages('t',{afterId:'removed-boundary'}),/boundary/i);
});

test('observe captures its boundary before send and excludes past same-thread cards',async()=>{
 const {ProductClient}=await import('./run.mjs');
 const client=new ProductClient('http://fixture',{},'/unused',1000);
 const old={id:'old',kind:'options',card:{requestId:'old',approvalId:'old'}},current={id:'current',kind:'text'};
 client.ledger.observe('t',old);client.stop=async()=>{};let sent=false;
 client.api=async(method,path)=>path.endsWith('/open-cards')?{pending:false,openCards:[]}:
  {messages:sent?[old,current]:[old],hasMore:false};
 const obs=await client.observe({id:'b',threadId:'t'},async()=>{
  sent=true;client.events.push({type:'turn.started',threadId:'t',turnId:'turn'},{type:'turn.completed',threadId:'t',turnId:'turn',ok:true});
 });
 assert.deepEqual(obs.messages.map(m=>m.id),['current']);assert.deepEqual(obs.cards,[]);
});
