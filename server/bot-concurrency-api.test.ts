import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";

// Isolated HTTP server and fake Claude only. The descriptor mounts a fake host
// connection; the fake engine records its configuration and never starts MCP.
//
// Platform admission is explicit and never faked (audit D5). What each host
// actually supports, per server/local-routing.ts:
//   darwin: Auto and explicit Local both mount host control.
//   linux:  explicit Local mounts the supervised Linux driver; Auto never falls
//           back to the user's desktop, even with a ready driver present.
//   win32:  host control is never mounted; explicit Local is refused before
//           the engine starts, Auto runs without host tools.
type HostOutcome = "host" | "none" | "refused";
const HOST_ADMISSION: Partial<Record<NodeJS.Platform, Record<"auto" | "local", HostOutcome>>> = {
  darwin: { auto: "host", local: "host" },
  linux: { auto: "none", local: "host" },
  win32: { auto: "none", local: "refused" },
};
const admission = HOST_ADMISSION[process.platform];

const fakeHostSource = `import { createInterface } from 'node:readline';
const rl=createInterface({input:process.stdin});
for await(const line of rl){const rpc=JSON.parse(line);if(rpc.id===undefined)continue;let result;
if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolated-fake-host',version:'1'}};
else if(rpc.method==='tools/list')result={tools:[{name:'fixture_ping',description:'No computer action',inputSchema:{type:'object',properties:{}}}]};
else if(rpc.method==='tools/call'&&rpc.params.name==='fixture_ping')result={content:[{type:'text',text:'isolated-host-pong'}]};
else result={isError:true,content:[{type:'text',text:'unsupported fixture request'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+String.fromCharCode(10));}`;

