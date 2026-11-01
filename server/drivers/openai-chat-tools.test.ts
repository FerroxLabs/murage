// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// OPENAI-TOOLS-109 section 11: the tool round loop of the OpenAI-chat engines (openai-compat, grok, minimax) end to end.
// The provider is a stubbed fetch (no network); every MCP server is a real stdio child (a small fake written to a temp dir
// and run with this node), started through the client's default spawnCli path, so tree stops and close confirmation are
// the real ones. Hermetic: the data dir is the setup file's throwaway home.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { createGracefulShutdown, SERVER_SHUTDOWN_TIMEOUT_MS } from "../graceful-shutdown.ts";
import { loggedRuntimeEvent } from "../runtime-event-out.ts";
import { recordEvents } from "../testing/events.ts";
import { ProviderStopUnconfirmedError } from "./child-teardown.ts";
import { GrokDriver } from "./grok.ts";
import { MinimaxDriver } from "./minimax.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import {
  MAX_CHAT_ROUNDS, MAX_TURN_TOOL_CALLS, NUDGE_ANNOUNCED_ACTION, PERMISSION_DENIED, TEXT_ONLY_NOTICE, TOOL_CALLS_TO_HELPER,
  TOOL_INTERRUPTED,
} from "./openai-chat-tools.ts";

// ── the fake MCP server ───────────────────────────────────────────────────

const FAKE_SERVER = String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const log = process.env.FAKE_LOG;
const record = (m) => { if (log) appendFileSync(log, JSON.stringify(m) + "\n"); };
const mode = process.env.FAKE_MODE ?? "normal";
// "orphan": on the first "slow" call, a middle process starts a descendant in its own session that holds this server's stdout
// open, and exits at once: the descendant is reparented away before any snapshot can see it, so nothing can find it by parentage.
const orphan = () => spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); require('node:fs').appendFileSync(process.env.FAKE_PIDS, '\\\\n' + process.pid);\"], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();"], {
  stdio: ["ignore", "inherit", "ignore"],
});
if (process.env.FAKE_GRANDCHILD && process.env.FAKE_GRANDCHILD !== "orphan") {
  // "group": a descendant in this server's process group that also ignores SIGTERM.
  // "escape": a descendant in its own session that holds this server's stdout open (the group kill never reaches it).
  const escape = process.env.FAKE_GRANDCHILD === "escape";
  // it adds its own pid to FAKE_PIDS only once its SIGTERM handler is in place
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); require('node:fs').appendFileSync(process.env.FAKE_PIDS, '\\n' + process.pid);"], {
    detached: escape, stdio: escape ? ["ignore", "inherit", "ignore"] : "ignore",
  });
  child.on("exit", (code, signal) => record({ grandchildExit: code, signal }));
}
if (process.env.FAKE_PIDS) writeFileSync(process.env.FAKE_PIDS, String(process.pid));
record({ boot: process.pid, env: Object.keys(process.env), token: process.env.FAKE_TOKEN ?? null });
process.on("exit", (code) => record({ exit: code }));
if (mode === "ignore-term") { process.on("SIGTERM", () => record({ sigterm: process.pid })); setInterval(() => {}, 1000); }
else process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const text = (id, value) => reply(id, { content: [{ type: "text", text: value }] });
const wide = (n, each) => ({ type: "object", properties: Object.fromEntries(Array.from({ length: n }, (_, i) => ["p" + i, { type: "string", description: "d".repeat(each) }])) });
const base = [
  { name: "echo", description: "echo the arguments", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "noop", description: "does nothing", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "never answers", inputSchema: { type: "object", properties: {} } },
  { name: "secret", description: "answers with the mounted token", inputSchema: { type: "object", properties: {} } },
  { name: "ask_user", description: "ask the owner", inputSchema: { type: "object", properties: { question: { type: "string" } } } },
];
const kind = process.env.FAKE_TOOLS ?? "base";
const tools = kind.startsWith("many:")
  ? Array.from({ length: Number(kind.slice(5)) }, (_, i) => ({ name: "t" + i, inputSchema: { type: "object", properties: {} } }))
  : kind === "bigschema" ? [...base, { name: "huge", inputSchema: wide(70, 1000) }]
  : kind === "bigcatalog" ? Array.from({ length: 10 }, (_, i) => ({ name: "w" + i, inputSchema: wide(30, 1000) }))
  : kind === "leaky" ? [...base,
    { name: "leaky", description: "signs with " + (process.env.FAKE_TOKEN ?? ""), inputSchema: { type: "object", properties: { auth: { type: "string", default: process.env.FAKE_TOKEN ?? "", examples: [process.env.FAKE_TOKEN ?? ""] } } } },
    { name: "resource", description: "answers with an embedded resource", inputSchema: { type: "object", properties: {} } }]
  : kind === "leakykey" ? [...base, { name: "keyed", inputSchema: { type: "object", properties: { [process.env.FAKE_TOKEN ?? ""]: { type: "string" } } } }]
  : base;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { if (mode !== "ignore-term") setTimeout(() => process.exit(0), 50); });
