// SPDX-License-Identifier: AGPL-3.0-or-later
// Rebuild throughput is off-thread. Main never materializes the history or runs
// FTS, including for large pasted rows and long spans of unsearchable messages.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach,afterEach,expect,it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase,database } from "./database.ts";
import { searchCleanupPending,stopSearchIndex,rebuildMessageSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
beforeEach(async()=>{closeDatabase();await stopSearchIndex();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(async()=>{closeDatabase();await stopSearchIndex();});
async function complete(){const until=Date.now()+120000;while(searchCleanupPending(database())){if(Date.now()>until)throw Error("worker fill timeout");await new Promise(r=>setTimeout(r,25));}}
for(const long of [false,true])it(`T-REBUILD: ${long?"400 pasted documents":"200k mixed rows"} are indexed entirely off the owner thread`,{tags:["perf-budget"],timeout:150000},async()=>{
  const db=database();
  if(long)db.exec(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<400) INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) SELECT i,'big','m'||i,i,'user','text','doc '||i||' '||lower(hex(randomblob(100000))),'{}' FROM n`);
  else db.exec(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200000) INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) SELECT i,'big','m'||i,i,'user',CASE WHEN i BETWEEN 100001 AND 110000 THEN 'screen' WHEN i%7=0 THEN 'activity' ELSE 'text' END,CASE WHEN i%7=0 THEN NULL ELSE 'searchable line '||i END,CASE WHEN i%7=0 THEN '{"tool":{"name":"Ran step '||i||'"}}' ELSE '{}' END FROM n`);
  rebuildMessageSearchIndex(db);await complete();
  const a=new DatabaseSync(join(DATA_DIR,"search.db"),{readOnly:true});
  try{expect(Number(a.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n)).toBe(long?400:190000);expect(a.prepare("SELECT 1 FROM search_state WHERE k='built'").get()).toBeUndefined();if(!long)expect(a.prepare("SELECT 1 FROM docs WHERE rowid BETWEEN 100001 AND 110000").get()).toBeUndefined();}finally{a.close();}
});
