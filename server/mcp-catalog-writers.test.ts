import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readMcpCatalog } from "./mcp-listed.ts";

const mounts = ["drivers/agents-proxy.ts", "drivers/memory-proxy.ts", "computer-proxy.ts", "connector-proxy.ts", "drivers/host-computer-proxy.ts", "drivers/unified-browser-proxy.ts", "drivers/phone-jobs-proxy.ts"];
it.each([...mounts.map(file => ({ file, fail: false })), ...["drivers/host-computer-proxy.ts", "drivers/phone-jobs-proxy.ts"].map(file => ({ file, fail: true }))])("T19 actual catalog writer flush $file failure=$fail", async ({ file, fail }) => {
  const root = mkdtempSync(join(tmpdir(), "c11-writer-")), marker = join(root, "generation.mount"), release = join(root, "release"), held = join(root, "held");
  const preload = join(root, "hold.mjs");
  writeFileSync(preload, `import {existsSync,writeFileSync} from 'node:fs';
const write=process.stdout.write.bind(process.stdout);
process.stdout.write=function(chunk,...args){
 if(String(chunk).includes('"tools":[')){
  writeFileSync(${JSON.stringify(held)},'');
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);${fail ? "const cb=args.find(x=>typeof x==='function');cb?.(new Error('fixture flush failed'));" : "write(chunk,...args);"}}},5);return true;
 }return write(chunk,...args);
};`);
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : {};
    const result = rpc.method === "tools/list" ? { tools: [{ name: "served_tool", description: "Offline fixture", inputSchema: { type: "object", properties: {} } }] } : rpc.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { content: [{ type: "text", text: "Offline fixture" }] };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rpc.jsonrpc ? { jsonrpc: "2.0", id: rpc.id, result } : result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL(file, import.meta.url))], {
    env: { ...process.env, MURAGE_MCP_LISTED_FILE: marker, MURAGE_CONTROL_URL: base, MURAGE_HARNESS_URL: base, MURAGE_CONNECTOR_UPSTREAM_URL: base, MURAGE_CONTROL_TOKEN: "fixture-only", MURAGE_COMMS_TOKEN: "fixture-only", MURAGE_MEMORY_TOKEN: "fixture-only", MURAGE_BOT_ID: "fixture", MURAGE_THREAD_ID: "fixture", MURAGE_PHONE_TOOLS: "phone_calendar_read", MURAGEBOX_BOX_API: base, MURAGEBOX_BOX_ID: "fixture", MURAGEBOX_TOKEN: "fixture-only" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let output = "", stderr = ""; const frames: any[] = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => { output += chunk; let at: number; while ((at = output.indexOf("\n")) >= 0) { frames.push(JSON.parse(output.slice(0, at))); output = output.slice(at + 1); } });
  const send = (id: number, method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { name: "absent_fixture_tool" } }) + "\n");
  try {
    send(1, "initialize"); await expect.poll(() => frames.some(frame => frame.id === 1) || stderr, { timeout: 10000 }).toBe(true);
    send(2, "tools/call"); await expect.poll(() => frames.some(frame => frame.id === 2), { timeout: 10000 }).toBe(true);
    expect(readMcpCatalog(marker)?.complete).not.toBe(true);
    send(3, "tools/list"); await expect.poll(() => existsSync(held) || stderr, { timeout: 10000 }).toBe(true);
    expect(frames.some(frame => frame.id === 3)).toBe(false);
    expect(readMcpCatalog(marker)?.complete).not.toBe(true);
    writeFileSync(release, "release");
    if (fail) {
      await expect.poll(() => stderr.includes("fixture flush failed") || child.exitCode !== null, { timeout: 10000 }).toBe(true);
      expect(readMcpCatalog(marker)?.complete).not.toBe(true);
    } else {
      await expect.poll(() => readMcpCatalog(marker)?.complete, { timeout: 10000 }).toBe(true);
      const tools = frames.find(frame => frame.id === 3).result.tools;
      expect(tools.length).toBeGreaterThan(0);
      expect(readMcpCatalog(marker)).toMatchObject({ processGeneration: "generation", resources: false });
      expect(readMcpCatalog(marker)?.tools?.slice().sort()).toEqual(tools.map((tool: any) => tool.name).sort());
    }
  } finally { child.kill("SIGTERM"); await closed; await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
