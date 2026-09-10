import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";

// Isolated HTTP server and fake Claude only. The descriptor mounts a fake host
// connection; the fake engine records its configuration and never starts MCP.
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
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    process.env.MURAGE_USER_DATA=process.env.MURAGE_DATA_DIR;
    const driver=path.join(process.env.MURAGE_DATA_DIR,'fake-host-driver.mjs');
    fs.writeFileSync(driver,${JSON.stringify(`import { createInterface } from 'node:readline';
const rl=createInterface({input:process.stdin});
for await(const line of rl){const rpc=JSON.parse(line);if(rpc.id===undefined)continue;let result;
if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolated-fake-host',version:'1'}};
else if(rpc.method==='tools/list')result={tools:[{name:'fixture_ping',description:'No computer action',inputSchema:{type:'object',properties:{}}}]};
else if(rpc.method==='tools/call'&&rpc.params.name==='fixture_ping')result={content:[{type:'text',text:'isolated-host-pong'}]};
else result={isError:true,content:[{type:'text',text:'unsupported fixture request'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+String.fromCharCode(10));}`)});
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'cua-connection.json'),JSON.stringify({mcpCommand:process.execPath,mcpArgs:[driver],mcpEnv:{FIXTURE_HOST_SECRET:'synthetic-host-only'}}));
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
    for (const name of ["fake-host-driver.mjs", "cua-connection.json", "fake-claude-dump.json", "second-dump.json"]) cpSync(join(fixture.info.dataDir, name), join(evidence, name));
    console.info("isolated diagnostic preserved", { evidence, logPath: fixture.info.logPath });
  } } finally { await fixture?.close(); }
});

it.each(["auto", "local"])("allows distinct %s bots to work concurrently before host actions and cancels only one", async (destination) => {
  expect(["darwin", "win32"]).toContain(process.platform);
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
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i], label = `${destination}-concurrency-${i}`;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
      await expect.poll(async () => {
        if ((JSON.stringify(dump(i === 1)?.prompt) ?? "").includes(label)) return "engine-started";
        const error = (await messages(bot.threadId)).find(message => message.tool?.name?.includes("Another thread is using this computer"));
        if (error) return "computer-admission-rejected";
        return "waiting";
      }, { timeout: 10000 }).toBe("engine-started").catch(async error => {
        console.info("isolated dispatch evidence", { destination, botIndex: i, messages: (await messages(bot.threadId)).map(message => ({ type: message.type, tool: message.tool?.name })), logPath: fixture.info.logPath });
        throw error;
      });
      expect(dump(i === 1).mcpConfig.mcpServers.computer).toBeTruthy();
    }
    const first = dump(false), second = dump(true);
    expect(first.pid).not.toBe(second.pid);
    const workspaces = await Promise.all(bots.map(async bot => (await state(bot.id)).tasks.find((task: any) => task.threadId === bot.threadId).cwd));
    expect(workspaces[0]).not.toBe(workspaces[1]);
    for (const cwd of workspaces) expect(cwd).toContain(fixture.info.dataDir);
    for (const bot of bots) expect((await state(bot.id)).tasks.find((task: any) => task.threadId === bot.threadId).busy).toBe(true);
    for (const captured of [first, second]) {
      const mounted = captured.mcpConfig.mcpServers.computer;
      expect(mounted.args.some((arg: string) => arg.includes("host-computer-proxy"))).toBe(true);
      expect(JSON.stringify(mounted)).not.toContain("fake-host-driver");
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
    expect((await api("POST", `/api/bots/${bots[0].id}/interrupt`, { threadId: bots[0].threadId })).status).toBe(200);
    expect((await state(bots[0].id)).tasks.find((task: any) => task.threadId === bots[0].threadId).busy).toBe(false);
    expect((await state(bots[1].id)).tasks.find((task: any) => task.threadId === bots[1].threadId).busy).toBe(true);
    expect(() => process.kill(second.pid, 0)).not.toThrow();
    expect(await clients[0].request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ isError: true });
    expect(await clients[1].request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "isolated-host-pong" }] });
  } finally {
    for (const client of clients) await client.close();
    for (const bot of bots) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }
}, 30000);
