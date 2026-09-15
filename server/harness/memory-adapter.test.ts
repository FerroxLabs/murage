import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE, memoryRequestPrefix, type MemoryBundle } from "../../shared/memory.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

const bundle: MemoryBundle = {
  bundleId: "bundle", text: "Prior decision: use nightly backups.", policyRevision: 1, deletionEpoch: 0,
  tokenCount: 20, recordVersions: [{ id: "r", version: 1 }], sourceVersions: [{ id: "s", revision: 1 }],
};
const bridge = { command: "node", args: ["memory-proxy.js"], env: { MURAGE_MEMORY_TOKEN: "fixture-token" } };

async function fixture(kind = "fake", memoryMcp = false) {
  const fake = makeFakeDriver({ kind });
  const captured: SendTurnInput[] = [];
  let sessionId: string | null = null;
  let unsubscriptions = 0;
  let fail = false;
  let original: ProviderInstance;
  const create = fake.driver.create;
  fake.driver.create = async input => {
    original = await create(input);
    Object.assign(original.adapter.capabilities, { customMcp: true, memoryMcp });
    original.adapter.hasSession = () => sessionId !== null;
    const subscribe = original.adapter.onEvent;
    original.adapter.onEvent = listener => {
      const unsubscribe = subscribe(listener);
      return () => { unsubscriptions++; unsubscribe(); };
    };
    original.adapter.sendTurn = async function (turn) {
      expect(this).toBe(original.adapter);
      if (fail) throw new Error("fixture rejected turn");
      captured.push(turn);
      return { turnId: "turn" };
    };
    original.snapshot = async function () { expect(this).toBe(original); return { state: "available" }; };
    return original;
  };
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ instance: { driver: kind } });
  const live = registry.get("instance")!;
  const emit = (id: string | null, type: "session.started" | "session.exited" = "session.started") => {
    sessionId = type === "session.exited" ? null : id;
    fake.created.get("instance")!.emit({
      eventId: "event", provider: kind, threadId: "thread", createdAt: new Date().toISOString(),
      ...(type === "session.started" ? { type, sessionId: id } : { type }),
    } as RuntimeEvent);
  };
  return { live, registry, captured, emit, setFail: (value: boolean) => { fail = value; }, unsubscriptions: () => unsubscriptions };
}

describe("registry memory delivery contract (capturing sinks, not native runtime proof)", () => {
  it.each(BUILT_IN_DRIVERS.map(driver => driver.driverKind))("delivers reference text for registered kind %s", async kind => {
    // The registry is exercised with the actual registered kind and an inert
    // contract sink. No native driver construction, credentials or model calls.
    const f = await fixture(kind);
    try {
      const input: SendTurnInput = { threadId: "thread", text: "What should I do?", system: "persona", memoryContext: bundle };
      await f.live.adapter.sendTurn(input);
      expect(f.captured[0].text).toBe(memoryRequestPrefix(bundle.text) + input.text);
      expect(f.captured[0].text).toMatch(/Current request:\nWhat should I do\?$/);
      expect(f.captured[0].system).toBe("persona");
      expect(f.captured[0].memoryContext).toBeUndefined();
      expect(input.memoryContext).toBe(bundle);
      expect(f.live.adapter.capabilities.memoryDelivery).toBe("prefixed-reference");
    } finally { await f.registry.disposeAll(); }
  });
});

it("mounts memory separately from agent tools and rejects a reserved-name collision", async () => {
  const f = await fixture("mcp", true);
  try {
    await f.live.adapter.sendTurn({ threadId: "thread", text: "request", memoryContext: bundle, integrations: { memory: bridge, custom: { user: bridge } } });
    expect(f.captured[0].integrations?.custom).toEqual({ user: bridge });
    expect(f.captured[0].integrations?.memory).toEqual(bridge);
    expect(f.captured[0].integrations?.agents).toBeUndefined();
    expect(f.live.adapter.capabilities.memoryMcp).toBe(true);
    await expect(f.live.adapter.sendTurn({ threadId: "thread", text: "request", integrations: { memory: bridge, custom: { "murage-memory": bridge } } })).rejects.toThrow("MEMORY_MCP_NAME_COLLISION");
    expect(f.captured).toHaveLength(1);
  } finally { await f.registry.disposeAll(); }
});

