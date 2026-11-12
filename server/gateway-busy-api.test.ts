// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
function saveEvidence(name: string, text: string | Buffer): void {
  const directory = process.env.BUSYLOOP_EVIDENCE_DIR;
  if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), text); }
}
let fixture: VerificationServer;
let headers: Record<string, string>;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return await response.json() as any;
}
beforeAll(async () => {
  const url = (file: string) => pathToFileURL(join(process.cwd(), file)).href;
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const dir=process.env.MURAGE_DATA_DIR;
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(url("server/drivers/builtIn.ts"))});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(url("server/testing/fake-late-terminal-driver.ts"))});
    const driver=makeLateTerminalDriver();
    driver.driverKind='fuigoAgent'; driver.metadata={displayName:'Fuigo'};
    const create=driver.create.bind(driver);
    driver.create=async input=>{
      const instance=await create(input); instance.driverKind='fuigoAgent';
      const onEvent=instance.adapter.onEvent.bind(instance.adapter);
      instance.adapter.onEvent=listener=>onEvent(event=>{
        event={...event,provider:'fuigoAgent'};
        const mode=readFileSync(join(dir,'refusal-mode'),'utf8');
        if(mode==='success')return listener({...event, provider:"fuigoAgent"});
        if(event.type==='turn.started'||event.type==='session.started')return listener({...event, provider:"fuigoAgent"});
        if(event.type!=='turn.completed')return;
        listener({...event,eventId:event.eventId+'-refusal',type:'runtime.error',message:'API error (status 429): capacity unavailable',httpStatus:429,providerError:{kind:'rate-limit',httpStatus:429},...(mode==='cap'?{gatewayCode:'free_cap_reached'}:{})});
        listener({...event,ok:false,stopReason:'failed'});
      });
      return instance;
    };
    BUILT_IN_DRIVERS.splice(BUILT_IN_DRIVERS.findIndex(d=>d.driverKind==='fuigoAgent'),1,driver);
    const file=join(dir,'config.json'), cfg=JSON.parse(readFileSync(file,'utf8'));
    cfg.instances.refusing={driver:'fuigoAgent',displayName:'Fuigo',environment:{}};
    writeFileSync(file,JSON.stringify(cfg));writeFileSync(join(dir,'refusal-mode'),'busy');
  ` });
  const proof = await fetch(fixture.info.url + "/api/desktop-secret").then(r => r.json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120000);
afterAll(async () => { if (fixture) saveEvidence("api-server.log", readFileSync(fixture.info.logPath)); await fixture?.close(); });
it("third refused send emits the repeat card; success resets; cap always keeps its own card", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Busy fixture", modelSelection: { instanceId: "refusing", model: "late-1" } })).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).messages as any[];
  let seen = 0;
  const refuse = async (expected: string) => {
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `try ${++seen}` });
    await expect.poll(async () => { const rows = await messages(); saveEvidence("api-messages.json", JSON.stringify(rows, null, 2)); return rows.filter(m => m.tool?.busy).length; }, { timeout: 60000 }).toBe(seen);
    const rows = (await messages()).filter(m => m.tool?.busy);
    expect(rows.at(-1).tool.busy.reason).toBe(expected);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15000 }).toBe(false);
  };
  await refuse("busy"); await refuse("busy"); await refuse("repeated");
  expect((await messages()).filter(m => m.tool?.busy).at(-1).tool.busy.shortReason).toBe("capacity unavailable");
  expect(readFileSync(fixture.info.logPath, "utf8")).toMatch(/gateway busy .*consecutive=3/);
  writeFileSync(join(fixture.info.dataDir, "refusal-mode"), "success");
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "succeed" });
  await expect.poll(async () => (await messages()).some(m => m.text === "Hello from late"), { timeout: 60000 }).toBe(true);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy).toBe(false);
  writeFileSync(join(fixture.info.dataDir, "refusal-mode"), "busy");
  await refuse("busy");
  writeFileSync(join(fixture.info.dataDir, "refusal-mode"), "cap");
  await refuse("freeCap");
}, 180000);
