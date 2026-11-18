// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// C11 v3.1 Astra r3 finding 4 (P-2 to P-5): each real proxy, spawned over stdio exactly as an engine runs it, with its FIRST catalog
// publication refused (a 403 from the harness). The caller sees exactly one answer per request id (the refused list gets the
// replacement error, never a result the catalog did not certify), a later list certifies, and the process stays alive.
import { boundProxyState, boundProxyTerminal, spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { publicationFailureFrame } from "../mcp-listed.ts";
import { terminalProxyRefusal } from "../proxy-turn-release.ts";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_TOOLS_ASK_HARNESS } from "../connector-cache.ts";

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }); });

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
/** The harness catalog endpoint: refuses the first POST, then keeps the highest revision it was given. */
async function refusingCatalog() {
  const posts: any[] = []; let stored = 0; let last: any;
  const base = await listen(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const doc = JSON.parse(body); posts.push(doc);
    if (posts.length === 1 || doc.revision <= stored) { res.writeHead(403).end(); return; }
    stored = doc.revision; last = doc; res.writeHead(200).end("{}");
  });
  return { url: `${base}/api/internal/mcp-catalog/${randomUUID()}`, posts, stored: () => last };
}
interface Run { send(...frames: unknown[]): void; frames(): any[]; exited(): Promise<number | null>; kill(): void; terminal(): unknown; state(): ReturnType<typeof boundProxyState>; }
async function run(entry: string, env: Record<string, string>, args: string[] = []): Promise<Run> {
  const role = ({ "./phone-jobs-proxy.ts": "phoneJobs", "./host-computer-proxy.ts": "hostComputer", "./unified-browser-proxy.ts": "unifiedBrowser", "../computer-proxy.ts": "computer", "../connector-proxy.ts": "connectors" } as Record<string, string>)[entry];
  if (!role) throw new Error("fixture proxy role missing");
  const child = await spawnBoundProxy(role, process.execPath, ["--experimental-strip-types", ...args, here(entry)], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let out = ""; child.stdout.on("data", (c) => { out += c; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  return {
    send: (...frames) => { for (const f of frames) child.stdin.write(`${JSON.stringify(f)}\n`); },
    frames: () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    exited: () => closed, terminal: () => boundProxyTerminal(child), state: () => boundProxyState(child),
    kill: () => { child.kill("SIGKILL"); },
  };
}
const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 15_000) => { for (let t = 0; t < ms && !check(); t += 25) await wait(25); };
const marker = (name: string) => join(mkdtempSync(join(tmpdir(), `c11-refuse-${name}-`)), "generation.mount");

/** P-2: list 1 is refused, list 2 and ping 3 follow. One answer each; 1 is the replacement error, 2 certifies, the process stays alive to its input's end. */
async function refusedFirstList(proxy: Run, stored: () => any, expected: string[]) {
  try {
    proxy.send(list(1));
    await until(() => proxy.frames().some((f) => f.id === 1));
    proxy.send(list(2), { jsonrpc: "2.0", id: 3, method: "ping" });
    await until(() => proxy.frames().length >= 3);
    const byId = new Map<number, any[]>(); for (const f of proxy.frames()) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
    expect([...byId.keys()].sort()).toEqual([1, 2, 3]);
    for (const id of [1, 2, 3]) expect(byId.get(id)).toHaveLength(1);
    expect(byId.get(1)![0].error?.code).toBe(-32000);
    expect(byId.get(1)![0].result).toBeUndefined();
    expect(byId.get(2)![0].result.tools.map((t: { name: string }) => t.name)).toEqual(expected);
    expect(byId.get(3)![0].result).toBeDefined();
    await until(() => stored()?.complete === true);
    expect(stored()).toMatchObject({ complete: true, tools: expected });
  } finally { proxy.kill(); }
}

describe("C11 v3.1 P-2: real proxies with their first catalog POST refused", () => {
  it("phoneJobs", async () => {
    const catalog = await refusingCatalog(), path = marker("phone");
    const base = await listen((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
    const proxy = await run("./phone-jobs-proxy.ts", { MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: catalog.url, MURAGE_MCP_TOKEN: "t", MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "device-token", MURAGE_PHONE_TOOLS: "phone_calendar_read" });
    await refusedFirstList(proxy, catalog.stored, ["phone_calendar_read"]);
  }, 40_000);

  it("hostComputer", async () => {
    const catalog = await refusingCatalog(), path = marker("host");
    const base = await listen((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tools: [{ name: "host_click" }] }))); });
    const proxy = await run("./host-computer-proxy.ts", { MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: catalog.url, MURAGE_MCP_TOKEN: "t",
      MURAGE_CONTROL_URL: `${base}/api/internal/computer-control?botId=b1`, MURAGE_CONTROL_TOKEN: "t", MURAGE_BOT_ID: "b1", MURAGE_THREAD_ID: "th1" });
    await refusedFirstList(proxy, catalog.stored, ["host_click"]);
  }, 40_000);

  it("unifiedBrowser", async () => {
    const catalog = await refusingCatalog(), path = marker("browser");
    const base = await listen((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tools: [{ name: "browser_open" }] }))); });
    const proxy = await run("./unified-browser-proxy.ts", { MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: catalog.url, MURAGE_MCP_TOKEN: "t",
      MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "bot", MURAGE_THREAD_ID: "thread" });
    await refusedFirstList(proxy, catalog.stored, ["browser_open"]);
  }, 40_000);
});