it("delivers host context when the engine cannot mount memory MCP", async () => {
  const f = await fixture();
  try {
    await f.live.adapter.sendTurn({ threadId: "thread", text: "request", memoryContext: bundle, integrations: { memory: bridge } });
    expect(f.captured[0].text).toContain(bundle.text);
    expect(f.captured[0].integrations).toEqual({});
    expect(f.live.adapter.capabilities.memoryMcp).toBe(false);
  } finally { await f.registry.disposeAll(); }
});

it("deduplicates only a confirmed live session with the same content and authority revisions", async () => {
  const f = await fixture();
  const turn = { threadId: "thread", text: "request", memoryContext: bundle };
  try {
    await f.live.adapter.sendTurn(turn);
    await f.live.adapter.sendTurn(turn); // no session.started: repeat is required
    expect(f.captured[1].text).toContain(bundle.text);
    f.emit("native-one");
    await f.live.adapter.sendTurn({ ...turn, memoryContext: { ...bundle, bundleId: "new-receipt" } });
    expect(f.captured[2].text).toBe("request");
    await f.live.adapter.sendTurn({ ...turn, memoryContext: { ...bundle, policyRevision: 2 } });
    expect(f.captured[3].text).toContain(bundle.text);
    f.emit(null, "session.exited");
    await f.live.adapter.sendTurn(turn);
    expect(f.captured[4].text).toContain(bundle.text);
    f.emit("native-two");
    await f.live.adapter.sendTurn({ ...turn, memoryContext: { ...bundle, deletionEpoch: 1 } });
    expect(f.captured[5].text).toContain(bundle.text);
    await f.live.adapter.stopAll();
    await f.live.adapter.sendTurn(turn);
    expect(f.captured[6].text).toContain(bundle.text);
  } finally { await f.registry.disposeAll(); }
});

it("preserves ordinary turns and this bindings, clears failed delivery, and unsubscribes on disposal", async () => {
  const f = await fixture();
  const turn = { threadId: "thread", text: "request", memoryContext: bundle };
  try {
    const plain = { threadId: "thread", text: "ordinary", system: "persona" };
    await f.live.adapter.sendTurn(plain);
    expect(f.captured[0]).toEqual(plain);
    await expect(f.live.snapshot()).resolves.toEqual({ state: "available" });
    await f.live.adapter.sendTurn(turn); f.emit("native");
    f.setFail(true);
    await expect(f.live.adapter.sendTurn(turn)).rejects.toThrow("fixture rejected turn");
    f.setFail(false);
    await f.live.adapter.sendTurn(turn);
    expect(f.captured.at(-1)?.text).toContain(bundle.text);
  } finally { await f.registry.disposeAll(); }
  expect(f.unsubscriptions()).toBe(1);
});

it("suppresses an unchanged reference only for the confirmed native resume identity", async () => {
  const f = await fixture();
  const turn = { threadId: "thread", text: "request", memoryContext: bundle };
  try {
    await f.live.adapter.sendTurn(turn);
    f.emit("native-one");
    await f.live.adapter.sendTurn({ ...turn, resumeCursor: "native-one" });
    expect(f.captured[1].text).toBe("request");
    await f.live.adapter.sendTurn({ ...turn, resumeCursor: "native-other" });
    expect(f.captured[2].text).toBe(memoryRequestPrefix(bundle.text) + turn.text);
    await f.live.adapter.sendTurn({ ...turn, resumeCursor: { sessionId: "native-one" } });
    expect(f.captured[3].text).toBe(memoryRequestPrefix(bundle.text) + turn.text);
  } finally { await f.registry.disposeAll(); }
});

