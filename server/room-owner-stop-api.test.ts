import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const observations = () => {
  const file = join(fixture.info.dataDir, "owner-stop.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    const fs=await import('node:fs');const path=await import('node:path');
    const {PiDriver}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "drivers/pi.ts")).href)});
    const create=PiDriver.create;
    PiDriver.create=async function(input){
      const instance=await create.call(this,input);if(input.instanceId!=='ownerHold')return instance;
      const adapter=instance.adapter,stop=adapter.interruptTurn.bind(adapter),observe=adapter.awaitTurnTeardown.bind(adapter);
      const log=row=>fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'owner-stop.jsonl'),JSON.stringify(row)+'\\n');
      const send=adapter.sendTurn.bind(adapter);
      adapter.sendTurn=async input=>{const result=await send(input);log({send:true,threadId:input.threadId,turnId:result.turnId});return result};
      adapter.interruptTurn=async(threadId,turnId)=>{log({stop:true,threadId,turnId});return {closeConfirmed:false,reason:'timeout'}};
      let closing;
      adapter.awaitTurnTeardown=async(threadId,turnId)=>{
        log({observe:true,threadId,turnId});
        if(!fs.existsSync(path.join(process.env.MURAGE_DATA_DIR,'owner-close')))return {closeConfirmed:false,reason:'timeout'};
        closing??=stop(threadId,turnId);await closing;
        const receipt=await observe(threadId,turnId);log({closed:receipt.closeConfirmed,threadId,turnId});return receipt;
      };return instance;
    };
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.ownerHold={driver:'piAgent',displayName:'Owner stop fixture',config:{cli:${JSON.stringify(join(serverDir, "testing/fake-pi-cli.ts"))},fullAuto:true},environment:{FAKE_PI_MODE:'hold'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("owner Stop settles a room operation after its exact child closes, while holding the next send", async () => {
  const made = await api("POST", "/api/bots", { name: "Stopped member", modelSelection: { instanceId: "ownerHold", model: "ollama-cloud/glm-5.2" } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const created = await api("POST", "/api/groups", { name: "Owner stop room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(created.status).toBe(201);
  const group = created.body.group;
  const state = async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((candidate: any) => candidate.id === group.id);
  writeFileSync(join(fixture.info.dataDir, "owner-stop.jsonl"), "");
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "Wait for an owner stop" })).status).toBe(202);
  await expect.poll(() => observations().filter(row => row.send).length, { timeout: 15000 }).toBe(1);
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { all: true })).status).toBe(200);
  expect((await state()).busyBotId).toBe(bot.id);
  const queued = await api("POST", `/api/groups/${group.id}/messages`, { text: "Wait for the first child to close" });
  expect(queued.status).toBe(202);
  expect(queued.body.queued).toBe(true);
  expect(observations().filter(row => row.send)).toHaveLength(1);
  expect((await api("DELETE", `/api/groups/${group.id}/queue/${queued.body.queueId}`)).status).toBe(200);
  writeFileSync(join(fixture.info.dataDir, "owner-close"), "close allowed");
  await expect.poll(async () => { const room = await state(); return !room.working && room.busyBotId === null; }, { timeout: 15000 }).toBe(true);
  const stops = observations().filter(row => row.stop), closed = observations().filter(row => row.closed);
  expect(stops).toHaveLength(1);
  expect(stops[0].turnId).toEqual(expect.any(String));
  expect(closed).toHaveLength(1);
  expect(closed[0]).toMatchObject({ threadId: group.threadId, turnId: stops[0].turnId });
  expect(observations().filter(row => row.send)).toHaveLength(1);
});
