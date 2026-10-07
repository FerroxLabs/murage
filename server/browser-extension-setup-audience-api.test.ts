// SPDX-License-Identifier: AGPL-3.0-or-later
// Route-level test (Opus review of lane 0162-chromereal, audit item 9 / Fable M5): a turn whose words were not
// proven to be the owner's cannot raise the browser setup card, even in a thread that is not unattended (the
// delegated-chain case). Real isolated server and fake engine. The claim's notOwnerAudience flag is set through a
// load hook on the real InternalCapabilities.mint (how a chain earns that flag is tested in execution-audience tests);
// what is under test here is the real /api/internal/request-browser-connection route reading it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
let fixture: VerificationServer; let headers: Record<string, string> = {}; let model: string;
const instrumentation = `
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
  if(url.endsWith('/browser-extension-integration.ts'))return {format:'module',shortCircuit:true,source:\`export class BrowserExtensionIntegration{constructor(){this.approvals={resolve:()=>false};}async start(){return this;}async connectOwner(){return this;}status(){return {profiles:[],bindings:[]};}hostConfigPath(){return 'fixture-helper';}async bind(){return {bindingId:'fixture-binding',profileId:'fixture-profile'};}async dispatch(){return {tools:[]};}async ownerAction(){}cancelThread(){}async close(){}}export function routineThreadSignal(){return ()=>false;}export function delegatedTurnUnattended(){return false;}\`};
  if(url.endsWith('/internal-capabilities.ts')){
    const loaded=next(url,context);
    const patch='\\nconst __murageMint=InternalCapabilities.prototype.mint;InternalCapabilities.prototype.mint=function(input){let forced=[];try{forced=JSON.parse(process.getBuiltinModule("node:fs").readFileSync(process.env.MURAGE_DATA_DIR+"/fixture-not-owner.json","utf8"));}catch{}return __murageMint.call(this,forced.includes(input.threadId)?{...input,notOwnerAudience:true}:input);};\\n';
    return {...loaded,source:String(loaded.source)+patch};
  }
  return next(url,context);
}});
`;
async function api(method: string, path: string, body?: unknown) { const res = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json() as any }; }
async function start(name: string, notOwner = false) {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: "off", composio: false });
  writeFileSync(join(fixture.info.dataDir, "fixture-not-owner.json"), JSON.stringify(notOwner ? [bot.threadId] : []));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__ " + name })).status).toBe(202);
  let dump: any;
  await expect.poll(() => { try { dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); return JSON.stringify(dump.prompt).includes(name) ? dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN : undefined; } catch { return undefined; } }, { timeout: 15000 }).toBeTruthy();
  return { bot, token: dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN as string };
}
async function request(token: string) { const res = await fetch(fixture.info.url + "/api/internal/request-browser-connection", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ reason: "Use the signed-in page" }) }); return { status: res.status, body: await res.json() as any }; }
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); });

it("a turn that is not the owner's audience cannot raise the browser setup card; the owner's own turn can", async () => {
  const chain = await start("Setup chain fixture", true);
  try {
    const refused = await request(chain.token);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Ask about browser setup from an owner conversation.");
  } finally { await api("POST", `/api/bots/${chain.bot.id}/interrupt`, { threadId: chain.bot.threadId }); }
  // Control: an owner turn in the same server raises the card.
  const owner = await start("Setup owner fixture");
  try { expect((await request(owner.token)).status).toBe(201); }
  finally { await api("POST", `/api/bots/${owner.bot.id}/interrupt`, { threadId: owner.bot.threadId }); }
}, 45000);