// Actual registered drivers behind the production registry decoration, each
// against its existing offline fake (scripted CLI, fake app-server or stubbed
// HTTP). Proves the dispatched protocol payload carries the memory frame once
// and never in system instructions. Not native binary, credential or model proof.
const TESTING = join(import.meta.dirname, "..", "testing");
const FAKE_CLAUDE = join(TESTING, "fake-claude-cli.ts");
const FAKE_CODEX = join(TESTING, "fake-codex-app-server.ts");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");
const FAKE_GROK = join(TESTING, "fake-grok-provider-cli.ts");
const FAKE_AGY = join(TESTING, "fake-agy-cli.ts");
const FAKE_PI = join(TESTING, "fake-pi-cli.ts");
const SYSTEM = "You are Fixture Bot.";
const REQUEST = "What did we decide about backups?";
const FRAME = [MEMORY_REFERENCE_PREAMBLE, MEMORY_REFERENCE_OPEN, '- m1 (the owner said; fact) "Use nightly backups."', MEMORY_REFERENCE_CLOSE].join("\n");
const framed: MemoryBundle = { ...bundle, bundleId: "framed", text: FRAME };
const FLUX_FIXTURE_KEY = "sk-flux-Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// A minimal Fuigo ACP agent, spawned as "<node>" "<script>" like fuigo.test.ts.
const FUIGO_SOURCE = [
  'import { writeFileSync } from "node:fs";', 'import { join } from "node:path";',
  'const argv = process.argv.slice(2);',
  'if (argv.includes("--version")) { console.log("fuigo 1.0.4 (fake)"); process.exit(0); }',
  'if (argv[0] === "models") process.exit(0);',
  'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); let buf = "";',
  'process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) {',
  '  const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; const m = JSON.parse(line);',
  '  const ok = (r) => send({ jsonrpc: "2.0", id: m.id, result: r });',
  '  if (m.method === "initialize") ok({ protocolVersion: 1, authMethods: [{ id: "fuigo.api_key" }] });',
  '  else if (m.method === "authenticate") ok({});',
  '  else if (m.method === "session/new") ok({ sessionId: "fake-fuigo-session" });',
  '  else if (m.method === "session/prompt") { writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "prompt.json"), JSON.stringify(m.params));',
  '    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-fuigo-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });',
  '    ok({ stopReason: "end_turn" }); }',
  '  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nm" } });',
  "} });",
].join("\n");

type Http = Array<{ url: string; method: string; body: any }>;
type Observed = { payload: string; system?: string | null };
interface Dispatch {
  entry(scratch: string): { driver: string; config?: unknown; environment?: Record<string, string> };
  processEnv?(scratch: string): Record<string, string>;
  turn?: Partial<SendTurnInput>;
  http?(calls: Http): typeof fetch;
  observe(scratch: string, events: RuntimeEvent[], calls: Http): Observed;
}
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const text = (blocks: Array<{ text?: string }>) => blocks.filter(block => typeof block.text === "string").map(block => block.text).join("\n");
const echoed = (events: RuntimeEvent[]) => ({
  payload: events.flatMap(e => e.type === "content.delta" && e.streamKind === "assistant_text" ? [e.delta] : []).join("").replace(/^echo: /, ""),
});
const acp = (driver: string, config: Record<string, unknown> = {}, environment: (scratch: string) => Record<string, string> = scratch => ({ HOME: scratch })): Dispatch => ({
  entry: scratch => ({ driver, config: { cli: FAKE_ACP, fullAuto: false, ...config }, environment: environment(scratch) }),
  processEnv: () => ({ FAKE_ACP_MODE: "echo-gated" }),
  observe: (_scratch, events) => echoed(events),
});
function openAiHttp(calls: Http): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), { status: 200 });
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
const chat = (calls: Http): Observed => {
  const body = calls.filter(call => call.method === "POST" && call.url.endsWith("/chat/completions")).at(-1)!.body;
  return { payload: body.messages.at(-1).content, system: body.messages[0]?.role === "system" ? body.messages[0].content : null };
};

