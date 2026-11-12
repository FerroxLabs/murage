// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, searchMessagesWithMeta } from "./message-db.ts";
import { parseGroupedContinuation, encodeGroupedContinuation, parseSearchBefore, searchChatThreads } from "./chat-search.ts";
import { rebuildSearchFixture, pendingSearchFixture } from "./testing/message-search-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const scope = (ids: string[]) => ids.map((threadId, i) => ({ threadId, title: threadId, createdAt: 59 - i }));
const gen = { epoch: "fixture", rev: 0 };
const resume = (token: string | null) => parseGroupedContinuation(token, "austin", {})!;
beforeEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMessageDb(); });
function put(thread: string, id: string, at: number, forgotten = false) {
  insertMessage(thread, { id, at, role: "user", kind: "text", text: `austin lease ${id}`, ...(forgotten ? { withheldFromBots: "forgotten" as const } : {}) });
}
it("groups before limiting, counts hits, excludes forgotten text and pages tied threads once", async () => {
  for (let i = 0; i < 60; i++) put("a", `a${i}`, i);
  put("b", "b1", 59); put("c", "c1", 58); put("outside", "out", 100);
  put("a", "forgotten", 200, true);
  const first = searchChatThreads("austin", 1, scope(["a", "b", "c"]));
  expect(first.hits).toMatchObject([{ threadId: "a", messageId: "a59", hits: 60 }]);
  expect(first.next).toBe(encodeGroupedContinuation({ v: 1, after: { threadId: "a", createdAt: 59 }, pending: null, gen, query: "austin", filters: "[]" }));
  const second = searchChatThreads("austin", 1, scope(["a", "b", "c"]), resume(first.next));
  expect(second.hits).toMatchObject([{ threadId: "b", hits: 1 }]);
  const third = searchChatThreads("austin", 1, scope(["a", "b", "c"]), resume(second.next));
  expect(third.hits.map(hit => hit.threadId)).toEqual(["c"]);
  expect(third.next).toBeNull();
  expect(third.partial).toBe(false);
  expect(searchChatThreads("austin", 40, []).hits).toEqual([]);
});
it("honours numeric before and accepts only finite cursor positions", async () => {
  put("a", "old", 10); put("a", "equal", 20); put("b", "new", 30);
  expect(searchMessagesWithMeta("austin", 40, ["a", "b"], { owner: true }, 20).hits).toMatchObject([{ messageId: "old" }]);
  expect(searchMessagesWithMeta("austin", 40, ["a", "b"], { owner: true }, 20).hits).toHaveLength(1);
  for (const bad of ["", "NaN", "Infinity", "-1", "2:", "2:a:more"]) expect(parseSearchBefore(bad)).toBeNull();
  expect(parseSearchBefore(null)).toBeUndefined();
});