function handle(m) {
  record(m);
  if (m.method === "initialize") return reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  if (m.method === "tools/list") return reply(m.id, { tools });
  if (m.method !== "tools/call") return;
  const name = m.params.name;
  if (name === "echo") return text(m.id, "echo:" + JSON.stringify(m.params.arguments));
  if (name === "noop" || name === "ask_user") return text(m.id, "done");
  if (name === "slow") { if (process.env.FAKE_GRANDCHILD === "orphan") orphan(); return; }
  if (name === "resource") return reply(m.id, { content: [{ type: "resource", resource: { uri: "file:///creds.txt", mimeType: "text/plain", text: "password=" + (process.env.FAKE_PASSWORD ?? "") } }] });
  if (name === "secret") return text(m.id, "r".repeat(Number(process.env.FAKE_PAD ?? "0")) + (process.env.FAKE_TOKEN ?? "") + " end");
  return text(m.id, "ran " + name);
}
`;

// ── provider stub ─────────────────────────────────────────────────────────

type Loose = { type: string; [key: string]: any };
type Decision = Parameters<ProviderInstance["adapter"]["respondToRequest"]>[2];
interface Sent { body: Record<string, any>; signal?: AbortSignal; index: number }
type Reply = (sent: Sent) => Response | Promise<Response>;

const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const DONE = "data: [DONE]\n\n";
const sse = (chunks: string[]): Response => {
  const queue = [...chunks];
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const textReply = (text: string, reasoning?: string) => sse([
  ...(reasoning ? [frame({ choices: [{ delta: { reasoning_content: reasoning } }] })] : []),
  frame({ choices: [{ delta: { content: text } }] }),
  frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  DONE,
]);
interface Call { id: string; name: string; args?: unknown }
const callsReply = (calls: Call[], finish = "tool_calls") => sse([
  ...calls.map((call, index) => frame({ choices: [{ delta: { tool_calls: [{
    index, id: call.id, type: "function",
    function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}) },
  }] } }] })),
  frame({ choices: [{ delta: {}, finish_reason: finish }] }),
  DONE,
]);
const httpError = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const connectError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
/** A stream that sends `first` and then holds until the request is aborted. */
const hanging = (signal: AbortSignal | undefined, first: string): Response => {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(encoder.encode(first)); return; }
      return new Promise<void>((_resolve, reject) => {
        const stop = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

let script: Reply[] = [];
let fallback: Reply | null = null;
let bodies: Array<Record<string, any>> = [];
let previousFetch: typeof globalThis.fetch;

// ── drivers ───────────────────────────────────────────────────────────────

const DRIVERS = {
  "openai-compat": {
    key: "compat-key-Q7m2Zr9Lw4Hd",
    reasoning: true,
    logsMessages: false,
    create: (key: string, url = "https://compat.invalid/v1") => OpenAICompatDriver.create({
      instanceId: "oc-tools", displayName: "OC tools", environment: {}, enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url, key, model: "test-model" }),
    }),
  },
  grok: {
    key: "xai-test-key-Hn4Tq8Wz2Pc",
    reasoning: false,
    logsMessages: true,
    create: (key: string) => GrokDriver.create({
      instanceId: "grok-tools", displayName: "Grok tools", environment: { XAI_API_KEY: key }, enabled: true,
      config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY" },
    }),
  },
  minimax: {
    key: "minimax-test-key-Jr6Kp3Xv9",
    reasoning: false,
    logsMessages: false,
    create: (key: string) => MinimaxDriver.create({
      instanceId: "mm-tools", displayName: "MM tools", environment: { MINIMAX_API_KEY: key }, enabled: true,
      config: MinimaxDriver.decodeConfig({ url: "https://fake.minimax.invalid/v1" }),
    }),
  },
} as const;
type DriverName = keyof typeof DRIVERS;
const NAMES = Object.keys(DRIVERS) as DriverName[];

const TOKEN = "tokQ4vZ8mL2xR7nW";
const PASSWORD = 'pw"q\\Zk8-Mv3#Lr9';
const PASSWORD_CORE = "Zk8-Mv3#Lr9";

let dir: string;
let script_: string;
let logCounter = 0;
const instances: ProviderInstance[] = [];
const strayPids = new Set<number>();
const savedEnv = new Map<string, string | undefined>();
const setEnv = (name: string, value: string | undefined) => {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const make = async (name: DriverName, url?: string): Promise<ProviderInstance> => {
  const spec = DRIVERS[name];
  const instance = name === "openai-compat" ? await DRIVERS["openai-compat"].create(spec.key, url) : await spec.create(spec.key);
  instances.push(instance);
  return instance;
};
const newLog = () => join(dir, `mcp-${++logCounter}.ndjson`);
const mount = (log: string, env: Record<string, string> = {}) => ({
  command: process.execPath, args: [script_], env: { FAKE_LOG: log, FAKE_TOKEN: TOKEN, ...env },
});
const lines = (path: string): Array<Record<string, any>> =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const ran = (log: string) => lines(log).filter((line) => line.method === "tools/call").map((line) => line.params as { name: string; arguments: Record<string, unknown> });
const boots = (log: string) => lines(log).filter((line) => typeof line.boot === "number");
const threadId = () => `oai-tools-${Math.random().toString(36).slice(2, 10)}`;
const nativeText = (thread: string) => {
  const path = join(NATIVE_DIR, `${thread}.ndjson`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const pidGone = (pid: number) => {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
const waitFor = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The server's side of the approval: answers every permission card with `decide` (undefined = left open). */
const answer = (instance: ProviderInstance, decide: (event: Loose) => Decision | undefined, sync = false) =>
  instance.adapter.onEvent((event) => {
    if (event.type !== "request.opened") return;
    const opened = event as unknown as Loose;
    const go = () => {
      const decision = decide(opened);
      if (decision) void instance.adapter.respondToRequest(opened.threadId, opened.requestId, decision);
    };
    if (sync) go(); else setImmediate(go);
  });
const allowAll = (instance: ProviderInstance) => answer(instance, () => ({ behavior: "allow" }));

const start = async (instance: ProviderInstance, input: SendTurnInput) => {
  const recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn(input);
  const events = recorder.events as unknown as Loose[];
  const done = () => recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId).then((event) => event as unknown as Loose);
  return { turnId, events, done, recorder };
};
const run = async (instance: ProviderInstance, input: SendTurnInput) => {
  const turn = await start(instance, input);
  const completed = await turn.done();
  turn.recorder.stop();
  return { ...turn, completed };
};
const ofType = (events: Loose[], type: string, itemType?: string) =>
  events.filter((event) => event.type === type && (itemType === undefined || event.itemType === itemType));
const answers = (events: Loose[]) => ofType(events, "item.completed", "assistant_text").map((event) => event.text as string);
const errors = (events: Loose[]) => ofType(events, "runtime.error").map((event) => event.message as string);
const toolNames = (body: Record<string, any>) => (body.tools as Array<{ function: { name: string } }> | undefined)?.map((tool) => tool.function.name);
const toolMessages = (body: Record<string, any>) => (body.messages as Array<Record<string, any>>).filter((message) => message.role === "tool");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oai-chat-tools-"));
  script_ = join(dir, "fake-mcp-server.mjs");
  writeFileSync(script_, FAKE_SERVER);
});

beforeEach(() => {
  ensureDirs();
  setEnv("FAKE_GROK_RETRY_SCALE", "0.001");
  previousFetch = globalThis.fetch;
  script = [];
  fallback = null;
  bodies = [];
  // SAFETY: the stub returns real Response objects, the only part of fetch's contract these drivers consume. Anything but a
  // chat completion (the openai-compat catalog refresh, local discovery) is answered 404 and never reaches the network.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    bodies.push(body);
    const next = script.shift() ?? fallback;
    if (!next) throw new Error(`unexpected extra provider request #${bodies.length}`);
    return next({ body, signal: init?.signal ?? undefined, index: bodies.length - 1 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  for (const pid of strayPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  strayPids.clear();
  for (const instance of instances.splice(0)) await instance.dispose().catch(() => {});
  for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  savedEnv.clear();
});

afterAll(() => {
  removeTempDirSync(dir);
});

describe.each(NAMES)("%s: tool round loop (OPENAI-TOOLS-109 s11)", (name) => {
  const spec = DRIVERS[name];

  it("1. advertises the mounted tools with safe schemas, runs an allowed call and returns its result to the model", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    script = [
      ({ body }) => callsReply([{ id: "call_1", name: "fake_echo", args: { text: "hi" } }], body.tools ? "tool_calls" : "stop"),
      () => textReply("the echo said hi"),
    ];
    const { completed, events } = await run(instance, { threadId: threadId(), text: "echo hi", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(completed.stopReason).toBeNull();
    expect(toolNames(bodies[0]!)).toEqual(["fake_echo", "fake_noop", "fake_slow", "fake_secret", "fake_ask_user"]);
    for (const tool of bodies[0]!.tools as Array<Record<string, any>>) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters.type).toBe("object");
    }
    expect(ran(log)).toEqual([{ name: "echo", arguments: { text: "hi" } }]);
    const [toolMessage] = toolMessages(bodies[1]!);
    expect(toolMessage!.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMessage!.content)).toEqual({ ok: true, result: 'echo:{"text":"hi"}' });
    const assistant = (bodies[1]!.messages as Array<Record<string, any>>).find((message) => message.role === "assistant");
    expect(assistant!.tool_calls[0].function.name).toBe("fake_echo");
    const item = ofType(events, "item.completed", "tool")[0]!;
    expect(item).toMatchObject({ itemId: "call_1", ok: true, result: 'echo:{"text":"hi"}' });
    expect(answers(events)).toEqual(["the echo said hi"]);
  });

  it("2. every call raises request.opened with the broker facts, and nothing runs before the allow", async () => {
    const instance = await make(name);
    const log = newLog();
    const ranAtOpen: number[] = [];
    answer(instance, () => {
      ranAtOpen.push(ran(log).length);
      return undefined;
    });
    // answered by hand, later: the call must still not have run while the card was open
    const opened: Loose[] = [];
    instance.adapter.onEvent((event) => {
      if (event.type !== "request.opened") return;
      opened.push(event as unknown as Loose);
      setTimeout(() => {
        ranAtOpen.push(ran(log).length);
        void instance.adapter.respondToRequest(event.threadId, (event as unknown as Loose).requestId, { behavior: "allow" });
      }, 150);
    });
    script = [
      () => callsReply([{ id: "call_a", name: "fake_echo", args: { text: "a" } }, { id: "call_b", name: "fake_echo", args: { text: "b", n: 2 } }]),
      () => textReply("both ran"),
    ];
    const { completed, events } = await run(instance, { threadId: threadId(), text: "two", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(opened).toHaveLength(2);
    // the first card saw zero calls run, the second saw one (the first, allowed), never its own
    expect(ranAtOpen).toEqual([0, 0, 1, 1]);
    expect(ran(log).map((call) => call.arguments)).toEqual([{ text: "a" }, { text: "b", n: 2 }]);
    for (const [index, card] of opened.entries()) {
      expect(card).toMatchObject({
        requestType: "permission",
        tool: "mcp__fake__echo",
        toolIdentity: { namespace: "mcp", name: "fake__echo" },
        toolEngine: "chat",
        mcpMounts: [{ engineName: "fake", mountId: "custom:fake", provenance: "custom" }],
      });
      expect(typeof card.requestId).toBe("string");
      expect(card.toolCall).toEqual({ name: "mcp__fake__echo", input: index === 0 ? { text: "a" } : { text: "b", n: 2 } });
    }
    expect(new Set(opened.map((card) => card.requestId)).size).toBe(2);
    expect(ofType(events, "request.resolved").map((event) => event.behavior)).toEqual(["allow", "allow"]);
    // each item.started follows its own allow
    const order = events.filter((event) => ["request.opened", "request.resolved", "item.started"].includes(event.type)).map((event) => event.type);
    expect(order).toEqual(["request.opened", "request.resolved", "item.started", "request.opened", "request.resolved", "item.started"]);
  });

  it("2b. agents_ask_user reaches the owner only through the permission card", async () => {
    const instance = await make(name);
    const log = newLog();
    const cards: Loose[] = [];
    instance.adapter.onEvent((event) => {
      if (event.type !== "request.opened") return;
      cards.push(event as unknown as Loose);
      // "by hand": the stub server answers only after looking at the card
      setTimeout(() => void instance.adapter.respondToRequest(event.threadId, (event as unknown as Loose).requestId, { behavior: "allow" }), 100);
    });
    script = [
      () => callsReply([{ id: "ask_1", name: "agents_ask_user", args: { question: "Ship it?" } }]),
      () => textReply("the owner said yes"),
    ];
    const { completed, events } = await run(instance, { threadId: threadId(), text: "ask", integrations: { agents: mount(log) } });
    expect(completed.ok).toBe(true);
    // no native ask_user: the only one advertised is the agents server's own
    expect(toolNames(bodies[0]!)!.filter((tool) => tool.includes("ask_user"))).toEqual(["agents_ask_user"]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ requestType: "permission", tool: "mcp__agents__ask_user", toolCall: { name: "mcp__agents__ask_user", input: { question: "Ship it?" } } });
    expect(ofType(events, "request.opened").every((event) => event.requestType === "permission")).toBe(true);
    expect(ran(log)).toEqual([{ name: "ask_user", arguments: { question: "Ship it?" } }]);
  });

  it("3. deny: the tool is not executed and {ok:false} goes to the model; updatedInput runs the narrowed args", async () => {
    const instance = await make(name);
    const log = newLog();
    answer(instance, (opened) => opened.toolCall.input.text === "deny me"
      ? { behavior: "deny" }
      : { behavior: "allow", updatedInput: { text: "narrowed" } });
    script = [
      () => callsReply([{ id: "c_deny", name: "fake_echo", args: { text: "deny me" } }, { id: "c_narrow", name: "fake_echo", args: { text: "wide" } }]),
      () => textReply("done"),
    ];
    const { completed, events } = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(completed.denials).toEqual(["mcp__fake__echo"]);
    expect(ran(log)).toEqual([{ name: "echo", arguments: { text: "narrowed" } }]);
    const [denied, narrowed] = toolMessages(bodies[1]!);
    expect(denied!.tool_call_id).toBe("c_deny");
    expect(JSON.parse(denied!.content)).toEqual({ ok: false, result: PERMISSION_DENIED });
    expect(JSON.parse(narrowed!.content)).toEqual({ ok: true, result: 'echo:{"text":"narrowed"}' });
    const started = ofType(events, "item.started", "tool");
    expect(started.map((event) => event.itemId)).toEqual(["c_narrow"]);
    expect(started[0]!.input).toEqual({ text: "narrowed" });
  });

  it("4. the server may answer synchronously inside the emit (the ask is registered first)", async () => {
    const instance = await make(name);
    const log = newLog();
    const outcomes: unknown[] = [];
    instance.adapter.onEvent((event) => {
      if (event.type !== "request.opened") return;
      // synchronously, inside the emit, before request.opened returns to the driver
      void instance.adapter.respondToRequest(event.threadId, (event as unknown as Loose).requestId, { behavior: "allow" }).then((value) => outcomes.push(value));
    });
    script = [() => callsReply([{ id: "sync_1", name: "fake_noop" }]), () => textReply("ok")];
    const { completed } = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(outcomes).toEqual(["allowed-once"]);
    expect(ran(log)).toEqual([{ name: "noop", arguments: {} }]);
  });

  it("5. tool_calls split across deltas with interleaved indexes and null fields; a whole JSON reply with content null", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const delta = (toolCalls: unknown[], extra: Record<string, unknown> = {}) => frame({ choices: [{ delta: { ...extra, tool_calls: toolCalls } }] });
    script = [
      () => sse([
        delta([{ index: 0, id: "call_x", type: "function", function: { name: "fake_", arguments: "" } }], { role: "assistant", content: null }),
        delta([{ index: 1, id: "call_y", type: "function", function: { name: "fake_echo", arguments: '{"te' } }]),
        delta([{ index: 0, id: null, type: null, function: { name: "echo", arguments: '{"text":' } }]),
        delta([{ index: 1, function: { name: null, arguments: 'xt":"y"}' } }]),
        delta([{ index: 0, function: { arguments: '"x"}' } }]),
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
      ]),
      // a gateway answering the streaming request with one whole completion
      () => new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
        { id: "call_j", type: "function", function: { name: "fake_echo", arguments: '{"text":"j"}' } },
      ] } }] }), { status: 200, headers: { "content-type": "application/json" } }),
      () => textReply("all three ran"),
    ];
    const { completed } = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(ran(log).map((call) => call.arguments)).toEqual([{ text: "x" }, { text: "y" }, { text: "j" }]);
    expect(toolMessages(bodies[1]!).map((message) => message.tool_call_id)).toEqual(["call_x", "call_y"]);
    const replay = (bodies[2]!.messages as Array<Record<string, any>>).filter((message) => message.role === "assistant").at(-1)!;
    expect(replay.content).toBeNull();
    expect(replay.tool_calls[0].id).toBe("call_j");
  });

  it("6. protocol refusals: reused id across rounds, finish length, bad index, long name run nothing; bad args are refused without a card", async () => {
    const instance = await make(name);
    allowAll(instance);
    const custom = (log: string) => ({ custom: { fake: mount(log) } });
    // reused id across rounds
    let log = newLog();
    script = [() => callsReply([{ id: "dup", name: "fake_noop" }]), () => callsReply([{ id: "dup", name: "fake_noop" }])];
    let turn = await run(instance, { threadId: threadId(), text: "dup", integrations: custom(log) });
    expect(turn.completed.ok).toBe(false);
    expect(ran(log)).toHaveLength(1);
    expect(errors(turn.events).join(" ")).toContain("repeated a tool call");
    // finish "length" with calls, an index out of range, a name over 64 chars: the reply is refused whole, no card
    for (const reply of [
      () => callsReply([{ id: "len_1", name: "fake_noop" }], "length"),
      () => sse([frame({ choices: [{ delta: { tool_calls: [{ index: 40, id: "idx", type: "function", function: { name: "fake_noop", arguments: "{}" } }] } }] }), frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), DONE]),
      () => callsReply([{ id: "long_1", name: "a".repeat(65) }]),
    ]) {
      log = newLog();
      script = [reply];
      turn = await run(instance, { threadId: threadId(), text: "bad", integrations: custom(log) });
      expect(turn.completed.ok).toBe(false);
      expect(ofType(turn.events, "request.opened")).toHaveLength(0);
      expect(ran(log)).toHaveLength(0);
    }
    // arguments that are not a JSON object: refused, no card, the model is told and the turn goes on
    log = newLog();
    script = [() => callsReply([{ id: "nj", name: "fake_echo", args: "{not json" }, { id: "arr", name: "fake_echo", args: "[1]" }]), () => textReply("sorry")];
    turn = await run(instance, { threadId: threadId(), text: "bad args", integrations: custom(log) });
    expect(turn.completed.ok).toBe(true);
    expect(ofType(turn.events, "request.opened")).toHaveLength(0);
    expect(ran(log)).toHaveLength(0);
    for (const message of toolMessages(bodies.at(-1)!)) expect(JSON.parse(message.content).ok).toBe(false);
  });

  it("7. text-only fallback: a refused tools parameter resends once without tools, says so once, and later turns mount nothing", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    script = [
      () => httpError(400, { error: { message: "tools is not supported", type: "invalid_request_error" } }),
      () => textReply("answering without tools"),
      () => textReply("second turn"),
    ];
    const first = await run(instance, { threadId: threadId(), text: "one", integrations: { custom: { fake: mount(log) } } });
    expect(first.completed.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.tools).toBeDefined();
    expect(bodies[1]!.tools).toBeUndefined();
    expect(errors(first.events).filter((message) => message === TEXT_ONLY_NOTICE)).toHaveLength(1);
    expect(answers(first.events)).toEqual(["answering without tools"]);
    expect(boots(log)).toHaveLength(1);
    const second = await run(instance, { threadId: threadId(), text: "two", integrations: { custom: { fake: mount(log) } } });
    expect(second.completed.ok).toBe(true);
    expect(bodies[2]!.tools).toBeUndefined();
    expect(boots(log)).toHaveLength(1); // no MCP process was started for the remembered text-only model
    expect(errors(second.events)).not.toContain(TEXT_ONLY_NOTICE);
  });

  it("7b. a network error never triggers the text-only fallback", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    script = [() => { throw connectError("ECONNREFUSED"); }];
    fallback = () => textReply("fine");
    const first = await run(instance, { threadId: threadId(), text: "one", integrations: { custom: { fake: mount(log) } } });
    expect(errors(first.events)).not.toContain(TEXT_ONLY_NOTICE);
    const before = bodies.length;
    const second = await run(instance, { threadId: threadId(), text: "two", integrations: { custom: { fake: mount(log) } } });
    expect(second.completed.ok).toBe(true);
    expect(bodies.length).toBeGreaterThan(before);
    for (const body of bodies) expect(toolNames(body)).toContain("fake_echo");
  });

  it("8. the 64-step cap: every step ran, the turn fails plainly, and the last step refuses a steer", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const thread = threadId();
    const steers: Record<number, Promise<unknown>> = {};
    fallback = ({ index }) => {
      if (index === 10 || index === MAX_CHAT_ROUNDS - 1) steers[index] = instance.adapter.steer!(thread, `steer at ${index}`);
      return callsReply([{ id: `c${index}`, name: "fake_noop" }]);
    };
    const { completed, events } = await run(instance, { threadId: thread, text: "loop", integrations: { custom: { fake: mount(log) } } });
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(bodies).toHaveLength(MAX_CHAT_ROUNDS);
    expect(ran(log)).toHaveLength(MAX_CHAT_ROUNDS);
    expect(errors(events).at(-1)).toContain(`Stopped after ${MAX_CHAT_ROUNDS} steps`);
    expect(await steers[10]).toBe("delivered");
    expect(await steers[MAX_CHAT_ROUNDS - 1]).toBe("rejected");
    const carrying = bodies.flatMap((body, index) => (body.messages as Array<Record<string, any>>).some((message) => message.content === "steer at 10") ? [index] : []);
    expect(carrying[0]).toBe(11);
    expect(bodies.some((body) => (body.messages as Array<Record<string, any>>).some((message) => message.content === `steer at ${MAX_CHAT_ROUNDS - 1}`))).toBe(false);
  });

  it("8b. the 200-call cap: the batch that crosses it never runs", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    fallback = ({ index }) => callsReply(Array.from({ length: index < 6 ? 32 : 9 }, (_, k) => ({ id: `r${index}_${k}`, name: "fake_noop" })));
    const { completed, events } = await run(instance, { threadId: threadId(), text: "many", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(false);
    expect(bodies).toHaveLength(7);
    expect(ran(log)).toHaveLength(192);
    expect(ofType(events, "request.opened")).toHaveLength(192);
    expect(errors(events).at(-1)).toContain(`Stopped after ${MAX_TURN_TOOL_CALLS} tool calls`);
  });

  it("9. steer: spliced between rounds only (never mid-batch), resolves on its splice; a fence throw is rejected", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const thread = threadId();
    let between: Promise<unknown> | undefined;
    let refused: Promise<unknown> | undefined;
    let bodiesAtDelivery = -1;
    instance.adapter.onEvent((event) => {
      if (event.type !== "request.opened" || between) return;
      // parked while the first call of a two-call batch waits for its card
      between = instance.adapter.steer!(thread, "also check b", undefined, "ij-1").then((value) => { bodiesAtDelivery = bodies.length; return value; });
      refused = instance.adapter.steer!(thread, "STEER-FENCED-XYZ", () => { throw new Error("moved"); });
    });
    script = [
      () => callsReply([{ id: "s_a", name: "fake_noop" }, { id: "s_b", name: "fake_noop" }]),
      () => textReply("checked both"),
    ];
    const { completed, events } = await run(instance, { threadId: thread, text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(await between).toBe("delivered");
    expect(await refused).toBe("rejected");
    expect(bodiesAtDelivery).toBe(2);
    const roles = (bodies[1]!.messages as Array<Record<string, any>>).slice(-4).map((message) => `${message.role}:${message.content ?? ""}`);
    expect(roles.slice(1)).toEqual([expect.stringMatching(/^tool:/), expect.stringMatching(/^tool:/), "user:also check b"]);
    for (const body of bodies) expect(JSON.stringify(body.messages)).not.toContain("STEER-FENCED-XYZ");
    expect(JSON.stringify(bodies[0]!.messages)).not.toContain("also check b");
    expect(ofType(events, "steer.confirmed")).toHaveLength(0);
  });

  it("9b. steer: unspliced when the turn ends resolves rejected; a steer during the final answer runs one more round with the answer kept", async () => {
    const instance = await make(name);
    let thread = threadId();
    let late: Promise<unknown> | undefined;
    script = [() => { late = instance.adapter.steer!(thread, "too late"); return httpError(400, { error: { message: "bad request" } }); }];
    const failed = await run(instance, { threadId: thread, text: "go" });
    expect(failed.completed.ok).toBe(false);
    expect(await late).toBe("rejected");

    thread = threadId();
    let more: Promise<unknown> | undefined;
    script = [
      () => { more = instance.adapter.steer!(thread, "and in French"); return textReply("first answer", "thinking about it"); },
      () => textReply("premiere reponse"),
    ];
    const steered = await run(instance, { threadId: thread, text: "answer" });
    expect(steered.completed.ok).toBe(true);
    expect(await more).toBe("delivered");
    expect(bodies.slice(-2)).toHaveLength(2);
    const tail = (bodies.at(-1)!.messages as Array<Record<string, any>>).slice(-2);
    expect(tail[0]).toMatchObject({ role: "assistant", content: "first answer" });
    if (spec.reasoning) expect(tail[0]!.reasoning_content).toBe("thinking about it");
    expect(tail[1]).toEqual({ role: "user", content: "and in French" });
    expect(answers(steered.events)).toEqual(["first answer", "premiere reponse"]);
  });

  it("10. Stop during the stream settles once as cancelled and every child is confirmed stopped", async () => {
    const instance = await make(name);
    const log = newLog();
    const thread = threadId();
    script = [({ signal }) => hanging(signal, frame({ choices: [{ delta: { content: "partial" } }] }))];
    const turn = await start(instance, { threadId: thread, text: "go", integrations: { custom: { fake: mount(log) } } });
    await turn.recorder.until((event) => event.type === "content.delta");
    const result = await instance.adapter.interruptTurn(thread, turn.turnId);
    expect(result).toEqual({ closeConfirmed: true });
    const completed = await turn.done();
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(await instance.adapter.awaitTurnTeardown!(thread, turn.turnId)).toEqual({ closeConfirmed: true });
    expect(pidGone(boots(log)[0]!.boot)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ofType(turn.events, "turn.completed")).toHaveLength(1);
  });

  it("10b. Stop with a card open resolves it as the system's deny and the tool never runs", async () => {
    const instance = await make(name);
    const log = newLog();
    const thread = threadId();
    script = [() => callsReply([{ id: "card_1", name: "fake_echo", args: { text: "x" } }])];
    const turn = await start(instance, { threadId: thread, text: "go", integrations: { custom: { fake: mount(log) } } });
    const card = await turn.recorder.until((event) => event.type === "request.opened") as unknown as Loose;
    expect(await instance.adapter.interruptTurn(thread, turn.turnId)).toEqual({ closeConfirmed: true });
    const completed = await turn.done();
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(ofType(turn.events, "request.resolved")).toEqual([expect.objectContaining({ requestId: card.requestId, behavior: "deny", source: "system" })]);
    expect(await instance.adapter.respondToRequest(thread, card.requestId, { behavior: "allow" })).toBe("unavailable");
    expect(ran(log)).toHaveLength(0);
    expect(ofType(turn.events, "item.started")).toHaveLength(0);
    expect(bodies).toHaveLength(1);
    expect(ofType(turn.events, "turn.completed")).toHaveLength(1);
  });

  it("10c. Stop during an MCP call: cancelled to the server, the item fails as interrupted, the turn settles once", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const thread = threadId();
    script = [() => callsReply([{ id: "slow_1", name: "fake_slow" }])];
    const turn = await start(instance, { threadId: thread, text: "go", integrations: { custom: { fake: mount(log) } } });
    await turn.recorder.until((event) => event.type === "item.started");
    await waitFor(() => ran(log).length === 1);
    expect(await instance.adapter.interruptTurn(thread, turn.turnId)).toEqual({ closeConfirmed: true });
    const completed = await turn.done();
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(ofType(turn.events, "item.completed", "tool")).toEqual([expect.objectContaining({ itemId: "slow_1", ok: false, result: TOOL_INTERRUPTED })]);
    expect(lines(log).some((line) => line.method === "notifications/cancelled")).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(ofType(turn.events, "turn.completed")).toHaveLength(1);
  });

  it("10d. Stop between rounds writes no new request", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const thread = threadId();
    let stop: Promise<unknown> | undefined;
    instance.adapter.onEvent((event) => {
      if (event.type === "item.completed" && (event as unknown as Loose).itemType === "tool" && !stop) stop = instance.adapter.interruptTurn(thread);
    });
    script = [() => callsReply([{ id: "between_1", name: "fake_noop" }])];
    fallback = () => textReply("must not be asked");
    const { completed, events } = await run(instance, { threadId: thread, text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(await stop).toEqual({ closeConfirmed: true });
    expect(bodies).toHaveLength(1);
    expect(ran(log)).toHaveLength(1);
    expect(ofType(events, "turn.completed")).toHaveLength(1);
  });

  // H6: a descendant that left the group while its parent ran is found and ended (shutdown case below); "orphan" was already
  // reparented away before any snapshot, the one kind nothing can find by parentage, so its tree really outlives the kill.
  it.skipIf(process.platform === "win32")("10e. a child whose tree outlives the kill: Stop rejects unconfirmed, turn.completed waits for the late close, then comes once", async () => {
    setEnv("MURAGE_PROVIDER_CLOSE_MS", "1000");
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const pids = join(dir, `pids-${logCounter}.txt`);
    const thread = threadId();
    script = [() => callsReply([{ id: "held_1", name: "fake_slow" }])];
    const turn = await start(instance, { threadId: thread, text: "go", integrations: { custom: { fake: mount(log, { FAKE_GRANDCHILD: "orphan", FAKE_PIDS: pids }) } } });
    await turn.recorder.until((event) => event.type === "item.started");
    await waitFor(() => readFileSync(pids, "utf8").split("\n").length === 2);
    const [, escaped] = readFileSync(pids, "utf8").split("\n").map(Number);
    strayPids.add(escaped!);
    const stop = await instance.adapter.interruptTurn(thread, turn.turnId).then(() => null, (error: unknown) => error);
    expect(stop).toBeInstanceOf(ProviderStopUnconfirmedError);
    expect(await instance.adapter.awaitTurnTeardown!(thread, turn.turnId)).toMatchObject({ closeConfirmed: false });
    let closed = false;
    const close = instance.adapter.awaitTurnClose!(thread, turn.turnId).then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    expect(ofType(turn.events, "turn.completed")).toHaveLength(0);
    // the descendant ends: the root's pipes close and the tree is confirmed stopped
    process.kill(escaped!, "SIGKILL");
    await close;
    const completed = await turn.done();
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ofType(turn.events, "turn.completed")).toHaveLength(1);
    expect(await instance.adapter.awaitTurnTeardown!(thread, turn.turnId)).toEqual({ closeConfirmed: true });
  });

  it("11. redaction: a key split across deltas never streams; toolCall.input is exact live; every capped copy is scrubbed first", async () => {
    const instance = await make(name);
    allowAll(instance);
    const key = spec.key;
    // the request key, split across two deltas
    let thread = threadId();
    script = [() => sse([
      frame({ choices: [{ delta: { content: `the key is ${key.slice(0, 9)}` } }] }),
      frame({ choices: [{ delta: { content: `${key.slice(9)} ok` } }] }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE,
    ])];
    const split = await run(instance, { threadId: thread, text: "key?" });
    for (const event of ofType(split.events, "content.delta")) expect(event.delta).not.toContain(key.slice(0, 8));
    expect(answers(split.events).join("")).not.toContain(key.slice(0, 8));
    expect(answers(split.events).join("")).toContain("[redacted]");

    // a mounted token straddling every cap boundary: 2 KiB per value and 16 KiB whole (card), 50 KiB (result), 4 KiB (native log)
    thread = threadId();
    const log = newLog();
    const valueCap = { v: "y".repeat(2048 - 4) + TOKEN };
    const whole: Record<string, string> = {};
    for (let i = 0; i < 8; i++) whole[`a${i}`] = "x".repeat(1900);
    whole.t = "";
    const at = JSON.stringify(whole).length - 2; // where t's value starts
    whole.t = "z".repeat(16 * 1024 - 4 - at) + TOKEN;
    expect(JSON.stringify(whole).indexOf(TOKEN)).toBe(16 * 1024 - 4);
    script = [
      () => callsReply([
        { id: "ordinary", name: "fake_noop", args: { note: TOKEN } },
        { id: "value_cap", name: "fake_noop", args: valueCap },
        { id: "whole_cap", name: "fake_noop", args: whole },
        { id: "result_cap", name: "fake_secret" },
        { id: "native_cap", name: "small_secret" },
      ]),
      () => textReply("done"),
    ];
    const turn = await run(instance, { threadId: thread, text: "caps", integrations: { custom: {
      fake: mount(log, { FAKE_PAD: String(50 * 1024 - 4) }),
      small: mount(log, { FAKE_PAD: String(4 * 1024 - 4) }),
    } } });
    expect(turn.completed.ok).toBe(true);
    const prefix = TOKEN.slice(0, 8);
    const cards = ofType(turn.events, "request.opened");
    expect(cards).toHaveLength(5);
    // the broker copy is exact
    expect(cards[0]!.toolCall.input).toEqual({ note: TOKEN });
    expect(cards[1]!.toolCall.input).toEqual(valueCap);
    expect(cards[2]!.toolCall.input).toEqual(whole);
    expect(ran(log).slice(0, 3).map((call) => call.arguments)).toEqual([{ note: TOKEN }, valueCap, whole]);
    // every display, model and log copy is scrubbed before its cap
    for (const card of cards) expect(String(card.toolInput ?? "")).not.toContain(prefix);
    for (const event of ofType(turn.events, "item.started")) expect(JSON.stringify(event.input)).not.toContain(prefix);
    for (const event of ofType(turn.events, "item.completed", "tool")) expect(String(event.result)).not.toContain(prefix);
    for (const message of toolMessages(bodies[1]!)) expect(message.content).not.toContain(prefix);
    expect(nativeText(thread)).not.toContain(prefix);
    expect(nativeText(thread)).not.toContain(key.slice(0, 8));
    // the persisted event log (the live toolCall.input dropped by loggedRuntimeEvent)
    expect(JSON.stringify(turn.events.map((event) => loggedRuntimeEvent(event as unknown as RuntimeEvent)))).not.toContain(prefix);
    if (spec.logsMessages) expect(nativeText(thread)).toContain("[redacted]");
  });

  it("11c. a mounted password holding a quote and a backslash, in an ordinary field, is absent from the native log and the event log", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const thread = threadId();
    script = [() => callsReply([{ id: "pw_1", name: "fake_noop", args: { note: PASSWORD } }]), () => textReply("noted")];
    const turn = await run(instance, { threadId: thread, text: "pw", integrations: { custom: { fake: mount(log, { FAKE_PASSWORD: PASSWORD }) } } });
    expect(turn.completed.ok).toBe(true);
    expect(ofType(turn.events, "request.opened")[0]!.toolCall.input).toEqual({ note: PASSWORD });
    expect(ran(log)[0]!.arguments).toEqual({ note: PASSWORD });
    expect(nativeText(thread)).not.toContain(PASSWORD_CORE);
    if (spec.logsMessages) expect(nativeText(thread)).toContain("[redacted]");
    expect(JSON.stringify(turn.events.map((event) => loggedRuntimeEvent(event as unknown as RuntimeEvent)))).not.toContain(PASSWORD_CORE);
  });

  it("11d. reasoning: a request key and a mounted token split across reasoning deltas never stream", async () => {
    if (!spec.reasoning) return;
    const instance = await make(name);
    const key = spec.key;
    const reasoning = (text: string) => frame({ choices: [{ delta: { reasoning_content: text } }] });
    script = [() => sse([
      reasoning(`the key is ${key.slice(0, 9)}`), reasoning(`${key.slice(9)} and the token is ${TOKEN.slice(0, 6)}`), reasoning(`${TOKEN.slice(6)} done`),
      frame({ choices: [{ delta: { content: "ok" } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE,
    ])];
    const turn = await run(instance, { threadId: threadId(), text: "think", integrations: { custom: { fake: mount(newLog()) } } });
    expect(turn.completed.ok).toBe(true);
    const deltas = ofType(turn.events, "content.delta").filter((event) => event.streamKind === "reasoning_text").map((event) => event.delta as string);
    for (const delta of deltas) {
      expect(delta).not.toContain(key.slice(0, 8));
      expect(delta).not.toContain(TOKEN.slice(0, 5));
    }
    expect(deltas.join("")).toContain("[redacted]");
    expect(deltas.join("")).toContain("done");
  });

  it("11e. the tool catalog sent to the model carries no mounted secret in a description or a schema default/example", async () => {
    const instance = await make(name);
    script = [() => textReply("hi")];
    await run(instance, { threadId: threadId(), text: "hi", integrations: { custom: { fake: mount(newLog(), { FAKE_TOOLS: "leaky" }) } } });
    const tools = bodies[0]!.tools as Array<{ function: { name: string; description?: string; parameters: Record<string, any> } }>;
    const leaky = tools.find((tool) => tool.function.name === "fake_leaky")!;
    expect(JSON.stringify(bodies[0]!.tools)).not.toContain(TOKEN.slice(0, 8));
    expect(leaky.function.description).toBe("signs with [redacted]");
    expect(leaky.function.parameters.properties.auth).toEqual({ type: "string", default: "[redacted]", examples: ["[redacted]"] });
  });

  it("11f. an embedded-resource result holding a password with a quote and a backslash is scrubbed before serialization", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const thread = threadId();
    script = [() => callsReply([{ id: "res_1", name: "fake_resource" }]), () => textReply("read it")];
    const turn = await run(instance, { threadId: thread, text: "creds", integrations: { custom: { fake: mount(log, { FAKE_TOOLS: "leaky", FAKE_PASSWORD: PASSWORD }) } } });
    expect(turn.completed.ok).toBe(true);
    const item = ofType(turn.events, "item.completed", "tool")[0]!;
    expect(item.ok).toBe(true);
    expect(String(item.result)).toContain("file:///creds.txt");
    expect(String(item.result)).not.toContain(PASSWORD_CORE);
    for (const message of toolMessages(bodies[1]!)) expect(message.content).not.toContain(PASSWORD_CORE);
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain(PASSWORD_CORE);
    expect(nativeText(thread)).not.toContain(PASSWORD_CORE);
    expect(JSON.stringify(turn.events.map((event) => loggedRuntimeEvent(event as unknown as RuntimeEvent)))).not.toContain(PASSWORD_CORE);
  });

  it("11g. the assistant replay to the model is scrubbed (text, reasoning, parsed and unparseable arguments); the call runs exact", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    const broken = `{"note":${JSON.stringify(PASSWORD)}`; // escaped password, never closed: not JSON
    script = [
      () => sse([
        ...(spec.reasoning ? [frame({ choices: [{ delta: { reasoning_content: `plan with ${TOKEN}` } }] })] : []),
        frame({ choices: [{ delta: { content: `using ${TOKEN}` } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "rp_1", type: "function", function: { name: "fake_noop", arguments: JSON.stringify({ note: TOKEN, pw: PASSWORD }) } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: "rp_2", type: "function", function: { name: "fake_noop", arguments: broken } }] } }] }),
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), DONE,
      ]),
      () => textReply("done"),
    ];
    const turn = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log, { FAKE_PASSWORD: PASSWORD }) } } });
    expect(turn.completed.ok).toBe(true);
    // the exact arguments ran and the broker saw them exact
    expect(ran(log)[0]!.arguments).toEqual({ note: TOKEN, pw: PASSWORD });
    expect(ofType(turn.events, "request.opened")[0]!.toolCall.input).toEqual({ note: TOKEN, pw: PASSWORD });
    const replay = (bodies[1]!.messages as Array<Record<string, any>>).find((message) => message.role === "assistant")!;
    const text = JSON.stringify(replay);
    expect(text).not.toContain(TOKEN.slice(0, 8));
    expect(text).not.toContain(PASSWORD_CORE);
    expect(replay.content).toBe("using [redacted]");
    expect(JSON.parse(replay.tool_calls[0].function.arguments)).toEqual({ note: "[redacted]", pw: "[redacted]" });
    expect(replay.tool_calls[1].function.arguments).toBe('{"note":"[redacted]"');
    if (spec.reasoning) expect(replay.reasoning_content).toBe("plan with [redacted]");
  });

  it("11h. reasoning that resumes after answer text cannot stream a secret split around that text (Astra code-r2)", async () => {
    if (!spec.reasoning) return;
    const instance = await make(name);
    const reasoning = (text: string) => frame({ choices: [{ delta: { reasoning_content: text } }] });
    script = [() => sse([
      reasoning(`the token is ${TOKEN.slice(0, 6)}`), frame({ choices: [{ delta: { content: "ok" } }] }), reasoning(`${TOKEN.slice(6)} done`),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE,
    ])];
    const turn = await run(instance, { threadId: threadId(), text: "think", integrations: { custom: { fake: mount(newLog()) } } });
    expect(turn.completed.ok).toBe(true);
    const deltas = ofType(turn.events, "content.delta").filter((event) => event.streamKind === "reasoning_text").map((event) => event.delta as string);
    expect(deltas.join("")).not.toContain(TOKEN.slice(0, 5));
    expect(deltas.join("")).toContain("done");
  });

  it("11i. a text result that holds a secret JSON-escaped (a password with a quote and a backslash) is scrubbed (Astra code-r2)", async () => {
    const instance = await make(name);
    allowAll(instance);
    const thread = threadId();
    script = [() => callsReply([{ id: "esc_1", name: "fake_echo", args: { note: PASSWORD } }]), () => textReply("echoed")];
    const turn = await run(instance, { threadId: thread, text: "echo", integrations: { custom: { fake: mount(newLog(), { FAKE_PASSWORD: PASSWORD }) } } });
    expect(turn.completed.ok).toBe(true);
    const item = ofType(turn.events, "item.completed", "tool")[0]!;
    expect(String(item.result)).toContain("echo:");
    expect(String(item.result)).not.toContain(PASSWORD_CORE);
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain(PASSWORD_CORE);
    expect(nativeText(thread)).not.toContain(PASSWORD_CORE);
    expect(JSON.stringify(turn.events.map((event) => loggedRuntimeEvent(event as unknown as RuntimeEvent)))).not.toContain(PASSWORD_CORE);
  });

  it("11j. a secret used as an argument key is removed from the replay; the call runs with the exact key (Astra code-r2)", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    script = [() => callsReply([{ id: "key_1", name: "fake_noop", args: { [TOKEN]: "v" } }]), () => textReply("done")];
    const turn = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(turn.completed.ok).toBe(true);
    expect(ran(log)[0]!.arguments).toEqual({ [TOKEN]: "v" });
    const replay = (bodies[1]!.messages as Array<Record<string, any>>).find((message) => message.role === "assistant")!;
    expect(JSON.stringify(replay)).not.toContain(TOKEN.slice(0, 8));
    expect(JSON.parse(replay.tool_calls[0].function.arguments)).toEqual({ "[redacted]": "v" });
  });

  it("11k. a server whose schema names a secret as a property is left out of the turn, never sent (Astra code-r2)", async () => {
    const instance = await make(name);
    script = [() => textReply("hi")];
    await run(instance, { threadId: threadId(), text: "hi", integrations: { custom: { fake: mount(newLog(), { FAKE_TOOLS: "leakykey" }) } } });
    expect(JSON.stringify(bodies[0]!.tools ?? [])).not.toContain(TOKEN.slice(0, 8));
    expect(toolNames(bodies[0]!) ?? []).not.toContain("fake_echo");
  });

  it("12. the MCP child gets no ambient secret, only its own mount's token", async () => {
    const sentinels = ["MURAGE_MCP_TOKEN", "MURAGEBOX_BOX_TOKEN", "FLUX_API_KEY", "OPENAI_COMPAT_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "MURAGE_X"];
    for (const sentinel of sentinels) setEnv(sentinel, `sentinel-${sentinel}`);
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    script = [() => textReply("hi")];
    await run(instance, { threadId: threadId(), text: "hi", integrations: { custom: { fake: mount(log) } } });
    const [boot] = boots(log);
    for (const sentinel of sentinels) expect(boot!.env).not.toContain(sentinel);
    expect(boot!.env).toContain("FAKE_TOKEN");
    expect(boot!.token).toBe(TOKEN);
  });

  it("13. draftOnly, engineCommand, textOnlyTurn and generateText send no tools and mount nothing", async () => {
    const instance = await make(name);
    const log = newLog();
    fallback = () => textReply("plain");
    await run(instance, { threadId: threadId(), text: "draft", draftOnly: true, integrations: { custom: { fake: mount(log) } } });
    await run(instance, { threadId: threadId(), text: "cmd", engineCommand: { name: "compact", args: "" }, integrations: { custom: { fake: mount(log) } } });
    expect(boots(log)).toHaveLength(0);
    fallback = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    await instance.adapter.textOnlyTurn!({
      system: "s", text: "t", model: "test-model", outputSchema: { type: "object" }, signal: new AbortController().signal,
      maxOutputTokens: 64, maxOutputBytes: 4096, context: { botId: "b", runId: "r", family: "f", attempt: 1 },
    }).catch(() => undefined);
    expect(await instance.generateText!("hello")).toBe("{}");
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
    }
    // a helper that is handed tool calls fails instead of running them
    fallback = () => new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      { id: "h1", type: "function", function: { name: "fake_noop", arguments: "{}" } },
    ] } }] }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(instance.generateText!("hello")).rejects.toThrow(TOOL_CALLS_TO_HELPER);
  });

  it("14. no retry after a call ran; a Groq tool_use_failed before any call is resent", async () => {
    const instance = await make(name);
    allowAll(instance);
    let log = newLog();
    script = [() => callsReply([{ id: "once_1", name: "fake_noop" }]), () => httpError(503, { error: { message: "service unavailable" } })];
    fallback = () => textReply("a retry must not happen");
    const after = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(after.completed.ok).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(ran(log)).toHaveLength(1);
    expect(ofType(after.events, "turn.retrying")).toHaveLength(0);
    expect(errors(after.events).join(" ")).toContain("The steps so far already ran");

    bodies = [];
    fallback = null;
    log = newLog();
    script = [
      () => httpError(400, { error: { code: "tool_use_failed", message: "Failed to call a function", failed_generation: "<x>" } }),
      () => callsReply([{ id: "ok_1", name: "fake_noop" }]),
      () => textReply("worked"),
    ];
    const resent = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(resent.completed.ok).toBe(true);
    expect(ofType(resent.events, "turn.retrying")).toEqual([expect.objectContaining({ reason: "tool_use_failed", attempt: 1 })]);
    expect(bodies).toHaveLength(3);
    expect(toolNames(bodies[1]!)).toEqual(toolNames(bodies[0]!));
    expect(ran(log)).toHaveLength(1);
  });

  it("15. caps: 129 tools, an oversized schema or an oversized catalog drop that server whole, with a notice", async () => {
    const instance = await make(name);
    allowAll(instance);
    const log = newLog();
    script = [() => textReply("hi")];
    const { completed, events } = await run(instance, { threadId: threadId(), text: "hi", integrations: { custom: {
      fake: mount(log),
      many: mount(log, { FAKE_TOOLS: "many:129" }),
      schema: mount(log, { FAKE_TOOLS: "bigschema" }),
      catalog: mount(log, { FAKE_TOOLS: "bigcatalog" }),
    } } });
    expect(completed.ok).toBe(true);
    expect(toolNames(bodies[0]!)).toEqual(["fake_echo", "fake_noop", "fake_slow", "fake_secret", "fake_ask_user"]);
    const notices = errors(events);
    for (const server of ["many", "schema", "catalog"]) {
      expect(notices.filter((message) => message.startsWith(`The ${server} tools were left out of this turn`))).toHaveLength(1);
    }
  });
});

