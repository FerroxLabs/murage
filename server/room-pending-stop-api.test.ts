import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const rows = () => {
  const file = join(fixture.info.dataDir, "room-stops.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const {RoomTurnDeadline}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "room-turn-timeout.ts")).href)});
    const start=RoomTurnDeadline.prototype.start;
    RoomTurnDeadline.prototype.start=function(){this.remainingMs=1000;start.call(this)};
    const {PiDriver}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "drivers/pi.ts")).href)});
    const create=PiDriver.create;
    PiDriver.create=async function(input){
      const instance=await create.call(this,input);if(input.instanceId!=='roomHold')return instance;
      const adapter=instance.adapter,stop=adapter.interruptTurn.bind(adapter),observe=adapter.awaitTurnTeardown.bind(adapter);
      const log=row=>fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'room-stops.jsonl'),JSON.stringify(row)+'\\n');
      const send=adapter.sendTurn.bind(adapter);
      adapter.sendTurn=async input=>{const result=await send(input);log({send:true,threadId:input.threadId,turnId:result.turnId});return result};
      adapter.interruptTurn=async(threadId,turnId)=>{log({stop:true,threadId,turnId});return {closeConfirmed:false,reason:'timeout'}};
      let closing;
      adapter.awaitTurnTeardown=async(threadId,turnId)=>{
        log({observe:true,threadId,turnId});
        if(!fs.existsSync(path.join(process.env.MURAGE_DATA_DIR,'allow-room-close')))return {closeConfirmed:false,reason:'timeout'};
        closing??=stop(threadId,turnId);await closing;
        const receipt=await observe(threadId,turnId);log({closed:receipt.closeConfirmed,threadId,turnId});return receipt;
      };return instance;
    };
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const [id,mode] of [['roomHold','hold'],['roomHappy','happy']])cfg.instances[id]={driver:'piAgent',displayName:id,
      config:{cli:${JSON.stringify(join(serverDir, "testing/fake-pi-cli.ts"))},fullAuto:true},environment:{FAKE_PI_MODE:mode}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("retains a timed-out room beyond six seconds, queues its next prompt without dispatch and releases only after the exact fake child closes", async () => {
  const bot = async (name: string, instanceId: string) => {
    const result = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "ollama-cloud/glm-5.2" } });
    expect(result.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return result.body.bot;
  };
  const slow = await bot("Pending close", "roomHold"), fast = await bot("Independent", "roomHappy");
  const room = async (name: string, botId: string) => {
    const result = await api("POST", "/api/groups", { name, memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } });
    expect(result.status).toBe(201);return result.body.group;
  };
  const held = await room("Held room", slow.id), independent = await room("Independent room", fast.id);
  const state = async () => (await api("GET", "/api/bots?messages=0")).body;
  expect((await api("POST", `/api/groups/${held.id}/messages`, { text: "Wait for explicit close" })).status).toBe(202);
  await expect.poll(() => rows().filter(row => row.stop).length, { timeout: 15000 }).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 6500));
  expect((await state()).groups.find((group: any) => group.id === held.id).busyBotId).toBe(slow.id);
  expect((await state()).bots.find((candidate: any) => candidate.id === slow.id).busy).toBe(true);
  const queued = await api("POST", `/api/groups/${held.id}/messages`, { text: "Must not start another member" });
  expect(queued.status).toBe(202);
  expect(queued.body).toMatchObject({ queued: true, threadId: held.threadId });
  expect(queued.body.queueId).toEqual(expect.any(String));
  expect((await api("POST", `/api/groups/${independent.id}/messages`, { text: "Other room may proceed" })).status).toBe(202);
  await expect.poll(async () => (await api("GET", `/api/threads/${independent.threadId}/messages?limit=50`)).body.messages.some((message: any) => message.text === "Hello from pi"), { timeout: 15000 }).toBe(true);
  await expect.poll(async () => (await api("GET", `/api/threads/${held.threadId}/messages?limit=50`)).body.messages.some((message: any) => message.tool?.name?.includes("stopping; waiting for the engine to confirm close")), { timeout: 5000 }).toBe(true);
  expect(rows().filter(row => row.send)).toHaveLength(1);
  expect((await state()).groups.find((group: any) => group.id === held.id).busyBotId).toBe(slow.id);
  expect((await api("DELETE", `/api/groups/${held.id}/queue/${queued.body.queueId}`)).status).toBe(200);
  writeFileSync(join(fixture.info.dataDir, "allow-room-close"), "fixture close allowed");
  await expect.poll(async () => (await state()).groups.find((group: any) => group.id === held.id).busyBotId, { timeout: 15000 }).toBeNull();
  expect((await state()).bots.find((candidate: any) => candidate.id === slow.id).busy).toBe(false);
  const stops = rows().filter(row => row.stop), closes = rows().filter(row => row.closed);
  expect(rows().filter(row => row.send)).toHaveLength(1);
  expect(stops).toHaveLength(1);expect(stops[0].turnId).toEqual(expect.any(String));
  expect(closes).toHaveLength(1);expect(closes[0]).toMatchObject({ threadId: held.threadId, turnId: stops[0].turnId });
}, 45000);
