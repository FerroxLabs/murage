import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { readMcpCatalog } from "../mcp-listed.ts";

it("c11-cloud-remote-catalog: actual VPS outer bridge publishes normalized output only after its flush", async () => {
  const root = mkdtempSync(join(tmpdir(), "c11-vps-")), marker = join(root, "generation.computer"), release = join(root, "release");
  const preload = join(root, "hold.mjs");
  writeFileSync(preload, `import { existsSync } from 'node:fs';
const write = process.stdout.write.bind(process.stdout);
if (process.argv[2] !== 'pipe') process.stdout.write = function(chunk, ...args) {
  if (String(chunk).includes('"tools":[')) {
    const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); write(chunk, ...args); } }, 10);
    return true;
  }
  return write(chunk, ...args);
};`);
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => ws.once("listening", resolve));
  ws.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: frame.method === "initialize" ? { capabilities: { tools: {}, resources: {} } } : { tools: [{ name: "served", inputSchema: { anyOf: [{ type: "object", properties: { x: { type: "string" } } }] } }] } }));
  }));
  const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("./vps-relay-mcp.ts", import.meta.url))], { env: { ...process.env, MURAGE_CONTROL_URL: `http://127.0.0.1:${(ws.address() as { port: number }).port}`, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_MCP_LISTED_FILE: marker }, stdio: ["pipe", "pipe", "pipe"] });
  const frames: any[] = []; let text = "";
  child.stdout.on("data", chunk => { text += chunk; let at: number; while ((at = text.indexOf("\n")) >= 0) { frames.push(JSON.parse(text.slice(0, at))); text = text.slice(at + 1); } });
  try {
    child.stdin.write(JSON.stringify({ id: 0, method: "initialize" }) + "\n");
    await expect.poll(() => frames.length).toBe(1);
    child.stdin.write(JSON.stringify({ id: 1, method: "tools/list" }) + "\n");
    await expect.poll(() => readMcpCatalog(marker)?.complete).toBe(false);
    expect(frames).toHaveLength(1);
    writeFileSync(release, "release");
    await expect.poll(() => readMcpCatalog(marker)?.complete).toBe(true);
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1].result.tools[0].inputSchema).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(readMcpCatalog(marker)).toMatchObject({ tools: ["served"], resources: true, revision: 2 });
  } finally {
    child.kill(); for (const client of ws.clients) client.terminate(); await new Promise<void>(resolve => ws.close(() => resolve()));
  }
});


