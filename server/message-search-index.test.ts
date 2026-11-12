// SPDX-License-Identifier: AGPL-3.0-or-later
// Search candidates can lag; the live-row LIKE, audience, order and scope remain
// authoritative. These tests use the real worker and an isolated test data dir.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach,afterEach,it } from "vitest";
import { expect } from "./testing/search-index-oracle.ts";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb,deleteThread,insertMessage,searchMessages,updateMessage } from "./message-db.ts";
import { intentCount,openSearchIndex,searchCleanupPending,searchIndexTestHooks,stopSearchIndex,trigramQuery,readMessageSearchCandidates,rebuildMessageSearchIndex } from "./testing/search-index-compat.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import * as messageDb from './message-db.ts';
const searchMessagesWithMeta = messageDb.searchMessagesWithMeta ?? ((...args:Parameters<typeof messageDb.searchMessages>)=>({hits:messageDb.searchMessages(...args),partial:false}));
import type { Message } from "./store.ts";
let clock=1000;
const msg=(id:string,text:string,extra:Partial<Message>={}):Message=>({id,role:"user",kind:"text",text,at:++clock,...extra});
const chip=(id:string,name:string):Message=>({id,role:"bot",kind:"activity",at:++clock,tool:{name,ok:true}} as Message);
const found=(q:string,n=40,scope?:string)=>searchMessages(q,n,scope,{owner:true}).map(h=>h.threadId+"/"+h.messageId);
async function idle(){database();const deadline=Date.now()+20000;while(searchCleanupPending(database())){if(Date.now()>deadline)throw Error("index not settled");await new Promise(r=>setTimeout(r,20));}}
function withIndex<T>(run:(db:DatabaseSync)=>T):T{const db=openSearchIndex(DATA_DIR);try{return run(db);}finally{db.close();}}
const indexed=()=>withIndex(db=>Number((db.prepare("SELECT 1 FROM sqlite_schema WHERE name='docs'").get()?db.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n:db.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get()!.n)));
const fts=(query:string)=>withIndex(db=>db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(trigramQuery(query)).length);
beforeEach(async()=>{closeMessageDb();await stopSearchIndex();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(async()=>{searchIndexTestHooks.halted=false;closeMessageDb();await stopSearchIndex();});
it("T-SEARCH: insert, patch, activity rename, kind change and replace converge while pending stays searchable",async()=>{
  insertMessage("t",msg("a","first alpacas"));insertMessage("t",chip("b","Bash: alembic upgrade"));
  expect(found("alpacas"), "ORACLE:T-SEARCH").toEqual(["t/a"]);await idle();expect(indexed(), "ORACLE:T-SEARCH").toBe(2);expect(fts("alpacas"), "ORACLE:T-SEARCH").toBe(1);
  updateMessage("t",msg("a","second llamas"));expect(found("alpacas"), "ORACLE:T-SEARCH").toEqual([]);expect(found("llamas"), "ORACLE:T-SEARCH").toEqual(["t/a"]);
  updateMessage("t",chip("b","Grep: needle"));expect(found("bash"), "ORACLE:T-SEARCH").toEqual([]);expect(found("grep"), "ORACLE:T-SEARCH").toEqual(["t/b"]);
  await idle();expect(fts("alpacas"), "ORACLE:T-SEARCH").toBe(0);expect(indexed(), "ORACLE:T-SEARCH").toBe(2);
  expect(intentCount(database()),"ORACLE:T-SEARCH" + " " + ("replacement has durable fixed references")).toBeGreaterThan(0);
  const before=Number(database().prepare("SELECT MAX(seq) AS n FROM search_intents").get()!.n);
  updateMessage("t",{...msg("a","second llamas"),attachments:[]});
  expect(Number(database().prepare("SELECT MAX(seq) AS n FROM search_intents").get()!.n), "ORACLE:T-SEARCH").toBe(before);
  updateMessage("t",{...msg("a","second llamas"),kind:"options"});await idle();expect(indexed(), "ORACLE:T-SEARCH").toBe(1);
  insertMessage("t",msg("a","third draft"));insertMessage("t",msg("a","fourth draft"));await idle();expect(indexed(), "ORACLE:T-SEARCH").toBe(2);expect(fts("third draft"), "ORACLE:T-SEARCH").toBe(0);expect(found("fourth draft"), "ORACLE:T-SEARCH").toEqual(["t/a"]);
});
it("T-EDIT-REPLACE / M34: replacement emits old and new rowid references in one owner commit",async()=>{
  insertMessage("t",msg("a","old marker"));insertMessage("t",msg("b","neighbour"));await idle();searchIndexTestHooks.halted=true;
  expect(intentCount(database()),"ORACLE:T-EDIT-REPLACE" + " " + ("replacement has durable fixed references")).toBeGreaterThan(0);
  const before=Number(database().prepare("SELECT MAX(seq) AS n FROM search_intents").get()!.n);
  const old=Number(database().prepare("SELECT rowid FROM messages WHERE id='a'").get()!.rowid);
  insertMessage("t",msg("a","new marker"));
  const fresh=Number(database().prepare("SELECT rowid FROM messages WHERE id='a'").get()!.rowid);
  expect(database().prepare("SELECT rowid FROM search_intents WHERE seq>? ORDER BY seq").all(before).map(r=>Number(r.rowid)), "ORACLE:T-EDIT-REPLACE").toEqual([old,fresh]);
  expect(found("old marker"), "ORACLE:T-EDIT-REPLACE").toEqual([]);expect(found("new marker"), "ORACLE:T-EDIT-REPLACE").toEqual(["t/a"]);
  searchIndexTestHooks.halted=false;await idle();expect(indexed(), "ORACLE:T-EDIT-REPLACE").toBe(2);expect(fts("old marker"), "ORACLE:T-EDIT-REPLACE").toBe(0);
});
it("T-SEARCH: a thread drop scrubs search postings separately from messages WAL",async()=>{
  insertMessage("a",msg("a","qzvxkjw secret"));insertMessage("b",msg("b","keepsake"));await idle();deleteThread("a");
  expect(found("qzvxkjw"), "ORACLE:T-SEARCH").toEqual([]);await idle();expect(indexed(), "ORACLE:T-SEARCH").toBe(1);expect(fts("qzvxkjw"), "ORACLE:T-SEARCH").toBe(0);
});
it("T-SEARCH: indexed and pending LIKE agree on Unicode, literal wildcards and FTS syntax",async()=>{
  const corpus=["Railway deploy RAILWAY up","50% done_ready","she said \"hello world\" twice","NEAR(a b) AND OR NOT *star* ^caret -dash","日本語のテキストを検索する","你好，世界。再见","हिन्दी में खोज","emoji 😀😀😀 party","Café crème brûlée ÉCOLE","col:umn t:filter {braces} (parens) 'single'","tab\tand\nnewline spaced   out","ab","x".repeat(300)+" tail needle"];
  corpus.forEach((text,i)=>insertMessage(i%2?"odd":"even",msg("m"+i,text)));
  const queries=["railway","RAILWAY UP","50%","_ready","done_","\"hello","hello world\"","near(a b)","and or","*star*","^caret","-dash","日本語","日本","本語の","テキストを検索","你好","你好，世界","世界。再","हिन्दी","😀😀😀","😀😀","é","café","CAFÉ","crème","École","brûlée","col:umn","t:filter","{braces}","(parens)","'single'","tab\tand","newline spaced","ab","a","tail needle","nomatchatall","x".repeat(40),"%","_","\\"];
  const expected=(q:string)=>database().prepare("SELECT thread_id,id FROM messages WHERE kind='text' AND text LIKE ? ESCAPE '\\' ORDER BY at DESC,rowid DESC").all("%"+q.trim().toLowerCase().replace(/([\\%_])/g,"\\$1")+"%").map(r=>r.thread_id+"/"+r.id);
  for(const q of queries)expect(found(q),"ORACLE:T-SEARCH" + " " + (q)).toEqual(expected(q));await idle();for(const q of queries)expect(found(q),"ORACLE:T-SEARCH" + " " + (q)).toEqual(expected(q));
});
it("T-SEARCH-SCOPED: limits count live visible hits, with total timestamp/rowid order",async()=>{
  for(let i=0;i<1200;i++)insertMessage(i%2?"x":"y",{...msg("m"+i,`dense common-word ${i===3?"ancient-needle":""}`),at:i<20?5:i});
  await idle();
  const scan=(q:string,n:number,t?:string)=>database().prepare(`SELECT thread_id,id FROM messages WHERE text LIKE ? ${t?"AND thread_id=?":""} ORDER BY at DESC,rowid DESC LIMIT ?`).all("%"+q+"%",...(t?[t]:[]),n).map(r=>r.thread_id+"/"+r.id);
  for(const[q,n,t]of [["common-word",5],["common-word",300],["ancient-needle",40],["common-word",40,"x"],["ancient-needle",40,"y"]] as const)expect(found(q,n,t), "ORACLE:T-SEARCH-SCOPED").toEqual(scan(q,n,t));
  expect(searchMessages("common-word",40,[]), "ORACLE:T-SEARCH-SCOPED").toEqual([]);
});
it("T-SEARCH-PARTIAL: unavailable index preserves bounded pending search and discloses partial",async()=>{
  insertMessage("t",msg("a","needle"));await stopSearchIndex();
  const result=searchMessagesWithMeta("needle",40,undefined,{owner:true});expect(result.hits.map(h=>h.messageId), "ORACLE:T-SEARCH-PARTIAL").toContain("a");expect(result.partial, "ORACLE:T-SEARCH-PARTIAL").toBe(true);
});
it("T-SEARCH-SCOPED: withheld and forgotten audience verification survives stale candidates",async()=>{
  insertMessage("t",msg("a","needle",{withheldFromBots:true}));insertMessage("t",msg("b","needle",{withheldFromBots:"forgotten"}));await idle();
  expect(found("needle"), "ORACLE:T-SEARCH-SCOPED").toEqual(["t/b","t/a"]);
  expect(searchMessagesWithMeta("needle",40,undefined,{owner:true,excludeForgotten:true}).hits.map(h=>h.messageId), "ORACLE:T-SEARCH-SCOPED").toEqual(["a"]);
  expect(searchMessages("needle"), "ORACLE:T-SEARCH-SCOPED").toEqual([]);
});
it("T-REBUILD: schema/VACUUM changes reset off-thread; restored history is never scanned on main",async()=>{
  for(let i=0;i<1300;i++)insertMessage("t",msg("r"+i,`restored row number ${i}`));await idle();
  database().exec("VACUUM");await idle();expect(found("number 1234"), "ORACLE:T-REBUILD").toEqual(["t/r1234"]);expect(indexed(), "ORACLE:T-REBUILD").toBe(1300);
  rebuildMessageSearchIndex(database());
  const snapshot=readMessageSearchCandidates(database(),trigramQuery("restored"),10);expect(snapshot.rowids.length, "ORACLE:T-REBUILD").toBeLessThanOrEqual(2010);
  await idle();expect(indexed(), "ORACLE:T-REBUILD").toBe(1300);
});