it("keeps the partial flag when counts come from a bounded candidate window", async () => {
  const db = database();
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<2100)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'a','m'||v,v,'user','text','austin lease','{}' FROM n`).run();
  await rebuildSearchFixture(db);
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<4001)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'b','b'||v,v,'user','text','no matching word','{}' FROM n`).run();
  const page = searchChatThreads("austin", 40, scope(["a", "b"]));
  expect(page.hits).toHaveLength(1);
  expect(page.hits[0]!.hits).toBeLessThan(2100);
  expect(page.partial).toBe(true);
});
it("message paging keeps equal-time lines on both indexed and pending-reference paths", async () => {
  for (let i = 0; i < 9; i++) put("a", `m${i}`, 10);
  for (const indexed of [true, false]) {
    if (indexed) await rebuildSearchFixture(database());
    else await pendingSearchFixture();
    const seen: string[] = [];
    let cursor: { at: number; threadId?: string } | undefined;
    for (let page = 0; page < 4; page++) {
      const result = searchMessagesWithMeta("austin", 3, ["a"], { owner: true, excludeForgotten: true }, cursor?.at, cursor?.threadId ? Number(cursor.threadId) : undefined);
      seen.push(...result.hits.map(hit => hit.messageId));
      if (!result.partial) break;
      if (!result.hits.length) { expect(indexed).toBe(false); expect(result.partial).toBe(true); break; }
      cursor = parseSearchBefore(result.hits.at(-1)!.cursor!)!;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  }
});

it("P6 lists the 41st chat on the next complete page", async () => {
  const ids = Array.from({ length: 41 }, (_, i) => `t${i}`);
  for (const id of ids) put(id, id, 1);
  const first = searchChatThreads("austin", 40, scope(ids));
  expect(first.hits).toHaveLength(40); expect(first.partial).toBe(false);
  const last = searchChatThreads("austin", 40, scope(ids), resume(first.next));
  expect(last.hits.map(hit => hit.threadId)).toEqual([ids[40]]);
  expect(last.next).toBeNull(); expect(last.partial).toBe(false);
});

it("T-GROUP-RESUME advances past 4,000 nonmatching rows without skipping or repeating the chat", async () => {
  put("a", "old-match", 0); put("b", "next-match", 0);
  const db = database();
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<8001)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'a','n'||v,1,'user','text','no match','{}' FROM n`).run();
  // Force the normal fallback window to be incomplete.
  db.exec("DROP TABLE IF EXISTS messages_fts");
  const first = searchChatThreads("austin", 40, scope(["a", "b"]));
  expect(first.hits).toEqual([]); expect(first.partial).toBe(true);
  const p1 = resume(first.next); expect(p1.pending?.thread.threadId).toBe("a");
  const second = searchChatThreads("austin", 40, scope(["a", "b"]), p1);
  const p2 = resume(second.next);
  expect(p2.pending!.beforeRowid).toBeLessThan(p1.pending!.beforeRowid);
  const last = searchChatThreads("austin", 40, scope(["a", "b"]), p2);
  expect(last.hits.map(hit => hit.messageId)).toEqual(["old-match", "next-match"]);
  expect(last.next).toBeNull(); expect(last.partial).toBe(false);
  // A deleted pending chat is consumed at its saved chat key.
  const deleted = searchChatThreads("austin", 40, scope(["a", "b"]).slice(1), p1);
  expect(deleted.hits.map(hit => hit.threadId)).toEqual(["b"]);
});

it("T-GROUP-NEWEST walks represented chats when the candidate window is incomplete", async () => {
  put("a", "newest-low-rowid", 99999);
  const db = database();
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<2100)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'a','m'||v,v,'user','text','austin old import','{}' FROM n`).run();
  await rebuildSearchFixture(db);
  const page = searchChatThreads("austin", 40, scope(["a", "b", "c", "d", "e", "f", "g", "h", "i"]));
  expect(page.hits[0]).toMatchObject({ messageId: "newest-low-rowid", countComplete: false });
  expect(page.partial).toBe(false);
});

import { groupedSearchWork, GROUPED_WALK_ROWS } from "./message-db.ts";
it("P6 budget: 300 chats of 4,000 rows advance to the oldest match within every request budget", async () => {
  const db = database();
  db.exec("DROP TABLE IF EXISTS messages_fts");
  db.exec(`WITH RECURSIVE t(v) AS (VALUES(0) UNION ALL SELECT v+1 FROM t WHERE v<299), n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<4000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't'||t.v,'m'||n.v,n.v,'user','text','no match','{}' FROM t CROSS JOIN n`);
  put("last", "oldest-match", 0);
  const ordered = scope([...Array.from({length:300},(_,i)=>`t${i}`),"last"]);
  const seen: string[] = []; let from;
  for(let page=0;page<65;page++) {
    groupedSearchWork.rows=0;
    const result=searchChatThreads("austin",40,ordered,from);
    expect(groupedSearchWork.rows).toBeLessThanOrEqual(GROUPED_WALK_ROWS);
    seen.push(...result.hits.map(hit=>hit.messageId));
    if (!result.next) { expect(result.partial).toBe(false); break; }
    expect(result.partial).toBe(true); from=resume(result.next);
  }
  expect(seen).toEqual(["oldest-match"]);
},120_000);

it("grouped tokens reject bad versions, unsafe message pairs, and changed query or filters", async () => {
  const valid = { v:1 as const, after:null, pending:{thread:{threadId:"t",createdAt:1},beforeAt:1,beforeRowid:1},gen,query:"austin",filters:"[]" };
  expect(parseGroupedContinuation(encodeGroupedContinuation(valid),"austin",{})).toEqual(valid);
  for (const bad of [{...valid,v:2},{...valid,pending:{...valid.pending,beforeRowid:0}},{...valid,pending:{...valid.pending,beforeAt:Infinity}}]) expect(parseGroupedContinuation(encodeGroupedContinuation(bad as typeof valid),"austin",{})).toBeNull();
  expect(parseGroupedContinuation(encodeGroupedContinuation(valid),"other",{})).toBeNull();
  expect(parseGroupedContinuation(encodeGroupedContinuation(valid),"austin",{archived:true})).toBeNull();
  expect(parseSearchBefore(encodeGroupedContinuation(valid))).toBeNull();
});

