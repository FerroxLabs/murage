// SPDX-License-Identifier: AGPL-3.0-or-later
// Only the isolated C1-C18 test parent launches this child. No configured data dir.
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { dirname,join } from "node:path";
import { initializeMessageTables } from "../message-tables.ts";
import { SEARCH_INDEX_WORKER_SOURCE, MESSAGE_SEARCH_DDL, syncMessageSearchRow, dropThreadSearchRows } from "./search-index-compat.ts";

const [file,mode]=process.argv.slice(2);
if (!file || !mode || !file.includes("murage-search-crash-")) throw Error("isolated crash fixture required");
const db=new DatabaseSync(file);db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;PRAGMA secure_delete=ON");initializeMessageTables(db);
const held=()=>{process.stdout.write("BARRIER\n");setInterval(()=>{},1000);};
if(mode.startsWith("owner-")) {
  db.exec("BEGIN IMMEDIATE");
  if(mode.includes("drop")) { dropThreadSearchRows(db,"t");db.exec("DELETE FROM messages"); }
  else { db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','new',1,'user','text','secret','{}')").run();syncMessageSearchRow(db,Number(db.prepare("SELECT last_insert_rowid() AS n").get()!.n),"secret"); }
  if(mode.endsWith("after"))db.exec("COMMIT");
  held();
} else if(mode==="retire-after-commit") {
  const api=await import("./search-index-compat.ts");api.settleInheritedSearchMerge(db,false);held();
} else {
  const shared=new SharedArrayBuffer(4),token="child";
  const worker=new Worker(SEARCH_INDEX_WORKER_SOURCE,{eval:true,workerData:{file,searchFile:join(dirname(file),"search.db"),ddl:MESSAGE_SEARCH_DDL,token,barrier:{name:mode,shared}}});
  worker.on("message",event=>{
    if(event.type==="reset-needed") { db.prepare("INSERT OR IGNORE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner','child',0,0)").run();const r=db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES(7,0)").run();worker.postMessage({type:"reset",token,marker:{seq:Number(r.lastInsertRowid),nonce:"7"}}); }
    if(event.type==="ready"||event.type==="stepped")worker.postMessage({type:"step",token});
    if(event.type==="barrier")held();
    if(event.type==="failure"){process.stderr.write(String(event.message));process.exitCode=2;void worker.terminate();}
  });
}
