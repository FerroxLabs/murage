// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22, binding): no transport size cap on any hop. The group A tool proxies
// forward each tool request to an internal route of the harness; those routes read the body with readBody's default 1,000,000-byte
// bound and answered 413, which the proxy takes as a lost transport and seals. This witness boots the REAL server
// (scripts/control-murage.ts) and POSTs a real 20 MiB tool request, exactly as the turn's own proxy issues it (bearer = the turn's
// capability), through each production route handler in server/index.ts:
//   HC  /api/internal/host-computer   (drivers/host-computer-proxy.ts)    -> the host driver receives every byte
//   UB  /api/internal/unified-browser (drivers/unified-browser-proxy.ts)  -> the browser engine receives every byte
//   DV  /api/internal/device/call     (drivers/phone-jobs-proxy.ts)       -> the route parses the whole body and gives its own answer
//   EX  /api/browser-extension/mcp     (drivers/browser-extension-mcp.ts)  -> the route parses the whole body and lists its tools
//   IN  readInternalBody              (drivers/agents-proxy.ts; the same read serves connectors/mcp, mcp-remote, connectors/request)
// Owners: lane cause22-main-fable owns these rows and the body reads they drive; the handlers behind the reads keep their owners.
// RED on c187b11166: each route answers 413 "body too large" and the tool never sees the request.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const ITEM = 20 * 1024 * 1024;

// The host "driver": answers a call with the size of the text it was given.
const fakeHostSource = `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'route-body-fake-host', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'fixture_size', description: 'No computer action', inputSchema: { type: 'object', properties: {} } }] };
  else if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: 'host-got=' + String((rpc.params.arguments && rpc.params.arguments.text) || '').length }] };
  else result = { isError: true, content: [{ type: 'text', text: 'unsupported fixture request' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + String.fromCharCode(10));
}`;

