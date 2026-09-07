import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const TOKEN = "fixture-memory-capability";
type Json = Record<string, any>;
let stub: Server;
let child: ChildProcess;
let nextId = 1;
let status = 200;
let response = JSON.stringify({ hits: [], degradedReason: "lexical-only" });
let requests: Array<{ path: string; method: string; auth: string | undefined; body: Json }> = [];
const pending = new Map<number, (value: Json) => void>();

function rpc(method: string, params?: unknown): Promise<Json> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 5000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
const evidence = [{ sourceId: "source", revision: 1, startByte: 0, endByte: 8 }];

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url ?? "", method: req.method ?? "", auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(response);
    });
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./memory-proxy.ts", import.meta.url))], {
    env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${address.port}`, MURAGE_MEMORY_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffered = "";
  child.stdout!.on("data", chunk => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Json;
      const resolve = pending.get(message.id);
      pending.delete(message.id); resolve?.(message);
    }
  });
});

beforeEach(() => { requests = []; status = 200; response = JSON.stringify({ hits: [], degradedReason: "lexical-only" }); });
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill(); await closed;
  }
  if (stub) await new Promise<void>((resolve, reject) => stub.close(error => error ? reject(error) : resolve()));
});

it("negotiates MCP and exposes only four bounded memory tools", async () => {
  const initialized = await rpc("initialize", { protocolVersion: "2024-11-05" });
  expect(initialized.result.protocolVersion).toBe("2024-11-05");
  expect(initialized.result.serverInfo.name).toBe("murage-memory");
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list");
  expect(listed.result.tools.map((tool: Json) => tool.name)).toEqual(["memory_search", "memory_get", "memory_save", "memory_propose_correction"]);
  expect(listed.result.tools.every((tool: Json) => tool.inputSchema.additionalProperties === false)).toBe(true);
  expect((await rpc("ping")).result).toEqual({});
  expect(requests).toEqual([]);
});

it("forwards approved fields to fixed routes using the server-issued capability", async () => {
  const cases = [
    ["memory_search", "search", { query: "nightly backups", limit: 20, historical: true, cursor: "cursor" }],
    ["memory_get", "get", { handles: [{ id: "record", version: 2 }] }],
    ["memory_save", "save", { text: "candidate", evidence, idempotencyKey: "save-once" }],
    ["memory_propose_correction", "propose-correction", { id: "record", version: 2, replacement: "proposed", evidence, idempotencyKey: "correct-once" }],
  ] as const;
  for (const [name, route, args] of cases) {
    const reply = await call(name, args);
    expect(reply.result.isError).toBe(false);
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ hits: [], degradedReason: "lexical-only" });
    expect(requests.at(-1)).toEqual({ path: `/api/internal/memory/${route}`, method: "POST", auth: `Bearer ${TOKEN}`, body: args });
  }
});

it("rejects caller authority claims and oversized or malformed arguments before HTTP", async () => {
  const cases = [
    ["memory_search", { query: "ok", botId: "other" }],
    ["memory_search", { query: "界".repeat(1366) }],
    ["memory_search", { query: "ok", cursor: "x".repeat(161) }],
    ["memory_search", { query: "ok", limit: 21 }],
    ["memory_get", { handles: Array.from({ length: 21 }, () => ({ id: "r", version: 1 })) }],
    ["memory_get", { handles: [{ id: "r", version: 1, scopeId: "private" }] }],
    ["memory_save", { text: "x".repeat(4097), evidence, idempotencyKey: "k" }],
    ["memory_save", { text: "candidate", evidence: [], idempotencyKey: "k" }],
    ["memory_propose_correction", { id: "r", version: 1, replacement: "candidate", evidence, idempotencyKey: "k", ownerApproved: true }],
    ["memory_propose_correction", { id: "r", version: 1, replacement: "candidate", evidence: [{ ...evidence[0], endByte: 0 }], idempotencyKey: "k" }],
  ] as const;
  for (const [name, args] of cases) expect((await call(name, args)).result.isError).toBe(true);
  expect((await call("http_proxy", { url: "http://example.invalid" })).error.code).toBe(-32602);
  expect(requests).toEqual([]);
});

it("preserves API failure and degraded results without claiming success", async () => {
  status = 403; response = JSON.stringify({ error: "MEMORY_CONTEXT_REVOKED" });
  let reply = await call("memory_search", { query: "backups" });
  expect(reply.result.isError).toBe(true);
  expect(JSON.parse(reply.result.content[0].text).error).toBe("MEMORY_CONTEXT_REVOKED");
  status = 200; response = JSON.stringify({ error: "MEMORY_EVIDENCE_UNAVAILABLE" });
  reply = await call("memory_save", { text: "candidate", evidence, idempotencyKey: "k" });
  expect(reply.result.isError).toBe(true);
  response = "not json";
  expect((await call("memory_search", { query: "backups" })).result.isError).toBe(true);
});

it("refuses oversized response frames and never executes tool notifications", async () => {
  response = JSON.stringify({ text: "x".repeat(32769) });
  const reply = await call("memory_get", { handles: [{ id: "r", version: 1 }] });
  expect(reply.result.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(32768);
  const count = requests.length;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "memory_save", arguments: { text: "candidate", evidence, idempotencyKey: "k" } } }) + "\n");
  await rpc("ping");
  expect(requests).toHaveLength(count);
});
