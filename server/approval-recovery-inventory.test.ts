// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { backupFixture, optionalBackupAgeUnavailable, rawAgeHost, testAgeKeys } from './testing/backup-fixture.ts';
import { openFixtureApproval } from './testing/approval-card.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { writeEncryptedInstallationBackup, inspectEncryptedInstallationBackup, restoreEncryptedInstallationNew } from './installation-encrypted-backup.ts';
import { downgradeInstallationMemorySchema } from './installation-memory-downgrade.ts';
import { initializeApprovals, pendingEngineAnswers } from './decision/records.ts';
import { fenceRestoredSql } from './restore-fence.ts';

it('backup fixture omission is never a CI or release skip on a pinned host', () => {
  expect(optionalBackupAgeUnavailable({}, true)).toBe(true);
  expect(optionalBackupAgeUnavailable({CI:'1'}, true)).toBe(false);
  expect(optionalBackupAgeUnavailable({MURAGE_RELEASE_GATE:'1'}, true)).toBe(false);
  expect(optionalBackupAgeUnavailable({CI:'1'}, false)).toBe(true);
  expect(optionalBackupAgeUnavailable({MURAGE_BACKUP_TEST_AGE_DIR:'fixture'}, true)).toBe(false);
});

it.skipIf(!rawAgeHost)('encrypted backup keeps durable queue bytes, while restore activates no old queue', async () => {
  const f=backupFixture(), keys=testAgeKeys();
  try {
    const queue=JSON.stringify({version:1,entries:[{state:'waiting',item:{ref:'waiting-owner',call:{input:{text:'owner draft retained exactly'}}}}]});
    mkdirSync(join(f.data,'decision-queues')); writeFileSync(join(f.data,'decision-queues','memory.json'),queue);
    writeFileSync(join(f.data,'decision-gate.jsonl'),'diagnostic-only\n');
    const archive=join(f.parent,'backup.age');
    const result=await writeEncryptedInstallationBackup(f.data,archive,{...keys,selection:{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'}});
    const view=await inspectEncryptedInstallationBackup(archive,f.parent,keys);
    try {
      expect(readFileSync(join(view.stateDirectory,'raw','decision-queues','memory.json'),'utf8')).toBe(queue);
      expect(existsSync(join(view.stateDirectory,'raw','decision-gate.jsonl'))).toBe(false);
      expect(result.coverage.components).toContainEqual(expect.objectContaining({path:'decision-queues',status:'included'}));
      expect(result.coverage.components).toContainEqual(expect.objectContaining({path:'decision-gate.jsonl',status:'excluded'}));
    } finally {removeTempDirSync(view.directory);}
    const target=join(f.parent,'restored');
    await restoreEncryptedInstallationNew(target,archive,result.sha256,{ageExecutable:keys.ageExecutable,identity:keys.identity});
    expect(existsSync(join(target,'decision-queues'))).toBe(false);
    expect(readFileSync(join(f.data,'decision-queues','memory.json'),'utf8')).toBe(queue);
  } finally {f.db.close();removeTempDirSync(f.parent);}
}, 120_000);

it('the restore fence cancels actual open approval records before any recovery consumer can see them', () => {
  const f=backupFixture();
  try {
    const message=openFixtureApproval(f.db,'thread',{id:'pending',role:'bot',kind:'options',card:{requestId:'request',title:'Pending',options:['Allow','Deny']}});
    f.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES('thread','pending',2,'bot','options',?)").run(JSON.stringify(message));
    expect(f.db.prepare("SELECT state FROM approval_records").get()?.state).toBe('open');
    fenceRestoredSql(f.db,'restored');
    expect(f.db.prepare("SELECT state FROM approval_records").get()?.state).toBe('cancelled');
    expect(pendingEngineAnswers(f.db)).toEqual([]);
    expect(JSON.parse(String(f.db.prepare("SELECT json FROM messages WHERE id='pending'").get()?.json)).card).toMatchObject({answered:'Cancelled (restore)',dismissed:true,orphaned:true});
  } finally {f.db.close();removeTempDirSync(f.parent);}
});

it.each([10,13] as const)('downgrade target %s preserves queue data and local archives, removes new authority and resets legacy search', target => {
  const f=backupFixture(); let preserved:string|undefined;
  try {
    initializeApprovals(f.db);
    f.db.exec("CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY,done INTEGER NOT NULL,cursor INTEGER NOT NULL,skipped INTEGER NOT NULL); INSERT OR REPLACE INTO transcript_index_state VALUES('search_fts',1,99,0)");
    mkdirSync(join(f.data,'decision-queues'));writeFileSync(join(f.data,'decision-queues','memory.json'),'pending draft bytes');
    mkdirSync(join(f.data,'restore-archives'));writeFileSync(join(f.data,'restore-archives','saved.zip'),'local source archive bytes');
    f.db.close();
    const result=downgradeInstallationMemorySchema(f.data,target) as {applicationDataPreservedAt?:string};
    preserved=result.applicationDataPreservedAt;
    expect(preserved).toBeTypeOf('string');
    expect(readFileSync(join(preserved!,'decision-queues','memory.json'),'utf8')).toBe('pending draft bytes');
    expect(readFileSync(join(preserved!,'restore-archives','saved.zip'),'utf8')).toBe('local source archive bytes');
    expect(existsSync(join(f.data,'decision-queues'))).toBe(false);
    expect(existsSync(join(f.data,'restore-archives'))).toBe(false);
    const db=new DatabaseSync(join(f.data,'messages.db'),{readOnly:true});
    try {
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('approval_records','decision_continuations')").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='messages_fts'").get()?.name).toBe('messages_fts');
      expect(db.prepare("SELECT done,cursor,skipped FROM transcript_index_state WHERE name='search_fts'").get()).toEqual({done:0,cursor:0,skipped:0});
    } finally {db.close();}
  } finally {try{f.db.close();}catch{} if(preserved)removeTempDirSync(preserved);removeTempDirSync(f.parent);}
});

it('a restored answer awaiting engine delivery remains history and is never replayed', () => {
  const f=backupFixture();
  try {
    openFixtureApproval(f.db,'thread',{id:'answered',kind:'options',card:{requestId:'pending-delivery',title:'Answered',options:['Allow','Deny']}});
    f.db.exec("UPDATE approval_records SET state='answered',answer='{}',answer_id='answer',delivery='pending'");
    expect(pendingEngineAnswers(f.db)).toHaveLength(1);
    fenceRestoredSql(f.db,'restored');
    expect(pendingEngineAnswers(f.db)).toEqual([]);
    expect(f.db.prepare("SELECT state,delivery FROM approval_records").get()).toEqual({state:'answered',delivery:'unconfirmed'});
  } finally {f.db.close();removeTempDirSync(f.parent);}
});

it('downgrade refuses live continuation provenance before changing data or moving queue payloads', () => {
  const f=backupFixture();
  try {
    initializeApprovals(f.db);
    f.db.exec("INSERT INTO decision_continuations VALUES('live-continuation','{}')");
    mkdirSync(join(f.data,'decision-queues'));writeFileSync(join(f.data,'decision-queues','memory.json'),'waiting source bytes');
    f.db.close();
    const before=readFileSync(join(f.data,'messages.db'));
    expect(() => downgradeInstallationMemorySchema(f.data,13)).toThrowError(expect.objectContaining({code:'DOWNGRADE_WORK_PENDING'}));
    expect(readFileSync(join(f.data,'messages.db'))).toEqual(before);
    expect(readFileSync(join(f.data,'decision-queues','memory.json'),'utf8')).toBe('waiting source bytes');
  } finally {try{f.db.close();}catch{}removeTempDirSync(f.parent);}
});
