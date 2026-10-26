import { spawn, type ChildProcess } from "node:child_process";
import { MEMORY_CURSOR_MAX_CHARS } from "../memory/cursor-limits.ts";
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
/** Hold the stub's reply past the proxy's own deadline, to prove the two
 * failures are told apart. */
let holdMs = 0;
let rpcTimeoutMs = 5000;
const pending = new Map<number, (value: Json) => void>();

function rpc(method: string, params?: unknown): Promise<Json> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, rpcTimeoutMs);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
const evidence = [{ sourceId: "source", revision: 1, startByte: 0, endByte: 8 }];

it("advertises and forwards typed grounded memory and fictional invitation evidence", async () => {
  const listed=await rpc("tools/list");
  const save=listed.result.tools.find((tool:Json)=>tool.name==="memory_save");
  expect(save.inputSchema.properties.claimType.enum).toContain("character-canon");
  expect(save.inputSchema.properties.ownerInvitation.properties).toHaveProperty("sourceId");
  expect(save.inputSchema.properties.ownerInvitation.properties).toHaveProperty("quote");
  response=JSON.stringify({candidateId:"canon",state:"active",pendingReview:false});
  const input={text:"Fictional background",evidence,idempotencyKey:"canon",claimType:"character-canon",ownerInvitation:{sourceId:"invitation",revision:1,startByte:0,endByte:8}};
  const saved=await call("memory_save",input);
  expect(saved.result.isError).toBe(false);expect(requests[0].body).toEqual(input);
  expect(requests[0].path).toBe("/api/internal/memory/save");
  requests=[];await call("memory_save",{...input,claimType:"grant-permission"});expect(requests).toEqual([]);
});

// 1.0.5: a bot cites a conversation line by its words. No tool hands it a conversation line's sourceId, so before this a bot
// could save nothing it heard (Ember on the training rig: "needs conversation sources in a specific format I couldn't provide").
it("advertises and forwards evidence given as the quoted words, with or without a messageId, and names a malformed item", async () => {
  const listed=await rpc("tools/list");
  for(const name of ["memory_save","memory_propose_correction"]){
    const tool=listed.result.tools.find((item:Json)=>item.name===name);
    const items=tool.inputSchema.properties.evidence.items;
    // one flat object, every field optional: no anyOf for an engine's tool layer to misread
    expect(items.required).toEqual([]);expect(items.anyOf).toBeUndefined();
    expect(Object.keys(items.properties)).toEqual(expect.arrayContaining(["quote","messageId","sourceId","revision","startByte","endByte"]));
    expect(tool.inputSchema.properties.evidence.description).toContain("quote");
  }
  response=JSON.stringify({candidateId:"c",state:"active",pendingReview:false});
  requests=[];
  const input={text:"Maya runs Wren & Willow.",evidence:[{quote:"I run Wren & Willow."},{quote:"We open at nine.",messageId:"msg-1"}],idempotencyKey:"quoted"};
  const saved=await call("memory_save",input);
  expect(saved.result.isError).toBe(false);expect(requests[0].body).toEqual(input);
  requests=[];
  const bad=await call("memory_save",{...input,evidence:[{}]});
  expect(bad.result.isError).toBe(true);expect(requests).toEqual([]);
  expect(bad.result.content[0].text).toContain("{quote}");
});

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url ?? "", method: req.method ?? "", auth: req.headers.authorization, body: JSON.parse(body) });
      const reply = () => { res.writeHead(status, { "content-type": "application/json" }); res.end(response); };
      if (holdMs) setTimeout(reply, holdMs); else reply();
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

beforeEach(() => { requests = []; status = 200; holdMs = 0; rpcTimeoutMs = 5000; response = JSON.stringify({ hits: [], degradedReason: "lexical-only" }); });
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill(); await closed;
  }
  if (stub) await new Promise<void>((resolve, reject) => stub.close(error => error ? reject(error) : resolve()));
});

