import {expect,it} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
it.each(['allow','deny','expired'] as const)('A6 F5 terminal %s emits the persisted patch',async behavior=>{
 const f=fixture();const seen:any[]=[];f.store.onChange(e=>seen.push(e));const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 if(behavior==='expired')await d.settle(ref,'expired');else await d.answerApproval(ref,{behavior});
 expect(seen.filter(e=>e.type==='message.patch'&&e.message.card?.answered)).toHaveLength(1);expect(d.readApproval(ref.approvalId)?.state).toBe(behavior==='expired'?'expired':'answered');
});
it('R17 M5 queue→card consumes one record, accepts JSON round-trip, rejects wrong refs (M20)',async()=>{
 const f=fixture();const call=f.serviceCall();const ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(0);
 expect(()=>d.attachQueue(ref,{kind:'email',ref:'wrong',call})).toThrow();d.attachQueue(ref,{kind:'email',ref:'q',call});await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});await d.presentApproval(ref,{title:'Duplicate',subtitle:'x'});
 const r=d.readApproval(ref.approvalId)!;expect(JSON.parse(JSON.stringify(r)).actionHash).toBe(r.actionHash);expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(1);expect(d.lookupApproval('t',r.chatMessageId)?.ref.approvalId).toBe(ref.approvalId);
});
it('A6 F5 restart expires an engine record and emits its terminal patch after durable state',async()=>{
 const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});let terminal=false;f.store.onChange(e=>{if(e.type==='message.patch'){expect(d.readApproval(ref.approvalId)?.state).toBe('expired');terminal=true;}});await d.recover();expect(terminal).toBe(true);
});
it('A6 F5 legacy terminal patches reach the client',async()=>{
 const {APPROVAL_OBJECTS,initializeApprovals}=await import('./records.ts');const f=fixture();for(const name of APPROVAL_OBJECTS.triggers)f.db.exec(`DROP TRIGGER ${name}`);
 const row={id:'legacy',at:1,role:'bot',kind:'options',card:{requestId:'old',title:'Legacy',subtitle:'x',options:['Allow','Deny']}};
 f.db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)').run('t',row.id,1,'bot','options',JSON.stringify(row));initializeApprovals(f.db);const seen:any[]=[];f.store.onChange(e=>seen.push(e));const m=f.store.messageById('t','legacy')!;f.store.patchMessagePoint('t','legacy',{card:{...m.card,answered:'Expired',orphaned:true}} as any);expect(seen.filter(e=>e.type==='message.patch')).toHaveLength(1);
});

it('settlement details remain display data while the original permission stays immutable in both guards',async()=>{
 const f=fixture('ask');
 d.installEngineApprovalBuilder(()=>({options:['Trust','Skip'],folderTrust:{key:'/fixture/project',folder:'/fixture/project',sources:['AGENTS.md']}}));
 const ref=card(d.decide(f.open('result',{command:'echo fixture'}),baseCard));
 await d.presentApproval(ref,{title:'Fixture',subtitle:'Original action'});
 const record=d.readApproval(ref.approvalId)!;
 const current=()=>f.store.messageById('t',record.chatMessageId)!;
 const writeSql=(next:unknown)=>f.db.prepare('UPDATE messages SET json=? WHERE thread_id=? AND id=?').run(JSON.stringify(next),'t',record.chatMessageId);
 const open=current();
 expect(()=>f.store.patchMessagePoint('t',open.id,{card:{...open.card!,answers:[{id:'folderTrust',selected:['Trust']}]}})).toThrow('card-action-changed');
 expect(()=>writeSql({...open,card:{...open.card,expired:true}})).toThrow('card-action-changed');
 f.store.patchMessagePoint('t',open.id,{card:{...open.card!,held:'The routine changed. Please review it again.'}});
 expect(d.readApproval(ref.approvalId)?.actionHash).toBe(record.actionHash);
 expect(()=>f.store.patchMessagePoint('t',open.id,{card:{...current().card!,subtitle:'Different action'}})).toThrow('card-action-changed');
 await d.settle(ref,'expired');
 const terminal=current();
 f.store.patchMessagePoint('t',terminal.id,{card:{...terminal.card!,expired:true,folderTrust:{...terminal.card!.folderTrust!,late:'finished'}}});
 expect(current().card).toMatchObject({expired:true,folderTrust:{key:'/fixture/project',late:'finished'}});
 const changed={...current(),card:{...current().card!,folderTrust:{...current().card!.folderTrust!,key:'/fixture/other'}}};
 expect(()=>f.store.patchMessagePoint('t',changed.id,{card:changed.card})).toThrow('card-action-changed');
 expect(()=>writeSql(changed)).toThrow('card-action-changed');
 expect(f.respond).not.toHaveBeenCalled();
});