let fixture: VerificationServer, model: string, headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};
const dump = (second: boolean) => {
  try { return JSON.parse(readFileSync(second ? join(fixture.info.dataDir, "second-dump.json") : fixture.fixtureDumpPath, "utf8")); }
  catch { return null; }
};
const state = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const task = async (bot: any) => (await state(bot.id)).tasks.find((item: any) => item.threadId === bot.threadId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');const net=await import('node:net');const {randomUUID}=await import('node:crypto');
    process.env.MURAGE_USER_DATA=process.env.MURAGE_DATA_DIR;
    const dataDir=fs.realpathSync(process.env.MURAGE_DATA_DIR);
    const hostSource=${JSON.stringify(fakeHostSource)};
    if(process.platform==='linux'){
      // A supervised Linux driver descriptor that passes the real validation:
      // private descriptor, executable fake driver with its file identity,
      // a live private socket and live owner/daemon processes.
      const driverDir=path.join(dataDir,'fake-cua-driver');fs.mkdirSync(driverDir,{mode:0o700});
      const driver=path.join(driverDir,'fake-cua-driver.mjs');
      fs.writeFileSync(driver,'#!'+process.execPath+String.fromCharCode(10)+hostSource);fs.chmodSync(driver,0o755);
      const socketDir=path.join(dataDir,'cua');fs.mkdirSync(socketDir,{mode:0o700});fs.chmodSync(socketDir,0o700);
      const socketPath=path.join(socketDir,'d.sock');
      const daemon=net.createServer(socket=>socket.destroy());
      await new Promise((resolve,reject)=>{daemon.once('error',reject);daemon.listen(socketPath,resolve);});
      daemon.unref();fs.chmodSync(socketPath,0o600);
      const stat=fs.statSync(driver,{bigint:true});
      const fileIdentity=Object.fromEntries(['dev','ino','uid','gid','mode','size','mtimeNs','ctimeNs'].map(key=>[key,String(stat[key])]));
      fs.writeFileSync(path.join(dataDir,'cua-connection.json'),JSON.stringify({schemaVersion:1,mode:'linux-x11-supervised',platform:'linux',session:'x11',enabled:true,status:'ready',ownerPid:process.pid,generation:randomUUID(),
        driver:{path:driver,version:'0.19.3',source:'path',manifestSchema:'1',fileIdentity},
        daemon:{socketPath,pid:process.pid,contractVersion:'0.6.0',toolsListSchemaVersion:'1',capabilityVersion:'1',mcpProtocolVersion:'2025-06-18'},
        mcp:{command:driver,args:['mcp','--embedded','--socket',socketPath],env:{CUA_DRIVER_EMBEDDED:'1',CUA_DRIVER_HOST_BUNDLE_ID:'com.murage.app',CUA_DRIVER_RS_UPDATE_CHECK:'false',CUA_DRIVER_RS_TELEMETRY_ENABLED:'false'}},
        toolNames:['click','get_window_state','list_apps','type_text','fixture_ping'],doctorWarnings:[]}),{mode:0o600});
    }else{
      const driver=path.join(dataDir,'fake-host-driver.mjs');fs.writeFileSync(driver,hostSource);
      fs.writeFileSync(path.join(dataDir,'cua-connection.json'),JSON.stringify({mcpCommand:process.execPath,mcpArgs:[driver],mcpEnv:{FIXTURE_HOST_SECRET:'synthetic-host-only'}}));
    }
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.second={...cfg.instances.verification,displayName:'Second isolated engine',environment:{FAKE_CLAUDE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'second-dump.json')}};
    fs.writeFileSync(file,JSON.stringify(cfg));process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  ` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 30000);
afterAll(async () => {
  try { if (fixture && process.env.MURAGE_CONCURRENCY_DIAGNOSTIC === "1") {
    const evidence = mkdtempSync(join(tmpdir(), "murage-concurrency-diagnostic-"));
    for (const name of ["cua-connection.json", "fake-claude-dump.json", "second-dump.json"]) { try { cpSync(join(fixture.info.dataDir, name), join(evidence, name)); } catch { /* absent on this platform */ } }
    console.info("isolated diagnostic preserved", { evidence, logPath: fixture.info.logPath });
  } } finally { await fixture?.close(); }
});

it("defines host-control admission for this platform and matches the routing policy", () => {
  if (!admission) throw new Error(`No host-control admission is defined for ${process.platform}; add its real supported scenario before running this suite.`);
  for (const destination of ["auto", "local"] as const) {
    expect(shouldMountLocalComputer({ requested: destination === "local" ? "local" : undefined, hostPlatform: process.platform, providerSupportsLocal: true }), destination)
      .toBe(admission[destination] === "host");
  }
});

it.each(["auto", "local"] as const)(`runs distinct %s bots on ${process.platform} with the host control this platform supports and cancels only one`, async (destination) => {
  if (!admission) throw new Error(`No host-control admission is defined for ${process.platform}.`);
  const outcome = admission[destination];
  const bots: any[] = [];
  const clients: EngineClient[] = [];
  try {
    for (const instanceId of ["verification", "second"]) {
      const created = await api("POST", "/api/bots", { name: `${destination} concurrency ${instanceId}`, modelSelection: { instanceId, model } });
      expect(created.status).toBe(201);
      const bot = created.body.bot; bots.push(bot);
      const configured = await api("PATCH", `/api/bots/${bot.id}`, { ...(destination === "local" ? { computer: "local" } : {}), browser: false, composio: false });
      expect(configured.status).toBe(200);
      expect((await state(bot.id)).computer).toBe(destination === "local" ? "local" : undefined);
    }
    expect(bots[0].id).not.toBe(bots[1].id);

    if (outcome === "refused") {
      // Windows: explicit Local is refused at dispatch, before any engine
      // receives the prompt, and neither bot is left holding work.
      for (let i = 0; i < bots.length; i++) {
        const bot = bots[i], label = `${destination}-refused-${i}`;
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
        await expect.poll(async () => (await messages(bot.threadId)).some(message => message.tool?.name?.includes("cannot control this computer")), { timeout: 10000 }).toBe(true);
        expect(JSON.stringify(dump(i === 1)?.prompt ?? "")).not.toContain(label);
        await expect.poll(async () => (await task(bot)).busy, { timeout: 10000 }).toBe(false);
      }
      return;
    }

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i], label = `${destination}-concurrency-${i}`;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
      await expect.poll(async () => {
        if ((JSON.stringify(dump(i === 1)?.prompt) ?? "").includes(label)) return "engine-started";
        const error = (await messages(bot.threadId)).find(message => message.tool?.name?.includes("Another thread is using this computer") || message.tool?.name?.includes("CUA Driver is not ready"));
        if (error) return `rejected: ${error.tool.name}`;
        return "waiting";
      }, { timeout: 10000 }).toBe("engine-started").catch(async error => {
        console.info("isolated dispatch evidence", { destination, platform: process.platform, botIndex: i, messages: (await messages(bot.threadId)).map(message => ({ type: message.type, tool: message.tool?.name })), logPath: fixture.info.logPath });
        throw error;
      });
      if (outcome === "host") expect(dump(i === 1).mcpConfig.mcpServers.computer).toBeTruthy();
      else expect(dump(i === 1).mcpConfig.mcpServers.computer).toBeUndefined();
    }
    const first = dump(false), second = dump(true);
    expect(first.pid).not.toBe(second.pid);
    const workspaces = await Promise.all(bots.map(async bot => (await task(bot)).cwd));
    expect(workspaces[0]).not.toBe(workspaces[1]);
    for (const cwd of workspaces) expect(cwd).toContain(fixture.info.dataDir);
    for (const bot of bots) expect((await task(bot)).busy).toBe(true);
    if (outcome === "host") {
      for (const captured of [first, second]) {
        const mounted = captured.mcpConfig.mcpServers.computer;
        expect(mounted.args.some((arg: string) => arg.includes("host-computer-proxy"))).toBe(true);
        expect(JSON.stringify(mounted)).not.toContain("fake-host-driver");
        expect(JSON.stringify(mounted)).not.toContain("fake-cua-driver");
        expect(JSON.stringify(mounted)).not.toContain("synthetic-host-only");
        if (process.env.MURAGE_CONCURRENCY_DIAGNOSTIC === "1") {
          const direct = new URL("/api/internal/host-computer", mounted.env.MURAGE_CONTROL_URL);
          direct.searchParams.set("botId", mounted.env.MURAGE_BOT_ID); direct.searchParams.set("threadId", mounted.env.MURAGE_THREAD_ID);
          const response = await fetch(direct, { method: "POST", headers: { authorization: `Bearer ${mounted.env.MURAGE_CONTROL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ method: "tools/call", params: { name: "fixture_ping", arguments: {} } }) });
          const result = await response.json() as any;
          console.info("isolated host HTTP diagnostic", { status: response.status, redactedToken: /redact/i.test(mounted.env.MURAGE_CONTROL_TOKEN), error: typeof result.error === "string" ? result.error.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : undefined, pong: JSON.stringify(result).includes("isolated-host-pong") });
        }
        const client = startHeadlessEngine({ ...mounted, env: { ...process.env, ...mounted.env } }); clients.push(client);
        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-test", version: "1" } });
        expect(await client.request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "isolated-host-pong" }] });
      }
    }
    expect((await api("POST", `/api/bots/${bots[0].id}/interrupt`, { threadId: bots[0].threadId })).status).toBe(200);
    expect((await task(bots[0])).busy).toBe(false);
    expect((await task(bots[1])).busy).toBe(true);
    expect(() => process.kill(second.pid, 0)).not.toThrow();
    if (outcome === "host") {
      expect(await clients[0].request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ isError: true });
      expect(await clients[1].request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "isolated-host-pong" }] });
    }
  } finally {
    for (const client of clients) await client.close();
    for (const bot of bots) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }
}, 30000);
