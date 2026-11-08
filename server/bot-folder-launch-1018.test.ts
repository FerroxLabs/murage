import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotFolderUnavailableError, botFolderOrThrow } from "./bot-folder.ts";
import { ensureDirs } from "./config.ts";
import { recordEvents } from "./testing/events.ts";
import { antigravityRelayAsk } from "./drivers/antigravity-relay.ts";
import { commandCwdFromToolInput } from "../shared/exact-command.ts";

const launches = vi.hoisted(() => [] as { cwd: unknown; args: string[]; requests: string[] }[]);
vi.mock("./procs.ts", async (original) => {
  const actual = await original<typeof import("./procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
    const seen = { cwd: args[2].cwd, args: args[1], requests: [] as string[] };
    launches.push(seen);
    const child = actual.spawnCli(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      seen.requests.push(String(chunk));
      return (write as Function)(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child;
  } };
});

// Literal import paths let Vite resolve the nested ACP modules.
const driverImporters: Record<string, () => Promise<Record<string, unknown>>> = {
  "claude": () => import("./drivers/claude.ts"),
  "codex": () => import("./drivers/codex.ts"),
  "pi": () => import("./drivers/pi.ts"),
  "antigravity": () => import("./drivers/antigravity.ts"),
  "acp/droid": () => import("./drivers/acp/droid.ts"),
  "acp/gemini": () => import("./drivers/acp/gemini.ts"),
  "acp/qwen": () => import("./drivers/acp/qwen.ts"),
  "acp/kimi": () => import("./drivers/acp/kimi.ts"),
  "acp/grok": () => import("./drivers/acp/grok.ts"),
  "acp/fuigo": () => import("./drivers/acp/fuigo.ts"),
  "acp/hermes": () => import("./drivers/acp/hermes.ts"),
  "acp/cursor": () => import("./drivers/acp/cursor.ts"),
  "acp/custom": () => import("./drivers/acp/custom.ts"),
  "acp/cline": () => import("./drivers/acp/cline.ts"),
  "acp/openclaw": () => import("./drivers/acp/openclaw.ts"),
  "acp/opencode-go": () => import("./drivers/acp/opencode-go.ts"),
};

const engines = [
  ["Claude", "claude", "ClaudeDriver", "fake-claude-cli.ts"],
  ["Codex", "codex", "CodexDriver", "fake-codex-app-server.ts"],
  ["Pi", "pi", "PiDriver", "fake-pi-cli.ts"],
  ["Antigravity", "antigravity", "AntigravityDriver", "fake-agy-cli.ts"],
  ...[
    ["droid", "DroidAgentDriver"], ["gemini", "GeminiAgentDriver"], ["qwen", "QwenAgentDriver"],
    ["kimi", "KimiAgentDriver"], ["grok", "GrokAgentDriver"], ["fuigo", "FuigoAgentDriver"],
    ["hermes", "HermesAgentDriver"], ["cursor", "CursorAgentDriver"], ["custom", "CustomAcpDriver"],
    ["cline", "ClineAgentDriver"], ["openclaw", "OpenclawAgentDriver"], ["opencode-go", "OpenCodeDriver"],
  ].map(([file, name]) => [`ACP ${file}`, `acp/${file}`, name, "fake-acp-cli.ts"]),
] as const;
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; launches.length = 0; });

