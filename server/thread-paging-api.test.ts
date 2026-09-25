// The desktop hydrates and switches threads by page (upstream #1527,
// 08b479d7). A thread switch answers `?messages=n` with a bounded page, and
// its broadcast frame is bounded whatever the caller asked for: every client
// folds that frame, a phone over a tunnel included, and a long room's whole
// history is exactly the payload paging exists to avoid. A page also reaches
// back to the oldest open request card, because the client renders the
// approval strip from what it holds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse } from "./testing/sse.ts";

const LONG = 300;
const CARD_AT = 20;
const FRAME_PAGE = 100;

let fixture: VerificationServer, headers: Record<string, string>;
let ids: { bot: string; long: string; short: string; group: string; groupLong: string; groupShort: string; card: string };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Paging fixture'},{seedMessages:false});
    const long=bot.threadId;let card='';
    for(let i=0;i<${LONG};i++){
      if(i===${CARD_AT})card=store.appendMessage(long,{role:'bot',kind:'options',card:{title:'Allow?',subtitle:'run ls',options:['Allow','Deny'],requestId:'paging-open-request',tool:'Bash'}}).id;
      else store.appendMessage(long,{role:i%2?'bot':'user',kind:'text',text:'bot message '+i});
    }
    const short=store.createTask(bot.id,'Short').threadId;
    for(let i=0;i<3;i++)store.appendMessage(short,{role:'user',kind:'text',text:'short '+i});
    const group=store.createGroup('Paging room',[bot.id],false,undefined,{completed:true});
    const groupLong=group.threadId;
    for(let i=0;i<${LONG};i++)store.appendMessage(groupLong,{role:'user',kind:'text',text:'room message '+i});
    const groupShort=store.createGroupTask(group.id,'Quiet',true).threadId;
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'paging-fixture.json'),JSON.stringify({bot:bot.id,long,short,group:group.id,groupLong,groupShort,card}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "paging-fixture.json"), "utf8"));
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

const call = async (method: string, path: string) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers });
  return { status: response.status, body: await response.json() as any };
};
const snapshot = async () => (await call("GET", "/api/bots?messages=0")).body as { bots: any[]; groups: any[] };
const texts = (messages: any[]) => messages.map((message) => message.text ?? message.card?.title);

