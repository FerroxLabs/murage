// SPDX-License-Identifier: AGPL-3.0-or-later
import { MESSAGE_SEARCH_DDL } from './testing/search-index-compat.ts';
// Legacy automerge/deletemerge settings and debt are retired, never paid on main.
import { removeTempDirSync } from "./testing/cleanup.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { expect } from "./testing/search-index-oracle.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { settleInheritedSearchMerge } from "./testing/search-index-compat.ts";
for(const done of [undefined,0,1])for(const firstOpen of [false,true])it(`T-RETIRE / T-RETIRE-BOUND / T-RETIRE-REOPEN / C12: inherited debt ${done}, firstOpen ${firstOpen}, is retired without reading segments`,()=>{
  const dir=mkdtempSync(join(tmpdir(),"murage-fts-inherited-")),db=new DatabaseSync(join(dir,"messages.db"));
  try {
    initializeMessageTables(db);db.exec(MESSAGE_SEARCH_DDL);db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('automerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('deletemerge',0);INSERT INTO messages_fts(rowid,t) VALUES(1,'qzvxkjw')");
    if(done!==undefined)db.prepare("INSERT INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_merge',?,0,0)").run(done);
    const configBefore=db.prepare("SELECT * FROM messages_fts_config ORDER BY k").all();
    const before=db.prepare("SELECT id,block FROM messages_fts_data ORDER BY id").all();const sql:string[]=[];
    const exec=db.exec.bind(db),prepare=db.prepare.bind(db);db.exec=s=>{sql.push(s);return exec(s);};db.prepare=s=>{sql.push(s);return prepare(s);};
    settleInheritedSearchMerge(db,firstOpen);
    expect(sql, "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").not.toContainEqual(expect.stringMatching(/optimize|checkpoint|INSERT INTO messages_fts|DELETE FROM messages_fts|FROM messages_fts_data|messages_fts_config/));
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").toBeUndefined();
    expect(db.prepare("SELECT id,block FROM messages_fts_retired_data ORDER BY id").all(), "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").toEqual(before);
    expect(db.prepare("SELECT * FROM messages_fts_retired_config ORDER BY k").all(), "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").toEqual(configBefore);
    expect(db.prepare("SELECT 1 FROM transcript_index_state WHERE name='search_merge'").get(), "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").toBeUndefined();
    expect(db.prepare("SELECT done,cursor FROM transcript_index_state WHERE name='search_fts'").get(), "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").toMatchObject({done:0,cursor:0});
    const owner=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done;
    settleInheritedSearchMerge(db,firstOpen);expect(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done, "ORACLE:T-RETIRE ORACLE:T-RETIRE-BOUND ORACLE:T-RETIRE-REOPEN ORACLE:C12").toBe(owner);
  }finally{db.close();removeTempDirSync(dir);}
});