it("negotiates MCP and exposes only the bounded memory and thread tools", async () => {
  const initialized = await rpc("initialize", { protocolVersion: "2024-11-05" });
  expect(initialized.result.protocolVersion).toBe("2024-11-05");
  expect(initialized.result.serverInfo.name).toBe("murage-memory");
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list");
  expect(listed.result.tools.map((tool: Json) => tool.name)).toEqual(["memory_search", "memory_get", "memory_save", "memory_propose_correction", "thread_search", "thread_list", "thread_read"]);
  expect(listed.result.tools.every((tool: Json) => tool.inputSchema.additionalProperties === false)).toBe(true);
  // L2: the schema states the runtime's UTF-8 byte bound, never a character minimum that would refuse 東京
  const search = listed.result.tools.find((tool: Json) => tool.name === "thread_search");
  expect(search.inputSchema.properties.query.minLength ?? 0).toBeLessThanOrEqual(1);
  expect(search.inputSchema.properties.query.description).toContain("3 to 512 UTF-8 bytes");
  // MEMJSON2: both record-addressing tools advertise the turn-local handle next to id/version.
  const get = listed.result.tools.find((tool: Json) => tool.name === "memory_get");
  expect(Object.keys(get.inputSchema.properties.handles.items.properties).sort()).toEqual(["handle", "id", "version"]);
  expect(get.inputSchema.properties.handles.items.properties.handle.pattern).toBe("^m[1-9][0-9]{0,2}$");
  const correction = listed.result.tools.find((tool: Json) => tool.name === "memory_propose_correction");
  expect(correction.inputSchema.required).toEqual(["replacement", "evidence", "idempotencyKey"]);
  expect(correction.inputSchema.properties.handle.pattern).toBe("^m[1-9][0-9]{0,2}$");
  expect((await rpc("ping")).result).toEqual({});
  expect(requests).toEqual([]);
});

it("forwards approved fields to fixed routes using the server-issued capability", async () => {
  const cases = [
    ["memory_search", "search", { query: "nightly backups", limit: 20, historical: true, cursor: "cursor" }],
    ["memory_get", "get", { handles: [{ id: "record", version: 2 }] }],
    // MEMJSON2: turn-local handles from <remembered-context> pass through verbatim.
    ["memory_get", "get", { handles: [{ handle: "m1" }, { id: "record", version: 2 }, { handle: "m999" }] }],
    ["memory_save", "save", { text: "candidate", evidence, idempotencyKey: "save-once" }],
    ["memory_propose_correction", "propose-correction", { id: "record", version: 2, replacement: "proposed", evidence, idempotencyKey: "correct-once" }],
    ["memory_propose_correction", "propose-correction", { handle: "m12", replacement: "proposed", evidence, idempotencyKey: "correct-once" }],
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
    ["memory_search", { query: "ok", cursor: "x".repeat(MEMORY_CURSOR_MAX_CHARS + 1) }],
    ["memory_search", { query: "ok", limit: 21 }],
    ["memory_get", { handles: Array.from({ length: 21 }, () => ({ id: "r", version: 1 })) }],
    ["memory_get", { handles: [{ id: "r", version: 1, scopeId: "private" }] }],
    // A reference is a handle or an exact id+version, never a mix, a bare id or a malformed handle.
    ["memory_get", { handles: [{ handle: "m1", id: "r", version: 1 }] }],
    ["memory_get", { handles: [{ id: "r" }] }],
    ["memory_get", { handles: [{ handle: "m0" }] }],
    ["memory_get", { handles: [{ handle: "m1000" }] }],
    ["memory_get", { handles: [{ handle: "r" }] }],
    ["memory_get", { handles: [{}] }],
    ["memory_propose_correction", { handle: "m1", id: "r", version: 1, replacement: "candidate", evidence, idempotencyKey: "k" }],
    ["memory_propose_correction", { replacement: "candidate", evidence, idempotencyKey: "k" }],
    ["memory_save", { text: "x".repeat(4097), evidence, idempotencyKey: "k" }],
    ["memory_save", { text: "candidate", evidence: [], idempotencyKey: "k" }],
    ["memory_propose_correction", { id: "r", version: 1, replacement: "candidate", evidence, idempotencyKey: "k", ownerApproved: true }],
    ["memory_propose_correction", { id: "r", version: 1, replacement: "candidate", evidence: [{ ...evidence[0], endByte: 0 }], idempotencyKey: "k" }],
  ] as const;
  for (const [name, args] of cases) expect((await call(name, args)).result.isError).toBe(true);
  expect((await call("http_proxy", { url: "http://example.invalid" })).error.code).toBe(-32602);
  expect(requests).toEqual([]);
});