it('replays an older signed status only with its original action, through the application and SQL guards',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {hash}=await import('./bounds.ts');
 const {readRecord,insertRecord,updateRecord,initializeApprovals,assertCardAuthorized}=await import('./records.ts');
 const f=fixture('ask');
 d.installEngineApprovalBuilder(()=>({options:['Allow','Deny'],held:'Original reason',futurePayload:{target:'original'}}));
 const ref=card(d.decide(f.open('legacy-result',{command:'echo fixture'}),baseCard));
 await d.presentApproval(ref,{title:'Fixture',subtitle:'Original action'});
 const record=readRecord(f.db,ref.approvalId)!;
 const original=f.store.messageById('t',record.chat_message_id)!;
 const legacyAction=Object.fromEntries(Object.entries(original.card!).filter(([key])=>!['title','subtitle','detail','answered','answeredAt','dismissed','orphaned','actionHash'].includes(key)));
 const legacyHash=hash(legacyAction);
 const legacy={...original,card:{...original.card!,actionHash:legacyHash}};
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE messages(thread_id TEXT,id TEXT,kind TEXT,json TEXT)');
  initializeApprovals(db);
  insertRecord(db,{...record,action_hash:legacyHash,presented_action:JSON.stringify(legacy.card)});
  const insert=(row:unknown)=>db.prepare('INSERT INTO messages(thread_id,id,kind,json) VALUES(?,?,?,?)').run('t',original.id,'options',JSON.stringify(row));
  expect(()=>assertCardAuthorized(db,'t',legacy)).not.toThrow();
  expect(()=>insert(legacy)).not.toThrow();
  updateRecord(db,record.id,{state:'expired'});
  const terminal={...legacy,card:{...legacy.card,answered:'expired',expired:true,held:'The turn ended.'}};
  expect(()=>assertCardAuthorized(db,'t',terminal)).not.toThrow();
  db.exec('DELETE FROM messages');
  expect(()=>insert(terminal)).not.toThrow();
  const changed={...terminal,card:{...terminal.card,futurePayload:{target:'different'}}};
  expect(()=>assertCardAuthorized(db,'t',changed)).toThrow('card-without-approval');
  expect(()=>insert(changed)).toThrow('card-without-approval');
 }finally{db.close();}
});

it('migrates service queue guards to stable references while refreshed public answer keys stay immutable',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {hash}=await import('./bounds.ts');
 const {actionProjection}=await import('../../shared/permission-card.ts');
 const {readRecord,insertRecord,initializeApprovals,assertCardAuthorized}=await import('./records.ts');
 const f=fixture('ask');
 const call=f.serviceCall({command:'echo fixture'});
 const ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));
 d.attachQueue(ref,{kind:'email',ref:'q',call});await d.presentApproval(ref,{title:'Fixture',subtitle:'Queue'});
 const record=readRecord(f.db,ref.approvalId)!;
 const original=f.store.messageById('t',record.chat_message_id)!;
 const refreshed={...original,card:{...original.card!,requestId:'release-fixture',requestRef:'q'}};
 refreshed.card.actionHash=hash(actionProjection(refreshed.card));
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE messages(thread_id TEXT,id TEXT,kind TEXT,json TEXT)');
  initializeApprovals(db);
  // Reinstall the previous schema to prove upgrade replaces existing guards.
  for(const name of ['approval_card_insert','approval_card_update']){
   const installed=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)!;
   const legacy=String(installed.sql).replace('card-result-v4','card-result-v3').replace("WHEN 'mcp' THEN json_extract(NEW.json,'$.card.requestRef')","WHEN 'mcp' THEN json_extract(NEW.json,'$.card.requestId')");
   db.exec(`DROP TRIGGER ${name}`);db.exec(legacy);
  }
  initializeApprovals(db);
  for(const name of ['approval_card_insert','approval_card_update'])expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql)).toContain('card-result-v4');
  insertRecord(db,{...record,service:'mcp',queue_kind:'mcp',queue_ref:'q',action_hash:refreshed.card.actionHash,presented_action:null});
  const insert=(row:unknown)=>db.prepare('INSERT INTO messages(thread_id,id,kind,json) VALUES(?,?,?,?)').run('t',original.id,'options',JSON.stringify(row));
  expect(()=>assertCardAuthorized(db,'t',refreshed)).not.toThrow();expect(()=>insert(refreshed)).not.toThrow();
  db.exec('DELETE FROM messages');
  const wrongRef={...refreshed,card:{...refreshed.card,requestRef:'wrong'}};
  expect(()=>assertCardAuthorized(db,'t',wrongRef)).toThrow('card-without-approval');expect(()=>insert(wrongRef)).toThrow('card-without-approval');
  const wrongKey={...refreshed,card:{...refreshed.card,requestId:'q'}};
  expect(()=>assertCardAuthorized(db,'t',wrongKey)).toThrow('card-without-approval');expect(()=>insert(wrongKey)).toThrow('card-without-approval');
 }finally{db.close();}
});