// Runs inside the harness child before server/index.ts loads; everything it writes stays under the throwaway data dir.
const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
const { registerHooks } = await import('node:module');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
${fakeHostDescriptorSource({ driverSource: fakeHostSource, driverEnv: {} })}
const browserBinary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(browserBinary, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = browserBinary;
// The browser engine is replaced by one that answers a call with the size of the text it was given (nothing is launched).
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    export function createNativeBrowser(spec) {
      return {
        request: async (method, call) => method === 'tools/list'
          ? { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'browser-got=' + String((call && call.arguments && call.arguments.selector) || '').length }] },
        protected: async () => false,
        resetStream() {}, input() {},
        command: async () => '',
        connect: async () => 'fixture-stream',
        close: async () => {},
      };
    }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    const start = source.indexOf('export async function verifyAgentBrowserBinary(');
    const end = source.indexOf('export async function ensureChrome(', start);
    if (start < 0 || end < 0) throw new Error('Browser version fixture anchor changed');
    // The engine refuses a container host (no browser is launched there). The fake engine launches nothing, so the fixture lets
    // the mount through: the thing under test is the route's body read, not the host check.
    const hostCheck = 'if (browserHostRequiresSandboxBypass({';
    if (!source.includes(hostCheck)) throw new Error('Browser host fixture anchor changed');
    return { format: 'module-typescript', shortCircuit: true, source: (source.slice(0, start)
      + 'export async function verifyAgentBrowserBinary() {}' + String.fromCharCode(10) + source.slice(end)).replace(hostCheck, 'if (false && browserHostRequiresSandboxBypass({') };
  }
  return nextLoad(url, context);
} });
// a second engine slot, so the browser bot's turn is held next to the computer bot's
const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.instances.second = { ...cfg.instances.verification, displayName: 'Second isolated engine', environment: { FAKE_CLAUDE_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'second-dump.json') } };
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let servers: Record<string, { env?: Record<string, string> }> = {};

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const dump = (second = false) => { try { return withTurnSecrets(JSON.parse(readFileSync(second ? join(fixture.info.dataDir, "second-dump.json") : fixture.fixtureDumpPath, "utf8"))); } catch { return null; } };
/** A POST exactly as a turn's own proxy issues it: the bearer is the whole authority. */
const internal = async (path: string, token: string | undefined, body: unknown) => {
  const response = await fetch(fixture.info.url + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
};
const tokenOf = (key: string) => Object.values(servers).map((server) => server.env?.[key]).find(Boolean);
const big = () => "z".repeat(ITEM);

type Site = { row: string; path: string; token: () => string | undefined; body: (text: string) => unknown; status: number; proof: (text: string) => string };
const SITES: Site[] = [
  { row: "HC host computer route (index.ts /api/internal/host-computer)", path: "/api/internal/host-computer", token: () => servers.computer?.env?.MURAGE_CONTROL_TOKEN,
    body: (text) => ({ method: "tools/call", params: { name: "fixture_size", arguments: { text } } }), status: 200, proof: (text) => `host-got=${text.length}` },
  { row: "UB unified browser route (index.ts /api/internal/unified-browser)", path: "/api/internal/unified-browser", token: () => servers.browser?.env?.MURAGE_CONTROL_TOKEN,
    body: (text) => ({ method: "tools/call", params: { name: "agent_browser_snapshot", arguments: { selector: text } } }), status: 200, proof: (text) => `browser-got=${text.length}` },
  // readInternalBody: the handler keeps the text it was sent (its own text bound is on `text`, not on the request) and answers with its id.
  { row: "IN readInternalBody (index.ts /api/internal/tool-result)", path: "/api/internal/tool-result", token: () => tokenOf("MURAGE_COMMS_TOKEN"),
    body: (text) => ({ text: `kept ${text.length}`, pad: text }), status: 201, proof: () => '"id"' },
  // device/call: the body is read whole, then the route answers its own refusal for a tool name that is not a phone tool.
  { row: "DV phone route (index.ts /api/internal/device/call)", path: "/api/internal/device/call", token: () => servers.phoneJobs?.env?.MURAGE_CONTROL_TOKEN,
    body: (text) => ({ tool: "fixture_not_a_phone_tool", args: { text } }), status: 200, proof: () => '"code":"refused"' },
  // The agents proxy's other routes that read their body themselves (not through readInternalBody). status 0 = the route's own answer to
  // the same request small (its validation or its result): the 20 MiB request must get that same answer, never a size refusal.
  // (/api/internal/project/propose has its own rows in server/propose-authority-1021.test.ts: only the Chief's held proposal turn passes that route's gate.)
  { row: "ARTIFACT agents route (index.ts /api/internal/register-artifact)", path: "/api/internal/register-artifact", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "NEEDSOWNER agents route (index.ts /api/internal/needs-owner-now)", path: "/api/internal/needs-owner-now", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "VOICE agents route (index.ts /api/internal/voice-note)", path: "/api/internal/voice-note", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "STOPLINE agents route (index.ts /api/internal/stop-line-allowance)", path: "/api/internal/stop-line-allowance", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "PROMPTBLOCKS agents route (index.ts /api/internal/image-prompt-blocks)", path: "/api/internal/image-prompt-blocks", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "REFPACKS agents route (index.ts /api/internal/image-reference-packs)", path: "/api/internal/image-reference-packs", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "TAKEDOWN agents route (index.ts /api/internal/take-down-site)", path: "/api/internal/take-down-site", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "PUBLISH agents route (index.ts /api/internal/publish-site)", path: "/api/internal/publish-site", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "GENIMAGE agents route (index.ts /api/internal/generate-image)", path: "/api/internal/generate-image", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "WEBREAD agents route (index.ts /api/internal/web-read)", path: "/api/internal/web-read", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "WEBSEARCH agents route (index.ts /api/internal/web-search)", path: "/api/internal/web-search", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
  { row: "IMAGEREF agents route (index.ts /api/internal/resolve-image-reference)", path: "/api/internal/resolve-image-reference", token: () => tokenOf("MURAGE_COMMS_TOKEN"), body: (text) => ({ pad: text }), status: 0, proof: () => "" },
];

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 45_200, span: 90 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  expect((await api("PATCH", "/api/config", { features: { browser: true, phoneTools: true } })).status).toBe(200);
  // A registered phone (the app's own contract registration, through the door's phone envelope), so the computer bot's turn is
  // handed the phone-jobs capability and /api/internal/device/call is past its "off" answer. A failure here fails row DV only.
  const registration = JSON.parse(readFileSync(join(import.meta.dirname, "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8")).registration.valid;
  await fetch(`${fixture.info.url}/api/phones/self`, { method: "PUT", body: JSON.stringify(registration), headers: { "content-type": "application/json", "x-test-bare-loopback": "1",
    "x-murage-door-token": "c".repeat(64), "x-murage-phone-device": "22222222-2222-4222-8222-222222222222", "x-murage-phone-scope": "jobs" } }).then((response) => response.text(), () => "");
  const model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  // Two held turns (a computer bot and a browser bot): their capabilities stay live for every row.
  for (const [name, instanceId, patch, second] of [["Route body computer", "verification", { computer: "local", browser: false, phoneApps: { reminders: "read" } }, false], ["Route body browser", "second", { computer: "off" }, true]] as const) {
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, ...patch })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ route-body-${instanceId}` })).status).toBe(202);
    for (let waited = 0; waited < 30_000 && !JSON.stringify(dump(second)?.prompt ?? "").includes(`route-body-${instanceId}`); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    servers = { ...(dump(second)?.mcpConfig?.mcpServers ?? {}), ...servers };
  }
}, 90_000);

afterAll(async () => { await fixture?.close(); });

describe("cause22-no-transport-caps: a 20 MiB tool request passes each internal route's body read and the next request is served", () => {
  for (const site of SITES) it(`${site.row}: a 20 MiB request reaches the handler whole, never 413, and a small request after it is served`, async () => {
    const token = site.token();
    expect(token, `${site.row}: the turn was handed this capability (mounted: ${Object.keys(servers).join(",")})`).toBeTruthy();
    // control: a small request is served on base and tip alike, so a RED below is the size of the body and nothing else
    const small = await internal(site.path, token, site.body("s"));
    const want = site.status || small.status;
    expect(small.status, `${site.row} control: ${small.text.slice(0, 300)}`).toBe(want);
    expect(small.status, `${site.row} control is the route's own answer`).not.toBe(413);
    expect(small.text, `${site.row} control`).toContain(site.proof("s"));
    const text = big();
    const large = await internal(site.path, token, site.body(text));
    expect({ status: large.status, answer: large.text.slice(0, 200) }, `${site.row}: the 20 MiB request is not refused for its size`).toEqual(expect.objectContaining(site.status ? { status: want } : { status: want, answer: small.text.slice(0, 200) }));
    expect(large.text.slice(0, 400), `${site.row}: every byte reached the handler behind the body read`).toContain(site.proof(text));
    const after = await internal(site.path, token, site.body("after"));
    expect(after.status, `${site.row}: the next request is served`).toBe(want);
    expect(after.text).toContain(site.proof("after"));
  }, 120_000);
});