for (const [label, module, exported, fixture] of engines) describe(label, () => {
  async function create() {
    ensureDirs();
    root = mkdtempSync(join(tmpdir(), "marks-launch-"));
    const environment: Record<string, string> = { CLINE_API_KEY: "fixture", CURSOR_API_KEY: "fixture", OPENCODE_API_KEY: "fixture" };
    if (module === "acp/fuigo") {
      // Fuigo requires a key or login file before it reaches spawnCli.
      environment.FUIGO_HOME = join(root, "fuigo");
      mkdirSync(environment.FUIGO_HOME);
      writeFileSync(join(environment.FUIGO_HOME, "auth.json"), "{}");
    }
    const cli = resolve("server/testing", fixture!);
    chmodSync(cli, 0o755);
    const loaded = await driverImporters[module!]();
    const driver = loaded[exported!] as import("./contracts.ts").AnyProviderDriver;
    return driver.create({ instanceId: `marks-${module}`, displayName: label, enabled: true, environment, config: driver.decodeConfig({ cli, fullAuto: false }) });
  }
  it("D3-e spawn and protocol cwd equal the bot folder", async () => {
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    const cwd = join(root!, "bot"); mkdirSync(cwd);
    try {
      launches.length = 0;
      await instance.adapter.sendTurn({ threadId: `marks-${module}`, text: "hello", cwd });
      await recorder.until(e => e.type === "turn.completed");
      const turns = launches.filter(x => !x.args.includes("--version"));
      expect(turns.length).toBeGreaterThan(0);
      for (const turn of turns) expect(turn.cwd).toBe(cwd);
      if (module === "codex" || module!.startsWith("acp/")) {
        const method = module === "codex" ? "thread/start" : "session/new";
        const requests = turns.flatMap(x => x.requests.join("").split("\n")).filter(Boolean).map(x => JSON.parse(x));
        const session = requests.find(x => x.method === method);
        expect(session).toBeDefined();
        expect(session.params.cwd).toBe(cwd);
      }
    } finally { recorder.stop(); await instance.dispose(); }
  });
  it("D3-f unknown bot folder throws before any process starts", async () => {
    const instance = await create();
    try {
      launches.length = 0;
      await expect(instance.adapter.sendTurn({ threadId: `marks-missing-${module}`, text: "hello" })).rejects.toThrow(BotFolderUnavailableError);
      expect(launches).toEqual([]);
    } finally { await instance.dispose(); }
  });
  if (module === "claude" || module === "antigravity") {
    it("D3-e helper launch uses the supplied bot folder", async () => {
      const instance = await create();
      const cwd = join(root!, "helper-bot"); mkdirSync(cwd);
      try {
        launches.length = 0;
        await instance.generateText!("hello", "fixture-bot", cwd);
        const turns = launches.filter(x => !x.args.includes("--version"));
        expect(turns.length).toBeGreaterThan(0);
        for (const turn of turns) expect(turn.cwd).toBe(cwd);
      } finally { await instance.dispose(); }
    });
    it("D3-f helper refuses missing folder without launching", async () => {
      const instance = await create();
      try {
        launches.length = 0;
        await expect(instance.generateText!("hello", "fixture-bot")).rejects.toThrow(BotFolderUnavailableError);
        expect(launches).toEqual([]);
      } finally { await instance.dispose(); }
    });
  }
});

it("D3-b resolver has the specified typed user text", () => {
  expect(() => botFolderOrThrow({})).toThrow(BotFolderUnavailableError);
  expect(() => botFolderOrThrow({})).toThrow("couldn't find this bot's folder");
});
it("D3-c invalid explicit folder is never replaced", () => {
  expect(() => botFolderOrThrow({ cwd: "relative" })).toThrow(BotFolderUnavailableError);
});
it("D3-g relay preserves the validated command folder for the approval reader", () => {
  root = mkdtempSync(join(tmpdir(), "marks-relay-"));
  const cwd = join(root, "child"); mkdirSync(cwd);
  const ask = antigravityRelayAsk({ tool_use_id: "marks", tool_name: "run_command", tool_input: { CommandLine: "touch out", Cwd: cwd } }, root);
  expect(commandCwdFromToolInput(ask.toolCall.input)).toBe(cwd);
});

import { commandFolderContext, commandFolderRefusal } from "./command-folder.ts";
import { spawnCli, launcherFrame, awaitCliTreeStopped } from "./procs.ts";
import { bwrapOptions, planHostPower } from "./host-power.ts";
import { runHeadlessCli, headlessArgv, headlessTextOnlyTurn, claudeTextOnlyTurn } from "./drivers/headless-text-only.ts";
import { createTempRoot } from "./memory/pip-transport.ts";
import { openChatMcpServers } from "./drivers/chat-mcp-client.ts";
import { remoteLaunchDispositions } from "./testing/launch-dispositions.ts";

