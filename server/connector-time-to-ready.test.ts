// How long the connected-apps MCP server takes to be ready, as an engine sees
// it: spawn, initialize answered, then tools/list answered. Measured end to
// end through the real stdio bridge (connector-proxy.ts) and the real harness
// relay (composio.relayMcp) against a broker that answers like a busy one
// (initialize 1.5 s, tools/list 3 s), while busy loops keep the CPU loaded.
// Before 1.0.2 the bridge waited on the broker's initialize (capped at 1 s)
// and every mount after a quiet spell waited on the broker's tools/list, so a
// loaded Mac could push it past the engine's own connect timeout.
import { exposedToolName } from "../shared/connected-app-names.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyManagedBrokerMessage, bumpAccessRevisionForTests, primeBrokerReadiness, relayMcp, resetManagedBrokerState, setColdToolsListWaitMsForTests } from "./composio.ts";
import type { AppConfig } from "./config.ts";
import { windowsPerfBudget } from "./testing/windows-hosted.ts";

/** The bridge lists its own outcome-check tool beside the service tools (1.0.2 tool latency); these assertions are about the service tools. */
const notStatusTool = (tool: { name?: string }) => tool.name !== "CHECK_CONNECTED_APP_ACTION";
/** The service tools of a list that must carry the outcome check exactly once (every list does, stand-ins included). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serviceTools = (tools: any[]): any[] => {
  expect(tools.filter((tool) => !notStatusTool(tool))).toHaveLength(1);
  return tools.filter(notStatusTool);
};
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
const BROKER_INITIALIZE_MS = 1_500;
const BROKER_TOOLS_LIST_MS = 3_000;
/** A broker slower than the cold wait (COLD_TOOLS_LIST_WAIT_MS, 4 s). */
const SLOW_BROKER_TOOLS_LIST_MS = 20_000;
/** Ready budgets under load. initialize and a mount with a remembered list:
 * no broker round trip at all. The first mount after the app starts: one
 * broker tools/list, never more than the cold wait. */
const INITIALIZE_BUDGET_MS = 500;
const WARM_BUDGET_MS = 500;
const COLD_BUDGET_MS = BROKER_TOOLS_LIST_MS + 800;
/** The first list is held 8 s for the real one (Codex and Grok never list again), then the bundled tools. */
/** A broker slower than the 8 s hold, for the loaded-Mac loop. */
const SLOW_LOOP_BROKER_MS = 10_000;
const SLOW_COLD_BUDGET_MS = 8_000 + 1_500;
let toolsListDelayMs = BROKER_TOOLS_LIST_MS;
/** How many tools/list requests the broker has received. */
let toolsListCalls = 0;

const TOOLS = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"]
  .map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));
/** The same tools as an engine is shown them: plain names, and descriptions that say them plainly too. */
const SHOWN = TOOLS.map((tool) => exposedToolName(tool.name));

let broker: Server;
let harness: Server;
let harnessUrl = "";
const loops: ChildProcess[] = [];
const cfg = {} as AppConfig;

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("did not bind");
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  broker = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname.endsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ service: "flux-composio", ready: true, claims: true }));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (body.id === undefined) { res.writeHead(202); return res.end(); }
    if (body.method === "tools/list") toolsListCalls += 1;
    const wait = body.method === "initialize" ? BROKER_INITIALIZE_MS : body.method === "tools/list" ? toolsListDelayMs : 0;
    await new Promise((resolve) => setTimeout(resolve, wait));
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: TOOLS } : { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
  });
  const base = await listen(broker);
  // The harness route, minus its bot checks: the body straight into relayMcp.
  harness = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const reply = await relayMcp(cfg, JSON.parse(Buffer.concat(chunks).toString("utf8")), req.headers["mcp-session-id"] as string | undefined);
      res.writeHead(reply.status, { "content-type": reply.contentType, ...(reply.transportSessionId ? { "mcp-session-id": reply.transportSessionId } : {}) });
      res.end(Buffer.from(reply.bytes));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  harnessUrl = await listen(harness);
  brokerBase = base;
});