// Renderer compatibility only: both proxies below use Claude MCP JSON from the Python launcher.
// OpenCode sends its descriptors over ACP; acp-catalog-chain.test.ts proves that chain.
// The real isolated server authenticates publication and owns the private marker.
it.each(["remote", "vpsRelay"] as const)("renderer compatibility: Claude rendered %s launch publishes after held flush", async kind => {
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { build } = await import("esbuild");
  const { windowsHideBundlePlugin } = await import("../../scripts/windows-hide-bundle-plugin.mjs");
  const { launcherRig } = await import("./engine-launch-fixture.ts");
  const { cloudRenderMcp } = await import("./engine-render.ts");
  const { SPAWNED_PROXIES } = await import("../proxy-paths.ts");
  const { launchVerificationServer } = await import("../../scripts/control-murage.ts");
  const serverDir = fileURLToPath(new URL("../", import.meta.url));
  const moduleUrl = (name: string) => pathToFileURL(join(serverDir, name)).href;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const fs=await import('node:fs'),path=await import('node:path');
    const { InternalCapabilities }=await import(${JSON.stringify(moduleUrl("internal-capabilities.ts"))});
    const { registerCloudMcpCatalog }=await import(${JSON.stringify(moduleUrl("mcp-listed.ts"))});
    const mint=InternalCapabilities.prototype.mint;
    InternalCapabilities.prototype.mint=function(input){
      const token=mint.call(this,input);
      if(input.kind==='agents'){
        const marker=path.join(process.env.MURAGE_DATA_DIR,'generation.proxy');
        const endpoint=registerCloudMcpCatalog(marker,input.threadId,'http://127.0.0.1:'+process.env.MURAGE_PORT);
        fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'publication.json'),JSON.stringify({token,marker,endpoint}));
      }return token;
    };
    const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(moduleUrl("drivers/builtIn.ts"))});
    const { createAcpDriver }=await import(${JSON.stringify(moduleUrl("drivers/acp/core.ts"))});
    BUILT_IN_DRIVERS.push(createAcpDriver({driverKind:'renderFixture',displayName:'Rendered fixture',models:{default:'mock',options:[]},defaultCli:'unused',nativeSource:'render.fixture',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true}));
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.render={driver:'renderFixture',displayName:'Rendered fixture',config:{cli:${JSON.stringify(join(serverDir, "testing/fake-acp-cli.ts"))}},environment:{FAKE_ACP_MODE:'c11-budget',FAKE_C11_LOG:path.join(process.env.MURAGE_DATA_DIR,'fixture.jsonl'),FAKE_C11_SPEC:JSON.stringify({initialGate:path.join(process.env.MURAGE_DATA_DIR,'hold-engine'),catalogs:{},native:0,limit:100})}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const rig = launcherRig(".murage-rendered-catalog-");
  let proxy: ReturnType<typeof spawn> | undefined;
  let ws: WebSocketServer | undefined;
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const frame = JSON.parse(raw || "{}");
    const publication = JSON.parse(readFileSync(join(fixture.info.dataDir, "publication.json"), "utf8"));
    if (req.headers.authorization !== `Bearer ${publication.token}`) { res.writeHead(401); res.end(); return; }
    const result = frame.method === "initialize" ? { capabilities: { tools: {}, resources: {} } }
      : frame.params?.cursor ? { tools: [{ name: "last" }] } : { tools: [{ name: "first" }], nextCursor: "last" };
    res.setHeader("content-type", frame.params?.cursor ? "text/event-stream" : "application/json");
    const body = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result });
    res.end(frame.params?.cursor ? `data: ${body}\n\n` : body);
  });
  try {
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.ok).toBe(true); return res.json() as Promise<any>;
    };
    const { bot } = await api("POST", "/api/bots", { name: "Rendered proxy", modelSelection: { instanceId: "render", model: "mock" } });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold this fixture turn" });
    const publicationFile = join(fixture.info.dataDir, "publication.json");
    await expect.poll(() => existsSync(publicationFile), { timeout: 10000 }).toBe(true);
    const publication = JSON.parse(readFileSync(publicationFile, "utf8"));
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    if (kind === "vpsRelay") {
      ws = new WebSocketServer({ server: upstream });
      ws.on("connection", (socket, req) => {
        expect(req.headers.authorization).toBe(`Bearer ${publication.token}`);
        socket.on("message", raw => {
          const frame = JSON.parse(String(raw));
          socket.send(JSON.stringify({ id: frame.id, result: frame.method === "initialize" ? { capabilities: { tools: {}, resources: {} } }
            : { tools: [{ name: "served", inputSchema: { anyOf: [{ type: "object", properties: { x: { type: "string" } } }] } }] } }));
        });
      });
    }
    const relative = kind === "remote" ? "drivers/remote-mcp-proxy" : "cloud-home/vps-relay-mcp";
    const bundled = join(rig.proxyRoot, relative + ".js");
    await build({ entryPoints: [join(serverDir, relative + ".ts")], outfile: bundled, bundle: true, platform: "node", format: "esm", packages: "external", plugins: [windowsHideBundlePlugin()] });
    const manifest = JSON.parse(readFileSync(rig.manifest, "utf8"));
    manifest.mcpProxies.find((entry: any) => entry.path === bundled).sha256 = createHash("sha256").update(readFileSync(bundled)).digest("hex");
    writeFileSync(rig.manifest, JSON.stringify(manifest));
    const env = { MURAGE_MCP_LISTED_FILE: "/not-mounted/generation.proxy", MURAGE_MCP_LISTED_URL: publication.endpoint,
      ...(kind === "remote" ? { MURAGE_HARNESS_URL: origin, MURAGE_MCP_TOKEN: publication.token } : { MURAGE_CONTROL_URL: origin, MURAGE_CONTROL_TOKEN: publication.token }) };
    const mcp = cloudRenderMcp({ fixture: { command: process.execPath, args: kind === "remote" ? [SPAWNED_PROXIES.remoteMcp, "--server", "fixture"] : [SPAWNED_PROXIES.vpsRelayMcp], env } });
    const plan = rig.plan(rig.request("claudeAgent", { render: { mcp } }), { set: { NODE: process.execPath } });
    expect(plan.error).toBeUndefined();
    const config = Object.values(plan.ok!.files).map(text => { try { return JSON.parse(text); } catch { return null; } }).find(value => value?.mcpServers?.fixture);
    const descriptor = config.mcpServers.fixture;
    expect(descriptor.env.MURAGE_MCP_LISTED_URL).toBe(publication.endpoint);
    expect(descriptor.args[0]).toBe(bundled);
    const release = join(rig.root, "release"), held = join(rig.root, "held"), preload = join(rig.root, "hold.mjs");
    writeFileSync(preload, `import {existsSync,writeFileSync} from 'node:fs';const write=process.stdout.write.bind(process.stdout);
      if(process.argv[2]!=='pipe')process.stdout.write=function(chunk,...args){if(String(chunk).includes('"tools":[')){
        writeFileSync(${JSON.stringify(held)},'');const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);write(chunk,...args);}},5);return true;}return write(chunk,...args);};`);
    proxy = spawn(descriptor.command, ["--import", preload, ...descriptor.args], { env: { PATH: process.env.PATH, ...descriptor.env }, stdio: ["pipe", "pipe", "pipe"] });
    const frames: any[] = []; let buffered = "", stderr = "";
    proxy.stderr!.on("data", chunk => { stderr += chunk; });
    proxy.stdout!.on("data", chunk => { buffered += chunk; let at: number; while ((at = buffered.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffered.slice(0, at))); buffered = buffered.slice(at + 1); } });
    const send = (frame: object) => proxy!.stdin!.write(JSON.stringify(frame) + "\n");
    send({ id: 0, method: "initialize" });
    await expect.poll(() => frames.length, { timeout: 10000, message: stderr }).toBe(1);
    send({ id: 1, method: "tools/list" });
    await expect.poll(() => existsSync(held)).toBe(true);
    await expect.poll(() => readMcpCatalog(publication.marker)?.complete).toBe(false);
    expect(frames).toHaveLength(1);
    writeFileSync(release, "release");
    await expect.poll(() => frames.length).toBe(2);
    if (kind === "remote") {
      expect(readMcpCatalog(publication.marker)?.complete).toBe(false);
      unlinkSync(release); unlinkSync(held);
      send({ id: "1", method: "tools/list", params: { cursor: "last" } });
      await expect.poll(() => existsSync(held)).toBe(true);
      expect(frames).toHaveLength(2);
      expect(readMcpCatalog(publication.marker)?.complete).toBe(false);
      writeFileSync(release, "release");
      await expect.poll(() => frames.length).toBe(3);
    } else expect(frames[1].result.tools[0].inputSchema).toEqual({ type: "object", properties: { x: { type: "string" } } });
    await expect.poll(() => readMcpCatalog(publication.marker)).toMatchObject({ complete: true, resources: true, processGeneration: "generation", tools: kind === "remote" ? ["first", "last"] : ["served"] });
    const doc = readMcpCatalog(publication.marker)!;
    expect((await fetch(publication.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer invalid" }, body: JSON.stringify({ ...doc, revision: doc.revision + 1 }) })).status).toBe(401);
    expect((await fetch(publication.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${publication.token}` }, body: JSON.stringify({ ...doc, processGeneration: "other", revision: doc.revision + 1 }) })).status).toBe(403);
    await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    expect((await fetch(publication.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${publication.token}` }, body: JSON.stringify({ ...doc, revision: doc.revision + 1 }) })).status).toBe(401);
  } finally {
    writeFileSync(join(rig.root, "release"), "cleanup");
    if (ws) for (const client of ws.clients) client.terminate();
    if (proxy) { proxy.stdin?.end(); if (proxy.exitCode === null) { const exited = new Promise(resolve => proxy!.once("close", resolve)); proxy.kill(); await exited; } }
    if (ws) { for (const client of ws.clients) client.terminate(); await new Promise<void>(resolve => ws!.close(() => resolve())); }
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await fixture.close(); rig.dispose();
  }
}, 60000);