describe("grok: steer write failures (11b; the one wrapper with a transient retry, so a failed write is followed by another)", () => {
  it("a never-connected write unstages and re-parks in order; the renewed fence's throw is rejected and never resent", async () => {
    const instance = await make("grok");
    const thread = threadId();
    let fenceCalls = 0;
    script = [
      () => { throw connectError("ECONNREFUSED"); },
      () => textReply("answered"),
    ];
    // parked from the turn's own fence, which runs right before the first write's splice
    let renewed: Promise<unknown> | undefined;
    let kept: Promise<unknown> | undefined;
    const turn = await start(instance, { threadId: thread, text: "go", beforeSubmit: () => {
      if (renewed) return;
      renewed = instance.adapter.steer!(thread, "steer one", () => { if (++fenceCalls > 1) throw new Error("moved"); });
      kept = instance.adapter.steer!(thread, "steer two");
    } });
    const completed = await turn.done();
    expect(completed.ok).toBe(true);
    expect(fenceCalls).toBe(2);
    expect(await renewed).toBe("rejected");
    expect(await kept).toBe("delivered");
    expect(bodies).toHaveLength(2);
    const users = (body: Record<string, any>) => (body.messages as Array<Record<string, any>>).filter((message) => message.role === "user").map((message) => message.content as string);
    expect(users(bodies[0]!).slice(-2)).toEqual(["steer one", "steer two"]);
    expect(users(bodies[1]!).filter((text) => text.startsWith("steer"))).toEqual(["steer two"]);
  });

  it("an ambiguous write failure resolves uncertain and is confirmed once by the next answered request", async () => {
    const instance = await make("grok");
    const thread = threadId();
    script = [
      () => { throw connectError("ECONNRESET"); },
      () => textReply("answered"),
    ];
    let steer: Promise<unknown> | undefined;
    const turn = await start(instance, { threadId: thread, text: "go", beforeSubmit: () => {
      steer ??= instance.adapter.steer!(thread, "maybe sent", undefined, "ij-uncertain");
    } });
    const completed = await turn.done();
    expect(completed.ok).toBe(true);
    expect(await steer).toBe("uncertain");
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect((body.messages as Array<Record<string, any>>).filter((message) => message.content === "maybe sent")).toHaveLength(1);
    }
    expect(ofType(turn.events, "steer.confirmed")).toEqual([expect.objectContaining({ interjectionId: "ij-uncertain" })]);
  });
});