// EX /api/browser-extension/mcp (drivers/browser-extension-mcp.ts posts here with its paired client's bearer). Its own server: the
// declared fake browser broker of browser-extension-mcp-api.test.ts (same instrumentation text), so a profile is connected and a
// client can be paired through the real routes. Nothing native is registered.
const extensionInstrumentation = `
globalThis.__murageFixtureBrowserEngine=options=>({
 async call(name,args){
  const doc=await options.transport.selected();
  if(name==='agent_browser_open'){await options.beforeDestination(args.url,doc);await options.transport.send('Page.navigate',{url:args.url},doc);return {content:[{type:'text',text:'Fixture navigation complete'}]};}
  if(name==='agent_browser_press'){const params={type:'keyDown',key:args.key};await options.beforeCommand(doc,'Input.dispatchKeyEvent',params);await options.transport.send('Input.dispatchKeyEvent',params,doc);return {content:[{type:'text',text:'Fixture key dispatched'}]};}
  throw Error('Unsupported declared fixture engine operation');
 },
 async resolveTarget(){return {backendNodeId:1,document:await options.transport.selected()};},
 async resolveTab(){return options.transport.selected();},event(){},async close(){}
});
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/server/index.ts')){const result=next(url,context);const source=String(result.source),needle='new BrowserExtensionIntegration({';if(source.split(needle).length!==2)throw Error('Fixture integration anchor changed');return {...result,source:source.replace('checkerInstances: () => registry.instances()','checkerInstances: () => []').replace(needle,needle+'createEngine:globalThis.__murageFixtureBrowserEngine,collectFacts:async(_i,_t,operation)=>({operation,visibility:{box:{x:1,y:1,width:50,height:20},inViewport:true,opacity:1,visibility:"visible",ariaHidden:false,coveredBy:null}}),')};}
 if(url.endsWith('/browser-extension-registration.mjs'))return {format:'module',shortCircuit:true,source:"export async function connectOwnerBrowser(input){if(!input.ownerConfirmed)throw Error('consent');return {status:'installed',connected:false}};export async function removeOwnerBrowser(){return {status:'removed'}}"};
 if(!url.endsWith('/browser-extension-broker.ts'))return next(url,context);
 return {format:'module',shortCircuit:true,source:\`
 export async function startBrowserExtensionBroker(){
  const bindings=new Map();
  return {configPath:'/fixture-only/no-native-registration',profiles:()=>[{version:1,type:'hello',profileId:'fixture_profile',browser:'chromium',extensionVersion:'1',capabilities:['scoped_cdp','durable_stop','explicit_share','manual_pause','unexpected_input_pause','engine_cdp_v1','ordered_requests_v1']}],close:async()=>{},request:async(profile,command)=>{
   let b=bindings.get(command.bindingId);
   if(command.operation==='bind'&&!b){b={generation:1,state:'active',tabs:[{tabId:bindings.size+1,navigationEpoch:1,origin:'null',url:'about:blank'}]};bindings.set(command.bindingId,b)}
   let result=b;
   if(command.operation==='stop'||command.operation==='pause'){b.generation++;b.state=command.operation==='stop'?'stopped':'paused'}
   if(command.operation==='cdp'){
    const {method,params}=command.params;let r={};const tab=b.tabs[0];
    if(method==='Page.navigate'){tab.url=params.url;tab.origin=new URL(params.url).origin;tab.navigationEpoch++}
    if(method==='Murage.getAllFrames')r={frames:[{frameId:0,parentFrameId:-1,url:tab.url}]};
    if(method==='Page.getFrameTree')r={frameTree:{frame:{id:'frame',loaderId:'L'}}};
    if(method==='Murage.getAllFrames')r={frames:[{frameId:0,parentFrameId:-1}]};
    if(method==='Page.createIsolatedWorld')r={executionContextId:7};
    if(method==='DOM.getDocument')r={root:{nodeId:1}};
    if(method==='DOM.describeNode')r={node:{backendNodeId:1}};
    if(method==='DOM.resolveNode')r={object:{objectId:'fixture-target'}};
    if(method==='Runtime.callFunctionOn')r={result:{type:params.functionDeclaration.includes('elementFromPoint')?'boolean':'string',value:params.functionDeclaration.includes('elementFromPoint')?true:'fixture target'}};
    if(method==='Runtime.evaluate')r={result:{type:'boolean',value:params.expression.includes('__murageGuard()')?false:'fixture target'}};
    if(method==='Runtime.evaluate'&&params.expression==='document.activeElement||document.body')r={result:{type:'object',subtype:'node',objectId:'fixture-active'}};
    if(method==='Accessibility.getFullAXTree')r={nodes:[]};
    if(method.startsWith('Input.'))throw Error('fixture_forbidden_input_was_dispatched');
    result={result:r,...tab};
   }
   return{version:1,type:'response',id:command.id,bindingId:command.bindingId,generation:command.generation,result};
  }};
 }
 \`};
}});
`;
describe("cause22-no-transport-caps: the external browser client route reads a 20 MiB request whole", () => {
  let extension: VerificationServer;
  let client: Record<string, string> = {};
  const post = async (path: string, body: unknown, extra: Record<string, string>) => {
    const response = await fetch(extension.info.url + path, { method: "POST", headers: { ...extra, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  beforeAll(async () => {
    extension = await launchVerificationServer({}, undefined, { instrumentationSource: extensionInstrumentation, portRange: { from: 45_300, span: 90 } });
    const secret = await (await fetch(extension.info.url + "/api/desktop-secret")).json() as { secret: string };
    const owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
    await fetch(extension.info.url + "/api/config", { method: "PATCH", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) });
    const bots = await (await fetch(extension.info.url + "/api/bots", { headers: owner })).json() as { bots: Array<{ id: string }> };
    await post(`/api/bots/${bots.bots[0]!.id}/browser-extension`, { action: "connect" }, owner);
    await post("/api/browser-extension/clients", { action: "enabled", enabled: true }, owner);
    const pair = { label: "Route body fixture", profileId: "fixture_profile" };
    const preview = JSON.parse((await post("/api/browser-extension/clients", { ...pair, action: "preview" }, owner)).text) as { disclosure?: { disclosureKey?: string } };
    const paired = JSON.parse((await post("/api/browser-extension/clients", { ...pair, action: "pair", disclosureKey: preview.disclosure?.disclosureKey }, owner)).text) as { config?: { mcpServers: Record<string, { env: Record<string, string> }> } };
    const saved = paired.config ? JSON.parse(readFileSync(paired.config.mcpServers["murage-browser"]!.env.MURAGE_BROWSER_MCP_CONFIG!, "utf8")) as { token: string; clientId: string } : undefined;
    if (saved) client = { authorization: `Bearer ${saved.token}`, "x-murage-browser-client": saved.clientId };
  }, 90_000);
  afterAll(async () => { await extension?.close(); });

  it("EX external browser client route (index.ts /api/browser-extension/mcp): a 20 MiB request reaches the handler whole, never 413, and a small request after it is served", async () => {
    const row = "EX external browser client route";
    expect(client.authorization, `${row}: a client was paired through the real routes`).toBeTruthy();
    const request = (text: string) => post("/api/browser-extension/mcp", { method: "tools/list", params: { arguments: { text } } }, client);
    const small = await request("s");
    expect(small.status, `${row} control: ${small.text.slice(0, 300)}`).toBe(200);
    expect(small.text, `${row} control`).toContain("agent_browser_open");
    const large = await request("z".repeat(ITEM));
    expect({ status: large.status, answer: large.text.slice(0, 200) }, `${row}: the 20 MiB request is not refused for its size`).toEqual(expect.objectContaining({ status: 200 }));
    expect(large.text, `${row}: the handler behind the body read answered`).toContain("agent_browser_open");
    const after = await request("after");
    expect(after.status, `${row}: the next request is served`).toBe(200);
  }, 120_000);
});

// WIPE /api/internal/mcp-remote/<name>/wipe-metadata (mcp-wipe-publisher.ts posts a server's tool effect hints here with the
// mount's own bearer before the engine sees tools/list; a refused post answers that tools/list with an error). The route read at
// most 2,000,000 bytes. Its schema allows 8,192 hints with names of 200 characters, which is over 5 MB when the names are not
// ASCII, so the largest list the schema allows was refused for its size. Its own server: one owner-added command server, mounted
// on a held turn (the engine fixture starts no MCP server).
describe("cause22-no-transport-caps: the MCP effect-hints route reads the largest hint list whole", () => {
  let server: VerificationServer;
  let token: string | undefined;
  beforeAll(async () => {
    server = await launchVerificationServer({}, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';", portRange: { from: 45_400, span: 90 } });
    const proof = await (await fetch(server.info.url + "/api/desktop-secret")).json() as { secret: string };
    const owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(server.info.url + path, { method, headers: owner, body: body === undefined ? undefined : JSON.stringify(body) });
      return await response.json().catch(() => null) as any;
    };
    await call("POST", "/api/mcp/servers", { name: "hints", command: "npx", args: ["-y", "@fixture/hints-mcp"], enabled: true });
    await call("PATCH", "/api/mcp/servers/hints", { enabled: true });
    const model = (await call("GET", "/api/instances")).instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    const bot = (await call("POST", "/api/bots", { name: "Route body hints", modelSelection: { instanceId: "verification", model } }))?.bot;
    await call("PATCH", `/api/bots/${bot?.id}`, { composio: false, computer: "off", browser: false });
    await call("POST", `/api/bots/${bot?.id}/messages`, { threadId: bot?.threadId, text: "__fixture_hold_authority__ route-body-hints" });
    const held = () => { try { return withTurnSecrets(JSON.parse(readFileSync(server.fixtureDumpPath, "utf8"))); } catch { return null; } };
    for (let waited = 0; waited < 30_000 && !JSON.stringify(held()?.prompt ?? "").includes("route-body-hints"); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    token = held()?.mcpConfig?.mcpServers?.hints?.env?.MURAGE_MCP_TOKEN;
  }, 90_000);
  afterAll(async () => { await server?.close(); });

  it("WIPE effect-hints route (index.ts /api/internal/mcp-remote/<name>/wipe-metadata): the largest hint list and a 20 MiB request are read whole, never 413, and every hint is recorded", async () => {
    const row = "WIPE effect-hints route";
    expect(token, `${row}: the held turn was handed the mounted server's capability`).toBeTruthy();
    const post = async (body: unknown) => {
      const text = JSON.stringify(body);
      const response = await fetch(server.info.url + "/api/internal/mcp-remote/hints/wipe-metadata", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: text });
      return { status: response.status, answer: (await response.text()).slice(0, 200), bytes: Buffer.byteLength(text) };
    };
    const hint = (tool: string) => ({ tool, destructive: false, bulk: false });
    // controls: a small list is recorded, and a name over the schema's 200 characters gets the route's own refusal, on base and tip alike
    const small = await post({ tools: [hint("small")], replace: true });
    expect(small, `${row} control`).toEqual({ status: 200, answer: '{"ok":true}', bytes: small.bytes });
    const refused = await post({ tools: [hint("n".repeat(201))], replace: false });
    expect(refused.status, `${row} control: the schema's own refusal is not a size refusal`).not.toBe(413);
    // the largest list the schema allows: 8,192 hints, each name 200 characters that are three bytes each
    const names = Array.from({ length: 8192 }, (_, index) => String(index).padStart(8, "0") + "\u5b57".repeat(192));
    const full = await post({ tools: names.map(hint), replace: true });
    expect(full.bytes, `${row}: the list is over the old 2,000,000 bytes`).toBeGreaterThan(5_000_000);
    expect({ status: full.status, answer: full.answer }, `${row}: the largest hint list is not refused for its size`).toEqual({ status: 200, answer: '{"ok":true}' });
    // every hint of it reached the store: the store holds 8,192 names for a server, so one of them again is taken and one more is not
    const again = await post({ tools: [hint(names[8191]!)], replace: false });
    expect({ status: again.status, answer: again.answer }, `${row}: a name of the list is known`).toEqual({ status: 200, answer: '{"ok":true}' });
    const extra = await post({ tools: [hint("one more")], replace: false });
    expect({ status: extra.status, answer: extra.answer }, `${row}: all 8,192 hints were recorded, so the store is full`).toEqual({ status: 400, answer: '{"ok":false}' });
    // a 20 MiB request (one name of 20 MiB) is read whole and gets the schema's refusal, the same answer as the small one
    const large = await post({ tools: [hint("n".repeat(ITEM))], replace: false });
    expect({ status: large.status, answer: large.answer }, `${row}: the 20 MiB request is not refused for its size`).toEqual({ status: refused.status, answer: refused.answer });
    const after = await post({ tools: [hint("small")], replace: true });
    expect({ status: after.status, answer: after.answer }, `${row}: the next request is served`).toEqual({ status: 200, answer: '{"ok":true}' });
  }, 120_000);
});