it("T-GROUP-RESUME keeps the saved chat key when pending activity moves above the cursor",()=>{
  put("a","old-match",0);put("b","later-match",0);
  const db=database(); db.exec("DROP TABLE IF EXISTS messages_fts");
  db.exec(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<8001)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'a','cut'||v,1,'user','text','no match','{}' FROM n`);
  const original=scope(["a","b"]), first=searchChatThreads("austin",1,original), token=resume(first.next);
  const moved=[{...original[0],createdAt:1000},original[1]];
  const second=searchChatThreads("austin",1,moved,token), next=resume(second.next);
  expect(next.pending!.thread).toEqual(token.pending!.thread);
  expect(next.pending!.beforeRowid).toBeLessThan(token.pending!.beforeRowid);
  const third=searchChatThreads("austin",1,moved,next), complete=resume(third.next);
  expect(third.hits.map(hit=>hit.messageId)).toEqual(["old-match"]);
  expect(complete.after).toEqual(token.pending!.thread);
  const last=searchChatThreads("austin",1,moved,complete);
  expect(last.hits.map(hit=>hit.messageId)).toEqual(["later-match"]);expect(last.next).toBeNull();
});

it("P6 unavailable index reaches all twenty oldest matching chats in a sixty-chat scope",()=>{
  const ids=Array.from({length:60},(_,i)=>`oldest-${i}`);
  for(let i=0;i<ids.length;i++)insertMessage(ids[i],{id:"m",at:1,role:"user",kind:"text",text:i>=40?"austin visible":"no match"});
  database().exec("DROP TABLE IF EXISTS messages_fts");
  let from;const seen:string[]=[];
  for(let page=0;page<65;page++){
    groupedSearchWork.rows=0;const result=searchChatThreads("austin",7,scope(ids),from);
    expect(groupedSearchWork.rows).toBeLessThanOrEqual(GROUPED_WALK_ROWS);seen.push(...result.hits.map(hit=>hit.threadId));
    if(!result.next){expect(result.partial).toBe(false);break;}from=resume(result.next);
  }
  expect(seen).toEqual(ids.slice(40));expect(new Set(seen).size).toBe(20);
});
it("T-GROUP-NEWEST ignores a forgotten newest timestamp outside the capped candidate window",async()=>{
  put("a","forgotten-newest",99999,true);put("a","visible-newest",99998);
  const db=database();db.exec(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<2100)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'a','old'||v,v,'user','text','austin old import','{}' FROM n`);
  await rebuildSearchFixture(db);groupedSearchWork.rows=0;
  const result=searchChatThreads("austin",40,scope(["a","b","c","d","e","f","g","h","i"]));
  expect(result.hits.map(hit=>hit.messageId)).toEqual(["visible-newest"]);
  expect(groupedSearchWork.rows).toBeGreaterThan(0);expect(groupedSearchWork.rows).toBeLessThanOrEqual(GROUPED_WALK_ROWS);
});

it.each([4,6000])("RULE rendered predicate covers grouped counts and bounded continuation, %s hidden rows",async count=>{
  put('a','visible',1);
  database().prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'a','hidden-'||v,v+2,'user','text','austin hidden','{}' FROM n`).run(count);
  await rebuildSearchFixture(database());
  const rendered=(_thread:string,message:import('./store.ts').Message)=>message.id==='visible';
  let page=searchChatThreads('austin',1,scope(['a']),undefined,gen,{},rendered);
  const hits=[...page.hits];let attempts=0;
  while(page.next) {
    expect(++attempts).toBeLessThan(5);
    page=searchChatThreads('austin',1,scope(['a']),resume(page.next),gen,{},rendered);
    hits.push(...page.hits);
  }
  expect(hits.map(h=>h.messageId)).toEqual(['visible']);
  expect(hits[0].hits).toBe(1);
});

it("C2 rig 1/2: rendered search receives checked rows with the stored sequence", async () => {
  put("a", "checked", 1);
  database().prepare("UPDATE messages SET seq=7,json=json_set(json,'$.seq',999,'$.tool.doneWhen',?) WHERE thread_id='a' AND id='checked'").run("x".repeat(10_000));
  await rebuildSearchFixture(database());
  const seen: import("./store.ts").Message[] = [];
  const result = searchChatThreads("austin", 40, scope(["a"]), undefined, gen, {}, (_thread, message) => { seen.push(message); return true; });
  expect(result.hits.map(hit => hit.messageId)).toEqual(["checked"]);
  expect(seen.length).toBeGreaterThan(0);
  for (const message of seen) { expect(message.seq).toBe(7); expect(message.tool?.doneWhen).toBeUndefined(); }
});
