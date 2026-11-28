// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { kimiAcpSupport } from "./kimi.ts";
import { createToolListNormalizer } from "../../mcp-tool-schema.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

let root = "";
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill(); await closed; }
  if (root) removeTempDirSync(root);
});
const small = { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const large = { name: "large", inputSchema: { type: "object", properties: { query: { type: "string", description: "x".repeat(13_000) } } } };
it("the schema budget empties only the oversized server's list and never tool results", () => {
  const guarded = createToolListNormalizer(12_000);
  const other = createToolListNormalizer(12_000);
  const request = JSON.stringify({ id: 1, method: "tools/list" });
  guarded.observeRequest(request); other.observeRequest(request);
  const frame = (tools: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });
  expect(JSON.parse(guarded.rewriteResponse(frame([small, large]))).result.tools).toEqual([]);
  expect(JSON.parse(other.rewriteResponse(frame([small]))).result.tools).toEqual([small]);
  const result = JSON.stringify({ id: 9, result: { content: [{ type: "text", text: "x".repeat(14_000) }] } });
  expect(guarded.rewriteResponse(result)).toBe(result);
});

it.each(["source", "packaged"])("Kimi's %s session mounts enforce the budget on independent MCP streams", async mode => {
  expect(typeof kimiAcpSupport.sessionMcpServers).toBe("function");
  root = mkdtempSync(join(tmpdir(), "murage-kimi-schema-"));
  const fixture = join(root, "mcp.mjs");
  writeFileSync(fixture, `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:JSON.parse(process.env.FIXTURE_TOOLS)}:{content:[{type:'text',text:'called'}]}})+'\\n')});`);
  const original = [small, large].map((tool, index) => ({ name: `server-${index}`, command: process.execPath, args: [fixture], env: [{ name: "FIXTURE_TOOLS", value: JSON.stringify([tool]) }] }));
  let mounts = kimiAcpSupport.sessionMcpServers!(original);
  if (mode === "packaged") {
    const { build } = await import("esbuild");
    const output = await build({ entryPoints: [fileURLToPath(new URL("../../mcp-tool-schema.ts", import.meta.url))], bundle: true, platform: "node", target: "node20", format: "esm", write: false });
    const file = join(root, "schema.mjs");
    writeFileSync(file, output.outputFiles![0]!.text);
    const bundled = await import(pathToFileURL(file).href) as typeof import("../../mcp-tool-schema.ts");
    mounts = bundled.budgetMcpServers(original, 12_000);
  }
  const rpc = async (mount: typeof mounts[number], method = "tools/list") => {
    const child = spawn(mount.command, mount.args, { env: { ...process.env, ...Object.fromEntries(mount.env.map(entry => [entry.name, entry.value])) }, stdio: "pipe" });
    children.push(child);
    return await new Promise<any>((resolve, reject) => {
      let buffer = "";
      child.once("error", reject);
      child.stdout.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method }) + "\n");
    });
  };
  expect((await rpc(mounts[0]!)).result.tools).toEqual([small]);
  expect((await rpc(mounts[1]!)).result.tools).toEqual([]);
});

async function diagnosticProbe(program: string, input = "", missing = false) {
  root = mkdtempSync(join(tmpdir(), "murage-schema-diagnostic-"));
  const peer = join(root, "peer.mjs");
  writeFileSync(peer, program);
  const [mount] = kimiAcpSupport.sessionMcpServers!([{ name: "fixture", command: missing ? join(root, "missing-peer") : process.execPath, args: missing ? [] : [peer], env: [{ name: "FIXTURE_CREDENTIAL", value: "fixture-sensitive-value" }] }]);
  const child = spawn(mount!.command, mount!.args, { env: { ...process.env, ...Object.fromEntries(mount!.env.map(e => [e.name, e.value])) }, stdio: "pipe" });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  if (input) child.stdin.write(input);
  await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  return stderr;
}
it("guard preserves bounded redacted child stderr across chunks", async () => {
  const stderr = await diagnosticProbe(`process.stderr.write('catalog unavailable token=');setTimeout(()=>{process.stderr.write('fixture-sensitive-value\\n');process.stderr.write('-----'+'BEGIN PRIVATE KEY-----\\nfixture-private-material\\n-----END PRIVATE KEY-----\\n');process.stderr.write('diagnostic detail\\n'.repeat(10000));},20);`);
  expect(stderr).toContain("catalog unavailable");
  expect(stderr).toContain("redacted");
  expect(stderr).not.toContain("fixture-sensitive-value");
  expect(stderr).not.toContain("fixture-private-material");
  expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(5000);
});
it("guard preserves the spawn failure reason", async () => {
  expect(await diagnosticProbe("", "", true)).toContain("ENOENT");
});
it("guard preserves forwarding failure reasons", async () => {
  const stderr = await diagnosticProbe("setInterval(()=>{},1000)", "x".repeat(8 * 1024 * 1024 + 1));
  expect(stderr).toContain("frame bound");
});
it("inventories both Kimi schema-budget English strings", () => {
  const inventory = readFileSync(new URL("../../../docs/verification/acp-rest-english.md", import.meta.url), "utf8");
  expect(inventory).toContain("This server was left out because its tool schemas exceed Kimi’s size limit.");
  expect(inventory).toContain("Murage left out one MCP server: its tool schemas exceed Kimi’s size limit.");
});
