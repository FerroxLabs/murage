// SPDX-License-Identifier: AGPL-3.0-or-later
// K2 (nativecrash stage 2, M13) for openai, I2 default "Stop after claim" through the REAL Stop route (k2Server + k2Stop,
// testing/nativecrash-k2.ts): a production revoke refuses the running openai turn, the lease's one interruptTurn (K3) is held, and the
// owner's Stop arrives while that close is pending. LLS S1: the Stop joins the refusal close (server log line), adds no interruptTurn of
// its own, and the turn ends as the refusal: one refusal row, no error card, the bot not busy.
// Owners: the Stop route + lease = G0 (fix/1019-nc-shared, server/index.ts); the openai driver side = G4 (this branch).
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { k2Server, k2Stop, type K2ServerFixture } from "../testing/nativecrash-k2.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";

const dir = dirname(fileURLToPath(import.meta.url));
let fixture: K2ServerFixture, headers: Record<string, string>, provider: Server, providerUrl = "";
/** Chat-completions requests the fixture provider saw, and the held replies (released by the test). */
const seen: string[] = []; const heldReplies: Array<() => void> = [];
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const data = (name: string) => join(fixture.info.dataDir, name);
const interrupts = () => existsSync(data("oa-interrupts")) ? readFileSync(data("oa-interrupts"), "utf8").length : 0;
const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId).busy as boolean;

