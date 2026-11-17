// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture control owner: tri3-g3; persisted decision action owner: tri3-g2.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {ProductClient} from './run.mjs';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';

for(const publicKey of ['queue-fixture','release-fixture'])test(`private card controls preserve presentation key ${publicKey}`,()=>{
 const directory=mkdtempSync(join(tmpdir(),'card-controls-'));
 const db=new DatabaseSync(join(directory,'messages.db'));
 try{
  db.exec('CREATE TABLE approval_records(id TEXT,thread_id TEXT,chat_message_id TEXT,request_id TEXT,action_hash TEXT,evidence TEXT)');
  const action={requestId:publicKey,requestRef:'queue-fixture',actionHash:'fixture-hash'};
  const update=(value)=>db.prepare('UPDATE approval_records SET evidence=?').run(JSON.stringify({action:value}));
  db.prepare('INSERT INTO approval_records VALUES(?,?,?,?,?,?)').run('approval-fixture','thread-fixture','card-fixture','queue-fixture','fixture-hash',JSON.stringify({action}));
  const client=new ProductClient('http://127.0.0.1:1',{},directory);
  const message={id:'card-fixture',card:{requestHandle:'p.card-fixture'}};
  const restored=client.fixtureCardControls('thread-fixture',message);
  assert.equal(restored.card.requestId,publicKey);assert.equal(restored.card.requestRef,'queue-fixture');assert.equal(restored.card.approvalId,'approval-fixture');assert.equal(restored.card.actionHash,'fixture-hash');
  assert.deepEqual(message,{id:'card-fixture',card:{requestHandle:'p.card-fixture'}});
  update({...action,requestRef:'wrong-fixture'});assert.throws(()=>client.fixtureCardControls('thread-fixture',message),/exact private binding/);
  update({...action,actionHash:'wrong-fixture'});assert.throws(()=>client.fixtureCardControls('thread-fixture',message),/exact private binding/);
 }finally{db.close();removeTempDirSync(directory);}
});
