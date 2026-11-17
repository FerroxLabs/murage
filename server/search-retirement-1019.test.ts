import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { database, closeDatabase } from './database.ts';
import { initializeMessageTables, MESSAGE_SEARCH_DDL } from './message-tables.ts';
import { drainRetiredSearchIndexes, settleInheritedSearchMerge, dropThreadSearchRows, messageSearchIndexReady, searchRetirementPending, searchIndexTestHooks } from './message-search-index.ts';
import { scrubWalAfterDelete } from './wal-maintenance.ts';
import { settleTestHandles } from './test-handle-registry.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
it('D2 a 1.0.18 search index is retired automatically and deleted words leave messages.db and WAL', async () => {
  closeDatabase(); await settleTestHandles(DATA_DIR); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR,{recursive:true});
  const file=join(DATA_DIR,'messages.db'), old=new DatabaseSync(file);
  try {
    initializeMessageTables(old); old.exec(MESSAGE_SEARCH_DDL);
    const message={id:'old118',at:1,role:'bot',kind:'text',text:'qzv private upgrade canary'};
    old.prepare('INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)').run('t',message.id,1,'bot','text',message.text,JSON.stringify(message));
    old.prepare('INSERT INTO messages_fts(rowid,t) VALUES(1,?)').run(message.text);
    expect(old.prepare('SELECT block FROM messages_fts_data').all().some(r=>Buffer.from(r.block as Uint8Array).includes(Buffer.from('qzv')))).toBe(true);
  } finally { old.close(); }
  const events: unknown[]=[];searchIndexTestHooks.event=e=>events.push(e);
  const db=database();
  await expect.poll(()=>messageSearchIndexReady(db),{timeout:10000}).toBe(true);
  try {await expect.poll(()=>searchRetirementPending(db),{timeout:10000}).toBe(false);} catch(error){throw new Error(JSON.stringify(events.slice(-12)),{cause:error});}
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'messages_fts*'").all()).toEqual([]);
  db.exec("BEGIN IMMEDIATE; DELETE FROM messages WHERE thread_id='t'"); dropThreadSearchRows(db,'t'); db.exec('COMMIT');
  expect(await scrubWalAfterDelete()).toBe(true);
  for(const path of [file,file+'-wal']) if(existsSync(path)) expect(readFileSync(path).includes(Buffer.from('qzv')),path).toBe(false);
},30000);

it('D2 interrupted shadow cleanup resumes after every committed batch and rolls back failed batches',()=>{
  const file=join(DATA_DIR,'retirement-crash.db');mkdirSync(DATA_DIR,{recursive:true});
  let db=new DatabaseSync(file);
  try {
    initializeMessageTables(db);db.exec(MESSAGE_SEARCH_DDL);
    const insert=db.prepare('INSERT INTO messages_fts(rowid,t) VALUES(?,?)');
    for(let i=1;i<=300;i++)insert.run(i,'qzv legacy posting '+i);
    settleInheritedSearchMerge(db,false);
    const original=db.prepare('SELECT * FROM messages_fts_retired_data').all();
    const exec=db.exec.bind(db);db.exec=(sql:string)=>{if(sql==='RELEASE retired_search_cleanup')throw new Error('interrupted batch');exec(sql);};
    expect(()=>drainRetiredSearchIndexes(db)).toThrow('interrupted batch');db.exec=exec;
    expect(db.prepare('SELECT * FROM messages_fts_retired_data').all()).toEqual(original);
    let passes=0;
    while(searchRetirementPending(db)&&passes++<20){drainRetiredSearchIndexes(db);db.close();db=new DatabaseSync(file);}
    expect(searchRetirementPending(db)).toBe(false);expect(passes).toBeGreaterThan(2);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  } finally {db.close();}
});
