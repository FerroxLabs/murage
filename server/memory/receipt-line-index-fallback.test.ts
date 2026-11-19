// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN ruling CJ-4 (review High): producer owner trainred-b5 (session-proof.ts receipt-line probe); consumer owner recall-s1s2g (session proof).
// A failed or pending build of the receipt-line session index must not leave a scan of every receipt line behind the session proof.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { RECEIPT_LINE_SESSION } from './schema.ts';
import { proofModule, receipts, setupProofFixture } from './session-proof-fixture.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{vi.restoreAllMocks();stopRecallViewMaintenance();closeDatabase();});

/** What a failed build leaves: the table without its session index. */
function failedBuild() {
  const db=database();
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(RECEIPT_LINE_SESSION.name)).toBeTruthy();
  db.exec(`DROP INDEX ${RECEIPT_LINE_SESSION.name}`);
}
function receiptLineReads(work:()=>unknown) {
  const db=database(),seen:string[]=[],prepare=db.prepare.bind(db);
  const spy=vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{seen.push(sql);return prepare(sql);});
  try{return {result:work(),reads:seen.filter(sql=>/\bmemory_receipt_lines\b/.test(sql)).length};}finally{spy.mockRestore();}
}
function warmHeld() {
  const f=setupProofFixture();
  database().prepare('INSERT OR REPLACE INTO memory_session_state VALUES(?,?,?,0)').run(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  return f;
}

it('a held session keeps its warm session through one indexed receipt-line seek',async()=>{
  const f=warmHeld(),p=await proofModule();
  const {result,reads}=receiptLineReads(()=>p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:false}));
  expect(result).toEqual({kind:'resume'});
  expect(reads).toBe(1);
});
it('a held session waits instead of scanning receipt lines while the session index is missing',async()=>{
  const f=warmHeld(),p=await proofModule();failedBuild();
  const {result,reads}=receiptLineReads(()=>p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:false}));
  expect(result).toEqual({kind:'fresh',reason:'receipt-index-pending',cause:'checking'});
  expect(reads).toBe(0);
});
it('a reader with receipts waits instead of scanning receipt lines while the session index is missing, and resumes once it is built',async()=>{
  const f=setupProofFixture('direct'),p=await proofModule();await receipts(f,1);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  failedBuild();
  const missing=receiptLineReads(()=>p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true}));
  expect(missing.result).toEqual({kind:'fresh',reason:'receipt-index-pending',cause:'checking'});
  expect(missing.reads).toBe(0);
  database().exec(RECEIPT_LINE_SESSION.sql);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
});