describe("openai-compat on a local endpoint: announcement nudges (s5.4)", () => {
  const LOCAL = "http://127.0.0.1:9/v1";

  it("nudges an announced action after tool progress", async () => {
    const instance = await make("openai-compat", LOCAL);
    allowAll(instance);
    const log = newLog();
    script = [
      () => callsReply([{ id: "n1", name: "fake_noop" }]),
      () => textReply("Let me check the logs:"),
      () => textReply("All checked."),
    ];
    const { completed } = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(bodies).toHaveLength(3);
    expect((bodies[2]!.messages as Array<Record<string, any>>).at(-1)).toEqual({ role: "user", content: NUDGE_ANNOUNCED_ACTION });
  });

  it("never nudges on the last allowed step", async () => {
    const instance = await make("openai-compat", LOCAL);
    allowAll(instance);
    const log = newLog();
    fallback = ({ index }) => index < MAX_CHAT_ROUNDS - 1 ? callsReply([{ id: `l${index}`, name: "fake_noop" }]) : textReply("Let me check the logs:");
    const { completed, events } = await run(instance, { threadId: threadId(), text: "go", integrations: { custom: { fake: mount(log) } } });
    expect(completed.ok).toBe(true);
    expect(bodies).toHaveLength(MAX_CHAT_ROUNDS);
    expect(answers(events).at(-1)).toBe("Let me check the logs:");
  });
});

