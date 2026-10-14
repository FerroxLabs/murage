// Switching back to a conversation the app already holds asks for what
// changed since its page (`since=` the version the page came with), and the
// hover prefetch reads the page a switch would open without switching
// (`view=switch`). When the server cannot say exactly what changed (a branch
// move, a version from another run), the answer is the whole page, as before.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const LONG = 150;
const PAGE = 100;

let fixture: VerificationServer, headers: Record<string, string>;
let ids: { bot: string; long: string; short: string };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Since fixture'},{seedMessages:false});
    const long=bot.threadId;
    for(let i=0;i<${LONG};i++)store.appendMessage(long,{role:i%2?'bot':'user',kind:'text',text:'message '+i});
    const short=store.createTask(bot.id,'Short').threadId;
    store.appendMessage(short,{role:'bot',kind:'text',text:'short reply'});
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'since-fixture.json'),JSON.stringify({bot:bot.id,long,short}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "since-fixture.json"), "utf8"));
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
}, 30000);
afterAll(async () => { await fixture?.close(); });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as any };
};
const switchTo = (threadId: string, since?: string) =>
  call("POST", `/api/bots/${ids.bot}/tasks/${threadId}?messages=${PAGE}${since ? `&since=${encodeURIComponent(since)}` : ""}`);

describe("a switch back with since=", () => {
  it("answers only what changed since the held page", async () => {
    const opened = (await switchTo(ids.long)).body.bot;
    expect(opened.messages.length).toBeGreaterThanOrEqual(PAGE);
    expect(typeof opened.threadVersion).toBe("string");
    await switchTo(ids.short);
    // a message of the held page changes while it is not on screen
    const target = opened.messages.at(-5);
    expect((await call("POST", `/api/threads/${ids.long}/messages/${target.id}/reactions`, { emoji: "👍" })).status).toBe(200);

    const back = (await switchTo(ids.long, opened.threadVersion)).body.bot;
    expect(back.threadId).toBe(ids.long);
    expect(back).not.toHaveProperty("messages");
    expect(back.threadDelta.messages.map((m: any) => m.id)).toEqual([target.id]);
    expect(back.threadDelta.messages[0].reactions).toBeTruthy();
    expect(back.threadDelta.activeLeafId).toBe(opened.activeLeafId);
    expect(back.tasks).toHaveLength(2);
    expect(back.threadVersion).not.toBe(opened.threadVersion);

    // nothing since: an empty delta
    await switchTo(ids.short);
    const again = (await switchTo(ids.long, back.threadVersion)).body.bot;
    expect(again.threadDelta.messages).toEqual([]);
  });

  it("answers the whole page when the branch moved, or the version is not this run's", async () => {
    const opened = (await switchTo(ids.long)).body.bot;
    await switchTo(ids.short);
    // the branch is chosen again (what a rewind or a fork does)
    const earlier = opened.messages.at(-3);
    const moved = await call("POST", `/api/bots/${ids.bot}/active-branch`, { messageId: earlier.id, threadId: ids.long });
    expect(moved.status).toBe(200);
    const back = (await switchTo(ids.long, opened.threadVersion)).body.bot;
    expect(back).not.toHaveProperty("threadDelta");
    expect(back.activeLeafId).toBe(moved.body.activeLeafId);
    expect(Array.isArray(back.messages)).toBe(true);

    await switchTo(ids.short);
    const foreign = (await switchTo(ids.long, "another-run.1")).body.bot;
    expect(foreign).not.toHaveProperty("threadDelta");
    expect(Array.isArray(foreign.messages)).toBe(true);
  });
});

describe("view=switch (the hover prefetch)", () => {
  it("reads the page a switch would open, without switching", async () => {
    await switchTo(ids.short);
    const page = (await call("GET", `/api/threads/${ids.long}/messages?limit=${PAGE}&view=switch`)).body;
    const switched = (await switchTo(ids.long)).body.bot;
    expect(page.messages.map((m: any) => m.id)).toEqual(switched.messages.map((m: any) => m.id));
    expect(page.hasMore).toBe(switched.hasMore);
    expect(page.activeLeafId).toBe(switched.activeLeafId);
    expect(typeof page.version).toBe("string");
    await switchTo(ids.short);
    // the prefetch itself did not move the bot
    const prefetched = (await call("GET", `/api/threads/${ids.long}/messages?limit=${PAGE}&view=switch`)).body;
    expect((await call("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === ids.bot).threadId).toBe(ids.short);

    // and with since=, only what changed
    const delta = (await call("GET", `/api/threads/${ids.long}/messages?limit=${PAGE}&view=switch&since=${encodeURIComponent(prefetched.version)}`)).body;
    expect(delta).toMatchObject({ delta: true, messages: [] });
    expect((await call("GET", `/api/threads/${ids.long}/messages?limit=${PAGE}&view=switch&before=x`)).status).toBe(400);
  });
});