describe("bot thread switch", () => {
  it("answers a page that reaches back to the open request card", async () => {
    const { status, body } = await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}?messages=${FRAME_PAGE}`);
    expect(status).toBe(200);
    expect(body.bot.threadId).toBe(ids.long);
    // 100 were asked for; the open card sits 280 from the end, so the page
    // is exactly the contiguous tail that holds it
    expect(body.bot.messages).toHaveLength(LONG - CARD_AT);
    expect(body.bot.messages[0].id).toBe(ids.card);
    expect(body.bot.messages.at(-1).text).toBe(`bot message ${LONG - 1}`);
    expect(body.bot.hasMore).toBe(true);
    expect(body.bot.activeLeafId).toBe(body.bot.messages.at(-1).id);
    expect(body.bot.tasks).toHaveLength(2);

    // the hydration route agrees, so a reload lands on the same rows
    const hydrated = (await call("GET", `/api/bots?messages=${FRAME_PAGE}`)).body.bots.find((bot: any) => bot.id === ids.bot);
    expect(texts(hydrated.messages)).toEqual(texts(body.bot.messages));
    expect(hydrated.hasMore).toBe(true);

    // and scrollback continues from the page's oldest row with no gap
    const older = (await call("GET", `/api/threads/${ids.long}/messages?limit=${FRAME_PAGE}&before=${ids.card}`)).body;
    expect(older.messages).toHaveLength(CARD_AT);
    expect(older.messages.at(-1).text).toBe(`bot message ${CARD_AT - 1}`);
    expect(older.hasMore).toBe(false);
  });

  it("keeps settings-only and whole-thread answers as they were", async () => {
    await call("POST", `/api/bots/${ids.bot}/tasks/${ids.short}?messages=0`);
    const settings = await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}?messages=0`);
    expect(settings.body.bot).not.toHaveProperty("messages");
    await call("POST", `/api/bots/${ids.bot}/tasks/${ids.short}?messages=0`);
    const whole = await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}`);
    expect(whole.body.bot.messages).toHaveLength(LONG);
    expect(whole.body.bot).not.toHaveProperty("hasMore");
  });

  it("refuses a bad page size before it moves the bot", async () => {
    await call("POST", `/api/bots/${ids.bot}/tasks/${ids.short}?messages=0`);
    expect((await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}?messages=lots`)).status).toBe(400);
    expect((await snapshot()).bots.find((bot) => bot.id === ids.bot).threadId).toBe(ids.short);
  });

  it("broadcasts a bounded frame, even to a caller that asked for the whole thread", async () => {
    await call("POST", `/api/bots/${ids.bot}/tasks/${ids.short}?messages=0`);
    const stream = await openSse(`${fixture.info.url}/api/events`, headers);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const whole = await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}`);
      expect(whole.body.bot.messages).toHaveLength(LONG);
      const frame = await stream.until((f) => f.kind === "bot" && f.bot?.id === ids.bot && f.bot?.threadId === ids.long && Array.isArray(f.bot?.messages));
      // one page, stretched only as far back as the open card
      expect(frame.bot.messages).toHaveLength(LONG - CARD_AT);
      expect(frame.bot.hasMore).toBe(true);
      expect(frame.bot.messages.at(-1).text).toBe(`bot message ${LONG - 1}`);
      expect(stream.frames.every((f: any) => (f.bot?.messages?.length ?? 0) < LONG)).toBe(true);
    } finally {
      stream.close();
    }
  });
});

describe("channel thread switch", () => {
  it("answers and broadcasts a bounded page", async () => {
    const stream = await openSse(`${fixture.info.url}/api/events`, headers);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const { status, body } = await call("POST", `/api/groups/${ids.group}/tasks/${ids.groupLong}?messages=${FRAME_PAGE}`);
      expect(status).toBe(200);
      expect(body.group.messages).toHaveLength(FRAME_PAGE);
      expect(body.group.hasMore).toBe(true);
      expect(body.group.messages.at(-1).text).toBe(`room message ${LONG - 1}`);
      expect(body.group.tasks).toHaveLength(2);
      const frame = await stream.until((f) => f.kind === "group" && f.group?.id === ids.group && f.group?.threadId === ids.groupLong && Array.isArray(f.group?.messages));
      expect(frame.group.messages).toHaveLength(FRAME_PAGE);
      expect(frame.group.hasMore).toBe(true);
      expect(texts(frame.group.messages)).toEqual(texts(body.group.messages));
    } finally {
      stream.close();
    }
    const hydrated = (await call("GET", `/api/bots?messages=${FRAME_PAGE}`)).body.groups.find((group: any) => group.id === ids.group);
    expect(hydrated.messages).toHaveLength(FRAME_PAGE);
    expect(hydrated.hasMore).toBe(true);
  });

  it("keeps settings-only and whole-thread answers, and refuses a bad size in place", async () => {
    await call("POST", `/api/groups/${ids.group}/tasks/${ids.groupShort}?messages=0`);
    const settings = await call("POST", `/api/groups/${ids.group}/tasks/${ids.groupLong}?messages=0`);
    expect(settings.body.group).not.toHaveProperty("messages");
    await call("POST", `/api/groups/${ids.group}/tasks/${ids.groupShort}?messages=0`);
    expect((await call("POST", `/api/groups/${ids.group}/tasks/${ids.groupLong}?messages=-1`)).status).toBe(400);
    expect((await snapshot()).groups.find((group) => group.id === ids.group).threadId).toBe(ids.groupShort);
    const whole = await call("POST", `/api/groups/${ids.group}/tasks/${ids.groupLong}`);
    expect(whole.body.group.messages).toHaveLength(LONG);
    expect(whole.body.group).not.toHaveProperty("hasMore");
  });
});

describe("a phone's slim hydrate (spec §6)", () => {
  it("still carries the open request card, and says there is more", async () => {
    expect((await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}?messages=0`)).status).toBe(200);
    const slim = (await call("GET", "/api/bots?messages=1")).body.bots.find((bot: any) => bot.id === ids.bot);
    expect(slim.threadId).toBe(ids.long);
    // one row was asked for; the page reaches back to the open card
    expect(slim.messages).toHaveLength(LONG - CARD_AT);
    expect(slim.messages[0].id).toBe(ids.card);
    expect(slim.hasMore).toBe(true);
    // zero is "settings only": the card a phone has to answer would be gone
    const bare = (await call("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === ids.bot);
    expect(bare.messages).toEqual([]);
  });

  it("is the newest row alone for a thread with nothing open", async () => {
    expect((await call("POST", `/api/bots/${ids.bot}/tasks/${ids.short}?messages=0`)).status).toBe(200);
    const slim = (await call("GET", "/api/bots?messages=1")).body.bots.find((bot: any) => bot.id === ids.bot);
    // The newest row, whatever it is: the fixture's unanswered "short 2"
    // earns a "Murage closed while this was running" notice at startup.
    const thread = (await call("GET", `/api/threads/${ids.short}/messages?limit=10`)).body.messages;
    expect(texts(thread)).toContain("short 2");
    expect(slim.messages).toHaveLength(1);
    expect(slim.messages[0].id).toBe(thread.at(-1).id);
    expect(slim.messages[0].kind).toBe("activity");
    expect(slim.messages[0].tool.name).toMatch(/^Murage closed while this was running/);
    expect(slim.hasMore).toBe(true);
  });
});
