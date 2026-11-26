// cause22 GROUP E witnesses (lane cause22-redact; owner of this file: lane cause22-redact). MAIN-RULING
// cause22-no-transport-caps (Sean 11-22): no size or count cap on a reply. Both rows enter through the openai-compat driver's
// own adapter.sendTurn with a stubbed provider fetch and a real stdio MCP server; RED on c187b11166.
//   E1 a 20 MiB reply carrying one key comes out of the driver whole, with only the key redacted (server/redact.ts scan budget).
//      The audience policy after the bus (redact-turn.ts / audience-collector.ts budgets) is NOT covered: OPEN NO-OWNER (DECISIONS D5).
//   E2 one reply with 40 tool calls runs all 40 (server/drivers/openai-chat-protocol.ts MAX_REPLY_TOOL_CALLS).
//   E3 one reply with 201 tool calls runs all 201 (server/drivers/openai-chat.ts per-turn MAX_TURN_TOOL_CALLS 200).
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { bindOpenAIFixture } from "../testing/bound-openai-fixture.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const SERVER = String.raw`
import { appendFileSync } from "node:fs";
const log = process.env.FAKE_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { n: { type: "number" } } } }] } });
    else if (m.method === "tools/call") { appendFileSync(log, JSON.stringify(m.params) + "\n"); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ran " + m.params.arguments?.n }] } }); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

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

type Reply = (body: Record<string, any>) => Response;
let script: Reply[] = [];
let bodies: Array<Record<string, any>> = [];
let previousFetch: typeof globalThis.fetch;
let dir: string;
let serverPath: string;
const instances: ProviderInstance[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cause22-redact-"));
  serverPath = join(dir, "fake-mcp-server.mjs");
  writeFileSync(serverPath, SERVER);
});
afterAll(() => { removeTempDirSync(dir); });

beforeEach(() => {
  ensureDirs();
  previousFetch = globalThis.fetch;
  script = [];
  bodies = [];
  // The stub returns real Response objects; anything but a chat completion (catalog refresh) is a 404 and never leaves the process.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    bodies.push(body);
    const next = script.shift();
    if (!next) throw new Error(`unexpected extra provider request #${bodies.length}`);
    return next(body);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = previousFetch;
  for (const instance of instances.splice(0)) await instance.dispose().catch(() => {});
});

const turn = async (threadId: string, log: string) => {
  const instance = await OpenAICompatDriver.create({
    instanceId: `cause22-redact-${threadId}`, displayName: "Fixture engine", environment: {}, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://compat.invalid/v1", key: "fixture", model: "test-model" }),
  });
  bindOpenAIFixture(instance);
  instances.push(instance);
  instance.adapter.onEvent((event: RuntimeEvent) => {
    if (event.type !== "request.opened") return;
    const opened = event as unknown as { threadId: string; requestId: string };
    setImmediate(() => void instance.adapter.respondToRequest(opened.threadId, opened.requestId, { behavior: "allow" } as never));
  });
  const recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn(fixtureMountTurn({ cwd: fixtureBotFolder(), threadId, text: "fixture",
    integrations: { custom: { fake: { command: process.execPath, args: [serverPath], env: { FAKE_LOG: log } } } } } as never));
  const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 120_000) as unknown as { ok: boolean };
  const events = recorder.events as unknown as Array<{ type: string; itemType?: string; text?: string; ok?: boolean }>;
  recorder.stop();
  const replies = events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text").map((event) => event.text);
  const tools = events.filter((event) => event.type === "item.completed" && event.itemType === "tool");
  return { completed, replies, tools };
};
const ran = (log: string) => existsSync(log)
  ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { arguments: { n: number } }).arguments.n) : [];

describe("cause22 GROUP E: no size or count cap on a reply (openai-compat adapter.sendTurn)", () => {
  it("E1 a 20 MiB reply with one key in it leaves the driver whole, with only the key redacted", async () => {
    const key = `sk-${"Q7m2Zr9Lw4HdXk".repeat(3)}`;
    const line = "the quick brown fox jumps over the lazy dog 0123456789\n";
    const head = line.repeat(Math.ceil((20 * 1024 * 1024) / line.length));
    const text = `${head}the key is ${key} and this is the end`;
    expect(text.length).toBeGreaterThan(20 * 1024 * 1024);
    // Sent in 64 KiB content deltas, as a provider streams it.
    const deltas: string[] = [];
    for (let at = 0; at < text.length; at += 65_536) deltas.push(frame({ choices: [{ delta: { content: text.slice(at, at + 65_536) } }] }));
    script = [() => sse([...deltas, frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE])];
    const { completed, replies } = await turn(`e1-${Date.now()}`, join(dir, "e1.ndjson"));
    expect(completed.ok).toBe(true);
    const shown = replies.join("");
    expect(shown.includes(key)).toBe(false);
    expect(shown).toBe(`${head}the key is «redacted ${key.length} chars» and this is the end`);
  }, 180_000);

  it("E2 one reply with 40 tool calls runs all 40", async () => {
    const log = join(dir, "e2.ndjson");
    const calls = Array.from({ length: 40 }, (_, n) => n);
    script = [
      () => sse([
        ...calls.map((n) => frame({ choices: [{ delta: { tool_calls: [{ index: n, id: `call_${n}`, type: "function", function: { name: "fake_echo", arguments: JSON.stringify({ n }) } }] } }] })),
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
      ]),
      () => sse([frame({ choices: [{ delta: { content: "all done" } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE]),
    ];
    const { completed, replies, tools } = await turn(`e2-${Date.now()}`, log);
    expect(completed.ok).toBe(true);
    expect(ran(log)).toEqual(calls);
    expect(tools.filter((tool) => tool.ok === true)).toHaveLength(40);
    const results = (bodies[1]!.messages as Array<Record<string, any>>).filter((message) => message.role === "tool").map((message) => message.tool_call_id);
    expect(results).toEqual(calls.map((n) => `call_${n}`));
    expect(replies).toEqual(["all done"]);
  }, 180_000);

  it("E3 one reply with 201 tool calls runs all 201", async () => {
    const log = join(dir, "e3.ndjson");
    const calls = Array.from({ length: 201 }, (_, n) => n);
    script = [
      () => sse([
        ...calls.map((n) => frame({ choices: [{ delta: { tool_calls: [{ index: n, id: `call_${n}`, type: "function", function: { name: "fake_echo", arguments: JSON.stringify({ n }) } }] } }] })),
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
      ]),
      () => sse([frame({ choices: [{ delta: { content: "all done" } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE]),
    ];
    const { completed, replies } = await turn(`e3-${Date.now()}`, log);
    expect(ran(log)).toEqual(calls);
    expect(completed.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(replies).toEqual(["all done"]);
  }, 180_000);
});

useOutsideStoreFixture();
