// Real companion handler + isolated harness: COMPANION-CHATS-1019 P1–P7, S1, G1, O1/O2.
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { launchVerificationServer } from "../scripts/control-murage.ts";
const COMPANION_TOKEN = "c".repeat(64), DOOR_HEADERS = { "x-murage-door-token": COMPANION_TOKEN };
let BASE: string, PORT: number, home: string, owner: Record<string, string>, fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let seeded: any;
async function desktopApi(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { ...owner, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() as any };
}
async function phoneApi(method: string, path: string) {
  const r = await fetch(BASE + path, { method, headers: { ...DOOR_HEADERS, "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN } }); return { status: r.status, body: await r.json() as any };
}
// Observe worker completion without spending the app's foreground I/O budget.
// A pending-intent hit alone does not prove the derived index finished rebuilding.
const ready = async (probe: () => Promise<string[]>, expected: string[]) => {
  const deadline = Date.now() + 10_000;
  let actual: string[] = [];
  for (;;) {
    let indexed = false;
    const source = new DatabaseSync(join(home, "messages.db"), {readOnly:true});
    try {
      const search = new DatabaseSync(join(home, "search.db"), {readOnly:true});
      try {
        const state = search.prepare("SELECT (SELECT v FROM search_state WHERE k='owner') AS owner,(SELECT v FROM search_state WHERE k='applied_seq') AS applied,EXISTS(SELECT 1 FROM search_state WHERE k='built') AS building").get()!;
        const owner = source.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done;
        const newest = source.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM search_intents").get()!.n;
        indexed = state.owner === String(owner) && state.building === 0 && Number(state.applied) >= Number(newest);
      } finally { search.close(); }
    } catch { /* The worker may be replacing its derived file. */ }
    finally { source.close(); }
    if (indexed) {
      actual = await probe();
      if (JSON.stringify(actual.slice().sort()) === JSON.stringify(expected.slice().sort())) return;
    }
    if (Date.now() >= deadline) throw new Error(`Fixture search index did not become ready: ${JSON.stringify({indexed, actual, expected})}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
import { createBrowserHandler } from "../companion/src/browser.ts";
import { createProxyHandler } from "../companion/src/proxy.ts";
import { DeviceRegistry } from "../companion/src/devices.ts";
import { syncThreadSummary, bumpChatsGen, readChatsGen } from "./thread-summary.ts";
import { encodeGroupedContinuation, normalizedSearchFilters } from "./chat-search.ts";
import { openSse } from "./testing/sse.ts";
let door: Server, deviceDoor: Server, origin: string, deviceOrigin: string, cookie: string;
const registry = new DeviceRegistry();
async function listen(server: Server) { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: COMPANION_TOKEN }, instrumentationSource: `
    const {writeFileSync,existsSync} = await import('node:fs'); const {join} = await import('node:path');
    if (!existsSync(join(process.env.MURAGE_DATA_DIR,'reader-fixture.json'))) {
    const { Store } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const { STATIC_CLAUDE_MODELS } = await import(${JSON.stringify(new URL("./drivers/claude.ts", import.meta.url).href)});
    const store = new Store(() => ({instanceId:'verification',model:STATIC_CLAUDE_MODELS.default}));
    const parity = store.createBot({name:'Parity'}, {seedMessages:false});
    store.appendMessage(parity.threadId, {id:'parity-withheld', role:'user',kind:'text',text:'abc withheld parity',withheldFromBots:true});
    const paging = store.createBot({name:'Paging'}, {seedMessages:false});
    const tasks = [paging.threadId, store.createTask(paging.id,'abc page 1',false).threadId, store.createTask(paging.id,'abc page 2',false).threadId];
    const ids = tasks.map((thread,n) => store.appendMessage(thread,{role:'user',kind:'text',text:'abc parity '+n,withheldFromBots:true}).id);
    store.appendMessage(tasks[0],{role:'user',kind:'text',text:'abc forgotten',withheldFromBots:'forgotten'});
    const hidden = store.createBot({name:'Hidden'}, {seedMessages:false});
    store.appendMessage(hidden.threadId,{role:'user',kind:'text',text:'abc outside'});
    const scopeBot = store.createBot({name:'Scope',section:'Home'}, {seedMessages:false});
    const archived = store.createGroup('Archived',[scopeBot.id]); archived.hidden = true;
    const dm = store.createGroup('Private room',[scopeBot.id],true);
    const project = store.createGroup('Project',[scopeBot.id]); project.channelProject = {goal:'Scope proof',status:'active',createdAt:1};
    const closedProject = store.createGroup('Closed project',[scopeBot.id]); closedProject.channelProject={goal:'Finished',status:'done',createdAt:1,completedAt:2};
    const live = store.createTask(scopeBot.id,'Live desk',false); live.channelProjectDesk = {groupId:project.id};
    const closed = store.createTask(scopeBot.id,'Closed desk',false); closed.channelProjectDesk = {groupId:closedProject.id,archivedAt:2};
    const routine = store.createTask(scopeBot.id,'Routine',false);
    const scopeMessages = [scopeBot.threadId,archived.threadId,dm.threadId,project.threadId,live.threadId,closed.threadId,routine.threadId].map(thread => ({threadId:thread,id:store.appendMessage(thread,{role:'user',kind:'text',text:'scopeabc '+thread}).id}));
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'routines.json'),JSON.stringify({version:1,routines:[],runs:[{id:'scope-run',routineId:'scope-routine',routineName:'Scope routine',target:'bot',botId:scopeBot.id,threadId:routine.threadId,runOn:'local',scheduledFor:1,createdAt:1,finishedAt:2,status:'completed'}]}));
    const shared = store.createBot({name:'Shared',section:'Home'}, {seedMessages:false}); shared.sharedWith = {mode:'all',teams:[]};
    store.createBot({name:'Other team',section:'Other'}, {seedMessages:false});
    const {teamIdFor} = await import(${JSON.stringify(new URL("./team-identities.ts", import.meta.url).href)});
    const teamId = teamIdFor('Other'); const work = store.createTask(shared.id,'Shared work',false); work.sharedWork={teamId,createdAt:1};
    const sharedMessage=store.appendMessage(work.threadId,{role:'user',kind:'text',text:'sharedabc team work'});
    const partial=store.createBot({name:'Partial walk'}, {seedMessages:false});
    const partialMessage=store.appendMessage(partial.threadId,{role:'user',kind:'text',text:'walkabc oldest hit',at:1});
    store.saveGroups(); store.saveBots();
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'reader-fixture.json'), JSON.stringify({parity,paging,hidden,tasks,ids,scopeBot,archived,dm,project,live,closed,routine,scopeMessages,shared,work,sharedMessage,partial,partialMessage,visible:store.visibleThreadIds()}));
    }
    // This fixture-only signal models an unavailable derived reader for P7.
    // No route or app setting exposes it; normal cases use the live worker.
    const {stopSearchIndex} = await import(${JSON.stringify(new URL("./message-search-index.ts", import.meta.url).href)});
    const stopReader = join(process.env.MURAGE_DATA_DIR,'stop-search-reader');
    const stopWatch = setInterval(async () => {
      if (!existsSync(stopReader)) return;
      clearInterval(stopWatch);
      await stopSearchIndex();
      writeFileSync(stopReader+'.done','stopped');
    },20); stopWatch.unref();
  ` });
  BASE = fixture.info.url; PORT = Number(new URL(BASE).port); home = fixture.info.dataDir;
  seeded = JSON.parse(readFileSync(join(home, 'reader-fixture.json'), 'utf8'));
  const proof = await (await fetch(BASE + '/api/desktop-secret')).json() as {secret:string};
  owner = { 'x-murage-surface':'desktop', 'x-murage-surface-secret':proof.secret };
  await desktopApi('PUT','/api/config',{profile:{name:'Chats owner'}});
  origin = await listen(door = createServer(createBrowserHandler({ harnessPort: PORT, companionToken: COMPANION_TOKEN, devices: registry, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }) })));
  deviceOrigin = await listen(deviceDoor = createServer(createProxyHandler({ harnessPort: PORT, companionToken: COMPANION_TOKEN, authenticate: () => ({cloudDesktopAccess:false}), redeem: () => ({ error: "unused" }), serverName: () => "Fixture" })));
  const paired = registry.redeem(registry.openPairing().code, "Real browser"); if ("error" in paired) throw new Error(paired.error);
  cookie = `murage_session=${registry.openSession(paired.device.id, "Fixture")!.value}`;
  // The current index is a separate worker-owned database. Wait for the
  // fixture's seeded rows before measuring paging or live invalidation.
  // Owner reads keep setup work out of the browser session budget.
  await ready(async () => (await desktopApi("GET", `/api/search?view=chats&q=abc&bot=${seeded.paging.id}`)).body.hits.map((hit: any) => hit.messageId), seeded.ids);
  await ready(async () => (await desktopApi("GET", "/api/search?view=chats&q=sharedabc")).body.hits.map((hit: any) => hit.messageId), [seeded.sharedMessage.id]);
});
// Keep each API scenario's background budget independent. The persisted seed
// survives restart, while the real worker and request authority start fresh.
beforeEach(async () => {
  await fixture.restart();
  const proof = await (await fetch(BASE + '/api/desktop-secret')).json() as {secret:string};
  owner = {'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
  await ready(async () => (await desktopApi("GET", "/api/search?view=chats&q=sharedabc")).body.hits.map((hit: any) => hit.messageId), [seeded.sharedMessage.id]);
});
afterAll(async () => { for (const server of [door, deviceDoor]) if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } await fixture?.close(); });
async function read(path: string, device = false) { const r = await fetch((device ? deviceOrigin : origin) + path, { headers: device ? { authorization: "Bearer fixture" } : { cookie } }); return { status: r.status, body: await r.json() as any }; }
it("STEP1/H6 existing browser transcript shows a withheld, non-forgotten line", async () => {
  const bot = seeded.parity;
  try {
    const transcript = await read(`/api/threads/${bot.threadId}/messages`);
    expect(transcript.status).toBe(200); expect(transcript.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "abc withheld parity", withheldFromBots: true })]));
  } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
});
it("H1/P1/P2/P3/P6 scoped snippets and three grouped pages match the device door", async () => {
  const bot = seeded.paging, hidden = seeded.hidden, tasks: string[] = seeded.tasks;
  try {
    await desktopApi("PATCH", `/api/bots/${hidden.id}`, { hidden: true });
    await ready(async () => (await desktopApi("GET", `/api/search?view=chats&q=abc&bot=${bot.id}`)).body.hits.map((hit: any) => hit.messageId), seeded.ids);
    const transcripts = new Map<string, any[]>();
    for (const thread of tasks) transcripts.set(thread, (await read(`/api/threads/${thread}/messages`)).body.messages);
    const list = await read(`/api/chats?bot=${bot.id}`); expect(list.status).toBe(200);
    expect(list.body.chats).toHaveLength(3);
    for (const row of list.body.chats) expect(transcripts.get(row.threadId)?.some(m => m.text === row.snippet)).toBe(true);
    expect((await read("/api/chats?archived=1")).body.chats).toEqual([]);
    for (const grouped of [false, true]) {
      const path = `/api/search?view=chats&q=abc&bot=${bot.id}&limit=${grouped ? 1 : 40}${grouped ? "&group_by=thread" : ""}`;
      let next: string | null = null; const seen = new Set<string>(); let pages = 0;
      do {
        const request = path + (next ? `&before=${encodeURIComponent(next)}` : "");
        const answer = await read(request); expect(answer.status).toBe(200);
        expect(answer).toEqual(await read(request, true));
        for (const hit of answer.body.hits) { expect(transcripts.get(hit.threadId)?.some(m => m.id === hit.messageId && m.withheldFromBots !== "forgotten")).toBe(true); seen.add(hit.messageId); }
        next = answer.body.next; pages++; expect(pages).toBeLessThan(5);
      } while (next);
      expect([...seen].sort()).toEqual([...seeded.ids].sort()); if (grouped) expect(pages).toBe(3);
    }
  } finally { for (const b of [bot]) await desktopApi("DELETE", `/api/bots/${b.id}`); }
});
it("O1/O2/P5 inaccessible and missing ids have byte-identical answers on both doors", async () => {
  const bot = (await desktopApi("POST", "/api/bots")).body.bot;
  try {
    await desktopApi("PATCH", `/api/bots/${bot.id}`, { hidden: true });
    const gen = (await phoneApi("GET", "/api/chats")).body.gen;
    for (const device of [false, true]) {
      const answers = [];
      for (const threadId of [bot.threadId, "missing-thread"]) {
        const direct = await read(`/api/search?view=chats&q=abc&threadId=${threadId}`, device);
        const cursor = encodeGroupedContinuation({ v: 1, after: null, pending: { thread: { threadId, createdAt: 1 }, beforeAt: 10, beforeRowid: 1 }, gen, query: "abc", filters: normalizedSearchFilters({}) });
        const pending = await read(`/api/search?view=chats&q=abc&group_by=thread&before=${cursor}`, device);
        expect(direct).toMatchObject({ status: 200, body: { hits: [] } }); expect(pending).toMatchObject({ status: 200, body: { hits: [], next: null, partial: false } });
        answers.push({ direct, pending });
      }
      expect(answers[0]).toEqual(answers[1]);
    }
  } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
});
it("H2 valid proof is needed; a door proof alone never counts", async () => {
  for (const proof of [undefined, "a".repeat(64), "c".repeat(63)]) for (const path of ["/api/chats", "/api/search?view=chats&q=abc"]) {
    const r = await fetch(BASE + path, { headers: { ...DOOR_HEADERS, "x-murage-companion": "1", ...(proof ? { "x-murage-chats-reader": proof } : {}) } }); expect(r.status).toBe(404);
  }
});

it("S1 chat and search scopes exclude hidden, archived, dm and closed desks, with routine opt-in", async () => {
  for (const routines of [false, true]) {
    const suffix = routines ? "?routines=1" : "";
    const list = await read("/api/chats" + suffix); expect(list.status).toBe(200);
    const threads = list.body.chats.map((r: any) => r.threadId);
    for (const thread of threads) expect(seeded.visible).toContain(thread);
    for (const thread of [seeded.hidden.threadId, seeded.archived.threadId, seeded.dm.threadId, seeded.closed.threadId]) expect(threads).not.toContain(thread);
    expect(threads).toContain(seeded.live.threadId); expect(threads.includes(seeded.routine.threadId)).toBe(routines);
    const found = await read(`/api/search?view=chats&q=scopeabc${routines ? "&routines=1" : ""}`); expect(found.status).toBe(200);
    for (const hit of found.body.hits) { expect(seeded.visible).toContain(hit.threadId); expect((await read(`/api/threads/${hit.threadId}/messages`)).status).toBe(200); }
    for (const thread of [seeded.hidden.threadId, seeded.archived.threadId, seeded.dm.threadId, seeded.closed.threadId]) expect(found.body.hits.map((h: any) => h.threadId)).not.toContain(thread);
  }
});
it("P4 shared work follows transcript visibility and team rows stay absent in snapshot, live and replay", async () => {
  const check = (body: any) => {
    if (Array.isArray(body)) { for (const value of body) check(value); }
    else if (body && typeof body === "object") for (const [key, value] of Object.entries(body)) { if (key === "sharedRows") expect(value).toEqual([]); else check(value); }
  };
  await ready(async () => (await desktopApi("GET", "/api/search?view=chats&q=sharedabc")).body.hits.map((hit: any) => hit.messageId), [seeded.sharedMessage.id]);
  const transcript = await read(`/api/threads/${seeded.work.threadId}/messages`);
  const search = await read("/api/search?view=chats&q=sharedabc"); expect(search.status).toBe(200);
  if (transcript.status === 200) expect(search.body.hits.map((h: any) => h.messageId)).toContain(seeded.sharedMessage.id);
  else expect(search.body.hits).toEqual([]);
  const fleet = await read("/api/bots"); expect(fleet.status).toBe(200);
  expect(fleet.body.bots.some((bot: any) => bot.id === seeded.shared.id)).toBe(true);
  check(fleet.body); check(transcript.body); check(search.body);
  const phone = await read("/api/bots", true); expect(phone.body.bots.find((b: any) => b.id === seeded.shared.id).sharedRows.length).toBeGreaterThan(0);
  const stream = await openSse(origin + "/api/events", {cookie});
  try {
    const hello = await stream.until(f => f.kind === "hello"); check(hello);
    await desktopApi("PATCH", `/api/bots/${seeded.shared.id}`, {name:"Shared live proof"});
    check(await stream.until(f => f.kind === "bot" && f.bot?.name === "Shared live proof"));
    const replay = await openSse(origin + "/api/events?since=" + encodeURIComponent(hello.cursor), {cookie});
    try { check(await replay.until(f => f.kind === "bot" && f.bot?.name === "Shared live proof")); }
    finally { replay.close(); }
  } finally { stream.close(); }
});

it("P-CONTENT grouped non-desktop hits omit unused content, preserving navigation and highlight fields", async () => {
  const answer = await read(`/api/search?view=chats&group_by=thread&q=sharedabc&bot=${seeded.shared.id}`, true);
  expect(answer.status).toBe(200); expect(answer.body.hits).toHaveLength(1);
  const hit = answer.body.hits[0];
  for (const field of ["role", "kind", "from", "name"]) expect(hit).not.toHaveProperty(field);
  expect(hit).toMatchObject({threadId:seeded.work.threadId,messageId:seeded.sharedMessage.id,snippet:"sharedabc team work",matchStart:0,matchLength:9,botId:seeded.shared.id});
});
it("H4 reader proof cannot approve or act as the owner", async () => {
  for (const proof of [{}, {"x-murage-chats-reader":COMPANION_TOKEN}]) {
    const response = await fetch(BASE + `/api/bots/${seeded.shared.id}/respond`, {method:"POST",headers:{...DOOR_HEADERS,"x-murage-companion":"1","content-type":"application/json",...proof} as Record<string,string>,body:JSON.stringify({threadId:seeded.shared.threadId,requestId:"unowned",behavior:"allow"})});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({error:"Approving or answering happens in the Murage app or on your paired phone. From here you can only decline."});
  }
});
it("P5 stale and forged continuation/filter combinations never expose an inaccessible thread", async () => {
  const page = await read("/api/chats"); expect(page.status).toBe(200);
  const gen = page.body.gen;
  for (const threadId of [seeded.hidden.threadId, "foreign-thread"]) {
    for (const stale of [false,true]) {
      const cursor=encodeGroupedContinuation({v:1,after:null,pending:{thread:{threadId,createdAt:1},beforeAt:10,beforeRowid:1},gen:{...gen,rev:gen.rev+(stale?1:0)},query:"abc",filters:normalizedSearchFilters({})});
      const answer=await read(`/api/search?view=chats&q=abc&group_by=thread&before=${cursor}`);
      expect(answer).toMatchObject({status:200,body:{hits:[],next:null,partial:false}});
    }
    for (const filter of [`threadId=${threadId}`,`threads=${threadId}`,`threadId=${threadId}&threads=${threadId}&group_by=thread`]) {
      expect(await read(`/api/search?view=chats&q=abc&${filter}`)).toMatchObject({status:200,body:{hits:[]}});
    }
  }
});
// Run the engine warmup after the normal-index cases. Only the explicit
// unavailable-reader case follows it; every assertion still exercises its door.
it("H5/G1 browser hello, live and replay expose only epoch/rev generation metadata", async () => {
  const stream = await openSse(`${origin}/api/events`, { cookie });
  let warmBot: any;
  try {
    const hello = await stream.until(f => f.kind === "hello"); expect(hello.chatsGen).toEqual({epoch:expect.any(String),rev:expect.any(Number)});
    // Snapshot the real reader before the unrelated fake-engine warmup.
    // That warmup spends background I/O credit, so it belongs after search.
    const scopeIndex = async () => (await desktopApi("GET", `/api/search?view=chats&q=scopeabc&threadId=${seeded.live.threadId}`)).body.hits.map((hit: any) => hit.messageId);
    const liveMessage = seeded.scopeMessages.find((row: any) => row.threadId === seeded.live.threadId).id;
    await ready(scopeIndex, [liveMessage]);
    const rowsBefore = await read("/api/chats"), hitsBefore = await read("/api/search?view=chats&q=scopeabc");
    const db = new DatabaseSync(join(home, "messages.db")); let gen;
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots','forgotten') WHERE thread_id=?").run(seeded.archived.threadId);
      syncThreadSummary(db, seeded.archived.threadId); bumpChatsGen(db);
      db.exec("COMMIT"); gen = readChatsGen(db);
    } finally { db.close(); }
    await ready(scopeIndex, [liveMessage]);
    const rowsAfter = await read("/api/chats"), hitsAfter = await read("/api/search?view=chats&q=scopeabc");
    expect(rowsAfter.body.gen).toEqual(gen);
    expect({...rowsAfter.body,gen:null}).toEqual({...rowsBefore.body,gen:null});
    expect({...hitsAfter.body,gen:null}).toEqual({...hitsBefore.body,gen:null});
    const live = await stream.until(f => f.kind === "chats.forgot" && f.gen.rev === gen.rev);
    expect(Object.keys(live.gen).sort()).toEqual(["epoch", "rev"]);
    const replay = await openSse(`${origin}/api/events?since=${encodeURIComponent(hello.cursor)}`, { cookie });
    try { expect((await replay.until(f => f.kind === "hello")).resumed).toBe(true); expect((await replay.until(f => f.kind === "chats.forgot" && f.gen.rev === gen.rev)).gen).toEqual(gen); }
    finally { replay.close(); }
    // Use the current create endpoint to give this dispatch its own active
    // task; the scope fixture also owns archived project and routine desks.
    warmBot = (await desktopApi("POST", "/api/bots", {name:"Reader generation warmup"})).body.bot;
    const warm = await desktopApi("POST", `/api/bots/${warmBot.id}/messages`, {text:"__fixture_hold_authority__",threadId:warmBot.threadId});
    expect(warm.status, JSON.stringify(warm.body)).toBe(202);
    await expect.poll(() => {
      try { return readFileSync(fixture.fixtureDumpPath, "utf8").includes("__fixture_hold_authority__"); } catch { return false; }
    }, {timeout:10_000}).toBe(true);
    expect((await desktopApi("POST", `/api/bots/${warmBot.id}/interrupt`, {threadId:warmBot.threadId})).status).toBe(200);
    await expect.poll(async () => (await desktopApi("GET", `/api/bots/${warmBot.id}`)).body.bot.busy, {timeout:10_000}).toBe(false);
    expect((await desktopApi("DELETE", `/api/bots/${warmBot.id}`)).status).toBe(200);
    warmBot = undefined;

  } finally { if (warmBot) await desktopApi("DELETE", `/api/bots/${warmBot.id}`); stream.close(); }
});
it("P7 partial-walk cursor with a pending thread completes unchanged through both doors", async () => {
  writeFileSync(join(home,"stop-search-reader"), "stop");
  await expect.poll(() => {
    try { return readFileSync(join(home,"stop-search-reader.done"),"utf8"); }
    catch { return "waiting"; }
  }, {timeout:10_000}).toBe("stopped");
  // Only this fallback case needs the large raw-SQL history. Keeping it here
  // leaves the normal search/reader cases on a fully built production index.
  const db = new DatabaseSync(join(home,"messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<8001)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT ?,'walk-'||v,2,'user','text','no match',json_object('id','walk-'||v,'at',2,'role','user','kind','text','text','no match') FROM n`).run(seeded.partial.threadId);
  } finally { db.close(); }
  // The closed worker leaves no derived reader: search must use its bounded
  // fallback walk, with the production walk and candidate caps unchanged.
  const path = `/api/search?view=chats&group_by=thread&q=walkabc&bot=${seeded.partial.id}`;
  let next: string | null = null; let pending = false; const hits: any[] = [];
  for (let page = 0; page < 8; page++) {
    const request = path + (next ? "&before=" + encodeURIComponent(next) : "");
    const answer = await read(request); expect(answer.status).toBe(200); expect(answer).toEqual(await read(request,true));
    hits.push(...answer.body.hits); next = answer.body.next;
    if (!next) break;
    const cursor = JSON.parse(Buffer.from(next,"base64url").toString());
    if (cursor.pending) { pending = true; expect(cursor.pending.thread.threadId).toBe(seeded.partial.threadId); expect(cursor.pending.beforeRowid).toBeGreaterThan(0); }
  }
  expect(pending).toBe(true); expect(next).toBeNull(); expect(hits.map(h=>h.messageId)).toEqual([seeded.partialMessage.id]);
});