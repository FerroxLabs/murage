// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
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
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 46000, span: 900 }, instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    // Capture only the assembled system text, never the fixture environment.
    delete process.env.FAKE_CLAUDE_DUMP;
    const {FuigoAgentDriver}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "drivers/fuigoagent.ts")).href)});
    const {ClaudeDriver}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "drivers/claude.ts")).href)});
    for(const [id,driver] of [['fuigoRoom',FuigoAgentDriver],['claudeRoom',ClaudeDriver]]){
      const create=driver.create;
      driver.create=async function(input){
        const instance=await create.call(this,input);
        if(input.instanceId!==id)return instance;
        // The fake ACP CLI has no Fuigo catalog or account. Pin fixture metadata.
        if(id==='fuigoRoom'){
          Object.defineProperty(instance,'models',{get:()=>({default:'fixture',options:[{id:'fixture',label:'Fixture'}]})});
          instance.refreshModels=async()=>instance.models;
          instance.snapshot=async()=>({state:'available',version:'fixture',authenticated:true});
        }
        const send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{
          fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,id+'.json'),JSON.stringify({system:turn.system}));
          return send(turn);
        };return instance;
      };
    }
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.fuigoRoom={driver:'fuigoAgent',displayName:'Fuigo room fixture',environment:{FAKE_ACP_MODE:'happy'},config:{cli:${JSON.stringify(join(serverDir, "testing/fake-acp-cli.ts"))},fullAuto:true}};
    cfg.instances.claudeRoom={driver:'claudeAgent',displayName:'Claude room fixture',config:{cli:${JSON.stringify(join(serverDir, "testing/fake-claude-cli.ts"))}}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it.each(["fuigoRoom", "claudeRoom"])("assembles the appropriate room tool instruction for %s", async instanceId => {
  const engines = (await api("GET", "/api/instances")).body.instances;
  const model = engines.find((engine: any) => engine.instanceId === instanceId).models.options[0].id;
  const created = await api("POST", "/api/bots", { name: instanceId, modelSelection: { instanceId, model } });
  expect(created.status).toBe(201);
  const botId = created.body.bot.id;
  expect((await api("PATCH", `/api/bots/${botId}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const createdRoom = await api("POST", "/api/groups", { name: instanceId, memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } });
  expect(createdRoom.status).toBe(201);
  expect((await api("POST", `/api/groups/${createdRoom.body.group.id}/messages`, { text: "Reply with one line." })).status).toBe(202);
  const file = join(fixture.info.dataDir, instanceId + ".json");
  await expect.poll(() => existsSync(file), { timeout: 20000 }).toBe(true);
  const { system } = JSON.parse(readFileSync(file, "utf8"));
  expect(system.length).toBeGreaterThan(0);
  if (instanceId === "fuigoRoom") {
    expect(system).toContain("use_tool");
    expect(system).toContain("agents__delegate_bot");
    // The room's own lines name tools the way Fuigo calls them.
    expect(system).toContain('use use_tool with tool_name "agents__request_credential" to show the secure in-app card');
    expect(system).not.toMatch(/use request_credential|use list_routines/);
  } else {
    expect(system).not.toContain("use_tool");
    expect(system).toContain("use request_credential to show the secure in-app card");
  }
}, 30000);
