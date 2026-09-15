import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root=process.argv[2], data=join(root,'data');
const files=JSON.parse(readFileSync(join(root,'evidence','source-files.json'),'utf8'));
assert.equal(Object.keys(files).length,6);
for(const [name,expected] of Object.entries(files)) {
  const file=join(data,name), stat=statSync(file,{bigint:true});
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),expected.sha256);
  assert.equal(String(stat.dev),expected.dev);assert.equal(String(stat.ino),expected.ino);
}
const db=new DatabaseSync(join(data,'messages.db'),{readOnly:true});
let tables;
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);
  for(const name of ['messages','thread_state','memory_meta','memory_tombstones'])assert(tables.includes(name));
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE id='receipt'").get().n,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE id='b20-tombstone' AND epoch=1").get().n,1);
  const meta=db.prepare('SELECT deletion_epoch, mode FROM memory_meta WHERE id=1').get();
  assert.equal(meta.deletion_epoch,1);assert.equal(meta.mode,'active');
} finally {db.close();}
writeFileSync(join(root,'evidence','seed-preflight.json'),JSON.stringify({ok:true,files:Object.keys(files),tables,transcriptReceipts:1,tombstones:1,deletionEpoch:1,databaseClosed:true})+'\n',{flag:'wx'});
