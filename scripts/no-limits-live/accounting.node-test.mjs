import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBindings } from './bindings.mjs';
test('release accounting reads actual durable stores without invented tap files or UI endpoints',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'gnl-accounting-'));const db=new DatabaseSync(join(dataDir,'messages.db'));
  db.exec(`CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,kind TEXT,json TEXT);
    CREATE TABLE approval_records(id TEXT,thread_id TEXT,request_id TEXT,why TEXT,state TEXT,chat_message_id TEXT,created_at INTEGER);`);
  const f={data:dataDir,client:{events:[{type:'turn.started',threadId:'t',receivedAt:1}],url:'http://fixture.invalid',headers:{}}};
  installBindings(f);const spec={id:'ordinary',actor:'owner',level:'unlimited',expected:'RUN'};
  try {
    assert.equal((await f.observeRow({spec,threadIds:['t']})).verdict,'PASS');
    db.prepare('INSERT INTO approval_records VALUES(?,?,?,?,?,?,?)').run('a','t','r','deny','open','m',2);
    const hold=await f.observeRow({spec,threadIds:['t']});assert.equal(hold.verdict,'FAIL');assert.equal(hold.hiddenHolds,1);
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('t','m',3,'options',JSON.stringify({card:{approvalId:'a',requestId:'r',tool:'Bash'}}));
    const shown=await f.observeRow({spec,threadIds:['t']});assert.equal(shown.verdict,'FAIL');assert.equal(shown.nonwipeCards,1);
    db.prepare("UPDATE approval_records SET why='wipe'").run();
    assert.equal((await f.observeRow({spec:{...spec,expected:'CARD',why:'wipe'},threadIds:['t']})).verdict,'PASS');
    assert.equal((await f.observeRow({spec:{...spec,expected:'RUN'},threadIds:['t']})).verdict,'FAIL','candidate wipe label cannot authorize a non-wipe action');
  }finally{db.close();rmSync(dataDir,{recursive:true,force:true});}
});
