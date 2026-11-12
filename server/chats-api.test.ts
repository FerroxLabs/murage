import { syncMessageSearchRow } from "./message-search-index.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// All chats, slice 1, end to end against the real harness: GET /api/chats pages the owner's chats from the records, and
// GET /api/search?view=chats never returns a line the owner forgot, while the owner's plain search is answered as before.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, desktopApi, phoneApi, home } from "./testing/index-harness.ts";
import { syncThreadSummary } from "./thread-summary.ts";

const writeDb = () => {
  const db = new DatabaseSync(join(home, ".murage", "messages.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
};

describe("GET /api/chats", () => {
  it("lists the owner's chats newest first with paging and filters, archived ones only under their filter", async () => {
    const ember = (await desktopApi("POST", "/api/bots")).body.bot;
    const sage = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const extra = await desktopApi("POST", `/api/bots/${ember.id}/tasks`, { title: "Austin lease renewal" });
      expect(extra.status).toBe(201);
      const all = await desktopApi("GET", "/api/chats?limit=200");
      expect(all.status).toBe(200);
      const threads = [...all.body.chats, ...(all.body.pinned ?? [])].map((row: { threadId: string }) => row.threadId);
      expect(threads).toEqual(expect.arrayContaining([ember.threadId, sage.threadId, extra.body.task.threadId]));
      // no transcript on the wire: titles, times and marks only
      for (const row of all.body.chats) expect(Object.keys(row).every((key) => ["threadId", "title", "createdAt", "lastActivityAt", "botId", "groupId", "place", "pinned", "unread", "archived", "routine", "snippet", "lastRole", "lastFrom"].includes(key))).toBe(true);

      const mine = await desktopApi("GET", `/api/chats?bot=${ember.id}`);
      expect(mine.body.chats.every((row: { botId?: string }) => row.botId === ember.id)).toBe(true);
      expect(mine.body.total).toBe(2);
      const phone = await phoneApi("GET", `/api/chats?bot=${ember.id}`);
      expect(phone.status).toBe(200);
      expect(phone.body.total).toBe(2);
      const titled = await desktopApi("GET", `/api/chats?bot=${ember.id}&q=lease`);
      expect(titled.body.chats.map((row: { title: string }) => row.title)).toEqual(["Austin lease renewal"]);

      const first = await desktopApi("GET", `/api/chats?bot=${ember.id}&limit=1`);
      expect(first.body.chats).toHaveLength(1);
      expect(first.body.next).toEqual(expect.any(String));
      const second = await desktopApi("GET", `/api/chats?bot=${ember.id}&limit=1&before=${encodeURIComponent(first.body.next)}`);
      expect(second.body.chats).toHaveLength(1);
      expect(second.body.chats[0].threadId).not.toBe(first.body.chats[0].threadId);
      expect((await desktopApi("GET", "/api/chats?before=nope")).status).toBe(400);
      expect((await desktopApi("GET", "/api/chats?limit=0")).status).toBe(400);

      expect((await desktopApi("PATCH", `/api/bots/${sage.id}`, { hidden: true })).status).toBe(200);
      const after = await desktopApi("GET", "/api/chats?limit=200");
      expect([...after.body.chats, ...(after.body.pinned ?? [])].some((row: { threadId: string }) => row.threadId === sage.threadId)).toBe(false);
      const archived = await desktopApi("GET", "/api/chats?archived=1&limit=200");
      expect(archived.body.chats.find((row: { threadId: string }) => row.threadId === sage.threadId)).toMatchObject({ archived: true, botId: sage.id });
      expect((await phoneApi("GET", "/api/chats?archived=1")).body.chats).toEqual([]);
    } finally {
      await desktopApi("DELETE", `/api/bots/${ember.id}`);
      await desktopApi("DELETE", `/api/bots/${sage.id}`);
    }
  });

  it("is not answered to a door, which gets the unknown-route answer rather than a list", async () => {
    const door = await api("GET", "/api/chats");
    expect(door.status).toBe(404);
    expect(door.body.chats).toBeUndefined();
  });
});

describe("GET /api/search?view=chats", () => {
  it("scopes all of an owner's threads, groups with counts, pages and refuses doors before looking up scope", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const other = (await desktopApi("POST", "/api/bots")).body.bot;
    const extra = (await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { title: "Older lease" })).body.task;
    const group = (await desktopApi("POST", "/api/groups", { name: "Lease room", memberIds: [bot.id] })).body.group;
    try {
      // This handle belongs to index-harness's isolated home, never an app.
      const db = writeDb();
      try {
        db.exec("BEGIN IMMEDIATE");
        const seed = (thread: string, id: string, at: number, forgotten = false) => {
          const text = `slice2-lease ${id}`;
          const message = { id, at, role: "user", kind: "text", text, ...(forgotten ? { withheldFromBots: "forgotten" } : {}) };
          const result = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'user','text',?,?)").run(thread, id, at, text, JSON.stringify(message));
          syncMessageSearchRow(db, Number(result.lastInsertRowid), text);
          db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(thread, id);
          syncThreadSummary(db, thread);
        };
        seed(bot.threadId, "s2-old", 100);
        seed(bot.threadId, "s2-best", 200);
        seed(bot.threadId, "s2-forgotten", 300, true);
        seed(extra.threadId, "s2-extra", 150);
        seed(other.threadId, "s2-outside", 400);
        seed(group.threadId, "s2-group", 500);
        db.exec("COMMIT");
      } finally { db.close(); }
      await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { pinned: true });
      const path = `/api/search?q=slice2-lease&bot=${bot.id}&group_by=thread&limit=1`;
      const first = await desktopApi("GET", path);
      expect(first.status).toBe(200);
      expect(first.body.hits).toMatchObject([{ threadId: bot.threadId, messageId: "s2-best", hits: 2 }]);
      const second = await desktopApi("GET", `${path}&before=${encodeURIComponent(first.body.next)}`);
      expect(second.body.hits).toMatchObject([{ threadId: extra.threadId, hits: 1 }]);
      expect(second.body.next).toBeNull();
      const room = await desktopApi("GET", `/api/search?q=slice2-lease&group=${group.id}&group_by=thread`);
      expect(room.body.hits.map((hit: { threadId: string }) => hit.threadId)).toEqual([group.threadId]);
      const before = await desktopApi("GET", `/api/search?q=slice2-lease&bot=${bot.id}&before=150`);
      expect(before.body.hits.map((hit: { messageId: string }) => hit.messageId)).toEqual(["s2-old"]);
      expect((await desktopApi("GET", `${path}&before=nonsense`)).status).toBe(400);
      const phone = await phoneApi("GET", path);
      expect(phone.body.hits).toMatchObject([{ messageId: "s2-best", hits: 2 }]);
      for (const suffix of [`bot=${bot.id}`, "bot=missing", `group=${group.id}`, "group_by=thread", `view=chats&threadId=${bot.threadId}`])
        expect(await api("GET", `/api/search?q=slice2-lease&${suffix}`)).toEqual({ status: 404, body: { error: "no such route" } });
      await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { pinned: false });
      const previews = await desktopApi("GET", `/api/chats?bot=${bot.id}`);
      expect(previews.body.chats.find((row: { threadId: string }) => row.threadId === bot.threadId)).toMatchObject({ snippet: "slice2-lease s2-best", lastRole: "user" });
      expect(JSON.stringify(previews.body)).not.toContain("s2-forgotten");
      expect((await desktopApi("GET", `/api/chats?bot=${bot.id}&date_from=${Date.now() + 86400000}`)).body.chats).toEqual([]);
    } finally {
      await desktopApi("DELETE", `/api/groups/${group.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("DELETE", `/api/bots/${other.id}`);
    }
  });
  it("leaves out a line the owner forgot, for the owner too, and changes nothing without the option", async () => {
    // One bot per line: a second message to a bot that is still answering the first waits in its queue and is not in the
    // transcript yet, so each line goes to its own bot and is written at once.
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const forgetBot = (await desktopApi("POST", "/api/bots")).body.bot;
    const sourceBot = (await desktopApi("POST", "/api/bots")).body.bot;
    const bots = [bot, forgetBot, sourceBot];
    try {
      const needle = "zephyr lease clause";
      const lines = [`${needle} kept`, `${needle} to forget`, `${needle} source forgotten`];
      for (const [i, text] of lines.entries()) {
        expect((await desktopApi("POST", `/api/bots/${bots[i].id}/messages`, { text })).status).toBe(202);
      }
      const plain = `/api/search?q=${encodeURIComponent(needle)}&limit=40`;
      await expect.poll(async () => (await desktopApi("GET", plain)).body.hits.filter((hit: { role: string }) => hit.role === "user").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
      // the owner's own lines (a fixture engine's reply may quote them; those are other rows)
      const hits: Array<{ messageId: string; snippet: string; role: string }> = (await desktopApi("GET", plain)).body.hits;
      const stamped = hits.find((hit) => hit.role === "user" && hit.snippet.includes("to forget"))!;
      const tombstoned = hits.find((hit) => hit.role === "user" && hit.snippet.includes("source forgotten"))!;
      expect(stamped && tombstoned).toBeTruthy();

      const db = writeDb();
      try {
        db.prepare("UPDATE messages SET json = json_set(json, '$.withheldFromBots', 'forgotten') WHERE thread_id = ? AND id = ?").run(forgetBot.threadId, stamped.messageId);
        db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,NULL,NULL,1,'owner-forget',1)")
          .run(`chats-test-${tombstoned.messageId}`, "source", `message:${sourceBot.threadId}:${tombstoned.messageId}`);
      } finally {
        db.close();
      }

      const chats = await desktopApi("GET", `${plain}&view=chats`);
      expect(chats.status).toBe(200);
      const shown = chats.body.hits.map((hit: { messageId: string }) => hit.messageId);
      expect(shown).not.toContain(stamped.messageId);
      expect(shown).not.toContain(tombstoned.messageId);
      const owners = chats.body.hits.filter((hit: { role: string }) => hit.role === "user");
      expect(owners.some((hit: { snippet: string }) => hit.snippet.includes("kept"))).toBe(true);
      // no owner line the view shows is one that was forgotten
      expect(owners.every((hit: { snippet: string }) => !hit.snippet.includes("to forget") && !hit.snippet.includes("source forgotten"))).toBe(true);
      const phone = await phoneApi("GET", `${plain}&view=chats&bot=${bot.id}`);
      expect(phone.status).toBe(200);
      expect(phone.body.hits.some((hit: { snippet: string }) => hit.snippet.includes("kept"))).toBe(true);
      expect(phone.body.hits.map((hit: { messageId: string }) => hit.messageId)).not.toContain(stamped.messageId);
      expect(phone.body.hits.map((hit: { messageId: string }) => hit.messageId)).not.toContain(tombstoned.messageId);

      // Filtering happens before LIMIT, not against the client's incomplete task window.
      expect((await desktopApi("GET", `${plain}&view=chats&bot=missing`)).body.hits).toEqual([]);
      expect((await desktopApi("GET", `${plain}&view=chats&pinned=1`)).body.hits).toEqual([]);
      await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { pinned: true });
      const pinned = await desktopApi("GET", `${plain}&view=chats&pinned=1&bot=${bot.id}&limit=1`);
      expect(pinned.body.hits).toHaveLength(1);
      expect(pinned.body.hits[0].threadId).toBe(bot.threadId);
      expect((await api("GET", `${plain}&view=chats`)).status).toBe(404);
      const refusedExisting = await api("GET", `${plain}&view=chats&threadId=${bot.threadId}`);
      const refusedMissing = await api("GET", `${plain}&view=chats&threadId=missing`);
      expect(refusedExisting).toEqual(refusedMissing);
      expect(refusedExisting).toEqual({ status: 404, body: { error: "no such route" } });

      // the owner's plain search, and every other caller of the route, is answered as before
      const again = (await desktopApi("GET", plain)).body.hits.map((hit: { messageId: string }) => hit.messageId);
      expect(again).toEqual(expect.arrayContaining([stamped.messageId, tombstoned.messageId]));
      for (const each of bots) await desktopApi("PATCH", `/api/bots/${each.id}`, { hidden: true });
      expect((await desktopApi("GET", `${plain}&view=chats`)).body.hits).toEqual([]);
      expect((await desktopApi("GET", `${plain}&view=chats&archived=1`)).body.hits.length).toBeGreaterThan(0);
      // a deleted conversation's rows are dropped with it: message-search-forgotten.test.ts ("does not return deleted conversations");
      // here a fixture turn may still hold the bot, which the delete refuses
    } finally {
      for (const each of bots) await desktopApi("DELETE", `/api/bots/${each.id}`);
    }
  });
});

import { BASE, DESKTOP_HEADERS, PAIRED_PHONE } from "./testing/index-harness.ts";
import { openSse } from "./testing/sse.ts";
import { bumpChatsGen, readChatsGen } from "./thread-summary.ts";
it("T-PUBLISH-HTTP: real storage, numbered stream and replay share the answer generation and audience", async () => {
  const desktop = await openSse(`${BASE}/api/events`, DESKTOP_HEADERS);
  const phone = await openSse(`${BASE}/api/events`, PAIRED_PHONE);
  const browser = await openSse(`${BASE}/api/events`);
  try {
    const hello = await desktop.until(frame => frame.kind === "hello");
    expect((await phone.until(frame => frame.kind === "hello")).chatsGen).toEqual(hello.chatsGen);
    expect((await browser.until(frame => frame.kind === "hello")).chatsGen).toBeUndefined();
    for (const path of ["/api/chats", "/api/search?view=chats&q=no-match-generation-fixture", "/api/search?view=chats&q=x"]) {
      const db = writeDb(); let gen;
      try { db.exec("BEGIN IMMEDIATE"); bumpChatsGen(db); db.exec("COMMIT"); gen = readChatsGen(db); } finally { db.close(); }
      const answer = await desktopApi("GET", path);
      expect(answer.status).toBe(200); expect(answer.body.gen).toEqual(gen);
      const sent = await desktop.until(frame => frame.kind === "chats.forgot" && frame.gen.rev === gen.rev, 200);
      expect(sent.seq).toBeTypeOf("number");
      expect((await phone.until(frame => frame.kind === "chats.forgot" && frame.gen.rev === gen.rev)).gen).toEqual(gen);
      expect(browser.frames.some(frame => frame.kind === "chats.forgot")).toBe(false);
    }
    const replay = await openSse(`${BASE}/api/events?since=${encodeURIComponent(hello.cursor)}`, DESKTOP_HEADERS);
    try {
      const reopened = await replay.until(frame => frame.kind === "hello");
      expect(reopened.resumed).toBe(true);
      expect(reopened.chatsGen.rev).toBeGreaterThan(hello.chatsGen.rev);
      expect((await replay.until(frame => frame.kind === "chats.forgot")).seq).toBeTypeOf("number");
    } finally { replay.close(); }
    expect((await desktopApi("GET", "/api/chats/gen")).status).toBe(404);
  } finally { desktop.close(); phone.close(); browser.close(); }
});

it.each(["/api/chats", "/api/search?view=chats&q=preview"])("C2 local audience at %s rejects a phone without owner proof", async path => {
  const { BASE, DOOR_HEADERS } = await import("./testing/index-harness.ts");
  expect((await desktopApi("GET", path)).status).toBe(200);
  expect((await phoneApi("GET", path)).status).toBe(200);
  const response = await fetch(BASE + path, { headers: { ...DOOR_HEADERS, "x-murage-companion": "1" } });
  expect(response.status).toBe(404);
  expect((await response.json() as { gen?: unknown }).gen).toBeUndefined();
});

it("T-GROUP-UNAUTHORIZED: HTTP rejects an existing pending chat outside current visible scope", async () => {
  const { encodeGroupedContinuation, normalizedSearchFilters } = await import("./chat-search.ts");
  const bot=(await desktopApi("POST","/api/bots")).body.bot;
  try {
    await desktopApi("PATCH",`/api/bots/${bot.id}`,{hidden:true});
    const page=await phoneApi("GET","/api/chats");
    const token=encodeGroupedContinuation({v:1,after:null,pending:{thread:{threadId:bot.threadId,createdAt:1},beforeAt:10,beforeRowid:1},gen:page.body.gen,query:"preview",filters:normalizedSearchFilters({})});
    const answer=await phoneApi("GET","/api/search?view=chats&group_by=thread&q=preview&before="+token);
    expect(answer).toEqual({status:400,body:{error:"before is not a position this search gave"}});
  } finally {await desktopApi("DELETE",`/api/bots/${bot.id}`);}
});

it("C2 local audience matrix agrees across routes, hello, live and replay", async()=>{
  const { DOOR_HEADERS }=await import("./testing/index-harness.ts");
  const barrierBot=(await desktopApi("POST","/api/bots",{name:"Local audience barrier"})).body.bot;
  try { for(const [headers,admitted] of [[DESKTOP_HEADERS,true],[{...DOOR_HEADERS,...PAIRED_PHONE},true],[DOOR_HEADERS,false]] as const) {
    const stream=await openSse(`${BASE}/api/events`,headers);
    try {
      const hello=await stream.until(frame=>frame.kind==="hello");expect(!!hello.chatsGen).toBe(admitted);
      const db=writeDb();let gen;
      try {db.exec("BEGIN IMMEDIATE");bumpChatsGen(db);db.exec("COMMIT");gen=readChatsGen(db);} finally {db.close();}
      for(const path of ["/api/chats","/api/search?view=chats&q=preview"])expect((await fetch(BASE+path,{headers})).status).toBe(admitted?200:404);
      await desktopApi("GET","/api/chats");
      if(admitted)await stream.until(frame=>frame.kind==="chats.forgot" && frame.gen.rev===gen.rev);
      const barrierName=`Local audience barrier ${gen.rev}`;
      await desktopApi("PATCH",`/api/bots/${barrierBot.id}`,{name:barrierName});
      await stream.until(frame=>frame.kind==="bot" && frame.bot?.name===barrierName);
      const replay=await openSse(`${BASE}/api/events?since=${encodeURIComponent(hello.cursor)}`,headers);
      try {
        const reopened=await replay.until(frame=>frame.kind==="hello");expect(reopened.resumed).toBe(true);expect(!!reopened.chatsGen).toBe(admitted);
        await replay.until(frame=>frame.kind==="bot" && frame.bot?.name===barrierName);
        if(admitted)await replay.until(frame=>frame.kind==="chats.forgot" && frame.gen.rev===gen.rev);
        else {expect(stream.frames.some(frame=>frame.kind==="chats.forgot")).toBe(false);expect(replay.frames.some(frame=>frame.kind==="chats.forgot")).toBe(false);}
      } finally {replay.close();}
    } finally {stream.close();}
  } } finally {await desktopApi("DELETE",`/api/bots/${barrierBot.id}`);}
});

it("RULE paths 14 to 16 owner search keeps forgotten lines, excludes hidden tools and deleted rows, and carries generation", async()=>{
  const bot=(await desktopApi('POST','/api/bots')).body.bot;
  const db=writeDb();
  try {
    const put=(id:string,kind:string,json:Record<string,unknown>)=>{
      const text=`rule-search ${id}`;
      const result=db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)').run(bot.threadId,id,Date.now(),'user',kind,text,JSON.stringify({id,at:Date.now(),role:'user',kind,text,...json}));
      syncMessageSearchRow(db, Number(result.lastInsertRowid), text);
    };
    put('kept','text',{});put('forgotten','text',{withheldFromBots:'forgotten'});put('changed','text',{withheldFromBots:true});
    put('hidden','activity',{tool:{name:'rule-search hidden',ok:true}});
    put('offbranch','text',{parentId:null});
    put('removed','text',{});db.prepare("DELETE FROM messages WHERE thread_id=? AND id='removed'").run(bot.threadId);
    for(const suffix of ['',`&threadId=${bot.threadId}`]) {
      const owner=await desktopApi('GET',`/api/search?q=rule-search${suffix}`);
      expect(owner.status).toBe(200);
      expect(owner.body.gen).toMatchObject({epoch:expect.any(String),rev:expect.any(Number)});
      expect(owner.body.hits.map((h:any)=>h.messageId).sort()).toEqual(['changed','forgotten','kept']);
    }
    const phone=await phoneApi('GET','/api/search?q=rule-search');
    expect(phone.body.gen).toMatchObject({epoch:expect.any(String),rev:expect.any(Number)});
    const door=await api('GET','/api/search?q=rule-search');
    expect(door.body.hits.map((h:any)=>h.messageId)).toEqual(['kept']);
    const chats=await desktopApi('GET','/api/search?view=chats&q=rule-search');
    expect(chats.body.hits.map((h:any)=>h.messageId).sort()).toEqual(['changed','kept']);
  } finally {db.close();await desktopApi('DELETE',`/api/bots/${bot.id}`);}
});
