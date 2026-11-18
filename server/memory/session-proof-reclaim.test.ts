// Owners: recall-s1s2g owns the session-proof objects; root-set-reclaim.ts owns the hand-back that drops memory_session_roots.
import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {stopWalMaintenance} from '../wal-maintenance.ts';
import {ROOT_SET_RECLAIM_TABLES} from './root-set-reclaim.ts';
import {beforeEach,afterEach,expect,it} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {closeDatabase,database} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {stopRecallViewMaintenance} from './recall-view.ts';
import {validateMemorySchema,migrateMemorySchema} from './schema.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
const has=(db:ReturnType<typeof database>,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name);
// as root-set-reclaim.ts does it: every batch marks root_sets_dropped in its own transaction, then the table goes
const handBack=(db:ReturnType<typeof database>)=>{db.exec("UPDATE memory_lineage_lsn_meta SET value=1 WHERE key='root_sets_dropped';DROP INDEX IF EXISTS memory_session_roots_set;DROP TABLE memory_session_roots");};
it('a file whose root sets were handed back (memory_session_roots and its two triggers gone) validates and reopens',()=>{
  const db=database();
  expect(has(db,'memory_session_proof_root_insert')).toBe(true);
  handBack(db);
  expect(has(db,'memory_session_proof_root_insert')).toBe(false);
  expect(has(db,'memory_session_proof_root_update')).toBe(false);
  expect(()=>validateMemorySchema(db)).not.toThrow();
  expect(()=>migrateMemorySchema(db,'active')).not.toThrow();
  expect(has(db,'memory_session_proof_root_insert')).toBe(false);
});
it('the hand-back excuses only the two root triggers: another missing proof trigger still refuses the file',()=>{
  const db=database();
  handBack(db);
  db.exec('DROP TRIGGER memory_session_proof_receipt_line_insert');
  expect(()=>validateMemorySchema(db)).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/);
});
it('a roots table missing without the hand-back mark refuses the file (mutant: excuse any rootless file)',()=>{
  const db=database();
  expect(Number(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()?.value)).toBe(0);
  db.exec('DROP INDEX IF EXISTS memory_session_roots_set;DROP TABLE memory_session_roots');
  expect(()=>validateMemorySchema(db)).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/);
});
it('with the roots table still present a missing root trigger refuses the file',()=>{
  const db=database();
  db.exec('DROP TRIGGER memory_session_proof_root_insert');
  expect(()=>validateMemorySchema(db)).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/);
});

it.each(['drop','commit'] as const)('W-DROP-MARK: a crash after %s preserves an atomic root-table/marker pair and the real database boot succeeds', async boundary=>{
  const db=database();
  // Reach the DROP itself with no earlier clear batch supplying the mark.
  for(const table of ROOT_SET_RECLAIM_TABLES) if(table!=='memory_session_roots') db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec("UPDATE memory_lineage_lsn_meta SET value=0 WHERE key='root_sets_dropped'");
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_session_roots").get()!.n)).toBe(0);
  closeDatabase(); await stopWalMaintenance();
  const file=join(DATA_DIR,'messages.db');
  const reclaim=new URL('./root-set-reclaim.ts',import.meta.url).href;
  const script=`
    import {DatabaseSync} from 'node:sqlite';
    import {runReclaimStep} from ${JSON.stringify(reclaim)};
    const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
    const exec=db.exec.bind(db); let dropped=false;
    db.exec=sql=>{
      const result=exec(sql);
      if(sql==='DROP TABLE IF EXISTS memory_session_roots'){
        dropped=true;
        if(process.argv[2]==='drop') process.kill(process.pid,'SIGKILL');
      }
      if(dropped&&sql==='COMMIT'&&process.argv[2]==='commit') process.kill(process.pid,'SIGKILL');
      return result;
    };
    runReclaimStep(db);
    throw new Error('crash boundary not reached');
  `;
  const killed=spawnSync(process.execPath,['--experimental-transform-types','--input-type=module','-e',script,file,boundary],{encoding:'utf8'});
  expect(killed.signal,killed.stderr).toBe('SIGKILL');
  const reopened=new DatabaseSync(file);
  let roots:boolean,mark:number;
  try{roots=has(reopened,'memory_session_roots');mark=Number(reopened.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()!.value);}
  finally{reopened.close();}
  const boot=spawnSync(process.execPath,['--experimental-transform-types',fileURLToPath(new URL('./session-proof-boot.fixture.mjs',import.meta.url))],
    {encoding:'utf8',env:{...process.env,MURAGE_DATA_DIR:DATA_DIR}});
  console.log('DROP_MARK_BOOT',JSON.stringify({boundary,roots,mark,status:boot.status,unsupported:boot.stderr.includes('MEMORY_SCHEMA_UNSUPPORTED')}));
  expect(boot.status,boot.stderr).toBe(0);
  expect(roots!).toBe(boundary==='drop');
  expect(mark!).toBe(boundary==='drop'?0:1);
});
