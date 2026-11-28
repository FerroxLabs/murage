// SPDX-License-Identifier: AGPL-3.0-or-later
// CHROME-RESUME-FROM-APP (1.0.23, row CR): the real HTTP route. canResumeHere is true for the desktop app, and a Resume that names no
// generation is refused 400 before anything else (U5). Real isolated Murage server with a fake engine; no browser is launched.
// W13c route resume_unconfirmed: a Resume the extension accepts without its `resumed` event reaching the server answers 200 with code resume_unconfirmed and the
// binding still paused. The broker module is a declared fake (the phone and MCP API tests use the same one): it records commands and never
// emits `resumed`; the HTTP route, the integration, the service and the policy are the real ones.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
// A declared fake broker in place of server/browser-extension-broker.ts: one profile with the app-resume capability, a bind makes the tab,
// pause/stop move its generation, and every command is appended to commands.jsonl in the data folder. It never sends a `resumed` event.
const fakeBroker = `
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/browser-extension-registration.mjs'))return {format:'module',shortCircuit:true,source:"export async function connectOwnerBrowser(input){if(!input.ownerConfirmed)throw Error('consent');return {status:'installed',connected:false}};export async function removeOwnerBrowser(){return {status:'removed'}}"};
 if(!url.endsWith('/browser-extension-broker.ts'))return next(url,context);
 return {format:'module',shortCircuit:true,source:\`
 import {appendFileSync} from 'node:fs';
 export async function startBrowserExtensionBroker(){
  const bindings=new Map();
  return {configPath:'/fixture-only/no-native-registration',profiles:()=>[{version:1,type:'hello',profileId:'fixture_profile',browser:'chromium',extensionVersion:'1.0.2',capabilities:['scoped_cdp','durable_stop','explicit_share','manual_pause','unexpected_input_pause','engine_cdp_v1','ordered_requests_v1','app_resume_v1']}],close:async()=>{},request:async(profile,command)=>{
   appendFileSync(process.env.MURAGE_DATA_DIR+'/commands.jsonl',JSON.stringify({operation:command.operation,generation:command.generation,params:command.params})+String.fromCharCode(10));
   let b=bindings.get(command.bindingId);
   if(!b){b={generation:command.generation,state:'active',tabs:[{tabId:bindings.size+1,navigationEpoch:1,origin:'null',url:'about:blank'}]};bindings.set(command.bindingId,b)}
   if(command.operation==='stop'||command.operation==='pause'){b.generation++;b.state=command.operation==='stop'?'stopped':'paused'}
   return{version:1,type:'response',id:command.id,bindingId:command.bindingId,generation:command.generation,result:{...b}};
  }};
 }
 \`};
}});
`;
let fixture: VerificationServer; let headers: Record<string, string> = {}; let model: string; let runtimeRoot: string; let resourcesRoot: string;
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
beforeAll(async () => {
  const root = resolve(".test-tmp"); mkdirSync(root, { recursive: true });
  runtimeRoot = mkdtempSync(join(process.platform === "win32" ? tmpdir() : realpathSync("/tmp"), "mbe-res-"));
  resourcesRoot = mkdtempSync(join(root, "resources-")); mkdirSync(join(resourcesRoot, "browser-extension"));
  writeFileSync(join(resourcesRoot, "browser-extension", "build.json"), JSON.stringify({ version: 1, mode: "development", developmentId: "b".repeat(32) }));
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `process.env.MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT=${JSON.stringify(runtimeRoot)};process.env.MURAGE_BROWSER_EXTENSION_RESOURCES_PATH=${JSON.stringify(resourcesRoot)};${fakeBroker}` } as never);
  const secret = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); if (runtimeRoot) removeTempDirSync(runtimeRoot); if (resourcesRoot) removeTempDirSync(resourcesRoot); });
it("W13c route: the desktop sees canResumeHere, and a resume with no generation is 400", async () => {
  const created = await api("POST", "/api/bots", { name: "Resume route fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const read = await api("GET", `/api/bots/${created.body.bot.id}/browser-extension`);
  expect(read.status).toBe(200); expect(read.body.canResumeHere).toBe(true);
  expect((await api("POST", `/api/bots/${created.body.bot.id}/browser-extension`, { action: "resume", bindingId: "binding" })).status).toBe(400);
  expect((await api("POST", `/api/bots/${created.body.bot.id}/browser-extension`, { action: "resume", bindingId: "binding", generation: 3 })).status).toBe(404);
});
it("W13c route resume_unconfirmed: a Resume whose resumed event never reaches the server is 200 with code resume_unconfirmed, and the task stays paused", async () => {
  expect((await fetch(fixture.info.url + "/api/config", { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) })).status).toBe(200);
  const botId = (await api("GET", "/api/bots")).body.bots[0].id;
  expect((await api("POST", `/api/bots/${botId}/browser-extension`, { action: "connect" })).status).toBe(200);
  expect((await api("POST", "/api/browser-extension/clients", { action: "enabled", enabled: true })).status).toBe(200);
  const preview = await api("POST", "/api/browser-extension/clients", { action: "preview", label: "Resume route client", profileId: "fixture_profile" });
  const paired = await api("POST", "/api/browser-extension/clients", { action: "pair", label: "Resume route client", profileId: "fixture_profile", disclosureKey: preview.body.disclosure?.disclosureKey });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  const saved = JSON.parse(readFileSync(paired.body.config.mcpServers["murage-browser"].env.MURAGE_BROWSER_MCP_CONFIG, "utf8"));
  const client = { authorization: `Bearer ${saved.token}`, "x-murage-browser-client": saved.clientId };
  const listed = await fetch(fixture.info.url + "/api/browser-extension/mcp", { method: "POST", headers: { ...client, "content-type": "application/json" }, body: JSON.stringify({ method: "tools/list" }) });
  expect(listed.status).toBe(200);
  const route = `/api/bots/${paired.body.botId}/browser-extension`;
  const [binding] = (await api("GET", route)).body.bindings;
  expect(binding).toMatchObject({ profileId: "fixture_profile", state: "active" });
  expect((await api("POST", route, { action: "pause", bindingId: binding.bindingId })).status).toBe(200);
  const paused = (await api("GET", route)).body.bindings[0];
  expect(paused).toMatchObject({ bindingId: binding.bindingId, state: "paused" });
  const commands = () => readFileSync(join(fixture.info.dataDir, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const from = commands().length;
  const resumed = await api("POST", route, { action: "resume", bindingId: binding.bindingId, generation: paused.generation });
  // The extension took the command (it answered) but its `resumed` event never came: the route says so, and the server never wrote active.
  expect(commands().slice(from).filter(command => command.operation === "resume")).toEqual([expect.objectContaining({ generation: paused.generation, params: { reason: "app_owner" } })]);
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  expect(resumed.body.code).toBe("resume_unconfirmed");
  expect(resumed.body.bindings[0]).toMatchObject({ bindingId: binding.bindingId, state: "paused", generation: paused.generation });
  // A plain read never carries the code.
  expect((await api("GET", route)).body.code).toBeUndefined();
});