it("D3-a omitted command cwd uses the validated bot folder", () => {
  root = mkdtempSync(join(tmpdir(), "marks-command-"));
  expect(commandFolderContext({ command: "touch out" }, root)).toEqual({ cwd: root, invalid: false });
  expect(commandFolderRefusal({ command: "touch out" }, root)).toBeNull();
});
it("D3-c and D3-g conflicting, invalid, or lost explicit cwd cannot auto approve", () => {
  root = mkdtempSync(join(tmpdir(), "marks-command-"));
  for (const input of [
    { command: "touch out", cwd: root, workdir: "/other" },
    { command: "touch out", cwd: 42 },
    { command: "touch out", cwdExplicit: true },
  ]) {
    expect(commandFolderContext(input, root)).toEqual({ invalid: true });
    expect(commandFolderRefusal(input, root)).toMatchObject({ approve: null, rule: "D3-command-cwd" });
  }
});
it("D3-e procs and host-power carry the inner bot cwd", async () => {
  root = mkdtempSync(join(tmpdir(), "marks-wrapper-"));
  const cli = resolve("server/testing/fake-pi-cli.ts"); chmodSync(cli, 0o755);
  const child = spawnCli(cli, ["--version"], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  await awaitCliTreeStopped(child);
  expect(launches.at(-1)?.cwd).toBe(root);
  const frame = launcherFrame({}, root).toString();
  expect(JSON.parse(frame.slice(frame.indexOf("\n") + 1)).cwd).toBe(root);
  const options = bwrapOptions({ euid: 1000, egid: 1000, helperDir: root, stub: join(root, "bus"), busPaths: [], bpfFd: 3, cwd: root, env: {} });
  expect(options[options.indexOf("--chdir") + 1]).toBe(root);
});
it("D3-f procs and host-power refuse omitted inner cwd before spawn", () => {
  expect(() => spawnCli("unused", [], {})).toThrow(BotFolderUnavailableError);
  expect(() => launcherFrame({}, undefined)).toThrow(BotFolderUnavailableError);
  expect(() => planHostPower("unused", [], {}, undefined)).toThrow(BotFolderUnavailableError);
});
it("D3-e headless text-only reflection runs in its throwaway temp.work (MurageMain R1), the bot folder is only the existence check", async () => {
  root = mkdtempSync(join(tmpdir(), "marks-headless-"));
  const cwd = join(root, "bot"); mkdirSync(cwd);
  const temp = createTempRoot(root, "marks", 1, "hello");
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const args = headlessArgv(temp, "fixture", schema);
  expect(args[args.indexOf("--cwd") + 1]).toBe(temp.work);
  await runHeadlessCli({ cli: process.execPath, args: [resolve("server/testing/pip-stub-cli.mjs"), "--stub=ok", ...args], cwd: temp.work, env: { ...process.env, HOME: temp.root } as Record<string, string>, temp, tmpBase: root, engine: "fuigo", outputSchema: schema, signal: new AbortController().signal, context: { runId: "marks", family: "lived", attempt: 1 } });
  expect(launches.at(-1)?.cwd).toBe(temp.work);
});
it("D3-f headless entry points refuse unknown folder before any process", async () => {
  // Missing-folder validation precedes schema, login, and gate preparation.
  expect(() => runHeadlessCli({} as never)).toThrow(BotFolderUnavailableError);
  await expect(headlessTextOnlyTurn({} as never, {} as never)).rejects.toThrow(BotFolderUnavailableError);
  await expect(claudeTextOnlyTurn({} as never, {} as never)).rejects.toThrow(BotFolderUnavailableError);
  expect(launches).toEqual([]);
});

function mcpFixture(): string {
  root = mkdtempSync(join(tmpdir(), "marks-mcp-"));
  const file = join(root, "mcp.mjs");
  writeFileSync(file, `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', text => { const m = JSON.parse(text); if (m.id === undefined) return;
const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [] };
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); });`);
  return file;
}
it("D3-e chat MCP child runs in the bot folder", async () => {
  const file = mcpFixture();
  const opened = await openChatMcpServers({ fixture: { command: process.execPath, args: [file], env: {} } }, { cwd: root });
  try { expect(opened.failed).toEqual([]); expect(launches.at(-1)?.cwd).toBe(root); }
  finally { for (const session of opened.sessions) session.close(); await Promise.all(opened.sessions.map(session => session.teardown.wait({ closeMs: 3000, maxMs: 8000 }))); }
});
it("D3-f chat MCP refuses a missing folder before spawning", async () => {
  await expect(openChatMcpServers({ fixture: { command: "unused", args: [] } })).rejects.toThrow(BotFolderUnavailableError);
  expect(launches).toEqual([]);
});
it("boxagent is NOT-ENGINE and remote relative commands never enter approval context", async () => {
  const { BoxAgentDriver } = await import("./drivers/boxagent.ts");
  const { _resetCloudComputerTurns, _cloudComputerTiming, _cloudComputerIdle } = await import("./cloud-computer-turns.ts");
  ensureDirs(); _resetCloudComputerTurns(); _cloudComputerTiming({ pauseMs: 0 });
  let posted = false;
  const previous = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, options) => {
    const path = String(url);
    let body: unknown = {};
    if (options?.method === "POST" && path.endsWith("/prompt")) { posted = true; body = { promptRun: { id: "marks-prompt" } }; }
    else if (path.includes("/events")) body = { events: posted ? [{ id: "marks-command", promptId: "marks-prompt", type: "tool_call", tool: "shell", input: { command: "touch out" } }] : [] };
    else if (path.includes("/prompts/")) body = { promptRun: { status: "finished" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const instance = await BoxAgentDriver.create({ instanceId: "marks-box", displayName: "fixture", enabled: true, environment: { BOX_TOKEN: "fixture" }, config: { pollMs: 0 } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "marks-box", text: "hello", integrations: { computer: { boxId: "marks-box", token: "fixture" } } });
    await recorder.until(e => e.type === "turn.completed");
    expect(recorder.events.some(e => e.type === "item.started" && e.itemType === "tool")).toBe(true);
    expect(recorder.events.some(e => e.type === "request.opened")).toBe(false);
    expect(remoteLaunchDispositions[0]).toMatchObject({ file: "server/drivers/boxagent.ts", kind: "NOT-ENGINE" });
  } finally { recorder.stop(); await instance.dispose(); await _cloudComputerIdle(); globalThis.fetch = previous; }
});

import { readCodexAppServerModelCatalog } from "./drivers/codex-catalog.ts";
import { fetchHermesAcpModels } from "./drivers/acp/hermes.ts";
import { probeCursorSessionModels } from "./drivers/acp/cursor.ts";
import { fetchPiModels, PiDriver } from "./drivers/pi.ts";
import { probeMcpServer } from "./mcp-probe.ts";
import { homedir } from "node:os";

for (const family of ["codex-catalog", "hermes", "cursor", "pi version", "mcp-probe"] as const) {
  it(`PROBE ${family} uses an explicit neutral folder, never home`, async () => {
    ensureDirs();
    root = mkdtempSync(join(tmpdir(), "marks-probe-"));
    const cli = resolve("server/testing", family === "codex-catalog" ? "fake-codex-app-server.ts" : family === "pi version" ? "fake-pi-cli.ts" : "fake-acp-cli.ts");
    chmodSync(cli, 0o755);
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    launches.length = 0;
    if (family === "codex-catalog") await readCodexAppServerModelCatalog(cli, env);
    else if (family === "hermes") await fetchHermesAcpModels(cli, env, "default");
    else if (family === "cursor") await probeCursorSessionModels(cli, env);
    else if (family === "pi version") {
      const instance = await PiDriver.create({ instanceId: "marks-pi-probe", displayName: "fixture", enabled: true, environment: env, config: PiDriver.decodeConfig({ cli }) });
      try { await instance.snapshot(); await fetchPiModels(cli, env); } finally { await instance.dispose(); }
    } else {
      rmSync(root, { recursive: true, force: true });
      const file = mcpFixture();
      await probeMcpServer({ command: process.execPath, args: [file], env: {}, enabled: true });
    }
    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) {
      expect(typeof launch.cwd).toBe("string");
      expect(launch.cwd).not.toBe(homedir());
      expect(launch.cwd).not.toBe(root);
      for (const line of launch.requests.join("").split("\n").filter(Boolean)) {
        const request = JSON.parse(line);
        if (request.method === "session/new") expect(request.params.cwd).toBe(launch.cwd);
      }
    }
  });
}

vi.mock("./fuigo-probe-isolation.ts", () => ({
  createFuigoIsolation: async (cli: string) => ({ command: cli, prefix: [], cleanup: async () => {} }),
}));
it("PROBE fuigo-native-update carries a neutral cwd through spawn and ACP session", async () => {
  const { probeNativeFuigo } = await import("./fuigo-native-update.ts");
  root = mkdtempSync(join(tmpdir(), "marks-fuigo-probe-"));
  const cli = join(root, "fuigo");
  writeFileSync(cli, `#!/bin/sh
if test "$1" = "--version"; then printf 'fuigo 1.0.9 (ba7ad5430c61)\\n'; exit 0; fi
while IFS= read -r line; do
case "$line" in
*initialize*) printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"fuigo.api_key"}]}}\\n';;
*authenticate*) printf '{"jsonrpc":"2.0","id":2,"result":{}}\\n';;
*session/new*) printf '{"jsonrpc":"2.0","id":3,"result":{"sessionId":"fixture"}}\\n';;
esac
done
`);
  chmodSync(cli, 0o700);
  await probeNativeFuigo(cli, "1.0.9", root);
  expect(launches.length).toBeGreaterThan(0);
  const launch = launches.at(-1)!;
  expect(launch.cwd).not.toBe(homedir());
  expect(String(launch.cwd)).toMatch(/[/\\]work$/);
  const session = launch.requests.join("").split("\n").filter(Boolean).map(x => JSON.parse(x)).find(x => x.method === "session/new");
  expect(session.params.cwd).toBe(launch.cwd);
});

async function chatRuntime() {
  const { OpenAICompatDriver } = await import("./drivers/openai-compat.ts");
  return OpenAICompatDriver.create({ instanceId: "marks-chat", displayName: "fixture", enabled: true, environment: {}, config: OpenAICompatDriver.decodeConfig({ url: "https://fixture.invalid/v1", key: "fixture", model: "fixture" }) });
}
it("D3-e openai-chat propagates the bot folder to its MCP child", async () => {
  ensureDirs();
  const file = mcpFixture();
  const instance = await chatRuntime();
  const recorder = recordEvents(instance.adapter);
  const previous = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    await instance.adapter.sendTurn({ threadId: "marks-chat", text: "hello", cwd: root, integrations: { custom: { fixture: { command: process.execPath, args: [file], env: {} } } } });
    await recorder.until(e => e.type === "turn.completed");
    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) expect(launch.cwd).toBe(root);
  } finally { recorder.stop(); await instance.dispose(); globalThis.fetch = previous; }
});
it("D3-f openai-chat refuses unknown folder before any process or request", async () => {
  const instance = await chatRuntime();
  const previous = globalThis.fetch;
  const fetch = vi.fn(); globalThis.fetch = fetch;
  try {
    await expect(instance.adapter.sendTurn({ threadId: "marks-chat-missing", text: "hello" })).rejects.toThrow(BotFolderUnavailableError);
    expect(launches).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  } finally { await instance.dispose(); globalThis.fetch = previous; }
});

