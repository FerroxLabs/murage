// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A room reply is stopped for silence, never for how long it runs (0.1.61).
// Room turns used to carry a fixed ceiling (five minutes by default) that
// stopped long work while it was still streaming. They now share the direct
// path's rule: no events for the silence limit stops the turn, and waiting
// on a person does not count.
//
// The real server runs against the fake pi CLI with the stall clock sped up
// sixty times: one real second is one simulated minute. The old fixed
// ceiling is sped up the same way where it still exists, so this file fails
// on the code it replaces.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const SPEED = 60;
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const stopLines = async (threadId: string) => (await messages(threadId))
  .map((message) => String(message.tool?.name ?? ""))
  .filter((name) => /no activity|exceeded/.test(name));
const roomBusy = async (groupId: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === groupId)?.busyBotId ?? null;

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const SPEED=${SPEED};const t0=Date.now();
    const {TurnWatchdog}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "turn-watchdog.ts")).href)});
    TurnWatchdog.prototype.now=function(){return t0+(Date.now()-t0)*SPEED};
    const watch=TurnWatchdog.prototype.start;
    TurnWatchdog.prototype.start=function(){this.opts={...this.opts,checkMs:100};return watch.call(this)};
    const timeout=await import(${JSON.stringify(pathToFileURL(join(serverDir, "room-turn-timeout.ts")).href)});
    if(timeout.RoomTurnDeadline){const start=timeout.RoomTurnDeadline.prototype.start;timeout.RoomTurnDeadline.prototype.start=function(){this.remainingMs=this.remainingMs/SPEED;start.call(this)};}
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const [id,environment] of [
      ['roomStream',{FAKE_PI_MODE:'stream',FAKE_PI_STREAM_EVERY_MS:'500',FAKE_PI_STREAM_FOR_MS:'8000'}],
      ['roomSilent',{FAKE_PI_MODE:'hold'}],
      ['roomAsk',{FAKE_PI_MODE:'permission'}],
    ])cfg.instances[id]={driver:'piAgent',displayName:id,config:{cli:${JSON.stringify(join(serverDir, "testing/fake-pi-cli.ts"))},fullAuto:true},environment};
    // saved before 0.1.61 as a five-minute ceiling: read as the 20-minute minimum
    cfg.rooms={turnTimeoutMinutes:5};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });

async function roomWith(name: string, instanceId: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "ollama-cloud/glm-5.2" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const group = await api("POST", "/api/groups", { name: `${name} room`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(group.status).toBe(201);
  return { bot, group: group.body.group as { id: string; threadId: string } };
}

it("lets a room reply that keeps streaming run for 8 simulated minutes and finish", async () => {
  const { group } = await roomWith("Long writer", "roomStream");
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "Write the long report" })).status).toBe(202);
  await expect.poll(async () => (await messages(group.threadId)).some((message) => String(message.text ?? "").includes("long reply done")), { timeout: 30_000, interval: 250 }).toBe(true);
  expect(await stopLines(group.threadId)).toEqual([]);
  await expect.poll(() => roomBusy(group.id), { timeout: 10_000 }).toBeNull();
}, 60_000);

it("stops a silent room reply at the silence limit with the no activity line", async () => {
  const { group } = await roomWith("Quiet one", "roomSilent");
  // the fixture saved 5 under the old meaning; it reads as the minimum
  const config = (await api("GET", "/api/config")).body;
  expect(config.rooms).toEqual({ turnTimeoutMinutes: 20 });
  const sentAt = Date.now();
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "Say nothing" })).status).toBe(202);
  await expect.poll(() => stopLines(group.threadId), { timeout: 40_000, interval: 250 }).toEqual([
    "error: no activity for 20 minutes: stopping; waiting for the engine to confirm close",
  ]);
  // twenty simulated minutes of silence, never the old five-minute ceiling
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(18 * 60_000 / SPEED);
  await expect.poll(() => roomBusy(group.id), { timeout: 20_000 }).toBeNull();
}, 70_000);

it("does not count a person's answer time as silence", async () => {
  const { group } = await roomWith("Asker", "roomAsk");
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "Ask me first" })).status).toBe(202);
  const openCard = async () => (await messages(group.threadId)).filter((message) => message.card?.questions?.length && !message.card.answered).at(-1);
  await expect.poll(async () => Boolean(await openCard()), { timeout: 20_000 }).toBe(true);
  // twenty-five simulated minutes with the card open and nothing else happening
  await new Promise((resolve) => setTimeout(resolve, 25 * 60_000 / SPEED));
  expect(await stopLines(group.threadId)).toEqual([]);
  expect(await roomBusy(group.id)).not.toBeNull();
  const card = await openCard();
  const answered = await api("POST", `/api/threads/${group.threadId}/respond`, { requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: ["Allow once"] }] });
  expect(answered.status).toBe(200);
  await expect.poll(() => roomBusy(group.id), { timeout: 20_000 }).toBeNull();
  expect(await stopLines(group.threadId)).toEqual([]);
}, 80_000);
