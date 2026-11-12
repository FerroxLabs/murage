// Qualification fixture: git archive 6e4dda8afd | tar -x -C .v118-ref
// The reference tree is immutable release source, never a live installation.
import {expect,it} from 'vitest';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DATA_DIR} from '../config.ts';
import {closeDatabase} from '../database.ts';
import {settleTestHandles} from '../test-handle-registry.ts';
import {downgradeInstallationMemorySchema} from '../installation-memory-downgrade.ts';
import {fixture} from './fixture.ts';
const have118=existsSync(join(process.cwd(),'.v118-ref/server/installation-database-snapshot.ts'));
it.skipIf(!have118)('D1 frozen 1.0.18 open/write/answer and backup succeed after real --to 13 rollback',async()=>{
 const f=fixture(); f.store.createBot();closeDatabase();await settleTestHandles(DATA_DIR);
 downgradeInstallationMemorySchema(DATA_DIR,13);
 const prefix='../../.v118-ref/server/';
 const oldDatabase=await import(/* @vite-ignore */ prefix+'database.ts');
 const messages=await import(/* @vite-ignore */ prefix+'message-db.ts');
 const snapshot=await import(/* @vite-ignore */ prefix+'installation-database-snapshot.ts');
 const wal=await import(/* @vite-ignore */ prefix+'wal-maintenance.ts');
 const legacy={id:'frozen118',at:1,role:'bot',kind:'options',card:{requestId:'approval118',title:'Allow?',subtitle:'Fixture',options:['Allow','Deny']}};
 try {
  messages.appendMessage('t',legacy);
  messages.updateMessage('t',{...legacy,card:{...legacy.card,answered:'Allow'}});
  expect(messages.readMessage('t',legacy.id).card.answered).toBe('Allow');
  try{snapshot.inspectInstallationDatabase(oldDatabase.database());}catch(error){
   const source=readFileSync(join(process.cwd(),'.v118-ref/server/installation-database-snapshot.ts'),'utf8').replace('function referenceSchema()', 'export function referenceSchema()');
   writeFileSync(join(process.cwd(),'.v118-ref/server/installation-database-snapshot.export.ts'),source);
   const diagnostic=await import(/* @vite-ignore */ prefix+'installation-database-snapshot.export.ts');
   const known=diagnostic.referenceSchema(),db=oldDatabase.database();
   const memory=await import(/* @vite-ignore */ prefix+'memory/schema.ts');let memoryNames=new Set<string>(),memoryError='';try{memoryNames=memory.validateMemorySchema(db);}catch(e){memoryError=String(e);}
   const normalized=(sql:unknown)=>sql==null?null:String(sql).replace(/\s+/g,' ').replace(/ ?([(),]) ?/g,'$1').trim();
   const objects=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
   throw new Error(JSON.stringify({code:(error as any).code,message:(error as Error).message,memoryError,extra:objects.filter((row:any)=>!known.has(row.name)&&!memoryNames.has(row.name)).map((row:any)=>row.name),different:objects.filter((row:any)=>known.has(row.name)&&!known.get(row.name).sql.has(normalized(row.sql))).map((row:any)=>row.name)}),{cause:error});
  }
 } finally {oldDatabase.closeDatabase();await wal.stopWalMaintenance();}
 expect(await snapshot.snapshotInstallationDatabase(DATA_DIR,join(dirname(DATA_DIR),'backup118.db'))).toMatchObject({status:'copied'});
},120000);
