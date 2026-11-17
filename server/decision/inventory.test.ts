import {expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {inventory} from './inventory.ts';
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):e.name.endsWith('.ts')&&!e.name.endsWith('.test.ts')?[join(root,e.name)]:[]);}
const production=()=>files('server').filter(p=>!p.includes('/testing/'));
it('R2 M9 raw-writer and per-file producer inventory pins all existing sites',()=>{
 // This snapshot counts literal message kinds. Browser, host, image, peer and
 // publish producers now open through serviceQueue rather than writing cards
 // here; their record/authorization checks remain in the producer suites.
 // The restore writer moved intact into the shared core; its former wrapper is no longer allowed to write raw rows.
 // Keep the raw-writer allow-list and credential-card prohibition independent
 // of this count so a new bypass still fails.
 const snapshot=JSON.parse(readFileSync('server/decision/producer-inventory.json','utf8'));const counts:Record<string,unknown>={};
 // MAIN RULING INT-CONFLICT-DEFAULT d67df5e6dff / 5b51448693: inventory the reviewed own-writer and send-custody restore projections; reject other raw writers.
 const allowed=new Set(['server/send-attempt-compat.ts','server/own-write-holds.ts','server/decision/records.ts','server/message-db.ts','server/restore-prep-core.ts','server/memory/lineage-backfill.ts','server/installation-database-snapshot.ts','server/transcript-backfill.ts','server/memory/lineage-warm-surface.ts']);
 for(const file of production()){const report=inventory(readFileSync(file,'utf8'));if(Object.keys(report.kinds).length)counts[file]=report.kinds;if(report.rawWriter)expect(allowed.has(file),file).toBe(true);expect(report.credentialCard,file).toBe(false);}
 // MAIN RULING INT-CONFLICT-DEFAULT c33d9c2544 / ee7826ac02: typed literal inventory includes the reviewed card-list metadata; credential-card and raw-writer checks above stay unchanged.
 expect(counts).toEqual(snapshot);
});
it('L5 M68 credential card producer and fresh raw writer mutations are detected',()=>{
 expect(inventory(`store.appendMessage(t,{kind:'secret',card:factory()})`).credentialCard).toBe(true);
 expect(inventory(`db.prepare('INSERT INTO messages(thread_id,json) VALUES(?,?)')`).rawWriter).toBe(true);
 expect(inventory(`store.appendMessage(t,{kind:'options',card:factory()})`).kinds).toEqual({options:1});
 expect(inventory(`store.appendMessage(t,{kind:'options' as const,card:factory()})`).kinds).toEqual({options:1});
 expect(inventory(`store.appendMessage(t,{kind:('secret' as const),card:factory()})`).credentialCard).toBe(true);
 expect(inventory(`store.appendMessage(t,{kind:'connector' satisfies string,card:factory()})`).credentialCard).toBe(true);
});
it('replay authority adapter is restricted to tests and replay scripts',()=>{
 for(const file of production())expect(readFileSync(file,'utf8'),relative('.',file)).not.toMatch(/from\s*['"][^'"]*replay-source(?:\.ts)?['"]/);
});