describe.skipIf(process.platform === "win32")("shutdown with a turn in flight (rev 5, H2)", () => {
  it("dispose inside the graceful shutdown escalates the POSIX group SIGTERM to SIGKILL before the deadline", async () => {
    // the real close budget, not a fixture's shortened one
    setEnv("MURAGE_PROVIDER_CLOSE_MS", undefined);
    const instance = await make("openai-compat");
    allowAll(instance);
    const log = newLog();
    const pids = join(dir, `pids-shutdown-${logCounter}.txt`);
    const thread = threadId();
    script = [() => callsReply([{ id: "slow_sd", name: "fake_slow" }])];
    const turn = await start(instance, { threadId: thread, text: "go", integrations: { custom: {
      fake: mount(log, { FAKE_MODE: "ignore-term", FAKE_GRANDCHILD: "group", FAKE_PIDS: pids }),
    } } });
    await turn.recorder.until((event) => event.type === "item.started");
    await waitFor(() => ran(log).length === 1 && readFileSync(pids, "utf8").split("\n").length === 2);
    const [root, grandchild] = readFileSync(pids, "utf8").split("\n").map(Number);
    for (const pid of [root!, grandchild!]) { strayPids.add(pid); expect(pidGone(pid)).toBe(false); }

    let gone: { root: boolean; grandchild: boolean } | undefined;
    let exitAt = 0;
    let startedAt = 0;
    const exited = new Promise<number>((resolve) => {
      const shutdown = createGracefulShutdown({
        cleanup: [() => instance.dispose()],
        exit: (code) => {
          exitAt = Date.now();
          gone = { root: pidGone(root!), grandchild: pidGone(grandchild!) };
          resolve(code);
        },
      });
      startedAt = Date.now();
      shutdown();
    });
    expect(await exited).toBe(0);
    console.log(`[shutdown] exit after ${exitAt - startedAt} ms`);
    // the stop went through the group SIGTERM (ignored by both) and its SIGKILL escalation, not an early exit
    expect(lines(log).some((line) => line.sigterm === root)).toBe(true);
    expect(lines(log).find((line) => "grandchildExit" in line)).toBeUndefined();
    expect(exitAt - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(gone).toEqual({ root: true, grandchild: true });
    expect(exitAt - startedAt).toBeLessThan(SERVER_SHUTDOWN_TIMEOUT_MS);
  });

  it("H6: a descendant that left the process group (setsid) is found, ended, and confirmed gone before the shutdown exits", async () => {
    setEnv("MURAGE_PROVIDER_CLOSE_MS", undefined);
    const instance = await make("openai-compat");
    allowAll(instance);
    const log = newLog();
    const pids = join(dir, `pids-shutdown-escape-${logCounter}.txt`);
    const thread = threadId();
    script = [() => callsReply([{ id: "slow_esc", name: "fake_slow" }])];
    const turn = await start(instance, { threadId: thread, text: "go", integrations: { custom: {
      fake: mount(log, { FAKE_MODE: "ignore-term", FAKE_GRANDCHILD: "escape", FAKE_PIDS: pids }),
    } } });
    await turn.recorder.until((event) => event.type === "item.started");
    await waitFor(() => ran(log).length === 1 && readFileSync(pids, "utf8").split("\n").length === 2);
    const [root, escaped] = readFileSync(pids, "utf8").split("\n").map(Number);
    for (const pid of [root!, escaped!]) { strayPids.add(pid); expect(pidGone(pid)).toBe(false); }

    let disposed: unknown = "pending";
    let gone: { root: boolean; escaped: boolean } | undefined;
    let exitAt = 0;
    let startedAt = 0;
    const exited = new Promise<number>((resolve) => {
      const shutdown = createGracefulShutdown({
        cleanup: [() => instance.dispose().then(() => { disposed = "confirmed"; }, (error: unknown) => { disposed = error; })],
        exit: (code) => {
          exitAt = Date.now();
          gone = { root: pidGone(root!), escaped: pidGone(escaped!) };
          resolve(code);
        },
      });
      startedAt = Date.now();
      shutdown();
    });
    expect(await exited).toBe(0);
    console.log(`[shutdown-escape] exit after ${exitAt - startedAt} ms`);
    // the group kill alone never reaches it: it was ended by its own SIGTERM, then SIGKILL, and the dispose confirmed it
    expect(disposed).toBe("confirmed");
    expect(exitAt - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(gone).toEqual({ root: true, escaped: true });
    expect(exitAt - startedAt).toBeLessThan(SERVER_SHUTDOWN_TIMEOUT_MS);
  });
});
