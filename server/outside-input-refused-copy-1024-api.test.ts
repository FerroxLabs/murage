// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.24 TC-TIDE S10. Owners: lane q1024-brucecopy owns this witness and the outside-input line (shared/resend-offer.ts
// OUTSIDE_INPUT_REFUSED_LINE, memory/dispatch.ts turnRefusedLine/isOutsideInputSource, the startTurn call sites in index.ts); the refusal
// rows and the submission boundary belong to their owners (turn-dispatch-guard.ts, D7 resend rows).
//
// Field shape: a webhook-triggered turn (outside input) was refused at its second send because memory was switched off meanwhile; its row
// read "Murage could not send it again because the submission checks failed", although no owner message exists to send again.
// Real server, real route (POST /api/webhooks/:id/test enqueues a webhook run into startTurn with automationSource "webhook"), the fixture
// driver playing the engine: prompt written, then the send repeated through the fence and refused.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { OUTSIDE_INPUT_REFUSED_LINE } from "../shared/resend-offer.ts";

const ENGINE = "Fixture engine";
const STOPPED = "Stopped: a memory check on outside input did not pass.";
const VAGUE = /could not send it again|Send again|Send it again|may already be working/;
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path} ${response.status}`).toBe(true);
  return await response.json() as any;
};
const gate = (name: string) => join(fixture.info.dataDir, `${name}-resend-gate`);
const toolName = (message: any) => String(message.tool?.name ?? "");
const allRows = async (botId: string) => {
  const runs = (await api("GET", "/api/routines")).runs as any[];
  const threads = new Set<string>([(await api("GET", `/api/bots/${botId}`)).bot?.threadId, ...runs.filter(run => run.botId === botId).map(run => run.threadId)].filter(Boolean));
  const rows: any[] = [];
  for (const id of threads) rows.push(...(await api("GET", `/api/threads/${id}/messages?limit=100`)).messages);
  return rows;
};
const refusalRows = (all: any[]) => all.filter(message => message.role === "bot" && message.kind === "activity" && (message.tool?.errorDetails === "submission_refused" || message.memoryNote === "resend"));

describe.skipIf(process.platform === "win32")("1.0.24 S10: a refused outside-input turn says a memory check on outside input did not pass", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
      // an instance with REVOKE_SETUP throws the memory refusal from every sendTurn before it submits anything (a setup refusal at each rebuild)
      driver.create=async input=>{
        const instance=await create(input);
        if(input.environment.NO_ENGINE_WRITE==='1'){
          // the engine never confirms its write (no onEngineWrite), so the refusal after its released send is uncertain, not confirmed
          const send=instance.adapter.sendTurn.bind(instance.adapter);
          instance.adapter.sendTurn=async turn=>send({...turn,onEngineWrite:undefined});
          return instance;
        }
        if(input.environment.RELEASE_THEN_REVOKE==='1'){
          // the send is released through the fence (an attempt that may have been written) and then the engine call fails with the memory refusal: the catch card, not the settle card
          instance.adapter.sendTurn=async turn=>{turn.beforeSubmit?.();throw new Error('MEMORY_CONTEXT_REVOKED');};
          return instance;
        }
        if(input.environment.REVOKE_SETUP!=='1')return instance;
        instance.adapter.sendTurn=async()=>{throw new Error('MEMORY_CONTEXT_REVOKED');};
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const dir=process.env.MURAGE_DATA_DIR; const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.outside=${JSON.stringify({ driver: "fakeLateTerminal", displayName: ENGINE })};
      cfg.instances.outside.environment={FAKE_LATE_HANDBACK:'1',FAKE_LATE_RESEND_GATE:path.join(dir,'outside-resend-gate')};
      cfg.instances.outsidenote=${JSON.stringify({ driver: "fakeLateTerminal", displayName: ENGINE })};
      cfg.instances.outsidenote.environment={FAKE_LATE_HANDBACK:'1',FAKE_LATE_REFUSE_AFTER_FENCE:'1'};
      cfg.instances.outsidecatch=${JSON.stringify({ driver: "fakeLateTerminal", displayName: ENGINE })};
      cfg.instances.outsidecatch.environment={REVOKE_SETUP:'1'};
      cfg.instances.outsidereleased=${JSON.stringify({ driver: "fakeLateTerminal", displayName: ENGINE })};
      cfg.instances.outsidereleased.environment={RELEASE_THEN_REVOKE:'1'};
      cfg.instances.outsidesettle=${JSON.stringify({ driver: "fakeLateTerminal", displayName: ENGINE })};
      cfg.instances.outsidesettle.environment={FAKE_LATE_HANDBACK:'1',FAKE_LATE_TOOL_FIRST:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'outsidesettle-resend-gate')};
      cfg.instances.outsideuncertain=${JSON.stringify({ driver: "fakeLateTerminal", displayName: ENGINE })};
      cfg.instances.outsideuncertain.environment={FAKE_LATE_HANDBACK:'1',NO_ENGINE_WRITE:'1',FAKE_LATE_RESEND_GATE:path.join(dir,'outsideuncertain-resend-gate')};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("S10 webhook turn refused at its repeated send: ONE error row says Stopped: a memory check on outside input did not pass, no resend offer", async () => {
    expect(OUTSIDE_INPUT_REFUSED_LINE).toBe(STOPPED);
    const bot = (await api("POST", "/api/bots", { name: "Bot outside", modelSelection: { instanceId: "outside", model: "late-1" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    const hook = (await api("POST", "/api/webhooks", { name: "Fixture hook", prompt: "say hello once", botId: bot.id })).webhook as { id: string };
    await api("POST", `/api/webhooks/${hook.id}/test`, {});
    await expect.poll(() => existsSync(`${gate("outside")}.waiting`), { timeout: 30000 }).toBe(true);
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    writeFileSync(gate("outside"), "");
    await expect.poll(async () => refusalRows(await allRows(bot.id)).length, { timeout: 30000 }).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await allRows(bot.id);
    const refused = refusalRows(all);
    expect(refused.map(toolName), JSON.stringify(all.map(m => [m.kind, toolName(m), m.memoryNote ?? ""]))).toEqual([`error: ${STOPPED}`]);
    expect(refused[0].tool.ok).toBe(false);
    expect(JSON.stringify(all)).not.toMatch(VAGUE);
  }, 120000);

  it("S16 card site, uncertain submission: a webhook turn refused at its repeated send (engine never confirmed its write): ONE error row says Stopped: a memory check on outside input did not pass, no resend offer", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Bot outside uncertain", modelSelection: { instanceId: "outsideuncertain", model: "late-1" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    const hook = (await api("POST", "/api/webhooks", { name: "Fixture uncertain hook", prompt: "say hello once", botId: bot.id })).webhook as { id: string };
    await api("POST", `/api/webhooks/${hook.id}/test`, {});
    await expect.poll(() => existsSync(`${gate("outsideuncertain")}.waiting`), { timeout: 30000 }).toBe(true);
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    writeFileSync(gate("outsideuncertain"), "");
    await expect.poll(async () => refusalRows(await allRows(bot.id)).length, { timeout: 30000 }).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await allRows(bot.id);
    const refused = refusalRows(all);
    expect(refused.map(toolName), JSON.stringify(all.map(m => [m.kind, toolName(m), m.memoryNote ?? ""]))).toEqual([`error: ${STOPPED}`]);
    expect(refused[0].tool.ok).toBe(false);
    expect(JSON.stringify(all)).not.toMatch(VAGUE);
  }, 120000);

  it("S11 note site: a webhook turn whose released write is refused gets the same line, and no resend row offering Send again", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Bot outside note", modelSelection: { instanceId: "outsidenote", model: "late-1" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    const hook = (await api("POST", "/api/webhooks", { name: "Fixture note hook", prompt: "say hello once", botId: bot.id })).webhook as { id: string };
    await api("POST", `/api/webhooks/${hook.id}/test`, {});
    await expect.poll(async () => refusalRows(await allRows(bot.id)).length, { timeout: 30000 }).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await allRows(bot.id);
    expect(refusalRows(all).map(toolName), JSON.stringify(all.map(m => [m.kind, toolName(m), m.memoryNote ?? ""]))).toEqual([`error: ${STOPPED}`]);
    expect(all.filter(m => m.memoryNote === "resend")).toEqual([]);
    expect(JSON.stringify(all)).not.toMatch(VAGUE);
  }, 120000);

  // S12 catch card: every send is refused at setup (REVOKE_SETUP), the rebuilds run out and the turn ends on the dispatch-failure card.
  // S13 settle card: a tool already ran, then the memory is switched off before the engine's late write, so the refused turn is not
  // rebuilt and settles with its card.
  for (const [site, instanceId] of [["S12 dispatch-failure catch card", "outsidecatch"], ["S13 settle card", "outsidesettle"], ["S17 catch card after a released write (resend guard)", "outsidereleased"]] as const) {
    it(`${site}: a refused webhook turn says the outside-input line, no Send again, no could-not-start line`, async () => {
      const bot = (await api("POST", "/api/bots", { name: `Bot ${instanceId}`, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
      await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
      const hook = (await api("POST", "/api/webhooks", { name: `Fixture ${instanceId} hook`, prompt: "say hello once", botId: bot.id })).webhook as { id: string };
      await api("POST", `/api/webhooks/${hook.id}/test`, {});
      if (instanceId === "outsidesettle") {
        await expect.poll(() => existsSync(`${gate(instanceId)}.waiting`), { timeout: 30000 }).toBe(true);
        await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
        writeFileSync(gate(instanceId), "");
      }
      const refusalLines = (all: any[]) => all.filter(m => m.role === "bot" && m.kind === "activity" && (toolName(m).startsWith("error:") || m.memoryNote === "resend"));
      await expect.poll(async () => refusalLines(await allRows(bot.id)).length, { timeout: 30000 }).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const all = await allRows(bot.id);
      expect(refusalLines(all).map(toolName), JSON.stringify(all.map(m => [m.kind, toolName(m), m.memoryNote ?? ""]))).toEqual([`error: ${STOPPED}`]);
      expect(all.filter(m => m.memoryNote === "resend")).toEqual([]);
      expect(JSON.stringify(all)).not.toMatch(VAGUE);
    }, 120000);
  }

  // S15 reachability: the room member-turn sites (index.ts roomOutsideInput) only see an outside-input run if a webhook run can become a
  // project-room routine request. It cannot: webhook runs are target "bot" (routines.ts createEventRun), so a bot that leads a project still
  // answers its webhook in its own thread, and the project room never receives the run. This pins that, so the room sites stay not-applicable.
  it("S15 a webhook run for the lead bot of a project runs in the bot's own thread, never in the project room", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Bot outside room", modelSelection: { instanceId: "outsidenote", model: "late-1" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    const group = (await api("POST", "/api/projects", { clientId: "outside-room-project", purpose: "Outside input reachability", mode: "bots", members: [bot.id], leadBotId: bot.id })).group as { id: string; threadId: string };
    const hook = (await api("POST", "/api/webhooks", { name: "Fixture room hook", prompt: "say hello once", botId: bot.id })).webhook as { id: string };
    await api("POST", `/api/webhooks/${hook.id}/test`, {});
    await expect.poll(async () => ((await api("GET", "/api/routines")).runs as any[]).filter(run => run.botId === bot.id).length, { timeout: 30000 }).toBeGreaterThan(0);
    const runs = ((await api("GET", "/api/routines")).runs as any[]).filter(run => run.botId === bot.id);
    expect(runs.map(run => [run.triggerSource, run.target])).toEqual([["webhook", "bot"]]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(runs[0].threadId).not.toBe(group.threadId);
    const room = (await api("GET", `/api/threads/${group.threadId}/messages?limit=100`)).messages as any[];
    expect(JSON.stringify(room)).not.toMatch(/say hello once/);
  }, 120000);
});