beforeAll(async () => {
  provider = createServer((req, res) => {
    req.resume();
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    seen.push(req.url);
    // The stream opens and stays open: the turn is running, waiting on its model, when the revoke lands.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture" } }] })}\n\n`);
    heldReplies.push(() => res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: " reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("fixture provider has no port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
  fixture = await k2Server(`
    process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    await import(${JSON.stringify(new URL("./testing/recall-ready-preload.mjs", import.meta.url).href)});
    const fs=await import('node:fs'), path=await import('node:path'), data=process.env.MURAGE_DATA_DIR;
    // The admitted ledger lease of the turn (admittedLedgerLeases.set), captured without touching tracked code, as T37-L does; while
    // lease-refuse-arm names a thread, its open lease takes the ledger refusal (the production lease port, onLedgerRefused).
    const leases=new Set(), mapSet=Map.prototype.set;
    Map.prototype.set=function(k,v){if(v&&typeof v==='object'&&typeof v.onLedgerRefused==='function'&&typeof v.attach==='function'&&typeof v.admissionNotLaunched==='function')leases.add(v);return mapSet.call(this,k,v);};
    const leaseArm=path.join(data,'lease-refuse-arm');
    setInterval(()=>{
      if(!fs.existsSync(leaseArm))return;const threadId=fs.readFileSync(leaseArm,'utf8');
      const lease=[...leases].find(l=>l.identity.threadId===threadId&&l.state==='open'&&l.providerTurnId);
      if(!lease)return;fs.unlinkSync(leaseArm);
      fs.writeFileSync(path.join(data,'lease-refused.json'),JSON.stringify({generation:lease.identity.dispatchGeneration}));
      lease.onLedgerRefused({state:'checking',reason:'not-built'});
    },5).unref();
    const { OpenAICompatDriver }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/openai-compat.ts")).href)});
    const create=OpenAICompatDriver.create;
    OpenAICompatDriver.create=async input=>{
      const instance=await create(input), interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
      // Every engine interrupt is counted; while armed, the first one (the lease's fallback close) is held until the test releases it.
      instance.adapter.interruptTurn=async(...args)=>{
        fs.appendFileSync(path.join(data,'oa-interrupts'),'x');
        const arm=path.join(data,'oa-hold-arm'), gate=path.join(data,'oa-hold');
        if(fs.existsSync(arm)){fs.unlinkSync(arm);fs.writeFileSync(gate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});}
        return interrupt(...args);
      };
      return instance;
    };
    const file=path.join(data,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.computer={...cfg.computer,defaultForNewBots:'off'};
    cfg.openaiCompat={url:${JSON.stringify(providerUrl)},key:'fixture-credential'};
    cfg.instances={...cfg.instances,openaiCompat:{driver:'openai-compat'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  `);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);
afterAll(async () => {
  for (const release of heldReplies.splice(0)) release();
  await fixture?.close();
  await new Promise<void>(resolve => provider ? provider.close(() => resolve()) : resolve());
});

it("openai K2 real Stop route: a Stop while the lease's refusal close is pending joins it, no interruptTurn of its own, ends as the refusal", async () => {
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "openaiCompat", model: "fixture-model" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200); return bot;
  };
  const bot = await create("Stop refused openai");
  for (;;) {
    try { await prepareFixtureRecall(fixture.info.dataDir, bot.id, bot.threadId); break; }
    catch (error) { if (!String(error).includes("MEMORY_RECALL_STORAGE_LIMIT")) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  writeFileSync(data("oa-hold-arm"), "");
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop this refused openai turn" })).status).toBe(202);
  await expect.poll(() => seen.length, { timeout: 15000 }).toBe(1);
  // A bystander's section move revokes no receipt of this turn (its recall is empty: probe k2stop-2.log), so the ledger refusal is raised
  // through the turn's own captured lease (T37-L); the lease's one close is held at its interruptTurn.
  writeFileSync(data("lease-refuse-arm"), bot.threadId);
  for (let i = 0; i < 100 && !existsSync(data("oa-hold.waiting")); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!existsSync(data("oa-hold.waiting"))) console.log("NC-K2-OA-PROBE " + JSON.stringify({ interrupts: interrupts(), busy: await busy(bot.id), log: readFileSync(fixture.info.logPath, "utf8").split("\n").filter(l => /refus|lease|revok|recall|memory|stop|openai/i.test(l)).slice(-25).map(l => l.slice(0, 200)) }));
  expect(existsSync(data("oa-hold.waiting")), "the lease's close reached interruptTurn").toBe(true);
  const leaseInterrupts = interrupts();
  expect(leaseInterrupts, "the lease's fallback close is the turn's one interruptTurn").toBe(1);
  const joined = () => readFileSync(fixture.info.logPath, "utf8").includes(`[stop] owner Stop joined the refusal close on thread ${bot.threadId}`);
  const stopping = k2Stop(fixture, headers, bot.id, bot.threadId);
  await expect.poll(joined, { timeout: 15000 }).toBe(true);
  expect(interrupts(), "the owner's Stop joins the refusal close: no interruptTurn of its own").toBe(leaseInterrupts);
  writeFileSync(data("oa-hold"), "release");
  expect((await stopping).status).toBe(200);
  await expect.poll(() => busy(bot.id), { timeout: 15000 }).toBe(false);
  expect(interrupts(), "no interruptTurn after the close either").toBe(leaseInterrupts);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  console.log("NC-K2-OA-STOP " + JSON.stringify({ interrupts: interrupts(), rows: messages.map(m => [m.role, m.kind, m.memoryNote, m.tool?.name, String(m.text ?? m.tool?.output ?? "").slice(0, 160)].filter(Boolean).join(":")) }));
  // The sandbox's MCP start notices (no network: "the X tools could not start") come before the refusal; no other error card.
  expect(messages.filter(m => m.tool?.name?.startsWith("error:") && !/tools could not start/.test(m.tool.name)), "no error card").toHaveLength(0);
  expect(messages.filter(m => m.role === "bot" && m.kind === "text" && String(m.text).includes("some of its context is no longer available")), "the turn ends as the refusal: one refusal row").toHaveLength(1);
  expect(messages.filter(m => m.role === "user"), "the message was sent once").toHaveLength(1);
  expect(JSON.stringify(messages), "a joined Stop is no cancel: no stop note").not.toMatch(/You stopped|Stopped by you/);
}, 90000);