describe("C11 v3.1 P-3/P-4: the computer proxy", () => {
  const computer = (path: string, url: string) => run("../computer-proxy.ts", { MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: url, MURAGE_MCP_TOKEN: "t",
    MURAGEBOX_BOX_API: "http://127.0.0.1:9", MURAGEBOX_BOX_ID: "box-1", MURAGEBOX_BOX_TOKEN: "t" });

  it("P-3 a refused first list is answered once with its replacement error, a notification in between writes nothing, and the next list certifies from the served tools", async () => {
    const catalog = await refusingCatalog(), path = marker("computer");
    const proxy = await computer(path, catalog.url);
    try {
      proxy.send(list(1));
      await until(() => proxy.frames().some((f) => f.id === 1));
      proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await wait(300);
      expect(proxy.frames()).toHaveLength(1);
      expect(proxy.frames()[0].error?.code).toBe(-32000);
      proxy.send(list(2));
      await until(() => proxy.frames().some((f) => f.id === 2));
      const served = proxy.frames().find((f) => f.id === 2).result.tools.map((t: { name: string }) => t.name);
      expect(served.length).toBeGreaterThan(0);
      await until(() => catalog.stored()?.complete === true);
      expect(catalog.stored()).toMatchObject({ complete: true, tools: served });
      expect(proxy.frames().map((f) => f.id)).toEqual([1, 2]);
    } finally { proxy.kill(); }
  }, 40_000);
});

describe("C11 v3.1 P-5: connector publication and transport refusals", () => {
  it("a first list the service cannot answer, with its publication refused: the failure is delivered once as the id's replacement answer and the process then exits 1", async () => {
    const catalog = await refusingCatalog(), path = marker("connector");
    const proxy = await run("../connector-proxy.ts", { MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: catalog.url, MURAGE_MCP_TOKEN: "t",
      MURAGE_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:9/mcp", MURAGE_CONNECTORS_TOKEN: "t", MURAGE_HARNESS_URL: "http://127.0.0.1:9",
      MURAGE_CONNECTOR_INITIAL_TOOLS: INITIAL_TOOLS_ASK_HARNESS, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: mkdtempSync(join(tmpdir(), "c11-refuse-cache-")),
      ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}) });
    const timer = setTimeout(() => proxy.kill(), 30_000);
    try {
      proxy.send(list(1));
      expect(await proxy.exited()).toBe(1);
      const frames = proxy.frames();
      // MAIN RULING INT-CONFLICT-DEFAULT 6a9dfe7db8 0058cec1be: upstream loss seals the consuming instance; no ordinary catalog fallback may reach the engine
      expect(frames).toHaveLength(0);
      // MAIN RULING INT-CONFLICT-DEFAULT 6a9dfe7db8 0058cec1be: retain the complete failure-envelope proof on the authenticated supervisor channel, with one refusal
      expect(proxy.state()).toMatchObject({ sealed: true, refusals: 1, terminal: {
        jsonrpc: "2.0", id: null, error: { code: -32099, data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } },
      } });
      // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: lost consuming transport seals before any ordinary reply; retain replacement coverage on the received-policy control below.
      expect(proxy.terminal()).toEqual(terminalProxyRefusal(null));
      expect(proxy.state()).toMatchObject({ sealed: true, refusals: 1 });
      expect(proxy.frames()).toEqual([]);
      expect(catalog.posts).toHaveLength(1);
      expect(catalog.posts[0]).toMatchObject({ complete: false });
    } finally { clearTimeout(timer); proxy.kill(); }
  }, 40_000);

  it("a received first-list policy refusal retains the exact publication replacement once and leaves the proxy alive", async () => {
    const catalog = await refusingCatalog(), path = marker("connector-policy");
    const upstream = await listen((req, res) => { req.resume(); res.writeHead(403, { "content-type": "application/json" }).end("{}"); });
    const proxy = await run("../connector-proxy.ts", { MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: catalog.url, MURAGE_MCP_TOKEN: "t",
      MURAGE_CONNECTOR_UPSTREAM_URL: `${upstream}/mcp`, MURAGE_CONNECTORS_TOKEN: "t", MURAGE_HARNESS_URL: upstream,
      MURAGE_CONNECTOR_INITIAL_TOOLS: INITIAL_TOOLS_ASK_HARNESS, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: mkdtempSync(join(tmpdir(), "c11-policy-cache-")),
      ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}) });
    try {
      proxy.send(list(1));
      await until(() => proxy.frames().length > 0);
      const frames = proxy.frames();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual(publicationFailureFrame(1));
      expect(proxy.state()).toMatchObject({ sealed: false, refusals: 0 });
      expect(proxy.terminal()).toBeUndefined();
    } finally { proxy.kill(); }
  }, 40_000);
});
