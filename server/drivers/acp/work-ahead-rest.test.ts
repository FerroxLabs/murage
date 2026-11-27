// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAcpDriver } from "./core.ts";
import { hermesAcpSupport } from "./hermes.ts";
import { customAcpSupport } from "./custom.ts";
import { kimiAcpSupport } from "./kimi.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { bindEngineWireFence } from "../engine-wire.ts";
import { launchVerificationServer } from "../../../scripts/control-murage.ts";
import { recordAdmittedEvents } from "../../testing/admitted-events.ts";
import { c11FixtureIntegrations } from "../../testing/c11-mount-fixture.ts";
import { REQUIRED_CONTROLS, ToolLimitStore, toolLimitFile } from "./opencode-tool-budget.ts";
import { DATA_DIR } from "../../config.ts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

useOutsideStoreFixture();
let root = "", instance: ProviderInstance | undefined, recorder: EventRecorder | undefined;
afterEach(async () => { recorder?.stop(); await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); if (root) removeTempDirSync(root); });

// Each test launches its own stdio engine in a throwaway home. No provider or live app is contacted.
async function start(kind: "hermes" | "custom" | "kimi" = "hermes", options: { missing?: boolean; commands?: boolean; answer?: string; holdSteer?: boolean; rpcRefusal?: boolean; steerDelay?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), "murage-acp-rest-"));
  const cli = join(root, "engine.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if(process.argv.includes('--version')) {console.log('Fixture 1.0.0');process.exit(0);}
const out = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update = update => out({method:'session/update',params:{sessionId:'fresh-session',update}});
let held;
const mounts=[];
async function mount(server) {
 const child=spawn(server.command,server.args,{env:{...process.env,...Object.fromEntries(server.env.map(e=>[e.name,e.value]))},stdio:'pipe'});mounts.push(child);child.stderr.resume();child.stdin.on('error',()=>{});
 let seq=0;const pending=new Map();
 createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);const done=pending.get(m.id);if(done){pending.delete(m.id);done(m.result);}}catch{}});
 const rpc=(method,params)=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
 const tools=[];let cursor;do{const page=await rpc('tools/list',cursor?{cursor}:{});tools.push(...(page?.tools??[]));cursor=page?.nextCursor;}while(cursor);appendFileSync(${JSON.stringify(join(root, 'catalog.jsonl'))},JSON.stringify({name:server.name,tools:tools.map(t=>t.name)})+'\\n');
}
process.once('SIGTERM',()=>{for(const child of mounts)child.kill();process.stdin.destroy();});
createInterface({input:process.stdin}).on('line', async line => {
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(join(root, "rpc.jsonl"))},JSON.stringify(m)+'\\n');
 const result = r => out({id:m.id,result:r});
 if(m.method==='initialize') return result({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 if(m.method==='session/load') return out({id:m.id,error:{code:-32602,message:'Session "saved-session" not found (session/load)'}});
 if(m.method==='session/new') {await Promise.all((m.params?.mcpServers??[]).map(mount));result({sessionId:'fresh-session',models:{currentModelId:'fixture',availableModels:[{modelId:'fixture',name:'Fixture'}]}}); ${options.commands === false ? "" : "update({sessionUpdate:'available_commands_update',availableCommands:[{name:'steer',description:'Steer the running turn'}]});"} return;}
 if(m.method==='session/cancel') {if(held) out({id:held,result:{stopReason:'cancelled'}});return;}
 if(m.method==='session/prompt') {
  const text=m.params.prompt[0].text;
  if(text.startsWith('/steer ')) {${options.steerDelay ? 'await new Promise(resolve=>setTimeout(resolve,' + options.steerDelay + '));' : ''}${options.rpcRefusal ? "return out({id:m.id,error:{code:-32601,message:'Steer unavailable'}});" : ''}update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(options.answer ?? "⏩ Steer queued for the active turn:")}}}); ${options.holdSteer ? "setTimeout(()=>out({id:held,result:{stopReason:'end_turn'}}),20);setTimeout(()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'finished fallback'}});result({stopReason:'end_turn'});},16000);" : "result({stopReason:'end_turn'});"} return;}
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'working'}});
  ${options.missing ? "result({stopReason:'end_turn'});" : "if(text.includes('also check the blue folder')) result({stopReason:'end_turn'}); else held=m.id;"} return;
 }
 if(m.id!==undefined) result({});
});
`);
  chmodSync(cli, 0o755);
  const selected = kind === "hermes" ? hermesAcpSupport : kind === "custom" ? customAcpSupport : kimiAcpSupport;
  // Keep the real support's steering/session hooks; omit unrelated login, home overlays and tool tripwires.
  const driver = createAcpDriver({ driverKind: selected.driverKind, displayName: selected.displayName,
    models: { default: "", options: [] }, defaultCli: cli, nativeSource: "fixture.acp", loginNote: "fixture",
    spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
    fluxReach: () => "elsewhere", ...("steer" in selected ? { steer: selected.steer } : {}),
    ...("sessionMcpServers" in selected ? { sessionMcpServers: selected.sessionMcpServers } : {}),
  });
  instance = await driver.create({ instanceId: "rest-fixture", displayName: "Fixture", enabled: true, environment: { HOME: root, USERPROFILE: root }, config: { cli, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  return instance.adapter;
}
function frames(): Array<{ method: string; params?: any }> { try { return readFileSync(join(root, "rpc.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } }
async function running(adapter: NonNullable<typeof instance>["adapter"]) {
  await adapter.sendTurn({ threadId: "fixture-thread", cwd: root, text: "work" });
  await recorder!.until(event => event.type === "content.delta", 15_000);
}

function admittedSteer(): () => void {
  const beforeWrite = () => {};
  bindEngineWireFence(beforeWrite, () => {}, (_wire, write, validate) => { validate?.(); return write(); });
  return beforeWrite;
}

it("a missing saved session starts fresh, replays history and logs the recovery reason", async () => {
  const adapter = await start("hermes", { missing: true });
  const warn = vi.spyOn(console, "warn");
  await adapter.sendTurn({ threadId: "fixture-thread", cwd: root, text: "continue", resumeCursor: "saved-session", transcript: [{ role: "user", text: "Remember the blue folder" }] });
  expect(await recorder!.until(event => event.type === "turn.completed", 15_000)).toMatchObject({ ok: true });
  expect(frames().filter(frame => frame.method === "session/new")).toHaveLength(1);
  expect(frames().find(frame => frame.method === "session/prompt")?.params.prompt[0].text).toContain("blue folder");
  expect(warn.mock.calls.some(call => /stored conversation cursor.*starting a new session/.test(String(call[0])))).toBe(true);
});

it.each(["hermes", "custom"] as const)("%s delivers a steer only to a running turn", async kind => {
  const adapter = await start(kind);
  expect(adapter.capabilities.queueing).toBe(true);
  expect(await adapter.steer?.("fixture-thread", "before start")).toBe("rejected");
  await running(adapter);
  expect(await adapter.steer?.("fixture-thread", "check the totals", admittedSteer())).toBe("delivered");
  expect(frames().filter(frame => frame.method === "session/prompt").map(frame => frame.params.prompt[0].text)).toEqual([expect.stringContaining("work"), "/steer check the totals"]);
  expect(recorder!.events.filter(event => event.type === "content.delta").map(event => event.delta)).toEqual(["working"]);
  await adapter.interruptTurn("fixture-thread");
  expect(await adapter.steer?.("fixture-thread", "after stop")).toBe("rejected");
  expect(frames().filter(frame => frame.method === "session/prompt")).toHaveLength(2);
});

it("an unadvertised steer never writes a prompt", async () => {
  const adapter = await start("hermes", { commands: false });
  await running(adapter);
  expect(await adapter.steer?.("fixture-thread", "try this", admittedSteer())).toBe("rejected");
  expect(frames().filter(frame => frame.method === "session/prompt")).toHaveLength(1);
});

it("an advertised steer with no submission hook writes nothing", async () => {
  const adapter = await start();
  await running(adapter);
  expect(await adapter.steer?.("fixture-thread", "try this")).toBe("rejected");
  expect(frames().filter(frame => frame.method === "session/prompt")).toHaveLength(1);
});

it("a steer stopped by its final submission fence never writes", async () => {
  const adapter = await start();
  await running(adapter);
  expect(await adapter.steer?.("fixture-thread", "try this", () => { throw new Error("stopped"); })).toBe("rejected");
  expect(frames().filter(frame => frame.method === "session/prompt")).toHaveLength(1);
});

it("a steer releases through its own registered wire fence", async () => {
  const adapter = await start();
  await running(adapter);
  const released: string[] = [];
  const beforeWrite = () => {};
  bindEngineWireFence(beforeWrite, () => {}, (wire, write, validate) => { validate?.(); released.push(wire); return write(); });
  expect(await adapter.steer?.("fixture-thread", "use the blue folder", beforeWrite)).toBe("delivered");
  expect(released).toHaveLength(1);
  expect(JSON.parse(released[0]!).params.prompt[0].text).toBe("/steer use the blue folder");
});

it("an acknowledged steer keeps its fallback alive after the original prompt ends", async () => {
  const adapter = await start("hermes", { holdSteer: true });
  await running(adapter);
  expect(await adapter.steer?.("fixture-thread", "finish the fallback", admittedSteer())).toBe("delivered");
  expect(await recorder!.until(event => event.type === "turn.completed", 25_000)).toMatchObject({ ok: true });
  expect(recorder!.events.some(event => event.type === "content.delta" && event.delta === "finished fallback")).toBe(true);
}, 30_000);

it.each([
  ["⚠️ Steer failed: busy", "rejected"],
  ["An unfamiliar reply", "uncertain"],
] as const)("a steer answer %s yields %s without resending", async (answer, outcome) => {
  const adapter = await start("hermes", { answer });
  await running(adapter);
  expect(await adapter.steer?.("fixture-thread", "use the blue folder", admittedSteer())).toBe(outcome);
  expect(frames().filter(frame => frame.method === "session/prompt")).toHaveLength(2);
});

it("the existing OpenCode recovery learns a 128-tool limit and retries once", async () => {
  root = mkdtempSync(join(tmpdir(), "murage-acp-budget-"));
  const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const route = randomUUID().replaceAll("-", "").repeat(2);
  const log = join(root, "budget.jsonl");
  const spec = { native: 11, limit: 128, awaitCatalogExit: true, catalogs: {
    agents: REQUIRED_CONTROLS.filter(name => name !== "project_propose"),
    murage_connectors: Array.from({ length: 140 }, (_, index) => `tool${index}`),
  } };
  const driver = createAcpDriver({ driverKind: "budgetFixture", displayName: "Fixture", models: { default: "opencode/mock", options: [] },
    defaultCli: cli, nativeSource: "fixture.acp", loginNote: "fixture", spawnArgs: () => [], pickAuthMethod: () => null,
    authFailure: "continue", isAuthenticated: () => true, fluxReach: () => "elsewhere", mcpListedWait: true,
    toolBudget: { routeKey: () => route }, transformEnv: env => { env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { "*": "ask" } }); } });
  instance = await driver.create({ instanceId: "budget-fixture", displayName: "Fixture", enabled: true, config: { cli, fullAuto: false },
    environment: { FAKE_ACP_MODE: "c11-budget", FAKE_C11_LOG: log, FAKE_C11_SPEC: JSON.stringify(spec) } });
  recorder = recordAdmittedEvents(instance.adapter);
  const mount = { command: process.execPath, args: [], env: {} };
  await instance.adapter.sendTurn({ threadId: "fixture-thread", cwd: root, text: "work", integrations: c11FixtureIntegrations({ agents: mount, composio: mount }, spec, root) });
  expect(await recorder.until(event => event.type === "turn.completed", 30_000)).toMatchObject({ ok: true });
  const rows = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.filter(row => row.event === "spawn")).toHaveLength(2);
  expect((await new ToolLimitStore(toolLimitFile(DATA_DIR)).get(route))?.limit).toBe(128);
});

// Both sides owned by up-acp-rest: inert ACP peer and the real message/Stop routes.
it.each([
  ["accepted", {}],
  ["RPC refusal", { rpcRefusal: true }],
  ["late RPC refusal", { rpcRefusal: true, steerDelay: 16_500 }],
  ["late text refusal", { answer: "⚠️ Steer failed: busy", steerDelay: 16_500 }],
  ["late acceptance", { steerDelay: 16_500 }],
] as const)("the isolated message route reconciles %s exactly once", async (outcome, options) => {
  await start("custom", options);
  await instance!.dispose(); instance = undefined;
  recorder?.stop(); recorder = undefined;
  const cli = join(root, "engine.mjs");
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const {createAcpDriver}=await import(${JSON.stringify(new URL("./core.ts", import.meta.url).href)});
    const {customAcpSupport}=await import(${JSON.stringify(new URL("./custom.ts", import.meta.url).href)});
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL("../builtIn.ts", import.meta.url).href)});
    BUILT_IN_DRIVERS.push(createAcpDriver({...customAcpSupport,driverKind:'restFixture',resolveModels:undefined,resolveModelsOnCreate:true,spawnArgs:()=>[${JSON.stringify(cli)}],
      models:{default:'fixture',options:[{id:'fixture',label:'Fixture'}]},fluxReach:()=> 'elsewhere'}));
    const fs=await import('node:fs'),path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.computer={...cfg.computer,defaultForNewBots:'off'};
    cfg.instances.rest={driver:'restFixture',config:{cli:process.execPath,fullAuto:false}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const proof = await api("GET", "/api/desktop-secret");
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    const created = await api("POST", "/api/bots", { name: "Fixture", modelSelection: { instanceId: "rest", model: "fixture" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", autoApprove: false, autoReview: "off" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "work" })).status).toBe(202);
    await expect.poll(() => frames().filter(frame => frame.method === "session/prompt").length, { timeout: 30_000 }).toBe(1);
    const response = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "also check the blue folder" });
    expect(response.status).toBe(202);
    if (outcome === "RPC refusal") expect(response.body.queued).toBe(true);
    if (outcome.startsWith("late")) {
      expect(response.body.message.steerUnconfirmed).toBe(true);
      await expect.poll(async () => {
        const result = await api("GET", `/api/threads/${bot.threadId}/messages`);
        return result.body.messages.find((row: any) => row.text === "also check the blue folder")?.steerUnconfirmed ?? false;
      }, { timeout: 25_000 }).toBe(false);
    }
    await expect.poll(() => frames().some(frame => frame.method === "session/prompt" && frame.params.prompt[0].text.startsWith("/steer ")), { timeout: 15_000 }).toBe(true);
    const pending = (await api("GET", "/api/bots")).body.pendingSends?.[bot.threadId] ?? [];
    if (outcome.includes("refusal")) expect(pending).toEqual([expect.objectContaining({ text: "also check the blue folder", state: "queued" })]);
    else expect(pending).toEqual([]);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    const expectedPrompts = outcome.includes("refusal") ? 3 : 2;
    await expect.poll(() => frames().filter(frame => frame.method === "session/prompt").length, { timeout: 30_000 }).toBe(expectedPrompts);
    const count = frames().filter(frame => frame.method === "session/prompt").length;
    const messages = await api("GET", `/api/threads/${bot.threadId}/messages`);
    expect(messages.body.messages.filter((row: any) => row.role === "user" && row.text === "also check the blue folder")).toHaveLength(1);
    expect(JSON.stringify(messages.body)).not.toContain("⏩ Steer queued");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((row: any) => row.id === bot.id)?.busy, { timeout: 15_000 }).toBe(false);
    console.log("Isolated ACP workflow evidence", JSON.stringify({
      action: "send, steer, Stop", fixtureLog: fixture.info.logPath,
      methods: frames().map(frame => frame.method), prompts: count, busy: false,
      messages: messages.body.messages.filter((row: any) => row.role === "user" || row.role === "assistant").map((row: any) => ({ role: row.role, text: row.text })),
    }));
  } catch (error) {
    console.error("Isolated fixture log", readFileSync(fixture.info.logPath, "utf8").slice(-6000));
    throw error;
  } finally { await fixture.close(); }
}, 180_000);

// Both sides owned by up-acp-rest: real Kimi turn setup and inert paginated MCP peers.
it("a complete Kimi turn omits a server with an oversized later page and retains another server", async () => {
  const adapter = await start("kimi", { missing: true });
  recorder!.stop(); recorder = recordAdmittedEvents(adapter);
  const peer = join(root, "catalog.mjs");
  writeFileSync(peer, `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const tool={name:process.env.LARGE?'large':m.params?.cursor?'searchNext':'search',inputSchema:{type:'object',description:'x'.repeat(process.env.LARGE&&m.params?.cursor?13000:1)}};const result=m.method==='tools/list'?{tools:[tool],...(!m.params?.cursor?{nextCursor:'page2'}:{})}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  await adapter.sendTurn({ threadId: "fixture-thread", cwd: root, text: "work", integrations: {
    agents: { command: process.execPath, args: [peer], env: {} },
    composio: { command: process.execPath, args: [peer], env: { LARGE: "1" } },
  } });
  expect(await recorder!.until(event => event.type === "turn.completed", 30_000)).toMatchObject({ ok: true });
  const catalogs = readFileSync(join(root, "catalog.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(catalogs.find(row => row.name === "agents")?.tools).toEqual(["search", "searchNext"]);
  expect(catalogs.find(row => row.name !== "agents")?.tools).toEqual([]);
  console.log("Kimi catalog evidence", JSON.stringify(catalogs));
});
