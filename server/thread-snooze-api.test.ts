// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation snooze through the real server: desktop only, persisted, and
// a question arriving in a snoozed conversation wakes it marked unread.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
let ids: { bot: string; quiet: string; asking: string; group: string; room: string };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Snooze fixture'},{seedMessages:false});
    const quiet=bot.threadId;
    const asking=store.createTask(bot.id,'Asks a question',false).threadId;
    const group=store.createGroup('Snooze room',[bot.id],false,undefined,{completed:true});
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'snooze-fixture.json'),JSON.stringify({bot:bot.id,quiet,asking,group:group.id,room:group.threadId}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "snooze-fixture.json"), "utf8"));
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
}, 30000);
afterAll(async () => { await fixture?.close(); });

const call = async (path: string, init: RequestInit = {}, desktop = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { ...init, headers: desktop ? headers : { "content-type": "application/json" } });
  return { status: response.status, body: await response.json() as any };
};
const snoozes = async () => (await call("/api/thread-snoozes")).body.snoozes as Array<{ threadId: string; until: number }>;
const task = async (threadId: string) => {
  const { body } = await call("/api/bots?messages=0");
  return body.bots.find((bot: any) => bot.id === ids.bot).tasks.find((entry: any) => entry.threadId === threadId);
};

it("answers 404 to anything but the desktop app, and changes nothing", async () => {
  expect((await call("/api/thread-snoozes", {}, false)).status).toBe(404);
  expect((await call(`/api/thread-snoozes/${ids.quiet}`, { method: "PUT", body: JSON.stringify({ until: Date.now() + 60_000 }) }, false)).status).toBe(404);
  expect((await call(`/api/thread-snoozes/${ids.quiet}`, { method: "DELETE" }, false)).status).toBe(404);
  expect(await snoozes()).toEqual([]);
});

it("snoozes a bot's conversation and a channel's, and unsnoozes", async () => {
  const until = Date.now() + 60 * 60_000;
  expect((await call(`/api/thread-snoozes/${ids.quiet}`, { method: "PUT", body: JSON.stringify({ until }) })).status).toBe(200);
  expect((await call(`/api/thread-snoozes/${ids.room}`, { method: "PUT", body: JSON.stringify({ until }) })).status).toBe(200);
  expect((await snoozes()).map(entry => entry.threadId).sort()).toEqual([ids.quiet, ids.room].sort());
  expect((await call("/api/thread-snoozes/no-such-thread", { method: "PUT", body: JSON.stringify({ until }) })).status).toBe(404);
  expect((await call(`/api/thread-snoozes/${ids.room}`, { method: "DELETE" })).body.snoozes).toEqual([{ threadId: ids.quiet, until }]);
  await call(`/api/thread-snoozes/${ids.quiet}`, { method: "DELETE" });
  expect(await snoozes()).toEqual([]);
});

it("wakes marked unread when a question arrives, then refuses to snooze until it is answered", async () => {
  await call(`/api/bots/${ids.bot}/tasks/${ids.asking}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  expect((await call(`/api/thread-snoozes/${ids.asking}`, { method: "PUT", body: JSON.stringify({ until: Date.now() + 60 * 60_000 }) })).status).toBe(200);
  expect((await task(ids.asking)).unread).toBe(false);
  await call(`/api/bots/${ids.bot}/messages`, { method: "POST", body: JSON.stringify({ threadId: ids.asking, text: "Ask me first. __fixture_ask_user_question__" }) });
  // The wake is pushed by the card itself, not by this read: poll the task,
  // which does not sweep, before asking for the list, which does.
  await expect.poll(async () => (await task(ids.asking)).unread, { timeout: 25_000 }).toBe(true);
  expect(await snoozes()).toEqual([]);
  const inbox = (await call("/api/inbox?view=decisions")).body;
  expect(inbox.questionThreads).toEqual({ [ids.asking]: 1 });
  expect(inbox.questions).toBe(1);
  const refused = await call(`/api/thread-snoozes/${ids.asking}`, { method: "PUT", body: JSON.stringify({ until: Date.now() + 60 * 60_000 }) });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatch(/waiting on your answer/);
}, 40_000);

it("wakes marked unread when its time comes", async () => {
  await call(`/api/bots/${ids.bot}/tasks/${ids.quiet}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  expect((await call(`/api/thread-snoozes/${ids.quiet}`, { method: "PUT", body: JSON.stringify({ until: Date.now() + 1_500 }) })).status).toBe(200);
  expect((await snoozes()).map(entry => entry.threadId)).toEqual([ids.quiet]);
  await new Promise(resolve => setTimeout(resolve, 1_700));
  expect(await snoozes()).toEqual([]);
  await expect.poll(async () => (await task(ids.quiet)).unread).toBe(true);
});