const wrapped = vi.hoisted(() => ({ script: "", filter: "", cwd: "" }));
vi.mock("./host-power.ts", async original => {
  const actual = await original<typeof import("./host-power.ts")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    hostPowerTestUnwrapped: () => wrapped.script ? false : actual.hostPowerTestUnwrapped(),
    hostPowerPlatform: () => wrapped.script ? "linux" : actual.hostPowerPlatform(),
    openPowerFilter: (...args: Parameters<typeof actual.openPowerFilter>) => wrapped.script ? fs.openSync(wrapped.filter, "r") : actual.openPowerFilter(...args),
    planHostPower: (...args: Parameters<typeof actual.planHostPower>) => {
      if (!wrapped.script) return actual.planHostPower(...args);
      wrapped.cwd = args[3] ?? "";
      return { kind: "bwrap", command: process.execPath, args: [wrapped.script], argsData: Buffer.from("fixture\0"), bpf: wrapped.filter, bpfSha256: "fixture", env: process.env };
    },
  };
});
it("D3-e wrapped process spawn receives the bot cwd and forwards it to the inner plan", async () => {
  root = mkdtempSync(join(tmpdir(), "marks-wrapped-"));
  wrapped.filter = join(root, "filter"); writeFileSync(wrapped.filter, "fixture");
  wrapped.script = join(root, "wrapper.mjs");
  writeFileSync(wrapped.script, `import { readFileSync, writeSync } from 'node:fs';
readFileSync(4); process.stdout.write(process.cwd()); writeSync(5, '{"exit-code":0}\\n');`);
  try {
    const child = spawnCli(process.execPath, ["unused"], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    let cwd = ""; child.stdout.on("data", data => { cwd += String(data); }); child.stderr.resume(); child.stdin.end();
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    expect(cwd).toBe(root);
    expect(wrapped.cwd).toBe(root);
  } finally { wrapped.script = ""; wrapped.filter = ""; wrapped.cwd = ""; }
});

import { hiddenTurnRunner } from "./drivers/cli-memory-learning.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "./contracts.ts";
function learningFixture() {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const sendTurn = vi.fn(async (turn: SendTurnInput) => {
    const child = spawnCli(process.execPath, ["-e", ""], { cwd: turn.cwd, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(); child.stdout.resume(); child.stderr.resume();
    await awaitCliTreeStopped(child);
    for (const listener of listeners) {
      listener({ threadId: turn.threadId, type: "item.completed", itemType: "assistant_text", text: "ready" } as RuntimeEvent);
      listener({ threadId: turn.threadId, type: "turn.completed", ok: true } as RuntimeEvent);
    }
    return { turnId: "learning" };
  });
  const instance = { adapter: { sendTurn,
    onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    interruptTurn: async () => {}, resetSession: async () => {},
  } } as unknown as ProviderInstance;
  return { run: hiddenTurnRunner(instance), sendTurn };
}
it("D3-e cli-memory-learning passes the bot folder to its hidden turn and child", async () => {
  root = mkdtempSync(join(tmpdir(), "marks-learning-"));
  const fixture = learningFixture();
  expect(await fixture.run("hello", new AbortController().signal, { cwd: root, maxBytes: 4096 })).toBe("ready");
  expect(fixture.sendTurn.mock.calls[0][0].cwd).toBe(root);
  expect(launches.at(-1)?.cwd).toBe(root);
});
it("D3-f cli-memory-learning refuses before a hidden turn or child starts", async () => {
  const fixture = learningFixture();
  await expect(fixture.run("hello", new AbortController().signal, { maxBytes: 4096 })).rejects.toThrow(BotFolderUnavailableError);
  expect(fixture.sendTurn).not.toHaveBeenCalled();
  expect(launches).toEqual([]);
});

import { cdpUrlFromCli } from "./drivers/headless-target-guard.ts";
import { cachedCliVersion, invalidateCliVersions } from "./cli-version-cache.ts";
it("PROBE headless target lookup starts in a neutral folder", async () => {
  root = mkdtempSync(join(tmpdir(), "marks-cdp-"));
  const cli = join(root, "browser.mjs");
  writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdout.write("ws://127.0.0.1:9222\\n");\n');
  chmodSync(cli, 0o755);
  // Use this test process's Node, independent of the shebang's PATH lookup.
  expect(await cdpUrlFromCli({ command: `"${process.execPath}" "${cli}"`, args: [], env: { ...process.env, AGENT_BROWSER_SESSION: "fixture" } } as Parameters<typeof cdpUrlFromCli>[0])).toBe("ws://127.0.0.1:9222");
  expect(launches).toHaveLength(1);
  expect(launches[0].cwd).toBe(probeFolder());
  expect(launches[0].cwd).not.toBe(homedir());
});
import { probeFolder } from "./probe-folder.ts";
it("PROBE cached version lookup hands its injected launcher a neutral folder", async () => {
  invalidateCliVersions();
  const run = vi.fn((_cli: string, _args: string[], options: import("node:child_process").ExecFileOptions, done: (error: Error | null, stdout: string, stderr?: string) => void) => {
    expect(options.cwd).toBe(probeFolder());
    expect(options.cwd).not.toBe(homedir());
    done(null, "fixture 1.0.0", "");
  });
  expect((await cachedCliVersion("fixture", {}, run)).stdout).toBe("fixture 1.0.0");
  expect(run).toHaveBeenCalledTimes(1);
});