it("says which argument a refused memory call got wrong, so the model can correct it", async () => {
  const tooLong = await call("memory_search", { query: "ok", cursor: "x".repeat(MEMORY_CURSOR_MAX_CHARS + 1) });
  expect(tooLong.result.isError).toBe(true);
  const text = tooLong.result.content[0].text as string;
  expect(text).toContain("cursor");
  expect(text).not.toBe("INVALID_MEMORY_ARGUMENTS");
  // the point of naming it: a bare code left the model retrying blind
  const missing = await call("memory_get", { handles: [{ id: "r" }] });
  expect(missing.result.content[0].text).toContain("handles");
  const unknownField = await call("memory_search", { query: "ok", botId: "other" });
  expect(unknownField.result.content[0].text.toLowerCase()).toContain("botid");
  expect(requests).toEqual([]);
});

it("distinguishes memory taking too long from memory not being there", async () => {
  holdMs = 8000; rpcTimeoutMs = 20000; // the stub holds the reply past the search deadline
  const reply = await call("memory_search", { query: "backups" });
  expect(reply.result.isError).toBe(true);
  expect(reply.result.content[0].text).toContain("5 seconds");
  expect(reply.result.content[0].text).not.toContain("MEMORY_REQUEST_FAILED");
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

it("forwards the thread tools to their fixed routes and rejects bad arguments before any request", async () => {
  const cases = [
    ["thread_search", "thread-search", { query: "vault code", before: "2026-01-01" }],
    ["thread_search", "thread-search", { query: "vault", before: "2026-01-01T10:00:00.123Z" }],
    // L2: two characters, six UTF-8 bytes: inside the 3 to 512 byte bound
    ["thread_search", "thread-search", { query: "東京" }],
    ["thread_list", "thread-list", {}],
    ["thread_list", "thread-list", { before: "2026-01-01" }],
    ["thread_read", "thread-read", { message_id: "m-1", direction: "around", limit: 40 }],
  ] as const;
  for (const [name, route, args] of cases) {
    requests = []; response = JSON.stringify({ rows: [] });
    const reply = await call(name, args);
    expect(reply.result.isError).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe(`/api/internal/memory/${route}`);
    expect(requests[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].body).toEqual(args);
  }
  requests = [];
  const bad: Array<[string, unknown]> = [
    ["thread_search", { query: "ab" }], ["thread_search", { query: "é" }], ["thread_search", { query: "あ".repeat(171) }], ["thread_search", { query: "x".repeat(513) }], ["thread_search", { query: "vault", before: "yesterday" }],
    ["thread_search", { query: "vault", before: "m-1" }], ["thread_search", { query: "vault", extra: 1 }], ["thread_list", { before: 12 }],
    ["thread_read", { message_id: "m", direction: "sideways" }], ["thread_read", { message_id: "m", direction: "before", limit: 41 }],
    ["thread_read", { message_id: "m", direction: "before", limit: 0 }], ["thread_read", { message_id: "x".repeat(257), direction: "before" }],
    ["thread_read", { direction: "before" }],
  ];
  for (const [name, args] of bad) {
    const reply = await call(name, args);
    expect(reply.result.isError).toBe(true);
    expect(String(reply.result.content[0].text)).toContain("Memory request rejected");
  }
  expect(requests).toEqual([]);
});

it("a request id over 256 bytes, or neither a string nor a finite number, runs no tool", async () => {
  const invalid = (id: unknown) => new Promise<Json>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(null as never); reject(new Error("no reply")); }, 5000);
    pending.set(null as never, value => { clearTimeout(timer); resolve(value); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "thread_list", arguments: {} } }) + "\n");
  });
  requests = [];
  for (const id of ["x".repeat(300), "é".repeat(129), true, { a: 1 }, [1], null]) {
    const reply = await invalid(id);
    expect(reply.error).toEqual({ code: -32600, message: "Invalid request" });
  }
  expect(requests).toEqual([]);
  // an id of exactly 256 bytes and a number still run
  response = JSON.stringify({ rows: [] });
  const ok = new Promise<Json>(resolve => { pending.set(1.5 as never, resolve); });
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "tools/call", params: { name: "thread_list", arguments: {} } }) + "\n");
  expect((await ok).result.isError).toBe(false);
  expect(requests).toHaveLength(1);
});