const DISPATCH: Record<string, Dispatch> = {
  piAgent: {
    entry: scratch => ({ driver: "piAgent", config: { cli: FAKE_PI, fullAuto: false }, environment: { HOME: scratch, USERPROFILE: scratch, FAKE_PI_DUMP: join(scratch, "pi.jsonl") } }),
    http: openAiHttp,
    observe: scratch => {
      const last = readFileSync(join(scratch, "pi.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.prompt === true).at(-1);
      if (typeof last?.message !== "string") throw Error("Pi fixture did not capture prompt text");
      return { payload: last.message };
    },
  },
  claudeAgent: {
    entry: () => ({ driver: "claudeAgent", config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } }),
    processEnv: scratch => ({ FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: join(scratch, "dump.json") }),
    observe: scratch => { const seen = json(join(scratch, "dump.json")); return { payload: seen.prompt.message.content, system: seen.systemPrompt }; },
  },
  codex: {
    entry: () => ({ driver: "codex", config: { cli: FAKE_CODEX, fullAuto: false } }),
    processEnv: scratch => ({ FAKE_CODEX_MODE: "happy", FAKE_CODEX_DUMP: join(scratch, "dump.json") }),
    observe: scratch => ({ payload: text(json(join(scratch, "dump.json")).calls.find((call: { method: string }) => call.method === "turn/start").params.input) }),
  },
  grokAgent: {
    entry: scratch => ({ driver: "grokAgent", config: { cli: FAKE_GROK, fullAuto: false },
      environment: { HOME: scratch, USERPROFILE: scratch, GROK_HOME: join(scratch, ".grok"), FAKE_GROK_DUMP: join(scratch, "dump.json") } }),
    observe: scratch => ({ payload: text(json(join(scratch, "dump.json")).calls.find((call: { method: string }) => call.method === "session/prompt").params.prompt) }),
  },
  fuigoAgent: {
    entry: scratch => {
      const script = join(scratch, "fake-fuigo.mjs"), home = join(scratch, "home");
      writeFileSync(script, FUIGO_SOURCE); mkdirSync(home, { recursive: true });
      return { driver: "fuigoAgent", config: { cli: `"${process.execPath}" "${script}"`, fullAuto: false }, environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: scratch } };
    },
    processEnv: () => ({ FLUX_API_KEY: FLUX_FIXTURE_KEY }),
    observe: scratch => ({ payload: text(json(join(scratch, "prompt.json")).prompt) }),
  },
  geminiAgent: acp("geminiAgent"),
  kimiAgent: acp("kimiAgent", {}, scratch => { mkdirSync(join(scratch, ".kimi-code"), { recursive: true }); return { HOME: scratch }; }),
  droidAgent: acp("droidAgent", { fullAuto: true }),
  cursorAgent: acp("cursorAgent", {}, scratch => ({ HOME: scratch, CURSOR_API_KEY: "cursor-fixture-key" })),
  qwenAgent: acp("qwenAgent"),
  hermesAgent: acp("hermesAgent", {}, scratch => ({ HOME: scratch, MURAGE_DATA_DIR: join(scratch, "state") })),
  customAcp: acp("customAcp"),
  opencodeGo: { ...acp("opencodeGo", {}, scratch => ({ HOME: scratch, XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "opencode-fixture-key", FAKE_ACP_MODELS: "opencode/fixture-model" })),
    turn: { model: "opencode/fixture-model" } },
  antigravityAgent: {
    entry: scratch => ({ driver: "antigravityAgent", config: { cli: FAKE_AGY, fullAuto: true }, environment: { HOME: scratch, FAKE_AGY_DUMP: join(scratch, "dump.json") } }),
    observe: scratch => ({ payload: json(join(scratch, "dump.json")).prompt }),
  },
  grok: {
    entry: () => ({ driver: "grok", config: { url: "https://fixture.invalid/v1", apiKeyEnv: "XAI_API_KEY" }, environment: { XAI_API_KEY: "xai-fixture" } }),
    http: openAiHttp, observe: (_scratch, _events, calls) => chat(calls),
  },
  "openai-compat": {
    entry: () => ({ driver: "openai-compat", config: { url: "http://127.0.0.1:9/v1", apiKeyEnv: "MURAGE_MEMORY_FIXTURE_UNSET_KEY" } }),
    turn: { model: "fixture-model" }, http: openAiHttp, observe: (_scratch, _events, calls) => chat(calls),
  },
  minimax: {
    entry: () => ({ driver: "minimax", environment: { MINIMAX_API_KEY: "minimax-fixture" } }),
    processEnv: scratch => ({ HOME: scratch, USERPROFILE: scratch }),
    http: openAiHttp, observe: (_scratch, _events, calls) => chat(calls),
  },
  boxAgent: {
    entry: () => ({ driver: "boxAgent", config: { pollMs: 0 }, environment: { BOX_TOKEN: "box-fixture-token" } }),
    turn: { integrations: { computer: { boxId: "box-1", token: "box-fixture-token" } } },
    http: calls => (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input), method = String(init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = url.endsWith("/prompt") ? { promptRun: { id: "p1" } } : url.includes("/events") ? { events: [] }
        : url.includes("/prompts/p1") ? { promptRun: { status: "completed", result: "ok" } } : { ok: true };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    observe: (_scratch, _events, calls) => ({ payload: calls.find(call => call.method === "POST" && call.url.endsWith("/boxes/box-1/prompt"))!.body.prompt }),
  },
};
// Registered kinds whose dispatched text cannot be read offline without changing
// shared fixtures owned elsewhere. Each stays visibly unobserved, not passed.
const GAPS: Record<string, string> = {};

describe("actual registered drivers receive the memory frame (offline fakes, not native runtime proof)", () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    saved.clear();
    vi.unstubAllGlobals();
  });

  it("classifies every registered kind as observed here or as an explicit offline gap", () => {
    expect(Object.keys(DISPATCH).filter(kind => kind in GAPS)).toEqual([]);
    expect([...Object.keys(DISPATCH), ...Object.keys(GAPS)].sort()).toEqual(BUILT_IN_DRIVERS.map(driver => driver.driverKind).sort());
  });

  it.each(Object.keys(DISPATCH))("%s sends the framed request exactly once outside system instructions", async kind => {
    const spec = DISPATCH[kind];
    const scratch = mkdtempSync(join(tmpdir(), `murage-memory-dispatch-${kind}-`));
    const calls: Http = [];
    ensureDirs();
    for (const fake of [FAKE_CLAUDE, FAKE_CODEX, FAKE_ACP, FAKE_GROK, FAKE_AGY, FAKE_PI]) chmodSync(fake, 0o755);
    for (const [key, value] of Object.entries(spec.processEnv?.(scratch) ?? {})) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    if (spec.http) vi.stubGlobal("fetch", spec.http(calls));
    const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
    const id = `memory-${kind}`;
    try {
      await registry.load({ [id]: spec.entry(scratch) } as Parameters<ProviderRegistry["load"]>[0]);
      const live = registry.get(id);
      expect(live, JSON.stringify(registry.entries().map(entry => ({ id: entry.instanceId, reason: (entry as { shadow?: { reason?: string } }).shadow?.reason })))).not.toBeNull();
      expect(live!.driverKind).toBe(kind);
      expect(live!.adapter.capabilities.memoryDelivery).toBe("prefixed-reference");
      const events = recordEvents(live!.adapter);
      try {
        await live!.adapter.sendTurn({ threadId: id, text: REQUEST, system: SYSTEM, memoryContext: framed, ...spec.turn });
        await events.until(event => event.type === "turn.completed", 20_000);
        const seen = spec.observe(scratch, events.events, calls);
        expect(seen.payload.endsWith(memoryRequestPrefix(FRAME) + REQUEST)).toBe(true);
        expect(seen.payload.split(MEMORY_REFERENCE_PREAMBLE)).toHaveLength(2);
        if (seen.system != null) expect(seen.system).not.toContain(MEMORY_REFERENCE_OPEN);
      } finally { events.stop(); }
    } finally {
      await registry.disposeAll();
      await removeTempDir(scratch);
    }
  }, 40_000);
});