let brokerBase = "";
/** A freshly started app: nothing remembered, the broker known ready. */
async function freshApp(): Promise<void> {
  resetManagedBrokerState();
  const fluxUrl = `${brokerBase}/composio`;
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: null,
    fluxBrokerUrl: fluxUrl,
    fluxAccess: { url: fluxUrl, token: "b".repeat(64) },
    legacyUntil: "",
    legacyClaim: { state: "claimed" },
    accountKind: null,
    tokenError: null,
  });
  await primeBrokerReadiness();
}

afterAll(async () => {
  resetManagedBrokerState();
  await new Promise<void>((resolve) => harness.close(() => resolve()));
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

/** Spawn the bridge and time it the way an engine connects: initialize, then
 * the initialized notice and tools/list. Resolves with ms to tools/list. */
async function timeToReady(): Promise<{ initializeMs: number; readyMs: number; tools: string[] }> {
  const started = Date.now();
  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { ...process.env, MURAGE_CONNECTOR_UPSTREAM_URL: `${harnessUrl}/api/internal/connectors/mcp`, MURAGE_CONNECTOR_UPSTREAM_HEADERS: "{}", MURAGE_CONNECTOR_TOOLS_CACHE_DIR: mkdtempSync(join(tmpdir(), "ttr-cache-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const lines = readline.createInterface({ input: child.stdout! });
    const replies = new Map<number, (message: any) => void>();
    lines.on("line", (line) => {
      try { const message = JSON.parse(line); replies.get(message.id)?.(message); } catch { /* not ours */ }
    });
    const ask = (id: number, method: string) => new Promise<any>((resolve) => {
      replies.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ttr", version: "1" } } : {} })}\n`);
    });
    await ask(1, "initialize");
    const initializeMs = Date.now() - started;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await ask(2, "tools/list");
    return { initializeMs, readyMs: Date.now() - started, tools: serviceTools(list.result?.tools ?? []).map((tool: { name: string }) => tool.name) };
  } finally {
    child.kill("SIGKILL");
  }
}

describe("connected apps time to ready under CPU load", () => {
  for (const busyLoops of [2, 4]) {
    it(`answers initialize at once and is ready within its budgets (${busyLoops} busy loops)`, { timeout: 90_000, ...windowsPerfBudget() }, async () => {
      for (let i = 0; i < busyLoops; i++) loops.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
      try {
        await freshApp();
        toolsListDelayMs = BROKER_TOOLS_LIST_MS;
        const cold = await timeToReady();
        // The bridge answered the first mount from the bundled tools after its short bound;
        // the broker finishes in the background, and the harness remembers the real list.
        await new Promise((resolve) => setTimeout(resolve, BROKER_TOOLS_LIST_MS + 500));
        const warm = await timeToReady();
        const again = await timeToReady();
        await freshApp();
        toolsListDelayMs = SLOW_LOOP_BROKER_MS;
        const slow = await timeToReady();
        console.info(`connected-apps time-to-ready loops=${busyLoops} initialize=${cold.initializeMs}ms; first mount (broker ${BROKER_TOOLS_LIST_MS}ms) ready=${cold.readyMs}ms; remembered ready=${warm.readyMs}ms,${again.readyMs}ms; first mount (broker ${SLOW_BROKER_TOOLS_LIST_MS}ms) ready=${slow.readyMs}ms`);
        expect(cold.initializeMs).toBeLessThan(INITIALIZE_BUDGET_MS);
        expect(cold.readyMs).toBeLessThan(COLD_BUDGET_MS);
        expect(warm.readyMs).toBeLessThan(WARM_BUDGET_MS);
        expect(again.readyMs).toBeLessThan(WARM_BUDGET_MS);
        expect(warm.tools).toEqual(SHOWN);
        // Let the slow broker answer finish so it cannot land in the next test.
        await new Promise((resolve) => setTimeout(resolve, SLOW_LOOP_BROKER_MS));
        expect(slow.readyMs).toBeLessThan(SLOW_COLD_BUDGET_MS);
        expect(slow.tools).toContain("APPS_SEARCH_TOOLS");
      } finally {
        for (const loop of loops.splice(0)) loop.kill("SIGKILL");
        toolsListDelayMs = BROKER_TOOLS_LIST_MS;
      }
    });
  }
});

/** Spawn the bridge, mount it, and keep it running: the engine side of a
 * provisional list being replaced by the real one. */
async function mountAndWatch(watchMs: number): Promise<{ first: any; changedAtMs: number | null; relisted: any }> {
  const started = Date.now();
  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { ...process.env, MURAGE_CONNECTORS_TOKEN: "turn-token", MURAGE_CONNECTOR_UPSTREAM_URL: `${harnessUrl}/api/internal/connectors/mcp`, MURAGE_CONNECTOR_UPSTREAM_HEADERS: "{}", MURAGE_CONNECTOR_TOOLS_CACHE_DIR: mkdtempSync(join(tmpdir(), "ttr-cache-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const lines = readline.createInterface({ input: child.stdout! });
    const replies = new Map<number, (message: any) => void>();
    let changed: () => void = () => {};
    const changedSeen = new Promise<void>((resolve) => { changed = resolve; });
    let changedAtMs: number | null = null;
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method === "notifications/tools/list_changed") { changedAtMs ??= Date.now() - started; changed(); }
        else replies.get(message.id)?.(message);
      } catch { /* not ours */ }
    });
    const ask = (id: number, method: string) => new Promise<any>((resolve) => {
      replies.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ttr", version: "1" } } : {} })}\n`);
    });
    const init = await ask(1, "initialize");
    expect(init.result.capabilities.tools).toEqual({ listChanged: true });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const first = await ask(2, "tools/list");
    await Promise.race([changedSeen, new Promise((resolve) => setTimeout(resolve, watchMs))]);
    const relisted = changedAtMs === null ? null : await ask(3, "tools/list");
    return { first, changedAtMs, relisted };
  } finally {
    child.kill("SIGKILL");
  }
}

describe("a first mount answered before the connection service", () => {
  it("gets the standard tools with their real schemas, then the real list and a list_changed notice", async () => {
    await freshApp();
    toolsListDelayMs = SLOW_BROKER_TOOLS_LIST_MS;
    try {
      const { first, changedAtMs, relisted } = await mountAndWatch(30_000);
      // The bundled list, marked provisional, with search's real structure.
      expect(first.result._meta).toEqual({ "murage/provisional": true });
      serviceTools(first.result.tools); // the stand-in list carries the outcome check once
      const search = first.result.tools.find((tool: { name: string }) => tool.name === "APPS_SEARCH_TOOLS");
      expect(search.inputSchema.required).toEqual(["queries", "session"]);
      expect(search.inputSchema.properties.queries.items.required).toEqual(["use_case"]);
      // The engine is told to list again once the real list is in, and gets it.
      expect(changedAtMs).not.toBeNull();
      expect(serviceTools(relisted.result.tools).map((tool: { name: string }) => tool.name)).toEqual(SHOWN);
      expect(relisted.result._meta).toBeUndefined();
    } finally {
      toolsListDelayMs = BROKER_TOOLS_LIST_MS;
    }
  }, 60_000);
});

describe("the harness's own cold answer", () => {
  it("says it is the bundled stand-in, so the bridge holds the first list against it", async () => {
    await freshApp();
    toolsListDelayMs = SLOW_BROKER_TOOLS_LIST_MS;
    try {
      const reply = await relayMcp(cfg, { jsonrpc: "2.0", id: 9, method: "tools/list" });
      const body = JSON.parse(new TextDecoder().decode(reply.bytes));
      expect(body.result._meta).toEqual({ "murage/provisional": true, "murage/provisional-bundled": true });
    } finally {
      toolsListDelayMs = BROKER_TOOLS_LIST_MS;
    }
  }, 30_000);
});

describe("one discovery per scope (single flight), 1.0.2 r7", () => {
  it("a retry while the broker is still answering joins the first request: with a 5 s broker the real list is served before the deadline, from ONE broker call", async () => {
    await freshApp();
    toolsListDelayMs = 5_000;
    toolsListCalls = 0;
    try {
      const { first } = await mountAndWatch(0);
      // The harness answered its bundled stand-in at 4 s; the bridge's retry (0.75 s later)
      // joined the request in flight and got its answer at 5 s, inside the 8 s deadline.
      expect(first.result._meta).toBeUndefined();
      expect(serviceTools(first.result.tools).map((tool: { description: string }) => tool.description)).toEqual(SHOWN);
      expect(toolsListCalls).toBe(1);
    } finally {
      toolsListDelayMs = BROKER_TOOLS_LIST_MS;
    }
  }, 30_000);

  it("concurrent cold lists share one broker round trip, each answered under its own id", async () => {
    await freshApp();
    toolsListDelayMs = 700;
    toolsListCalls = 0;
    setColdToolsListWaitMsForTests(2_000);
    try {
      const first = relayMcp(cfg, { jsonrpc: "2.0", id: 11, method: "tools/list" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const second = relayMcp(cfg, { jsonrpc: "2.0", id: 12, method: "tools/list" });
      const bodies = (await Promise.all([first, second])).map((reply) => JSON.parse(new TextDecoder().decode(reply.bytes)));
      expect(bodies.map((body) => body.id)).toEqual([11, 12]);
      // The harness relay answers the bridge, not the engine: the service's own ids (the bridge shows them plainly).
      for (const body of bodies) expect(body.result.tools.filter(notStatusTool).map((tool: { description: string }) => tool.description)).toEqual(TOOLS.map((tool) => tool.name));
      expect(toolsListCalls).toBe(1);
    } finally {
      setColdToolsListWaitMsForTests();
      toolsListDelayMs = BROKER_TOOLS_LIST_MS;
    }
  }, 30_000);
});

describe("a list remembered before the connected apps changed is never served, 1.0.2 r7", () => {
  it("a revision change drops the remembered list and the answer waits for authoritative discovery (the stand-in when it is slow), never the old tools", async () => {
    await freshApp();
    toolsListDelayMs = 100;
    setColdToolsListWaitMsForTests(300);
    try {
      const warm = JSON.parse(new TextDecoder().decode((await relayMcp(cfg, { jsonrpc: "2.0", id: 1, method: "tools/list" })).bytes));
      expect(warm.result.tools.length).toBe(TOOLS.length);
      // Remembered under revision 0; now the apps change and the broker is slow.
      bumpAccessRevisionForTests(cfg);
      toolsListDelayMs = 900;
      const after = JSON.parse(new TextDecoder().decode((await relayMcp(cfg, { jsonrpc: "2.0", id: 2, method: "tools/list" })).bytes));
      expect(after.result._meta).toEqual({ "murage/provisional": true, "murage/provisional-bundled": true });
      expect(after.result.tools[0].description).not.toBe(TOOLS[0]!.name);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    } finally {
      setColdToolsListWaitMsForTests();
      toolsListDelayMs = BROKER_TOOLS_LIST_MS;
    }
  }, 30_000);

  it("an answer that began before a disconnect is not shown after it", async () => {
    await freshApp();
    toolsListDelayMs = 600;
    setColdToolsListWaitMsForTests(3_000);
    try {
      const pending = relayMcp(cfg, { jsonrpc: "2.0", id: 5, method: "tools/list" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      bumpAccessRevisionForTests(cfg);
      const body = JSON.parse(new TextDecoder().decode((await pending).bytes));
      expect(body.result._meta).toEqual({ "murage/provisional": true, "murage/provisional-bundled": true });
    } finally {
      setColdToolsListWaitMsForTests();
      toolsListDelayMs = BROKER_TOOLS_LIST_MS;
    }
  }, 30_000);
});
