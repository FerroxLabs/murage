import { fixtureCredentialFingerprint } from "../testing/fixture-dump.ts";
import { buildRemoteMount } from "../custom-mcp-mounts.ts";
// Claude driver contract tests, run against the scripted fake CLI in
// server/testing/fake-claude-cli.ts — the driver must normalize the
// stream-json protocol into canonical events, keep argv hygiene (prompt
// over stdin, secrets stripped), and broker permission asks.
//
// These used to be POSIX-only: the fake CLI is a shebang script Windows
// cannot exec, and the broker is a unix socket. Both now go through
// resolveCliSpawn / permissionSocketPath, so they run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { brokerSocketCandidates, ClaudeDriver, claudeCostSnapshot, createPermissionBroker, permissionSocketPath, restoredCostBase, turnCostFromRunningTotal, type ClaudeConfig } from "./claude.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as localInject from "./local-inject.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

/** Thread ids for the four ask-id-collision tests. Each must truncate to a
 * unique 8-char tag so no two tests share a broker socket/pipe name. */
const COLLISION_THREAD_IDS = ["t-dup-1", "t-dup-2", "t-dup-3", "t-dup-4"];

/** Connect to a broker socket and resolve once the connection is live. */
function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let retriesLeft = 20;
    const tryConnect = () => {
      const conn = connect(path);
      const onConnect = () => {
        conn.removeListener("error", onError);
        resolve(conn);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        conn.removeListener("connect", onConnect);
        conn.destroy();
        // A Windows named pipe can briefly disappear while the server creates
        // its next pipe instance for another simultaneous client.
        if (process.platform === "win32" && error.code === "ENOENT" && retriesLeft-- > 0) {
          setTimeout(tryConnect, 25);
          return;
        }
        reject(error);
      };
      conn.once("connect", onConnect);
      conn.once("error", onError);
    };
    tryConnect();
  });
}

/** Returns a function that resolves, in order, with each `\n`-delimited JSON
 * message the broker writes back on `conn` — one call per expected answer. */
function answerQueue(conn: ReturnType<typeof connect>) {
  const waiters: Array<(msg: any) => void> = [];
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      waiters.shift()?.(JSON.parse(line));
    }
  });
  return () => new Promise<any>((resolve) => waiters.push(resolve));
}

describe("ClaudeDriver.decodeConfig", () => {
  it("defaults to the claude binary with acceptEdits", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig(undefined)).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
  });

  it("accepts the three known permission modes", () => {
    for (const permissionMode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(ClaudeDriver.decodeConfig({ permissionMode }).permissionMode).toBe(permissionMode);
    }
  });

  it("books a turn's share of the CLI's running cost total", () => {
    // a process's first turn has no earlier total: its figure is its own
    expect(turnCostFromRunningTotal(1.5822674, null)).toBe(1.5822674);
    // later turns book the growth — the incident's two consecutive totals
    expect(turnCostFromRunningTotal(1.7255570000000002, 1.5822674)).toBe(0.1432896);
    // without the float noise of subtracting two totals
    expect(turnCostFromRunningTotal(0.03, 0.02)).toBe(0.01);
    expect(turnCostFromRunningTotal(0.02, 0.02)).toBe(0);
    expect(turnCostFromRunningTotal(null, 0.02)).toBeNull();
    // a total below the earlier one cannot be the same count: never negative
    expect(turnCostFromRunningTotal(0.004, 0.02)).toBe(0.004);
  });

  it("finds the running cost the CLI restored for a resumed session", () => {
    // Real frames (2.1.282). modelUsage counts [input, cache read, cache
    // write, output] per model for the whole session; usage is the turn's own.
    const opus = (total: number, tokens: [number, number, number, number]) => claudeCostSnapshot(total, {
      "claude-opus-5-5": { inputTokens: tokens[0], cacheReadInputTokens: tokens[1], cacheCreationInputTokens: tokens[2], outputTokens: tokens[3], costUSD: total },
    })!;
    const earlier = [
      opus(1.5822674, [18, 776097, 103347, 30010]),
      opus(1.7255570000000002, [24, 1167845, 107739, 31499]),
      opus(3.2557024000000006, [34, 1682172, 227804, 54835]),
      opus(4.3538464, [36, 1682172, 353781, 59351]),
    ];
    // This resumed launch restored the 3.2557 state, not the later 4.3538 one.
    const resumed = opus(4.212299000000001, [60, 3542515, 254587, 73343]);
    expect(restoredCostBase(earlier, resumed, { input: 26, cacheRead: 1860343, cacheWrite: 26783, output: 18508 })).toBe(3.2557024000000006);
    // A fresh session restored nothing; a side call on another model (a
    // title from Haiku) is in modelUsage but not in the turn's usage.
    const fresh = claudeCostSnapshot(0.20990999999999999, {
      "claude-haiku-4-5-20251001": { inputTokens: 978, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10, costUSD: 0.001028 },
      "claude-sonnet-5": { inputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 52057, outputTokens: 65, costUSD: 0.208882 },
    })!;
    expect(restoredCostBase([], fresh, { input: 2, cacheRead: 0, cacheWrite: 52057, output: 65 })).toBe(0);
    // An interrupted turn's work was restored but never reported: measure
    // from the latest known state inside the new counts, so that work is
    // booked once, with this turn.
    const beforeInterrupt = opus(0.8265352, [20, 559016, 79339, 3997]);
    const afterInterrupt = opus(3.0735268, [86, 4211334, 254837, 9611]);
    expect(restoredCostBase([beforeInterrupt], afterInterrupt, { input: 48, cacheRead: 2873716, cacheWrite: 142479, output: 3805 })).toBe(0.8265352);
    // No known state at all: the whole figure.
    expect(restoredCostBase([], resumed, { input: 26, cacheRead: 1860343, cacheWrite: 26783, output: 18508 })).toBe(0);
    expect(claudeCostSnapshot(null, {})).toBeNull();
  });

  it("matches a resumed turn split over two models by the sum of its growth", () => {
    // States A=2 ($0.01) and A=3 ($0.02); the resume restored the first, and
    // the turn used one input token on each of A and B. Its usage counts both.
    const state = (total: number, models: Record<string, number>) => claudeCostSnapshot(total, Object.fromEntries(
      Object.entries(models).map(([model, input]) => [model, { inputTokens: input, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, costUSD: 0 }]),
    ))!;
    const earlier = [state(0.01, { A: 2 }), state(0.02, { A: 3 })];
    expect(restoredCostBase(earlier, state(0.03, { A: 3, B: 1 }), { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0.01);
  });

  it("measures from the latest known state, not the highest total", () => {
    // A resume that went back to an older state leaves a later state with a
    // lower total (4.3538 then 4.2123 in a real session). With no exact fit,
    // the latest state inside the new counts is the start.
    const state = (total: number, input: number) => claudeCostSnapshot(total, {
      A: { inputTokens: input, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, costUSD: total },
    })!;
    const earlier = [state(0.05, 5), state(0.03, 4)];
    expect(restoredCostBase(earlier, state(0.06, 8), { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0.03);
  });

  it("throws on an invalid permissionMode (registry downgrades this to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ permissionMode: "yolo" })).toThrow(/permissionMode/);
  });

  it("normalizes and deduplicates built-in tool lists", () => {
    expect(
      ClaudeDriver.decodeConfig({
        tools: [" Read ", "WebFetch", "Read"],
        disallowedTools: [" Bash(git *) ", "Bash(git *)"],
      }),
    ).toMatchObject({
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)"],
    });
    expect(ClaudeDriver.decodeConfig({ tools: [] }).tools).toEqual([]);
  });

  it.each([
    ["tools", "Read"],
    ["tools", ["Read", " "]],
    ["disallowedTools", [42]],
  ])("rejects invalid %s configuration", (field, value) => {
    expect(() => ClaudeDriver.decodeConfig({ [field]: value })).toThrow(new RegExp(field));
  });

  it.skipIf(process.platform !== "win32")("names permission pipes per harness process", () => {
    expect(permissionSocketPath("thread-abc")).toMatch(
      new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\murage-perm-${process.pid}-thre[0-9a-f]{4}$`),
    );
  });

  it("keeps threads whose ids share a prefix on distinct sockets", () => {
    // the truncated prefix agrees; only the digest separates them — without
    // it, Windows pipes for these two threads would collide and race
    expect(permissionSocketPath("t-perm-dup-1")).not.toBe(permissionSocketPath("t-perm-dup-2"));
  });

  it("does not advertise or accept local CUA in bypassPermissions mode", async () => {
    const bypass = await ClaudeDriver.create({
      instanceId: "claude-bypass",
      displayName: "Claude Bypass",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    expect(bypass.adapter.capabilities.localComputerMcp).toBe(false);
    await expect(
      bypass.adapter.sendTurn({
        threadId: "t-bypass-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive approval broker/);
    await bypass.dispose();
  });

  it("gives each collision test a distinct broker pipe path", () => {
    const paths = COLLISION_THREAD_IDS.map(permissionSocketPath);
    expect(new Set(paths).size).toBe(COLLISION_THREAD_IDS.length);
  });

  it("keeps the deterministic path as the first broker candidate", () => {
    const candidates = brokerSocketCandidates("t-candidates");
    expect(candidates[0]).toBe(permissionSocketPath("t-candidates"));
    if (process.platform === "win32") {
      // pipes are never unlinkable, so a held name needs fresh fallbacks
      expect(candidates.length).toBeGreaterThan(1);
      expect(new Set(candidates).size).toBe(candidates.length);
    } else {
      // macOS has a small Unix-socket path limit, so a deep HOME needs a
      // short fallback under the OS temp root.
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatch(/murage-perm-[0-9a-f]{16}\.sock$/);
      expect(candidates[1]).not.toBe(candidates[0]);
    }
  });

  // Windows can't listen on filesystem socket paths at all (EACCES), so the
  // unbindable-first-candidate unit runs on POSIX; the fake-CLI e2e below
  // covers the real pipe fallback on Windows CI.
  it.skipIf(process.platform === "win32")(
    "binds the next candidate when the first is unbindable, and asks round-trip on it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "murage-broker-fallback-"));
      const held = join(dir, "held.sock");
      // a directory squats the path the way a hung child holds a pipe:
      // unlink fails, listen fails — the broker must move on, not go dark
      mkdirSync(held);
      const free = join(dir, "free.sock");
      const asks: Array<{ id: string }> = [];
      const broker = await createPermissionBroker({
        socketPaths: [held, free],
        onAsk: (ask) => asks.push(ask),
        onResolve: () => {},
      });
      try {
        expect(broker.socketPath).toBe(free);
        const conn = connect(free);
        await new Promise<void>((resolve, reject) => {
          conn.on("connect", resolve);
          conn.on("error", reject);
        });
        const answered = new Promise<{ behavior: string }>((resolve) => {
          let buf = "";
          conn.on("data", (c) => {
            buf += c;
            const nl = buf.indexOf("\n");
            if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
          });
        });
        conn.write(JSON.stringify({ t: "ask", id: "ask-fb", tool: "Bash", input: { command: "echo hi" } }) + "\n");
        await expect.poll(() => asks.length).toBe(1);
        expect(broker.answer("ask-fb", "allow")).toBe(true);
        expect(await answered).toMatchObject({ behavior: "allow" });
        conn.end();
      } finally {
        broker.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("a project question stays open past its deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-project-question-"));
    const resolved: string[] = [];
    const broker = await createPermissionBroker({ socketPaths: [join(dir, "question.sock")], questionTimeoutMs: 50,
      holdProjectAsks: () => true, onAsk: () => {}, onResolve: ask => resolved.push(ask.source) });
    try {
      const conn = connect(broker.socketPath);
      await new Promise<void>((resolve, reject) => { conn.on("connect", resolve); conn.on("error", reject); });
      conn.write(JSON.stringify({ t: "ask", id: "question", tool: "AskUserQuestion", input: { questions: [{ question: "Which folder?", header: "Folder", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }], multiSelect: false }] } }) + "\n");
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(resolved).toEqual([]);
      expect(broker.answer("question", "deny")).toBe(true);
      conn.end();
    } finally { broker.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")(
    "a held turn's permission ask waits past the deny deadline; an ordinary one is denied",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "murage-broker-hold-"));
      const sock = join(dir, "hold.sock");
      let hold = true;
      const resolved: Array<{ id: string; source: string }> = [];
      const broker = await createPermissionBroker({
        socketPaths: [sock],
        timeoutMs: 50,
        holdPermissionAsks: () => hold,
        onAsk: () => {},
        onResolve: (ask) => resolved.push({ id: ask.id, source: ask.source }),
      });
      try {
        const conn = connect(broker.socketPath);
        await new Promise<void>((resolve, reject) => { conn.on("connect", resolve); conn.on("error", reject); });
        conn.write(JSON.stringify({ t: "ask", id: "held", tool: "Bash", input: { command: "echo hi" } }) + "\n");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(resolved).toEqual([]);
        hold = false;
        conn.write(JSON.stringify({ t: "ask", id: "plain", tool: "Bash", input: { command: "echo hi" } }) + "\n");
        await expect.poll(() => resolved).toEqual([{ id: "plain", source: "timeout" }]);
        expect(broker.answer("held", "allow")).toBe(true);
        expect(resolved).toEqual([{ id: "plain", source: "timeout" }, { id: "held", source: "user" }]);
        conn.end();
      } finally {
        broker.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects instead of returning an occupied path when every candidate is unavailable",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "murage-broker-unavailable-"));
      const heldOne = join(dir, "held-one.sock");
      const heldTwo = join(dir, "held-two.sock");
      mkdirSync(heldOne);
      mkdirSync(heldTwo);
      try {
        await expect(
          createPermissionBroker({
            socketPaths: [heldOne, heldTwo],
            onAsk: () => {},
            onResolve: () => {},
          }),
        ).rejects.toThrow(/could not bind a local socket/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("ClaudeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    mode?: string,
    environment: Record<string, string> = {},
    config: Partial<ClaudeConfig> = {},
  ) => {
    if (mode) process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment,
      enabled: true,
      config: {
        ...config,
        cli: config.cli ?? FAKE_CLI,
        permissionMode: config.permissionMode ?? "acceptEdits",
      },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.FAKE_CLAUDE_DUMP_LOG;
    delete process.env.FAKE_CLAUDE_CHILD_PID;
    delete process.env.FAKE_CLAUDE_TRANSIENTS;
    delete process.env.FAKE_CLAUDE_PARTIAL_FAILS;
    delete process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS;
    delete process.env.FAKE_CLAUDE_FAIL_AFTER;
    delete process.env.FAKE_CLAUDE_SIDE_EFFECTS;
    delete process.env.FAKE_CLAUDE_STATE;
    delete process.env.FAKE_CLAUDE_RETRY_SCALE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.MURAGE_TTS_KEY;
    // setup.ts clears this once per file; the Flux routing tests set it per
    // test, so it must not leak into the catalog assertions that follow.
    delete process.env.FLUX_API_KEY;
    delete process.env.MURAGE_CLAUDE_SESSION_IDLE_MS;
    delete process.env.MURAGE_CLAUDE_SESSION_IDLE_MIN_MS;
    delete process.env.FAKE_CLAUDE_COMMANDS;
    delete process.env.FAKE_CLAUDE_CONTROL_LOG;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("reports exactly one usage total for each of two turns on the same process",async()=>{
    const dump=join(scratch,"usage-process.json");process.env.FAKE_CLAUDE_DUMP=dump;
    await create();const pids=new Set<number>();
    for(let n=0;n<2;n++){const sent=await instance.adapter.sendTurn({threadId:"usage-two",text:"hi"});await recorder.until(e=>e.type==="turn.completed"&&e.turnId===sent.turnId);pids.add(JSON.parse(readFileSync(dump,"utf8")).pid);}
    expect(pids.size).toBe(1);
    const completed=recorder.events.filter(e=>e.type==="turn.completed");expect(completed).toHaveLength(2);
    for(const event of completed)expect(event).toMatchObject({ok:true,usage:{input:12,output:5,cachedInput:2}});
  });

  // Claude Code names its "/" commands on every init and describes them in
  // the answer to the SDK's `initialize` control request (2.1.x). Both halves
  // are read; terminal-bound commands and the ones Murage keeps out are not
  // offered.
  it("reports Claude Code's own commands with their descriptions", async () => {
    process.env.FAKE_CLAUDE_COMMANDS = "1";
    const controlLog = join(scratch, "control.log");
    process.env.FAKE_CLAUDE_CONTROL_LOG = controlLog;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-commands", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(readFileSync(controlLog, "utf8")).toContain('"subtype":"initialize"');
    const reports = recorder.events.filter((e) => e.type === "engine.commands") as Array<Extract<RuntimeEvent, { type: "engine.commands" }>>;
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.at(-1)!.commands).toEqual([
      { name: "compact", description: "Clear conversation history but keep a summary in context", hint: "<optional custom summarization instructions>" },
      { name: "context", description: "Show current context usage" },
      { name: "review", description: "Review a pull request" },
    ]);
  });

  it("sends a command turn as the command alone and shows a local command's answer", async () => {
    process.env.FAKE_CLAUDE_COMMANDS = "1";
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-context", text: "/context", engineCommand: { name: "context", args: "" }, system: "You are Moss." });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(dump, "utf8")).prompt.message.content).toBe("/context");
    expect(recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")).toMatchObject({ text: "FAKE_CONTEXT 12k of 200k tokens used" });
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text
      "item.started", // tool tu-1
      "thread.token-usage.updated",
      "item.completed", // tool tu-1 result
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "claudeAgent")).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 12, output: 5, cachedInput: 2 }); // input + cache_read, cache_read named
    const done = recorder.events.at(-1)!;
    // usage on the settle is the turn total from the result message, so
    // the harness has one figure to bank per turn
    expect(done).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01, usage: { input: 12, output: 5, cachedInput: 2 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("streams partial-message text deltas without re-emitting the whole message", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    const text = deltas.filter((d: any) => d.streamKind === "assistant_text");
    // two streamed chunks, and NO third full-text fallback delta after them
    expect(text.map((d: any) => d.delta)).toEqual(["hello from ", "fake claude"]);
    // subagent narration (parent_tool_use_id) never surfaces
    expect(text.some((d: any) => d.delta.includes("SUBAGENT"))).toBe(false);
    // reasoning streams on its own kind
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "hmm")).toBe(true);
    // the settled message still lands exactly once
    const settled = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("hello from fake claude");
  });

  it.each(["not-logged-in", "not-logged-in-success-result"])("routes signed-out CLI mode %s to setup and one failed auth terminal", async mode => {
    await create(mode);
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "hi" });
    await recorder.until(event => event.type === "turn.completed");
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([
      expect.objectContaining({ message: "Not logged in · Please run /login", setup: true, authRequired: true }),
    ]);
    expect(recorder.events.some((event: any) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.some(event => event.type === "content.delta")).toBe(false);
    expect(recorder.events.filter(event => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ ok: false, stopReason: "auth_required" }),
    ]);
  });

  // Upstream #1840 (0.1.61 triage row 2): a model newer than the installed
  // Claude Code is a setup problem the owner fixes by updating, not a reply.
  it("settles an outdated CLI as update_required without emitting an assistant reply", async () => {
    const message = "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update'.";
    await create("api-error", { FAKE_CLAUDE_API_ERROR: message });
    await instance.adapter.sendTurn({ threadId: "t-update", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message, setup: true, claudeUpdate: true }));
    expect(recorder.events.some((event: any) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "update_required" });
  });

  it("keeps update_required when the CLI exits after the refusal with no result (audit round 1, Kimi 2)", async () => {
    const message = "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required.";
    await create("api-error-exit", { FAKE_CLAUDE_API_ERROR: message });
    await instance.adapter.sendTurn({ threadId: "t-update-exit", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([
      expect.objectContaining({ message, setup: true, claudeUpdate: true }),
    ]);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "update_required" });
  });

  it("retires an outdated child before retry while a healthy pooled session stays", async () => {
    await create(undefined, { FAKE_CLAUDE_API_ERROR: "Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required." });
    const healthyDump = join(scratch, "healthy-session.json");
    process.env.FAKE_CLAUDE_DUMP = healthyDump;
    const healthy = await instance.adapter.sendTurn({ threadId: "t-update-healthy", text: "keep this session" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === healthy.turnId);
    const healthyPid = JSON.parse(readFileSync(healthyDump, "utf8")).pid;

    process.env.FAKE_CLAUDE_MODE = "api-error";
    const outdatedDump = join(scratch, "outdated-session.json");
    process.env.FAKE_CLAUDE_DUMP = outdatedDump;
    const resumeCursor = "fixture-update-session";
    const outdated = await instance.adapter.sendTurn({ threadId: "t-update-retry", text: "try the model", resumeCursor });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === outdated.turnId))
      .resolves.toMatchObject({ ok: false, stopReason: "update_required" });
    const outdatedPid = JSON.parse(readFileSync(outdatedDump, "utf8")).pid;

    // Only a new child sees the updated runtime; a pooled one keeps the code
    // it loaded, as a real CLI does after `claude update` replaces the file.
    process.env.FAKE_CLAUDE_MODE = "happy";
    const retryDump = join(scratch, "updated-session.json");
    process.env.FAKE_CLAUDE_DUMP = retryDump;
    const retry = await instance.adapter.sendTurn({ threadId: "t-update-retry", text: "retry explicitly", resumeCursor });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === retry.turnId))
      .resolves.toMatchObject({ ok: true });
    const replacement = JSON.parse(readFileSync(retryDump, "utf8"));
    expect(replacement.pid).not.toBe(outdatedPid);
    expect(replacement.argv).toContain("--resume");

    const continued = await instance.adapter.sendTurn({ threadId: "t-update-healthy", text: "continue normally" });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === continued.turnId))
      .resolves.toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(healthyDump, "utf8")).pid).toBe(healthyPid);
  });

  it.each(["anthropic", "flux"] as const)("routes a selected %s provider authentication failure to its connection, never native Claude login", async preset => {
    await create("not-logged-in");
    await instance.adapter.sendTurn({ threadId: "t-provider-auth", text: "hi", model: "claude-fixture",
      providerRoute: { connectionId: "fixture-provider", revision: "fixture-revision", preset, protocol: "anthropic", baseUrl: preset === "flux" ? "https://fluxrouter.ai/api/v1" : "https://api.anthropic.com", apiKey: "fixture-only-not-real", model: "claude-fixture" } });
    await recorder.until(event => event.type === "turn.completed");
    const failure = recorder.events.find(event => event.type === "runtime.error");
    expect(failure).toMatchObject({ setup: false, message: expect.stringContaining("selected model provider") });
    expect(failure).not.toHaveProperty("authRequired");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "auth_required" });
  });

  it("keeps unflagged assistant text about login as a normal reply", async () => {
    const text = "You are not logged in to npm; run npm login.";
    await create("happy", { FAKE_CLAUDE_REPLIES: JSON.stringify([text]) });
    await instance.adapter.sendTurn({ threadId: "t-login-text", text: "explain sign-in" });
    await recorder.until(event => event.type === "turn.completed");
    expect(recorder.events.some(event => event.type === "runtime.error")).toBe(false);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text }));
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  // Before 0.1.55 the picture never reached Claude: `content` was always the
  // bare prompt string and the model was left to open an <attached-image
  // path> tag with its read tool. The CLI's stream-json stdin takes an array
  // of content blocks on this exact path.
  it("puts an attached image into the stream-json prompt as a base64 content block", async () => {
    await create();
    const dump = join(scratch, "dump-image.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";

    await instance.adapter.sendTurn({ threadId: "t-image", text: "what is this", images: [{ mimeType: "image/png", data }] });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
        ],
      },
    });
    expect(instance.adapter.capabilities.imagesInline).toBe(true);
  });

  it("keeps the prompt a bare string when the turn carries no image", async () => {
    await create();
    const dump = join(scratch, "dump-no-image.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-image", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).prompt.message.content).toBe("hi");
  });

  it("keeps user and system prompts off argv and strips identity env vars", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.MURAGE_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "the secret prompt", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain("the secret prompt");
    expect(JSON.stringify(seen.argv)).not.toContain("You are Testy.");
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "the secret prompt" } });
    expect(seen.argv).toContain("--append-system-prompt-file");
    expect(seen.systemPrompt).toBe("You are Testy.");
    expect(existsSync(seen.argv[seen.argv.indexOf("--append-system-prompt-file") + 1])).toBe(false);
    expect(seen.argv).toContain("--session-id");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDECODE).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.MURAGE_TTS_KEY).toBeUndefined();
  });

  it("strips ambient routing switches left in the shell by a provider switcher", async () => {
    // cc-switch and friends export these into the user's shell; the desktop
    // shell inherits it and every spawn path spreads `...process.env`. Left
    // alone they redirect the whole turn off the CLI's own login — and
    // ANTHROPIC_AUTH_TOKEN is the same Bearer identity as the API key the
    // driver already deletes, so that guard is worthless without this.
    const ambient = {
      ANTHROPIC_BASE_URL: "https://leftover.example",
      ANTHROPIC_AUTH_TOKEN: "sk-leftover-should-not-route",
      ANTHROPIC_MODEL: "leftover-model",
      OPENAI_BASE_URL: "https://leftover.example/v1",
      OPENAI_MODEL: "leftover-openai-model",
    } as const;
    const saved = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ambient);
    try {
      await create();
      const dump = join(scratch, "dump-routing.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-routing", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      for (const name of Object.keys(ambient)) expect(seen.env[name]).toBeUndefined();
      // and the leftover model must not reach argv either
      expect(JSON.stringify(seen.argv)).not.toContain("leftover-model");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("keeps a deliberate local inject after the ambient routing strip", async () => {
    // The strip runs BEFORE applyClaudeInject, so the harness's own routing
    // still lands. Getting that order wrong breaks every local-host turn.
    const savedBase = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://leftover.example";
    try {
      await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
      const dump = join(scratch, "dump-routing-inject.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-routing-inject", text: "hi", model: "unsloth::local-model" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(fixtureCredentialFingerprint("unsloth-secret"));
      expect(seen.env.ANTHROPIC_MODEL).toBe("local-model");
    } finally {
      if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = savedBase;
    }
  });

  // ---- Flux Router, Anthropic Messages surface -----------------------------
  // The wire target these assertions encode is verified live:
  // `POST https://api.fluxrouter.ai/anthropic/v1/messages` → 200
  // (docs/plans/flux-router-spec.md §1.1), and Claude Code appends
  // `/v1/messages` to ANTHROPIC_BASE_URL — so the base must carry `/anthropic`.
  // Shape only below; never a live credential.
  const FLUX_TEST_KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("routes a flux-* turn at the Flux Anthropic Messages surface", async () => {
    process.env.FLUX_API_KEY = FLUX_TEST_KEY;
    await create();
    const dump = join(scratch, "dump-flux.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-flux", text: "hi", model: "flux-auto" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("https://api.fluxrouter.ai/anthropic");
    // both headers: the gateway accepts x-api-key and Bearer, and setting both
    // is what stops the `delete env.ANTHROPIC_API_KEY` guard half-routing it
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(fixtureCredentialFingerprint(FLUX_TEST_KEY));
    expect(seen.env.ANTHROPIC_API_KEY).toBe(fixtureCredentialFingerprint(FLUX_TEST_KEY));
    expect(seen.env.ANTHROPIC_MODEL).toBe("flux-auto");
    // argv must agree with the env, or the reuse cache can hand this turn to a
    // live natively-routed process (spec §4.1, claude.ts turn-site copy)
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("flux-auto");
    // the raw workspace credential itself never reaches the child: the value
    // arrives only under the ANTHROPIC_* names the CLI reads
    expect(seen.env.FLUX_API_KEY).toBeUndefined();
  });

  it("keeps the Flux route after the ambient routing strip", async () => {
    // strip-then-inject: a provider switcher's leftovers are removed first and
    // Flux is written after, so the leftover never wins and never survives.
    const ambient = {
      ANTHROPIC_BASE_URL: "https://leftover.example",
      ANTHROPIC_AUTH_TOKEN: "sk-leftover-should-not-route",
      ANTHROPIC_MODEL: "leftover-model",
    } as const;
    const saved = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ambient);
    process.env.FLUX_API_KEY = FLUX_TEST_KEY;
    try {
      await create();
      const dump = join(scratch, "dump-flux-ambient.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-flux-ambient", text: "hi", model: "flux-reasoning" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("https://api.fluxrouter.ai/anthropic");
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(fixtureCredentialFingerprint(FLUX_TEST_KEY));
      expect(seen.env.ANTHROPIC_MODEL).toBe("flux-reasoning");
      expect(JSON.stringify(seen.argv)).not.toContain("leftover-model");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("degrades a flux-* turn to the CLI's own login when no key is configured", async () => {
    // A half-written env would 401 and read as a bad Claude login. No key at
    // all must leave the turn exactly as it was before Flux existed.
    delete process.env.FLUX_API_KEY;
    await create();
    const dump = join(scratch, "dump-flux-nokey.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-flux-nokey", text: "hi", model: "flux-auto" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("leaves a native Claude turn untouched while a Flux key is present", async () => {
    // The key alone must not route anything: the model id is the switch.
    process.env.FLUX_API_KEY = FLUX_TEST_KEY;
    await create();
    const dump = join(scratch, "dump-flux-native.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-flux-native", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(Object.values(seen.env).some(value => value === FLUX_TEST_KEY)).toBe(false);
  });

  it("launches with a Windows-sized system prompt without putting it on argv", async () => {
    await create();
    const dump = join(scratch, "dump-long-system.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const system = `room instructions\n${"context-0123456789".repeat(8_000)}`;

    await instance.adapter.sendTurn({ threadId: "t-long-system", text: "review this", system });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.systemPrompt).toBe(system);
    expect(JSON.stringify(seen.argv)).not.toContain("room instructions");
    expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
  });

  it("uses instance credentials when launching an injected local model", async () => {
    await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-local-model",
      text: "hi",
      model: "unsloth::local-model",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("local-model");
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(fixtureCredentialFingerprint("unsloth-secret"));
  });

  it("injects a leftover API id when a local host is serving that model", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes(":8888")) {
        return new Response(JSON.stringify({ data: [{ id: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }] }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
      const dump = join(scratch, "dump-leftover.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({
        threadId: "t-leftover-local",
        text: "hi",
        model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF",
      });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("orcarouter/Qwen3.8-27B-Uncensored-GGUF");
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(fixtureCredentialFingerprint("unsloth-secret"));
      expect(seen.env.ANTHROPIC_API_KEY).toBe(fixtureCredentialFingerprint("unsloth-secret"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("mounts the agents comms proxy as an MCP server and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "hi",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: "tok", MURAGE_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.agents).toMatchObject({
      args: ["/fake/agents-proxy.js"],
      env: { MURAGE_BOT_ID: "b1", MURAGE_CRED_SERVER: "agents" },
    });
    // the token reaches the proxy through the credential file, not env
    expect(seen.mcpConfig.mcpServers.agents.env).not.toHaveProperty("MURAGE_COMMS_TOKEN");
    expect(seen.credFile.content.agents.MURAGE_COMMS_TOKEN).toBe("tok");
    // the config goes in a private file, never on argv, where `ps` would
    // show the comms token to every other user on the machine
    expect(JSON.stringify(seen.argv)).not.toContain("tok");
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
    const blockedNative = seen.argv[seen.argv.indexOf("--disallowedTools") + 1].split(",");
    expect(blockedNative).toContain("ListAgents");
    expect(blockedNative).toContain("SendMessage");
  });

  it("skips custom MCP entries with reserved env names while preserving built-ins and ordinary approval behavior", async () => {
    await create();
    const dump = join(scratch, "custom-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const blocked = Object.fromEntries([
      "MURAGE_COMMS_TOKEN", "murage_harness_url", "MURAGEBOX_TOKEN", "muragebox_url",
      "ELECTRON_RUN_AS_NODE", "electron_run_as_node", "DWEB_URL", "dweb_url",
      "PH_ANDROID_SERIAL", "ph_android_serial",
    ].map((key, index) => [`blocked${index}`, {
      command: "attacker-mcp", args: [], env: { [key]: "attacker-value", CUSTOM_REJECTED_MARKER: "must-not-copy" },
    }]));

    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp",
      text: "hi",
      integrations: {
        custom: {
          ...blocked,
          bearer_request: { command: "attacker-mcp", args: [], env: { MURAGE_COMMS_TOKEN: "" } },
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
        },
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: "tok", MURAGE_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    for (const name of [...Object.keys(blocked), "bearer_request"]) {
      expect(seen.mcpConfig.mcpServers).not.toHaveProperty(name);
    }
    expect(JSON.stringify(seen.mcpConfig)).not.toContain("attacker-mcp");
    expect(seen.mcpConfig.mcpServers.agents.env).toMatchObject({
      MURAGE_HARNESS_URL: "http://127.0.0.1:1",
    });
    expect(seen.mcpConfig.mcpServers.agents.env).not.toHaveProperty("MURAGE_COMMS_TOKEN");
    expect(seen.credFile.content.agents.MURAGE_COMMS_TOKEN).toBe("tok");
    // the server reaches the CLI through the private mcp-config file…
    expect(seen.mcpConfig.mcpServers.notes).toMatchObject({
      command: "npx",
      args: ["-y", "@x/notes-mcp"],
      env: { NOTES_TOKEN: "tok-notes" },
    });
    // …but its tools are NOT pre-allowed: acceptEdits denies unlisted tools,
    // which routes every custom call through the muragebox broker into a card.
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
    expect(allowed).not.toContain("mcp__notes");
    // and its credential value stays out of argv
    expect(JSON.stringify(seen.argv)).not.toContain("tok-notes");
  });

  it("mounts a link server as the proxy, with its name in argv, the harness's environment merged, and no secret anywhere", async () => {
    await create();
    const dump = join(scratch, "remote-mount.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const token = "a1".repeat(24);
    const context = { execPath: process.execPath, proxyPath: "/fake/remote-mcp-proxy.js", harnessUrl: "http://127.0.0.1:1", token: () => token };
    await instance.adapter.sendTurn({
      threadId: "t-remote-mount",
      text: "hi",
      integrations: {
        custom: {
          svc: buildRemoteMount("svc", context, token),
          svc2: buildRemoteMount("svc2", context, token),
          // a forged harness variable in the OWNER's environment is still refused
          forged: { command: "attacker-mcp", args: [], env: { MURAGE_MCP_TOKEN: "forged" } },
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const expected = (name: string) => ({
      command: process.execPath,
      args: ["/fake/remote-mcp-proxy.js", "--server", name],
      env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_CRED_FILE: seen.credFile.path, MURAGE_CRED_SERVER: name },
    });
    expect(seen.credFile.content.svc.MURAGE_MCP_TOKEN).toBe(token);
    expect(seen.credFile.content.svc2.MURAGE_MCP_TOKEN).toBe(token);
    expect(seen.mcpConfig.mcpServers.svc).toEqual(expected("svc"));
    expect(seen.mcpConfig.mcpServers.svc2).toEqual(expected("svc2"));
    expect(seen.mcpConfig.mcpServers.svc).not.toHaveProperty("harnessEnv");
    expect(seen.mcpConfig.mcpServers).not.toHaveProperty("forged");
    expect(seen.mcpConfig.mcpServers.notes.env).toEqual({ NOTES_TOKEN: "tok-notes" });
    // never pre-allowed, and nothing of the turn's token rides argv
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("mcp__svc");
    expect(JSON.stringify(seen.argv)).not.toContain(token);
  });

  it("passes normalized available and denied built-in tool sets to Claude", async () => {
    await create(undefined, {}, {
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)", "Edit"],
    });
    const dump = join(scratch, "tool-scope.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-tool-scope", text: "inspect" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("Read,WebFetch");
    expect(seen.argv[seen.argv.indexOf("--disallowedTools") + 1]).toBe("Bash(git *),Edit");
  });

  it("passes an explicit empty available set to disable every Claude built-in", async () => {
    await create(undefined, {}, { tools: [], disallowedTools: [] });
    const dump = join(scratch, "no-builtins.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-builtins", text: "reply only" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).not.toContain("--disallowedTools");
  });

  it("mounts the dweb proxy from the drivers directory and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-dweb",
      text: "hi",
      integrations: { dweb: { url: "http://127.0.0.1:49737" } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.dweb.args[0]).toMatch(/[\\/]drivers[\\/]dweb-proxy\.(?:ts|js)$/);
    expect(seen.mcpConfig.mcpServers.dweb.env.DWEB_URL).toBe("http://127.0.0.1:49737");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__dweb");
  });

  // the harness gates both the integration and the prompt hint on
  // capabilities.composioMcp, so the flag and the mount must agree — a bot
  // told about tools its driver never mounted burns the turn hunting
  it("mounts the user's connected apps and claims the capability that gates them", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { MURAGE_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.composio).toMatchObject({
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: { MURAGE_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
    });
    // the user's Composio key must not be readable via `ps`
    expect(JSON.stringify(seen.argv)).not.toContain("ak_test");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__composio");
  });

  // the config file holds live credentials, so it must not outlive the turn —
  // including when the CLI dies mid-turn, which is the path that leaks if
  // cleanup is hung off the happy-path result instead of settle()
  it.each([
    ["a completed turn", "happy"],
    ["a crashed turn", "exit-early"],
  ])("deletes the mcp config file after %s", async (_label, mode) => {
    await create(mode);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-cleanup",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { MURAGE_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const configPath = (() => {
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      return seen.argv[seen.argv.indexOf("--mcp-config") + 1] as string;
    })();
    expect(configPath).toMatch(/murage-mcp-/);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("mounts local CUA without pre-allowing its computer namespace", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect the desktop",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.computer).toEqual({
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("mcp__computer");
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("resumes with --resume when a cursor exists and reports that session id", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "sess-123" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "sess-123" });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--resume");
    expect(seen.argv).not.toContain("--session-id");
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  // A Stop is "requested, not observed": interruptTurn returns as soon as
  // the kill is sent, and the real CLI tears down its MCP children before it
  // exits (Windows ends it through an asynchronous taskkill). The next send
  // in that window is not a second turn on a running thread: it waits for
  // the stopped child's close and then runs (WIN1 fix round).
  it("a send that arrives while a stopped turn's child is still closing waits for the close, then runs", async () => {
    await create("hang", { FAKE_CLAUDE_SIGTERM_DELAY_MS: "600" });
    const first = await instance.adapter.sendTurn({ threadId: "t-stop-resend", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-stop-resend");
    // still closing: the child is alive and the thread still reads busy
    expect(instance.adapter.hasSession("t-stop-resend")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    process.env.FAKE_CLAUDE_MODE = "happy";
    const second = await instance.adapter.sendTurn({ threadId: "t-stop-resend", text: "two" });
    expect(second.turnId).not.toBe(first.turnId);
    // The send resolved only after the stopped turn settled, not before:
    // its cancelled completion is already on record, and the second turn's
    // own start comes after it. (Order, not elapsed time: the fake honours
    // the SIGTERM delay on POSIX, while Windows' taskkill /F ends the child
    // at once and only its close is asynchronous.)
    const stoppedAt = recorder.events.findIndex((e) => e.type === "turn.completed");
    expect(recorder.events[stoppedAt]).toMatchObject({ turnId: first.turnId, ok: true, stopReason: "cancelled" });
    const secondStartedAt = recorder.events.findIndex((e) => e.type === "turn.started" && e.turnId === second.turnId);
    expect(secondStartedAt).toBeGreaterThan(stoppedAt);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  }, 20_000);

  it("a user Stop kills the turn and settles it as cancelled, not failed or hung (STOP1)", async () => {
    await create("hang");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    // A requested stop is the same terminal state the ACP and Pi drivers
    // report. It must not surface as a runtime error card with Retry.
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(instance.adapter.hasSession("t-int")).toBe(false);
  });

  it("holds only when the hold-authority marker is on the current prompt line", async () => {
    await create(undefined, { HOME: scratch, USERPROFILE: scratch });

    const recalled = await instance.adapter.sendTurn({
      threadId: "t-recalled-hold-marker",
      text: "Earlier transcript: __fixture_hold_authority__\nPlease summarize the earlier request.",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === recalled.turnId)).toMatchObject({ ok: true });

    const held = await instance.adapter.sendTurn({
      threadId: "t-current-hold-marker",
      text: "Please wait for the owner.\n__fixture_hold_authority__",
    });
    await recorder.until((event) => event.type === "session.started" && event.turnId === held.turnId);
    expect(recorder.events.some((event) => event.type === "turn.completed" && event.turnId === held.turnId)).toBe(false);

    await instance.adapter.interruptTurn("t-current-hold-marker");
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === held.turnId)).toMatchObject({
      ok: true,
      stopReason: "cancelled",
    });
  });

  it("a user Stop on a retained live process settles that turn as cancelled (STOP1)", async () => {
    await create();
    const dump = join(scratch, "retained-stop.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-live-stop", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const dumpBefore = readFileSync(dump, "utf8");
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({
      threadId: "t-live-stop",
      text: "__fixture_hold_authority__ keep working",
      resumeCursor: announced,
    });
    expect(instance.adapter.hasSession("t-live-stop")).toBe(true);
    // the second turn runs on the first turn's process: no fresh launch
    expect(readFileSync(dump, "utf8")).toBe(dumpBefore);

    await instance.adapter.interruptTurn("t-live-stop");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  });

  it("a Stop during the prompt write on a retained process settles as cancelled, not a throw (upstream #1701)", async () => {
    // The fake stops reading stdin after its first prompt, so a prompt larger
    // than the pipe buffer stays mid-write until the process dies.
    await create(undefined, { FAKE_CLAUDE_STEER_GATE: join(scratch, "never-opened.gate") });
    const first = await instance.adapter.sendTurn({ threadId: "t-live-write-stop", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    // turn.started is emitted after Stop is registered and before the prompt
    // write is awaited: stopping here is a Stop that lands mid-write
    const unsubscribe = instance.adapter.onEvent((event) => {
      if (event.type === "turn.started" && event.turnId !== first.turnId) {
        unsubscribe();
        void instance.adapter.interruptTurn("t-live-write-stop");
      }
    });
    const second = await instance.adapter.sendTurn({ threadId: "t-live-write-stop", text: `two ${"x".repeat(2_000_000)}` });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  });

  it("an error result the CLI writes for a stopped turn settles as cancelled, not failed (STOP1)", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-stop-result",
      text: "__fixture_hold_authority__ __fixture_error_result_on_stop__ keep working",
    });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-stop-result");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("a message sent mid-turn is steered into the running turn", async () => {
    await create("slow");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-steer", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(instance.adapter.capabilities.queueing).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "and also this")).resolves.toBe(true);
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const reply = recorder.events.find(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text.startsWith("reply to:"),
    ) as { text: string };
    expect(reply.text).toContain("steered: and also this");
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "late")).resolves.toBe(false);
  });

  it("reuses the live process for the next compatible turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-live", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    const dumpBefore = readFileSync(dump, "utf8");
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-live", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(readFileSync(dump, "utf8")).toBe(dumpBefore);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("books each turn of a retained process at its own cost, not the process's running total", async () => {
    // The CLI's total_cost_usd counts every turn the process has run (the
    // fake reports 0.01, 0.02, 0.03); the harness books each
    // turn.completed cost as that turn's spend.
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const costs: unknown[] = [];
    let launch: string | undefined;
    for (const text of ["one", "two", "three"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-running-total", text });
      costs.push((await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId) as { cost?: unknown }).cost);
      launch ??= readFileSync(dump, "utf8");
      // one process for all three turns: a relaunch would rewrite the dump
      expect(readFileSync(dump, "utf8")).toBe(launch);
    }
    expect(costs).toEqual([0.01, 0.01, 0.01]);
  });

  it.each([false, true])("books a resumed session's first turn at its own cost, not the total the CLI restored (driver restarted: %s)", async (restarted) => {
    // A --resume launch starts from the session's saved running cost: the
    // fake's new process reports 0.02 for a turn that cost 0.01.
    const costState = join(scratch, "cost-state");
    mkdirSync(costState);
    await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
    const threadId = `t-resumed-cost-${restarted}`;
    const first = await instance.adapter.sendTurn({ threadId, text: "one", system: "Before." });
    const firstDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    if (restarted) {
      // an app restart: nothing the driver held in memory survives
      recorder.stop();
      await instance.dispose();
      await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
    }
    // a changed prompt relaunches the CLI, resuming the same session
    const second = await instance.adapter.sendTurn({ threadId, text: "two", system: "After.", resumeCursor: announced });
    const secondDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(join(costState, `${announced}.json`), "utf8")).total).toBe(0.02);
    expect([firstDone, secondDone].map((e) => (e as { cost?: unknown }).cost)).toEqual([0.01, 0.01]);
  });

  // Opus gate 0.1.62-A: the cost history is a convenience inside the data
  // folder. A damaged file is replaced on the next write; one that cannot be
  // written leaves a resumed turn at its whole figure. Neither fails a turn.
  it.each([
    ["corrupt", 0.01],
    ["unwritable", 0.02],
  ] as const)("a %s cost history in the data folder never fails a turn", async (kind, resumedCost) => {
    const file = join(DATA_DIR, "claude-cost-history.json");
    if (kind === "corrupt") writeFileSync(file, "{not json", "utf8");
    else mkdirSync(file, { recursive: true });
    try {
      const costState = join(scratch, `cost-state-${kind}`);
      mkdirSync(costState);
      await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
      const threadId = `t-cost-history-${kind}`;
      const first = await instance.adapter.sendTurn({ threadId, text: "one", system: "Before." });
      const firstDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
      const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
      recorder.stop();
      await instance.dispose();
      await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
      const second = await instance.adapter.sendTurn({ threadId, text: "two", system: "After.", resumeCursor: announced });
      const secondDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
      expect(firstDone).toMatchObject({ ok: true, cost: 0.01 });
      expect(secondDone).toMatchObject({ ok: true, cost: resumedCost });
      if (kind === "corrupt") expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toContain(announced);
    } finally {
      if (kind === "corrupt") rmSync(file, { force: true });
      else rmdirSync(file);
    }
  });

  // Gate 0.1.62-C: the history is keyed by session ids read from a file, so
  // the names every object already has are never accepted as a key, on read
  // or on write.
  it("never keeps a __proto__, constructor or prototype key in the cost history", async () => {
    const file = join(DATA_DIR, "claude-cost-history.json");
    const snap = { total: 0.5, models: { m: [1, 2, 3, 4] } };
    writeFileSync(file, `{"__proto__":[${JSON.stringify(snap)}],"constructor":[${JSON.stringify(snap)}],"prototype":[${JSON.stringify(snap)}],"keep-me":[${JSON.stringify(snap)}]}`, "utf8");
    try {
      const costState = join(scratch, "cost-state-proto");
      mkdirSync(costState);
      await create(undefined, { FAKE_CLAUDE_COST_STATE: costState });
      const turn = await instance.adapter.sendTurn({ threadId: "t-cost-proto", text: "one", system: "Before." });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turn.turnId);
      const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
      const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")));
      expect(keys).toContain("keep-me");
      expect(keys).toContain(announced);
      for (const bad of ["__proto__", "constructor", "prototype"]) expect(keys).not.toContain(bad);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("measures a resumed process from the restored cost even when its first result has none", async () => {
    // An overloaded API answers the first turn after --resume with an error
    // result that carries no total_cost_usd. The next turn on that process
    // must still be measured from what the CLI restored, not booked whole.
    const costState = join(scratch, "cost-state-error");
    mkdirSync(costState);
    const dump = join(scratch, "resumed-error-dump.json");
    await create(undefined, { FAKE_CLAUDE_COST_STATE: costState, FAKE_CLAUDE_RESUMED_API_ERROR: "1", FAKE_CLAUDE_DUMP: dump });
    const threadId = "t-resumed-error-cost";
    const first = await instance.adapter.sendTurn({ threadId, text: "one", system: "Before." });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const failed = await instance.adapter.sendTurn({ threadId, text: "two", system: "After.", resumeCursor: announced });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === failed.turnId)).toMatchObject({ ok: false, cost: null });
    const launch = readFileSync(dump, "utf8");
    const third = await instance.adapter.sendTurn({ threadId, text: "three", system: "After.", resumeCursor: announced });
    const thirdDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
    // the same resumed process, whose total now reads 0.02
    expect(readFileSync(dump, "utf8")).toBe(launch);
    expect(JSON.parse(readFileSync(join(costState, `${announced}.json`), "utf8")).total).toBe(0.02);
    expect(thirdDone).toMatchObject({ ok: true, cost: 0.01 });
  });

  // #1562: a rebuilt conversation (edit, branch switch, cwd or engine
  // change) carries its history in the prompt. Reusing the idle process
  // underneath, or --resume-ing the old cursor, replays that history on top
  // of the abandoned context.
  it.each([false, true])("sessionReset discards the retained idle process, old cursor supplied: %s", async (withCursor) => {
    await create();
    const dump = join(scratch, "session-reset.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-rebuilt", text: "abandoned branch" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const previous = JSON.parse(readFileSync(dump, "utf8"));
    const oldSession = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;

    const second = await instance.adapter.sendTurn({
      threadId: "t-rebuilt", text: "replacement history", sessionReset: true,
      ...(withCursor ? { resumeCursor: oldSession } : {}),
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const replacement = JSON.parse(readFileSync(dump, "utf8"));
    expect(replacement.pid).not.toBe(previous.pid);
    expect(replacement.argv).not.toContain("--resume");
    expect(replacement.argv).not.toContain(oldSession);
    expect(replacement.prompt.message.content).toBe("replacement history");
    const newSession = (recorder.events.filter((e) => e.type === "session.started").at(-1) as { sessionId: string }).sessionId;
    expect(newSession).not.toBe(oldSession);

    // an ordinary follow-up reuses the replacement again
    const third = await instance.adapter.sendTurn({ threadId: "t-rebuilt", text: "continue", resumeCursor: newSession });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(replacement.pid);
  });

  it("resets one idle native session without resuming its history or closing a sibling", async () => {
    await create();
    const dump = join(scratch, "reset-session.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const first = await instance.adapter.sendTurn({ threadId: "t-reset", text: "old private reference" });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
    const firstPid = JSON.parse(readFileSync(dump, "utf8")).pid;
    const sibling = await instance.adapter.sendTurn({ threadId: "t-sibling", text: "independent request" });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === sibling.turnId);
    const siblingPid = JSON.parse(readFileSync(dump, "utf8")).pid;
    expect(siblingPid).not.toBe(firstPid);
    // hasSession reports active turns, so an idle reset must not depend on it.
    expect(instance.adapter.hasSession("t-reset")).toBe(false);
    await instance.adapter.resetSession!("t-reset");
    rmSync(dump);
    const siblingNext = await instance.adapter.sendTurn({ threadId: "t-sibling", text: "continue independently" });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === siblingNext.turnId);
    expect(existsSync(dump)).toBe(false); // retained sibling did not launch again
    const fresh = await instance.adapter.sendTurn({ threadId: "t-reset", text: "filtered fresh request" });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === fresh.turnId);
    const freshDump = JSON.parse(readFileSync(dump, "utf8"));
    expect(freshDump.pid).not.toBe(firstPid);
    expect(freshDump.pid).not.toBe(siblingPid);
    expect(freshDump.argv).not.toContain("--resume");
    expect(freshDump.prompt).toEqual({ type: "user", message: { role: "user", content: "filtered fresh request" } });
    expect(JSON.stringify(freshDump.prompt)).not.toContain("old private reference");
    await expect(instance.adapter.resetSession!("absent-thread")).resolves.toBeUndefined();
  });

  it("mounts trusted memory MCP separately while retaining the custom credential filter", async () => {
    await create();
    const dump = join(scratch, "memory-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const memory = { command: process.execPath, args: ["fixture-memory-proxy"], env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_MEMORY_TOKEN: "fixture-memory-token" } };
    const custom = { command: process.execPath, args: ["user-server"], env: {} };
    const turn = await instance.adapter.sendTurn({ threadId: "t-memory-mcp", text: "recall", integrations: {
      memory, custom: { user: custom, malicious: { ...custom, env: { MURAGE_MEMORY_TOKEN: "forged" } } },
    } });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === turn.turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(instance.adapter.capabilities.memoryMcp).toBe(true);
    expect(seen.mcpConfig.mcpServers["murage-memory"]).toEqual({ ...memory, env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_CRED_FILE: seen.credFile.path, MURAGE_CRED_SERVER: "murage-memory" } });
    expect(seen.credFile.content["murage-memory"].MURAGE_MEMORY_TOKEN).toBe("fixture-memory-token");
    expect(seen.mcpConfig.mcpServers.user).toEqual(custom);
    expect(seen.mcpConfig.mcpServers.malicious).toBeUndefined();
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1].split(",")).toContain("mcp__murage-memory");
    expect(JSON.stringify(seen.argv)).not.toContain("fixture-memory-token");
    await expect(instance.adapter.sendTurn({ threadId: "t-memory-collision", text: "recall", integrations: { memory, custom: { "murage-memory": custom } } })).rejects.toThrow("MEMORY_MCP_NAME_COLLISION");
  });

  it("denies late broker asks between retained turns without opening a zombie card", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-retained-late", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");

    const conn = await connectSocket(permissionSocketPath("t-retained-late"));
    const nextAnswer = answerQueue(conn);
    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const answer = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-between", tool: "Bash", input: { command: "echo late" } }) + "\n");

    await expect(answer).resolves.toMatchObject({
      id: "ask-between",
      behavior: "deny",
      message: "Murage: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-retained-late", "ask-between", { behavior: "allow" }),
    ).resolves.toBe("unavailable");
    conn.end();
  });

  it("keeps submitted-turn authority after a stopped background task result", async () => {
    const gate = join(scratch, "background-finish");
    await create("background-result", { FAKE_CLAUDE_REPLY_GATE: gate });
    const threadId = "t-background-result";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "continue the requested work" });
    await recorder.until(event => event.type === "item.completed" && event.itemType === "assistant_text");
    const conn = await connectSocket(permissionSocketPath(threadId));
    const nextAnswer = answerQueue(conn);
    const unsubscribe = instance.adapter.onEvent(event => {
      if (event.type === "request.opened" && typeof event.requestId === "string") void instance.adapter.respondToRequest(threadId, event.requestId, { behavior: "allow" });
    });
    try {
      for (const tool of ["Bash", "Read", "WebSearch"]) {
        const answer = nextAnswer();
        conn.write(JSON.stringify({ t: "ask", id: `background-${tool}`, tool, input: { fixture: "no actual tool execution" } }) + "\n");
        await expect(answer).resolves.toMatchObject({ behavior: "allow" });
        expect(recorder.events.find(event => event.type === "request.opened" && event.requestId === `background-${tool}`)).toMatchObject({ turnId });
      }
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(0);
      writeFileSync(gate, "finish");
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ turnId, ok: true });
      expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
      const late = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "background-after-finish", tool: "Bash", input: {} }) + "\n");
      await expect(late).resolves.toMatchObject({ behavior: "deny", message: "Murage: the turn ended" });
    } finally { unsubscribe(); conn.destroy(); }
  });

  it("keeps real broker authority across retained turns and rotated process closure", async () => {
    const threadId = "t-multi-authority";
    const dump = join(scratch, "multi-authority.json");
    const finishGates = join(scratch, "finish");
    const exitGates = join(scratch, "exit");
    mkdirSync(finishGates);
    mkdirSync(exitGates);
    await create(undefined, {
      FAKE_CLAUDE_DUMP: dump,
      FAKE_CLAUDE_DUMP_EACH_TURN: "1",
      FAKE_CLAUDE_FINISH_GATE_DIR: finishGates,
      FAKE_CLAUDE_EXIT_GATE_DIR: exitGates,
    });
    // the token rotates every turn and never recycles the process; a changed
    // depth (a non-secret spawn input) does
    const integrations = (token: string, depth = "0") => ({
      agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_COMMS_TOKEN: token, MURAGE_TURN_DEPTH: depth } },
      composio: { command: process.execPath, args: ["fixture-composio-proxy"], env: { MURAGE_CONNECTORS_TOKEN: token } },
    });
    const sockets: Socket[] = [];
    const pids = new Set<number>();
    const open = async (socketPath: string) => {
      const socket = await connectSocket(socketPath);
      sockets.push(socket);
      return { socket, answer: answerQueue(socket) };
    };
    const denied = async (connection: Awaited<ReturnType<typeof open>>, id: string, tool: string) => {
      const openedBefore = recorder.events.filter(event => event.type === "request.opened").length;
      const answer = connection.answer();
      connection.socket.write(JSON.stringify({ t: "ask", id, tool, input: {} }) + "\n");
      await expect(answer).resolves.toMatchObject({ id, behavior: "deny", message: "Murage: the turn ended" });
      expect(recorder.events.filter(event => event.type === "request.opened")).toHaveLength(openedBefore);
      await expect(instance.adapter.respondToRequest(threadId, id, { behavior: "allow" })).resolves.toBe("unavailable");
    };
    const allowed = async (connection: Awaited<ReturnType<typeof open>>, turnId: string, id: string, tool: string) => {
      const answer = connection.answer();
      connection.socket.write(JSON.stringify({ t: "ask", id, tool, input: { diagnostic: "no actual tool execution" } }) + "\n");
      const opened = await recorder.until(event => event.type === "request.opened" && event.requestId === id);
      expect(opened).toMatchObject({ threadId, turnId, tool });
      await expect(instance.adapter.respondToRequest(threadId, id, { behavior: "allow" })).resolves.toBe("allowed-once");
      await expect(answer).resolves.toMatchObject({ id, behavior: "allow" });
      expect(await recorder.until(event => event.type === "request.resolved" && event.requestId === id)).toMatchObject({ turnId });
    };
    try {
      const first = await instance.adapter.sendTurn({ threadId, text: "first happy turn", integrations: integrations("first-fake-capability") });
      expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
      const firstDump = JSON.parse(readFileSync(dump, "utf8"));
      pids.add(firstDump.pid);
      const session = (recorder.events.find(event => event.type === "session.started" && event.turnId === first.turnId) as { sessionId: string }).sessionId;
      const old = await open(firstDump.mcpConfig.mcpServers.muragebox.args[1]);
      for (const tool of ["Bash", "WebSearch"]) await denied(old, `idle-first-${tool}`, tool);

      const second = await instance.adapter.sendTurn({ threadId, text: "__fixture_hold_authority__ second", resumeCursor: session, integrations: integrations("first-fake-capability") });
      await recorder.until(event => event.type === "session.started" && event.turnId === second.turnId);
      expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(firstDump.pid);
      for (const tool of ["Bash", "WebSearch"]) await allowed(old, second.turnId, `second-${tool}`, tool);
      writeFileSync(join(finishGates, String(firstDump.pid)), "finish second");
      expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === second.turnId)).toMatchObject({ ok: true });
      await denied(old, "idle-second", "Bash");

      const third = await instance.adapter.sendTurn({ threadId, text: "__fixture_hold_authority__ third", resumeCursor: session, integrations: integrations("rotated-fake-capability", "1") });
      await recorder.until(event => event.type === "session.started" && event.turnId === third.turnId);
      const thirdDump = JSON.parse(readFileSync(dump, "utf8"));
      pids.add(thirdDump.pid);
      expect(thirdDump.pid).not.toBe(firstDump.pid);
      expect(thirdDump.argv[thirdDump.argv.indexOf("--resume") + 1]).toBe(session);
      expect(thirdDump.credFile.content.agents.MURAGE_COMMS_TOKEN).toBe("rotated-fake-capability");
      expect(thirdDump.credFile.content.composio.MURAGE_CONNECTORS_TOKEN).toBe("rotated-fake-capability");
      expect(JSON.stringify(thirdDump.mcpConfig)).not.toContain("fake-capability");
      expect(JSON.stringify(thirdDump.credFile)).not.toContain("first-fake-capability");
      expect(() => process.kill(firstDump.pid, 0)).not.toThrow();
      const freshPath = thirdDump.mcpConfig.mcpServers.muragebox.args[1];
      const fresh = await open(freshPath);
      for (const tool of ["Bash", "WebSearch"]) {
        await denied(old, `old-during-third-${tool}`, tool);
        await allowed(fresh, third.turnId, `third-before-close-${tool}`, tool);
      }
      writeFileSync(join(exitGates, String(firstDump.pid)), "release old close");
      await expect.poll(() => {
        try { process.kill(firstDump.pid, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
      }).toBe(true);
      // A NEW connection proves old-child cleanup did not unlink the fresh
      // listener; an already-connected socket alone would miss that defect.
      const afterOldClose = await open(freshPath);
      for (const tool of ["Bash", "WebSearch"]) await allowed(afterOldClose, third.turnId, `third-after-close-${tool}`, tool);
      writeFileSync(join(finishGates, String(thirdDump.pid)), "finish third");
      expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === third.turnId)).toMatchObject({ ok: true });
      await denied(old, "old-after-third", "WebSearch");
      await denied(fresh, "fresh-after-third", "Bash");
      expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(3);
    } finally {
      for (const pid of pids) {
        writeFileSync(join(finishGates, String(pid)), "cleanup");
        writeFileSync(join(exitGates, String(pid)), "cleanup");
      }
      for (const socket of sockets) socket.destroy();
      // Dispose while the exit gates still exist: afterEach removes scratch,
      // which must not race the subprocess's EOF/gate observation.
      await instance.dispose();
      for (const pid of pids) {
        await expect.poll(() => {
          try { process.kill(pid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
        }).toBe(true);
      }
    }
  }, 20_000);

  it("rotates the internal capability every turn through the credential file, on one process", async () => {
    await create();
    const dumpPath = join(scratch, "rotated-capability.json");
    const logPath = join(scratch, "rotated-capability.log");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    process.env.FAKE_CLAUDE_DUMP_LOG = logPath;
    const agents = (token: string) => ({
      command: process.execPath, args: ["fixture-agents-proxy"],
      env: { MURAGE_BOT_ID: "fixture-bot", MURAGE_THREAD_ID: "t-rotate", MURAGE_COMMS_TOKEN: token },
    });
    const first = await instance.adapter.sendTurn({ threadId: "t-rotate", text: "one", integrations: { agents: agents("first-capability") } });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    const firstDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const session = (recorder.events.find((event) => event.type === "session.started") as { sessionId: string }).sessionId;
    // no token in the spawn contract at all
    expect(JSON.stringify(firstDump.mcpConfig)).not.toContain("first-capability");
    expect(JSON.stringify(firstDump.argv)).not.toContain("first-capability");
    expect(readFileSync(firstDump.credFile.path, "utf8")).toBe("{}");
    const second = await instance.adapter.sendTurn({ threadId: "t-rotate", text: "two", resumeCursor: session, integrations: { agents: agents("second-capability") } });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].credFile.content.agents.MURAGE_COMMS_TOKEN).toBe("first-capability");
    expect(lines[1].credFile.content.agents.MURAGE_COMMS_TOKEN).toBe("second-capability");
    expect(lines[1].credFile.path).toBe(lines[0].credFile.path);
    expect(readFileSync(lines[1].credFile.path, "utf8")).toBe("{}");
  });

  it("replaces and resumes a live process when its spawn contract changes", async () => {
    await create();
    const dumpPath = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    await instance.adapter.sendTurn({ threadId: "t-switch", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    rmSync(dumpPath);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({
      threadId: "t-switch",
      text: "two",
      model: "claude-other",
      resumeCursor: announced,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain("claude-other");
  });

  it("closes an idle session after the configured window", async () => {
    process.env.MURAGE_CLAUDE_SESSION_IDLE_MIN_MS = "10";
    process.env.MURAGE_CLAUDE_SESSION_IDLE_MS = "50";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-idle", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "idle-dump.json");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-idle", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(join(scratch, "idle-dump.json"), "utf8")).argv).toContain("--resume");
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("simulated crash");
  });

  // U-17: only a launch that died before its prompt was written may be
  // relaunched. The pre-accept fixture never reads stdin, and a prompt far
  // larger than any OS pipe buffer makes the driver's write report refusal.
  const PRE_ACCEPT_PROMPT = "x".repeat(4 * 1024 * 1024);

  it("auto-retries transient pre-accept exits, then completes with exactly one final message", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "2";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-retry", text: PRE_ACCEPT_PROMPT });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    // exactly one settled reply across all three launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
    expect(readFileSync(join(scratch, "launches"), "utf8")).toBe("3");
  }, 20_000);

  // The harness binds a run, its folder writer lease, its internal
  // capability generation and a channel routine's delivery to the id sendTurn
  // returned. A relaunch is the SAME turn continuing (turn.retrying already
  // carries that id), so every event it emits — the second turn.started and
  // the eventual turn.completed — must carry it too; a fresh id would leave
  // the harness waiting on a completion that never arrives (WIN1 fix round).
  // The reset is consumed by the first launch: a pre-accept relaunch must
  // resume the replacement session, not mint yet another one (#1562).
  it("a relaunch after a sessionReset resumes the replacement session", async () => {
    const dump = join(scratch, "reset-retry.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-reset");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    const turn = await instance.adapter.sendTurn({
      threadId: "t-reset-retry", text: PRE_ACCEPT_PROMPT, sessionReset: true, resumeCursor: "old-abandoned-session",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turn.turnId);
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    const sessionIds = recorder.events.filter((e) => e.type === "session.started" && e.turnId === turn.turnId)
      .map((e) => (e as { sessionId: string }).sessionId);
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).not.toBe("old-abandoned-session");
    const retried = JSON.parse(readFileSync(dump, "utf8"));
    expect(retried.argv).toContain("--resume");
    expect(retried.argv[retried.argv.indexOf("--resume") + 1]).toBe(sessionIds[0]);
  }, 20_000);

  it("a relaunched turn keeps the id sendTurn returned through to turn.completed", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-same-id");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-retry-id", text: PRE_ACCEPT_PROMPT });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, turnId });
    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.turnId)).toEqual([turnId]);
    expect(recorder.events.filter((e) => e.type === "turn.started").map((e) => e.turnId)).toEqual([turnId, turnId]);
    expect(recorder.events.every((e) => e.threadId !== "t-retry-id" || e.turnId === turnId)).toBe(true);
    expect(readFileSync(join(scratch, "launches-same-id"), "utf8")).toBe("2");
  }, 20_000);

  it("stops retrying at the attempt cap and settles the turn as failed", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cap");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: PRE_ACCEPT_PROMPT });

    const done = await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
    // the prompt never reached the CLI on the last launch either
    expect(done).toMatchObject({ stopReason: "stdin_write_failed" });
  }, 20_000);

  it("gives a later turn on the same thread a fresh retry budget", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-fresh-budget");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();

    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: `${PRE_ACCEPT_PROMPT}one` });
    const firstDone = await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: `${PRE_ACCEPT_PROMPT}two` });
    await recorder.until((e) => e.type === "turn.completed" && e.eventId !== firstDone.eventId);

    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1, 2, 1, 2]);
    // Windows starts every launch under a PowerShell Job Object supervisor
  }, process.platform === "win32" ? 120_000 : 20_000);

  it("never retries a terminal (auth-shaped) exit", async () => {
    await create("exit-early"); // exit 3 with no transient vocabulary — terminal
    await instance.adapter.sendTurn({ threadId: "t-terminal", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("never replays a transient exit once the prompt was written (U-17)", async () => {
    // this fixture reads the prompt, then exits with 503-shaped stderr
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-written");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-written", text: "go" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("503");
    expect(readFileSync(join(scratch, "launches-written"), "utf8")).toBe("1");
  }, 20_000);

  it.each(["tool", "text", "reasoning"] as const)(
    "never replays a turn after %s output and a connection reset (A1)",
    async (failAfter) => {
      const launches = join(scratch, `launches-after-${failAfter}`);
      const sideEffects = join(scratch, `side-effects-${failAfter}`);
      process.env.FAKE_CLAUDE_FAIL_AFTER = failAfter;
      process.env.FAKE_CLAUDE_STATE = launches;
      process.env.FAKE_CLAUDE_SIDE_EFFECTS = sideEffects;
      process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
      await create();
      const threadId = `t-after-${failAfter}`;
      await instance.adapter.sendTurn({ threadId, text: "run the sentinel action" });

      const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
      const events = recorder.events.filter((e) => e.threadId === threadId);
      expect(events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
      const error = events.find((e) => e.type === "runtime.error")!;
      expect(error.message).toContain("ECONNRESET");
      // one launch: the CLI was never started a second time for this turn
      expect(readFileSync(launches, "utf8")).toBe("1");
      if (failAfter === "tool") {
        expect(events.some((e) => e.type === "item.started" && e.itemType === "tool")).toBe(true);
        expect(events.some((e) => e.type === "item.completed" && e.itemType === "tool")).toBe(true);
        expect(readFileSync(sideEffects, "utf8").trim().split("\n")).toHaveLength(1);
      } else if (failAfter === "text") {
        // the completed block reset the UI de-dup flag; the boundary did not
        expect(events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toBe(true);
      } else {
        expect(events.some((e) => e.type === "content.delta" && e.streamKind === "reasoning_text")).toBe(true);
      }
    },
    20_000,
  );

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_PARTIAL_FAILS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-partial");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without a zombie relaunch", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cancel");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: PRE_ACCEPT_PROMPT });

    await recorder.until((e) => e.type === "turn.retrying");
    await instance.adapter.interruptTurn("t-cancel-backoff");
    const done = await recorder.until((e) => e.type === "turn.completed");
    // a Stop during the backoff is a user cancellation, not a failed turn (STOP1)
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    // no second launch ever happened: no further retries, no extra replies
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(0);
    expect(readFileSync(join(scratch, "launches-cancel"), "utf8")).toBe("1");
  }, 30_000);

  // U06 (upstream 1198): between two CLI processes of one logical turn the
  // driver resolves the model and binds a broker before spawning. A custom
  // model id routes through the local-model probe; holding that probe once a
  // retry was announced parks the relaunch inside its setup deterministically.
  const holdRelaunchProbe = () => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const probe = vi.spyOn(localInject, "probeLocalInjects").mockImplementation(async () => {
      if (recorder.events.some((e) => e.type === "turn.retrying")) {
        reached();
        await released;
      }
      return [];
    });
    return { probe, reached: reachedPromise, release };
  };

  it("a Stop during the relaunch setup settles the logical turn as cancelled without spawning", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-relaunch-setup");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create("hang");
    const hold = holdRelaunchProbe();
    try {
      const threadId = "t-stop-relaunch-setup";
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: PRE_ACCEPT_PROMPT, model: "custom-slow-model" });
      await recorder.until((e) => e.threadId === threadId && e.type === "turn.retrying");
      // an unrelated thread's turn, started after the failed launch so the
      // fixture's pre-accept quota is already spent
      await instance.adapter.sendTurn({ threadId: "t-unrelated-live", text: "keep working" });
      // init proves that CLI is running (and counted its launch), not just spawned
      await recorder.until((e) => e.threadId === "t-unrelated-live" && e.type === "session.started");
      await hold.reached;
      // the logical turn is still owned while its relaunch sets up
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      await instance.adapter.interruptTurn(threadId);
      await instance.adapter.interruptTurn(threadId);
      hold.release();

      const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed");
      expect(done).toMatchObject({ ok: true, stopReason: "cancelled", turnId });
      const events = recorder.events.filter((e) => e.threadId === threadId);
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
      expect(events.filter((e) => e.type === "runtime.error")).toEqual([]);
      expect(instance.adapter.hasSession(threadId)).toBe(false);
      // one launch for the stopped turn plus the unrelated thread's; the
      // stopped relaunch never reached spawn
      expect(readFileSync(join(scratch, "launches-relaunch-setup"), "utf8")).toBe("2");
      expect(instance.adapter.hasSession("t-unrelated-live")).toBe(true);
      expect(recorder.events.some((e) => e.threadId === "t-unrelated-live" && e.type === "turn.completed")).toBe(false);
    } finally {
      hold.release();
      hold.probe.mockRestore();
    }
  }, 30_000);

  it("a new user turn sent after that Stop waits for the stopped relaunch, then runs fresh", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-relaunch-next");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    const hold = holdRelaunchProbe();
    try {
      const threadId = "t-stop-relaunch-next";
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: PRE_ACCEPT_PROMPT, model: "custom-slow-model" });
      await recorder.until((e) => e.type === "turn.retrying");
      await hold.reached;
      await instance.adapter.interruptTurn(threadId);
      const next = instance.adapter.sendTurn({ threadId, text: "the next request" });
      hold.release();
      const { turnId: nextTurnId } = await next;

      expect(nextTurnId).not.toBe(turnId);
      const stopped = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(stopped).toMatchObject({ ok: true, stopReason: "cancelled" });
      const fresh = await recorder.until((e) => e.type === "turn.completed" && e.turnId === nextTurnId);
      expect(fresh).toMatchObject({ ok: true });
      expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "turn.started").map((e) => e.turnId)).toEqual([turnId, nextTurnId]);
      expect(readFileSync(join(scratch, "launches-relaunch-next"), "utf8")).toBe("2");
    } finally {
      hold.release();
      hold.probe.mockRestore();
    }
  }, 30_000);

  it("keeps the thread busy while a relaunch sets up, then completes that same turn", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-relaunch-busy");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    const hold = holdRelaunchProbe();
    try {
      const threadId = "t-relaunch-busy";
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: PRE_ACCEPT_PROMPT, model: "custom-slow-model" });
      await recorder.until((e) => e.type === "turn.retrying");
      await hold.reached;
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      await expect(instance.adapter.sendTurn({ threadId, text: "a concurrent request" })).rejects.toThrow("a turn is already running");
      hold.release();

      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: true, turnId });
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "turn.started").map((e) => e.turnId)).toEqual([turnId, turnId]);
      expect(readFileSync(join(scratch, "launches-relaunch-busy"), "utf8")).toBe("2");
    } finally {
      hold.release();
      hold.probe.mockRestore();
    }
  }, 30_000);

  it("a Stop after the relaunched process started cancels without a further relaunch", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-relaunch-started");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create("hang");
    const threadId = "t-stop-relaunch-started";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: PRE_ACCEPT_PROMPT });
    await recorder.until((e) => e.type === "turn.retrying");
    // the relaunched CLI is running and took up the prompt: only it emits init
    await recorder.until((e) => e.type === "session.started");
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    await instance.adapter.interruptTurn(threadId);

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled", turnId });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(readFileSync(join(scratch, "launches-relaunch-started"), "utf8")).toBe("2");
  }, 30_000);


  it("skips malformed protocol lines without losing the turn", async () => {
    await create("malformed");
    await instance.adapter.sendTurn({ threadId: "t-noise", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a missing binary surfaces as spawn_error, and snapshot says unavailable", async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "spawn_error" });

    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("carries the FULL tool input of a permission ask, beside the unchanged summary", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-full", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    const conn = connect(permissionSocketPath("t-perm-full"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    const input = { url: "https://api.example.test/items/7", method: "DELETE", headers: { "x-run": "1" } };
    conn.write(JSON.stringify({ t: "ask", id: "ask-full", tool: "mcp__web__fetch", input }) + "\n");
    const opened = await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-full");
    expect(opened).toMatchObject({ summary: "https://api.example.test/items/7" });
    expect(JSON.parse((opened as { toolInput?: string }).toolInput!)).toEqual(input);

    const big = "x".repeat(40_000);
    conn.write(JSON.stringify({ t: "ask", id: "ask-big", tool: "Write", input: { file_path: "/w/a.txt", content: big } }) + "\n");
    const bigOpened = await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-big");
    const text = (bigOpened as { toolInput?: string }).toolInput!;
    expect(text.length).toBeLessThan(17_000);
    // the long value is cut on its own, so every key survives and parses
    expect(JSON.parse(text).file_path).toBe("/w/a.txt");
    expect(JSON.parse(text).content).toMatch(/\[\d+ bytes more\]$/);
    conn.destroy();
    await instance.adapter.interruptTurn("t-perm-full");
  });

  it("brokers a permission ask into request.opened and answers over the socket", async () => {
    await create("hang");
    await instance.adapter.sendTurn({
      threadId: "t-perm-abc",
      text: "go",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((e) => e.type === "session.started");

    // connect as the MCP proxy would and raise an ask — unix socket on
    // POSIX, named pipe on Windows, same one the driver handed the proxy
    const conn = connect(permissionSocketPath("t-perm-abc"));
    const answered = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-1", tool: "Bash", input: { command: "rm -rf scratch" } }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "Bash",
      summary: "rm -rf scratch",
      requestId: "ask-1",
    });
    // a plain CLI tool never carries the desktop-control approval scope,
    // so the UI can offer a remembered grant for it
    expect(opened).toHaveProperty("approvalScope", undefined);

    // the outcome names exactly what was granted: this action, once
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-1", { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await answered).toMatchObject({ behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    expect(resolved).toHaveProperty("approvalScope", undefined);

    // a real desktop-control tool keeps the local-computer scope, which
    // suppresses remembered grants — desktop actions must be approved
    // one at a time
    const answered2 = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(
      JSON.stringify({ t: "ask", id: "ask-2", tool: "mcp__computer__screenshot", input: {} }) + "\n",
    );
    const opened2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.opened");
    expect(opened2).toHaveProperty("approvalScope", "local-computer");
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-2", { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await answered2).toMatchObject({ behavior: "allow" });
    const resolved2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.resolved");
    expect(resolved2).toHaveProperty("approvalScope", "local-computer");

    conn.end();
    await instance.adapter.interruptTurn("t-perm-abc");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("binds a fallback pipe when the thread's broker path is already held", async () => {
    await create("hang");
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const basePath = permissionSocketPath("t-perm-squat");
    // squat the deterministic path the way a hung child from an earlier
    // process does. On POSIX the driver steals the socket file (unlink) and
    // still binds the base; on Windows the name is unstealable and the
    // driver must bind a fallback — either way the ask flow must work.
    const squatter = createNetServer(() => {});
    await new Promise<void>((resolve, reject) => {
      squatter.once("listening", () => resolve());
      squatter.once("error", reject);
      squatter.listen(basePath);
    });
    try {
      await instance.adapter.sendTurn({ threadId: "t-perm-squat", text: "go" });
      await recorder.until((e) => e.type === "session.started");
      await expect.poll(() => existsSync(dump), { timeout: 5_000 }).toBe(true);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const mcpPath = seen.argv[seen.argv.indexOf("--mcp-config") + 1];
      const actual = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.muragebox.args[1];
      if (process.platform === "win32") expect(actual).not.toBe(basePath);
      const conn = connect(actual);
      await new Promise<void>((resolve, reject) => {
        conn.on("connect", resolve);
        conn.on("error", reject);
      });
      const answered = new Promise<{ behavior: string }>((resolve) => {
        let buf = "";
        conn.on("data", (c) => {
          buf += c;
          const nl = buf.indexOf("\n");
          if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
        });
      });
      conn.write(JSON.stringify({ t: "ask", id: "ask-squat", tool: "Bash", input: { command: "echo hi" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-squat");
      await expect(instance.adapter.respondToRequest("t-perm-squat", "ask-squat", { behavior: "allow" })).resolves.toBe("allowed-once");
      expect(await answered).toMatchObject({ behavior: "allow" });
      conn.end();
      await instance.adapter.interruptTurn("t-perm-squat");
      await recorder.until((e) => e.type === "turn.completed");
    } finally {
      squatter.close();
    }
  });

  it("answers to unknown or already-resolved asks resolve `unavailable` — typed, never a throw", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" })).resolves.toBe("unavailable");
    // and a thread with no turn at all is the same answer
    await expect(instance.adapter.respondToRequest("no-such-thread", "x", { behavior: "deny" })).resolves.toBe("unavailable");
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("resolves a pending ask as a system denial when the turn is interrupted", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-stop", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-perm-stop"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-stop", tool: "Bash", input: { command: "sleep 60" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-stop");

    await instance.adapter.interruptTurn("t-perm-stop");
    const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === "ask-stop");
    expect(resolved).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
    conn.end();
  });

  it("denies a colliding ask id on the same connection without orphaning the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[0], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[0]));
    const nextAnswer = answerQueue(conn);

    // two asks with the same id on one connection, second sent before the
    // first is resolved
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-1");
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo two" } }) + "\n");

    // the collision is denied immediately, on the wire, with the duplicate's
    // own id and the fixed denial message — and without a second
    // request.opened ever firing for it
    expect(await nextAnswer()).toMatchObject({
      id: "dup-1",
      behavior: "deny",
      message: "Murage: duplicate ask id, so this request is skipped.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-1")).toHaveLength(1);

    // the original ask is untouched and still resolves normally
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[0], "dup-1", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );
    expect(await nextAnswer()).toMatchObject({ behavior: "allow" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[0]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id from a second connection on the same broker", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[1], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn1 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    conn1.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-2");

    // `pending` is shared across every connection on the broker, so a
    // second connection reusing the same id must collide too
    const conn2 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    const conn2Answer = answerQueue(conn2)();
    conn2.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo two" } }) + "\n");
    expect(await conn2Answer).toMatchObject({
      id: "dup-2",
      behavior: "deny",
      message: "Murage: duplicate ask id, so this request is skipped.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-2")).toHaveLength(1);

    // the original, opened on conn1, still resolves normally
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[1], "dup-2", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn1.end();
    conn2.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[1]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("accepts an ask id reused after the original already resolved — not a collision", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[2], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[2]));

    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo one");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    // the id is free again once its ask resolved — reusing it is not a
    // collision and should open normally (distinct summary proves this is a
    // fresh request.opened, not the first one already seen by the recorder)
    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo two" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo two");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[2]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id for question-kind asks too, without disturbing the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[3], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[3]));
    const nextAnswer = answerQueue(conn);

    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "one?" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-4");
    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "two?" } }) + "\n");

    // same collision guard applies regardless of ask kind
    expect(await nextAnswer()).toMatchObject({
      id: "dup-4",
      behavior: "deny",
      message: "Murage: duplicate ask id, so this request is skipped.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-4")).toHaveLength(1);

    // the original question is untouched and still resolves normally
    await expect(
      instance.adapter.respondToRequest(COLLISION_THREAD_IDS[3], "dup-4", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("answered");
    expect(await nextAnswer()).toMatchObject({ behavior: "answer" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[3]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("drops a late ask on an already-closed broker instead of a dead card (#211)", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    // Same connection stays open across the turn ending — the exact
    // condition that let a still-alive child raise an unanswerable card.
    const conn = connect(permissionSocketPath("t-perm-late"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });

    await instance.adapter.interruptTurn("t-perm-late");
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = new Promise<{ id: string; behavior: string; message?: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-late", tool: "Bash", input: { command: "rm -rf /" } }) + "\n");

    // A dead card is a request.opened with no way to ever answer it — assert
    // the late ask never becomes one, and the connection still gets a
    // definite reply rather than hanging forever.
    expect(await reply).toMatchObject({
      id: "ask-late",
      behavior: "deny",
      message: "Murage: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(instance.adapter.respondToRequest("t-perm-late", "ask-late", { behavior: "allow" })).resolves.toBe(
      "unavailable",
    );

    conn.end();
  });

  it("drops a late question on an already-closed broker with an answer, not a deny (#211)", async () => {
    // systemEndedReply(kind) branches on "question" vs "permission" — cover
    // the question arm too, since the deny arm above doesn't exercise it.
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-question-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-question-late"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });

    await instance.adapter.interruptTurn("t-question-late");
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = new Promise<{ id: string; behavior: string; message?: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(JSON.stringify({ t: "ask", kind: "question", id: "q-late", tool: "ask_user", input: { question: "still there?" } }) + "\n");

    expect(await reply).toMatchObject({
      id: "q-late",
      behavior: "answer",
      message: "Murage: the turn is ending, so wrap up.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-question-late", "q-late", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("unavailable");

    conn.end();
  });

  it("passes effort to the CLI, and omits the flag when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--effort");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("xhigh");
    expect(seen.argv.filter((a: string) => a === "--effort")).toHaveLength(1);
  });

  it("adds no effort flag when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--effort");
  });

  it("strips workspace credentials from generateText helper children", async () => {
    const instanceConfigDir = join(scratch, "instance-claude-config");
    await create(undefined, { CLAUDE_CONFIG_DIR: instanceConfigDir });
    const dump = join(scratch, "generate-text-env.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "MURAGE_TTS_KEY"] as const;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;

    await instance.generateText?.("summarize safely");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toBe("summarize safely");
    expect(seen.argv).not.toContain("summarize safely");
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe(instanceConfigDir);
    for (const name of names) expect(seen.env[name]).toBeUndefined();
  });

  it("runs a proposal without tools, MCP, hooks or session persistence", async () => {
    await create(); const dump=join(scratch,"project-proposal.json"); process.env.FAKE_CLAUDE_DUMP=dump;
    await expect(instance.proposeProject?.("Propose",new AbortController().signal,"chief-model")).resolves.toBe("fake generated text");
    const seen=JSON.parse(readFileSync(dump,"utf8"));
    expect(seen.argv).toEqual(expect.arrayContaining(["--tools","","--strict-mcp-config","--no-session-persistence","--settings",'{"disableAllHooks":true}',"chief-model"]));
    expect(seen.prompt).toBe("Propose"); expect(seen.argv).not.toContain("Propose");
  });

  it("declares safe same-provider permission review", async () => {
    await create();
    await expect(instance.reviewPermission?.("review this request")).resolves.toBe("fake generated text");
  });

  it("stops permission review when its caller gives up", async () => {
    await create();
    const controller = new AbortController();
    controller.abort();
    await expect(instance.reviewPermission?.("review this request", controller.signal)).rejects.toThrow(/aborted/);
  });

  it("declares the effort levels the CLI accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  // ── AskUserQuestion (0.1.52 ASK2) ──────────────────────────────────────
  // The CLI routes its own AskUserQuestion through this permission host, so
  // the whole round trip — card, answer, skip, timeout — lives here.
  const AUQ_INPUT = {
    questions: [
      {
        question: "Which format should the report use?",
        header: "Format",
        options: [
          { label: "Summary", description: "A short overview" },
          { label: "Detailed", description: "Every finding with its evidence" },
        ],
        multiSelect: false,
      },
      {
        question: "Which sections should it include?",
        header: "Sections",
        options: [{ label: "Intro" }, { label: "Findings" }, { label: "Outro" }],
        multiSelect: true,
      },
    ],
  };

  /** Raise an AskUserQuestion on a live turn the way the MCP proxy does. */
  const askUserQuestion = async (threadId: string, askId: string, input: unknown = AUQ_INPUT) => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId, text: "go" });
    await recorder.until((e) => e.type === "session.started");
    const conn = await connectSocket(permissionSocketPath(threadId));
    const nextAnswer = answerQueue(conn);
    conn.write(JSON.stringify({ t: "ask", id: askId, kind: "question", tool: "AskUserQuestion", input }) + "\n");
    return { conn, nextAnswer };
  };

  const endTurn = async (threadId: string, conn: Socket) => {
    conn.end();
    await instance.adapter.interruptTurn(threadId);
    await recorder.until((e) => e.type === "turn.completed");
  };

  it("opens an AskUserQuestion as a question card carrying every question", async () => {
    const { conn } = await askUserQuestion("t-auq-open", "auq-1");
    const opened = await recorder.until((e) => e.type === "request.opened" && e.requestId === "auq-1");
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "AskUserQuestion",
      // the subtitle is the first question, not the raw JSON it used to be
      summary: "Which format should the report use?",
      // the first question's labels keep voice and older clients working
      choices: ["Summary", "Detailed"],
    });
    expect((opened as { questions?: unknown }).questions).toEqual([
      {
        id: "q1",
        question: "Which format should the report use?",
        header: "Format",
        options: [
          { label: "Summary", description: "A short overview" },
          { label: "Detailed", description: "Every finding with its evidence" },
        ],
        multiSelect: false,
        allowOther: true,
      },
      {
        id: "q2",
        question: "Which sections should it include?",
        header: "Sections",
        options: [{ label: "Intro" }, { label: "Findings" }, { label: "Outro" }],
        multiSelect: true,
        allowOther: true,
      },
    ]);
    await endTurn("t-auq-open", conn);
  });

  it("sends the owner's picks back keyed by question text", async () => {
    const { conn, nextAnswer } = await askUserQuestion("t-auq-answer", "auq-2");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "auq-2");
    await expect(
      instance.adapter.respondToRequest("t-auq-answer", "auq-2", {
        behavior: "answer",
        answers: [
          { id: "q1", selected: ["Detailed"] },
          { id: "q2", selected: ["Intro", "Outro"], other: "and an appendix" },
        ],
      }),
    ).resolves.toBe("answered");
    // the exact shape server/permission-proxy.ts puts in updatedInput.answers
    expect(await nextAnswer()).toMatchObject({
      id: "auq-2",
      behavior: "answer",
      answers: {
        "Which format should the report use?": "Detailed",
        "Which sections should it include?": ["Intro", "Outro", "and an appendix"],
      },
    });
    await endTurn("t-auq-answer", conn);
  });

  it("refuses an answer that does not match the questions that were shown", async () => {
    const { conn } = await askUserQuestion("t-auq-bad", "auq-3");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "auq-3");
    // a label nobody offered, and a second pick on a single-select
    for (const answers of [
      [{ id: "q1", selected: ["Exhaustive"] }, { id: "q2", selected: ["Intro"] }],
      [{ id: "q1", selected: ["Summary", "Detailed"] }, { id: "q2", selected: ["Intro"] }],
      [{ id: "q1", selected: ["Summary"] }],
    ]) {
      await expect(instance.adapter.respondToRequest("t-auq-bad", "auq-3", { behavior: "answer", answers })).resolves.toBe(
        "unavailable",
      );
    }
    // the card is still open, so the owner can correct it
    await expect(
      instance.adapter.respondToRequest("t-auq-bad", "auq-3", {
        behavior: "answer",
        answers: [{ id: "q1", selected: ["Summary"] }, { id: "q2", selected: ["Intro"] }],
      }),
    ).resolves.toBe("answered");
    await endTurn("t-auq-bad", conn);
  });

  // Regression: the broker rejected `deny` for a question kind, so closing a
  // question card returned "unavailable" and the engine waited out its whole
  // timeout — fifteen minutes of a bot doing nothing (research §1.2).
  it("delivers a skip immediately instead of leaving the engine waiting", async () => {
    const { conn, nextAnswer } = await askUserQuestion("t-auq-skip", "auq-4");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "auq-4");
    await expect(instance.adapter.respondToRequest("t-auq-skip", "auq-4", { behavior: "deny" })).resolves.toBe("rejected");
    const reply = await nextAnswer();
    expect(reply).toMatchObject({ id: "auq-4", behavior: "deny" });
    expect(reply.message).toMatch(/skipped this question/i);
    expect(reply.message).not.toMatch(/best judgment/i);
    const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === "auq-4");
    expect(resolved).toMatchObject({ behavior: "deny", source: "user" });
    await endTurn("t-auq-skip", conn);
  });

  it("never lets a question be allowed like a permission", async () => {
    const { conn } = await askUserQuestion("t-auq-allow", "auq-5");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "auq-5");
    await expect(instance.adapter.respondToRequest("t-auq-allow", "auq-5", { behavior: "allow" })).resolves.toBe("unavailable");
    await endTurn("t-auq-allow", conn);
  });

  it("answers a malformed question at once instead of opening a card nobody can answer", async () => {
    // duplicate question texts: Claude keys its answers by text, so this can
    // never be answered unambiguously
    const duplicated = { questions: [AUQ_INPUT.questions[0], { ...AUQ_INPUT.questions[0] }] };
    const { conn, nextAnswer } = await askUserQuestion("t-auq-bogus", "auq-6", duplicated);
    const reply = await nextAnswer();
    expect(reply).toMatchObject({ id: "auq-6", behavior: "deny" });
    expect(reply.message).toMatch(/could not show this question/i);
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "auq-6")).toHaveLength(0);
    await endTurn("t-auq-bogus", conn);
  });

  it("tells the engine honestly when the wait runs out, and never guesses an answer", async () => {
    // The shipped wait is 30 minutes; the driver clamps a configured one to
    // one second, which is what makes this assertable without inflating any
    // other timeout.
    await create("hang", {}, { questionTimeoutMs: 1_000 });
    await instance.adapter.sendTurn({ threadId: "t-auq-timeout", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    const conn = await connectSocket(permissionSocketPath("t-auq-timeout"));
    const nextAnswer = answerQueue(conn);
    conn.write(JSON.stringify({ t: "ask", id: "auq-7", kind: "question", tool: "AskUserQuestion", input: AUQ_INPUT }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "auq-7");

    const reply = await nextAnswer();
    // a deny with a note, never an allow with empty answers (which Claude
    // reports as "The user did not answer the questions") and never the old
    // "use your best judgment", which the model read as the owner's words
    expect(reply).toMatchObject({ id: "auq-7", behavior: "deny" });
    expect(reply.message).toMatch(/did not answer within 1 min/i);
    expect(reply.message).not.toMatch(/best judgment/i);
    expect(reply.answers).toBeUndefined();
    const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === "auq-7");
    expect(resolved).toMatchObject({ behavior: "deny", source: "timeout" });
    await endTurn("t-auq-timeout", conn);
  });

  it("keeps a permission ask on its own 15-minute wait, untouched by the question wait", async () => {
    await create("hang", {}, { questionTimeoutMs: 1_000 });
    await instance.adapter.sendTurn({ threadId: "t-auq-mixed", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    const conn = await connectSocket(permissionSocketPath("t-auq-mixed"));
    const nextAnswer = answerQueue(conn);
    conn.write(JSON.stringify({ t: "ask", id: "perm-1", tool: "Bash", input: { command: "echo hi" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "perm-1");
    // well past the 1s question wait: a permission must still be pending
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    expect(recorder.events.filter((e) => e.type === "request.resolved" && e.requestId === "perm-1")).toHaveLength(0);
    await expect(instance.adapter.respondToRequest("t-auq-mixed", "perm-1", { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await nextAnswer()).toMatchObject({ behavior: "allow" });
    await endTurn("t-auq-mixed", conn);
  });

  // Murage's Full access stops before deleting outside its folder, paying
  // and messaging someone new (server/stop-line.ts). A bypassPermissions
  // instance would never ask, so under the stop line it asks for this turn.
  // Gap 4: Ask and Auto turns override bypassPermissions without changing other instance modes.
  it("routeAsks overrides only Claude skip-all permission mode", async () => {
    const modes = ["default", "acceptEdits", "auto", "bypassPermissions"] as const;
    for (const [index, permissionMode] of modes.entries()) {
      if (index > 0) { recorder.stop(); await instance.dispose(); }
      await create(undefined, {}, { permissionMode });
      const dump = join(scratch, `enforce-asks-${permissionMode}.json`);
      process.env.FAKE_CLAUDE_DUMP = dump;
      for (const [turn, enforced] of [false, true, false].entries()) {
        const sent = await instance.adapter.sendTurn({
          threadId: `t-enforce-${permissionMode}-${turn}`, text: "hi",
          ...(enforced ? { routeAsks: true as const } : {}),
        });
        await recorder.until((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
        const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
        const expected = permissionMode === "bypassPermissions" && enforced ? "acceptEdits"
          : permissionMode === "auto" ? "acceptEdits" : permissionMode;
        expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(expected);
        expect(argv.includes("--permission-prompt-tool")).toBe(expected !== "bypassPermissions");
      }
    }
  });

  // S3b: Ask and Auto bots send connected-app calls (send, post, pay) to Murage too.
  it("does not pre-allow connected apps on a turn that routes asks", async () => {
    await create(undefined, {}, { permissionMode: "default" });
    const composio = { command: process.execPath, args: ["-e", ""], env: {} };
    for (const [name, flags] of [["plain", {}], ["routeAsks", { routeAsks: true as const }]] as const) {
      const dump = join(scratch, `dump-composio-${name}.json`);
      process.env.FAKE_CLAUDE_DUMP = dump;
      const sent = await instance.adapter.sendTurn({ threadId: `t-composio-${name}`, text: "hi", ...flags, integrations: { composio } });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1] ?? "";
      if (name === "plain") expect(allowed).toContain("mcp__composio");
      else expect(allowed).not.toContain("mcp__composio");
    }
  });

  it("routes a bypassPermissions instance's asks to Murage under the stop line", async () => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "dump-stop-line.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command: "rm -rf ~/Documents" });
    const composio = { command: process.execPath, args: ["-e", ""], env: {} };
    await instance.adapter.sendTurn({ threadId: "t-stop-line", text: "__fixture_permission_tool__", stopLine: true, integrations: { composio } });
    const opened = await recorder.until((e) => e.type === "request.opened" && e.tool === "Bash");
    expect(opened).toMatchObject({ toolCall: { name: "Bash", input: { command: "rm -rf ~/Documents" } } });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("--permission-mode acceptEdits");
    expect(seen.argv).toContain("--permission-prompt-tool");
    // connected apps are where a bot pays and messages: not pre-allowed
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).not.toContain("mcp__composio");
    await expect(instance.adapter.respondToRequest("t-stop-line", opened.requestId!, { behavior: "deny" })).resolves.toBe("rejected");
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "assistant_text" && /permission: denied/.test(e.text));
    await recorder.until((e) => e.type === "turn.completed");
    delete process.env.FAKE_CLAUDE_PERM_INPUT;
  });

  it("leaves a bypassPermissions instance as it was without the stop line", async () => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "dump-bypass.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-bypass", text: "__fixture_permission_tool__" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "assistant_text" && /ran without asking/.test(e.text));
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("--permission-mode bypassPermissions");
    expect(seen.argv).not.toContain("--permission-prompt-tool");
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
  });

  it("runs a whole AskUserQuestion turn through the real permission host", async () => {
    // The fake CLI spawns the muragebox MCP server from --mcp-config and
    // calls the prompt tool exactly as Claude Code 2.1.268 does, then builds
    // the tool_result string the binary would. This is the end-to-end proof
    // that the proxy's reply is a shape Claude accepts as answers.
    await create("ask-user-question");
    const turn = instance.adapter.sendTurn({ threadId: "t-auq-e2e", text: "ask me" });
    const opened = await recorder.until((e) => e.type === "request.opened" && e.tool === "AskUserQuestion");
    expect(opened).toMatchObject({ requestType: "question" });
    await expect(
      instance.adapter.respondToRequest("t-auq-e2e", opened.requestId!, {
        behavior: "answer",
        answers: [
          { id: "q1", selected: ["Summary"] },
          { id: "q2", selected: ["Intro", "Findings"] },
        ],
      }),
    ).resolves.toBe("answered");
    await turn;
    await recorder.until((e) => e.type === "turn.completed");
    const said = recorder.events.map((event) => JSON.stringify(event)).join("\n");
    // the "all labels" template — Claude treats these as real answers
    expect(said).toContain("Your questions have been answered");
    expect(said).toContain('Which format should the report use?\\"=\\"Summary');
    expect(said).toContain('Which sections should it include?\\"=\\"Intro, Findings');
    expect(said).not.toContain("The user did not answer the questions");
  });
});

// Auth state must come from the CLI, not from probing its credential store:
// on macOS the OAuth tokens live in the login Keychain, so the old
// ~/.claude/.credentials.json check reported signed-in users as signed out
// and disabled the model picker with them (#108).
describe("ClaudeDriver snapshot auth (fake CLI)", () => {
  let instance: ProviderInstance;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-auth-test",
      displayName: "Claude Auth Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.ANTHROPIC_API_KEY;
    await instance?.dispose();
  });

  it("reports authenticated when `auth status` says loggedIn", async () => {
    process.env.FAKE_CLAUDE_AUTH = "in";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("reports signed out when `auth status` says loggedIn:false", async () => {
    process.env.FAKE_CLAUDE_AUTH = "out";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });

  it("fails closed instead of trusting stale credential storage", async () => {
    await create();

    process.env.FAKE_CLAUDE_AUTH = "unsupported";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });

    process.env.FAKE_CLAUDE_AUTH = "malformed";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });

    // The real turn removes inherited API keys, so the auth probe must do the
    // same or setup can report a login the turn cannot use.
    process.env.FAKE_CLAUDE_AUTH = "inherited-api-key";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });
});

// A4: stream-json stdout and the ask socket are framed with a byte bound
// before any parse. An oversized frame fails its own turn (never a replay)
// and ends that retained process; other threads, and the next turn on the
// same thread, run normally.
describe("ClaudeDriver bounded ingress (A4)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-bounded",
      displayName: "Claude Bounded",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };
  /** No event on the thread may carry the dropped frame's content. */
  const noLargePayload = (threadId: string) =>
    recorder.events.filter((e) => e.threadId === threadId).every((e) => JSON.stringify(e).length < 1024 * 1024);

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("fails only the turn whose frame is over the limit, even when a success result follows it", async () => {
    await create();
    const oversized = await instance.adapter.sendTurn({ threadId: "t-oversize", text: "__fixture_oversize_frame__" });
    const ordinary = await instance.adapter.sendTurn({ threadId: "t-ordinary", text: "hi" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === oversized.turnId);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === ordinary.turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error",
      threadId: "t-oversize",
      message: expect.stringMatching(/^Claude sent a protocol message larger than 32 MiB/),
    }));
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed", itemType: "assistant_text", threadId: "t-ordinary", text: "hello from fake claude",
    }));
    expect(noLargePayload("t-oversize")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.completed" && e.turnId === oversized.turnId)).toHaveLength(1);
  });

  it("runs the next turn on the same thread in a fresh process after an overflow", async () => {
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-again", text: "__fixture_oversize_frame__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const second = await instance.adapter.sendTurn({ threadId: "t-again", text: "hi again" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);

    expect(done).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed", itemType: "assistant_text", turnId: second.turnId, text: "hello from fake claude",
    }));
  });

  it("fails an unterminated oversized frame without waiting for a newline", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-open", text: "__fixture_oversize_open_frame__" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(noLargePayload("t-open")).toBe(true);
  });

  it("still carries a valid 14 MiB multibyte frame intact", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-large", text: "__fixture_large_frame__" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: true });
    const reply = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.turnId === turnId);
    expect(Buffer.byteLength((reply as { text: string } | undefined)?.text ?? "")).toBe(14 * 1024 * 1024);
  });

  it("drops an ask connection whose frame is over the limit and keeps serving others", async () => {
    const asks: Array<{ id: string }> = [];
    const broker = await createPermissionBroker({
      socketPaths: brokerSocketCandidates("t-ask-oversize"),
      onAsk: (ask) => asks.push(ask),
      onResolve: () => {},
    });
    try {
      const flooding = await connectSocket(broker.socketPath);
      const closed = new Promise<void>((resolve) => flooding.once("close", () => resolve()));
      flooding.on("error", () => {});
      flooding.write(`{"t":"ask","id":"ask-huge","tool":"Bash","input":{"command":"${"a".repeat(32 * 1024 * 1024 + 1)}`);
      await closed;
      expect(asks).toEqual([]);

      const healthy = await connectSocket(broker.socketPath);
      const answers = answerQueue(healthy);
      healthy.write(JSON.stringify({ t: "ask", id: "ask-small", tool: "Bash", input: { command: "echo hi" } }) + "\n");
      await expect.poll(() => asks.length).toBe(1);
      expect(broker.answer("ask-small", "allow")).toBe(true);
      expect(await answers()).toMatchObject({ id: "ask-small", behavior: "allow" });
      healthy.end();
    } finally {
      broker.close();
    }
  });
});

// An MCP tool's image used to die in the tool_result branch: the driver read
// the block only for its ok flag, so the bytes never reached the
// assistant_image pipeline that retains, attaches and files them.
describe("ClaudeDriver MCP tool-result images", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-tool-images",
      displayName: "Claude Tool Images",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("surfaces a custom MCP tool's image and withholds the computer surface's frame", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-mcp-image", text: "__fixture_mcp_tool_image__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const images = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      threadId: "t-mcp-image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      alt: "mcp__omarchy__screenshot",
    });
    // Both chips still complete: the image is folded in beside them, not
    // instead of them.
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool")).toHaveLength(2);
  });
});

// Probed on macOS, Ubuntu 24.04 and Windows Server 2025 on 2026-09-20, spawned
// with plain pipes and no TERM — the conditions Murage runs a CLI under.
describe("the sign-in command Murage hands people", () => {
  it("signs in, instead of asking Claude Code to answer an empty prompt", () => {
    // Bare `claude` under pipes reads stdin as --print input and exits 1 with
    // "Input must be provided either through stdin or as a prompt argument
    // when using --print". Nobody is signed in and no URL is ever shown.
    expect(ClaudeDriver.install?.signInCommand).toBe("claude auth login");
    expect(ClaudeDriver.install?.signInCommand).not.toBe("claude");
  });
});

// "Murage: the turn ended" (2026-10-02): the CLI ran the bot's subagents as
// background tasks, sent an ordinary `result` while they still ran, and
// Murage settled the turn on it. Every later tool ask from the subagents was
// then denied with the turn-ended reply, and their notifications were ignored.
// The fake CLI replays the frame shapes of that session's native.ndjson.
describe("ClaudeDriver background tasks (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let log: string;

  const create = async (config: Partial<ClaudeConfig> = {}) => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-bg-test",
      displayName: "Claude BG Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits", ...config },
    });
    recorder = recordEvents(instance.adapter);
  };
  /** the harness's own part: answer every card the way Auto mode would */
  const autoApprove = (threadId: string) =>
    instance.adapter.onEvent((e) => {
      if (e.type === "request.opened" && e.threadId === threadId) void instance.adapter.respondToRequest(threadId, e.requestId!, { behavior: "allow" });
    });
  const verdicts = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("verdict:"));

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-bg-"));
    log = join(scratch, "bg.log");
    writeFileSync(log, "");
    process.env.FAKE_CLAUDE_BG_LOG = log;
    process.env.MURAGE_CLAUDE_BACKGROUND_CAP_MIN_MS = "50";
  });
  afterEach(async () => {
    for (const key of ["FAKE_CLAUDE_BG_LOG", "FAKE_CLAUDE_BG_TASKS", "FAKE_CLAUDE_BG_ASKS", "FAKE_CLAUDE_BG_HOLD", "FAKE_CLAUDE_DUMP", "MURAGE_CLAUDE_BACKGROUND_CAP_MIN_MS"]) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("keeps the turn open past the first result and approves the helpers' later asks", async () => {
    await create();
    autoApprove("t-bg-open");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-open", text: "__fixture_background__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(verdicts()).toEqual(["verdict:allowed", "verdict:allowed"]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.some((e) => e.type === "item.completed" && e.itemType === "tool" && e.ok === false)).toBe(false);
  });

  it("delivers the notifications' follow-up reply inside the same turn, before it completes", async () => {
    await create();
    autoApprove("t-bg-notify");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-notify", text: "__fixture_background__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const reply = recorder.events.findIndex((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "All helpers reported.");
    const done = recorder.events.findIndex((e) => e.type === "turn.completed");
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(done);
    expect(recorder.events[reply].turnId).toBe(turnId);
  });

  it("reports each helper as a turn.subtask with a running snapshot", async () => {
    await create();
    autoApprove("t-bg-sub");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-sub", text: "__fixture_background__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const subs = recorder.events.filter((e) => e.type === "turn.subtask") as any[];
    expect(subs.filter((e) => e.subtask.status === "started").map((e) => e.subtask.id)).toEqual(["bgtask1", "bgtask2", "bgtask3"]);
    expect(subs.filter((e) => e.subtask.status === "done").map((e) => e.subtask.id)).toEqual(["bgtask1", "bgtask2", "bgtask3"]);
    expect(subs.every((e) => e.turnId === turnId)).toBe(true);
    const progressed = subs.find((e) => e.subtask.status === "running");
    expect(progressed.subtask).toMatchObject({ id: "bgtask1", toolCount: expect.any(Number) });
    expect(subs[subs.length - 1].subtasks.every((s: any) => s.status === "done" && typeof s.endedAt === "number")).toBe(true);
  });

  it("still asks in Ask mode: a helper's ask waits for the owner instead of being denied", async () => {
    await create();
    process.env.FAKE_CLAUDE_BG_ASKS = "1";
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-ask", text: "__fixture_background__" });
    const opened = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-bg-ask");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(verdicts()).toEqual([]);
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.respondToRequest("t-bg-ask", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(verdicts()).toEqual(["verdict:denied: Denied from Murage"]);
  });

  it("ends cleanly when the owner stops the turn during the wait", async () => {
    await create();
    process.env.FAKE_CLAUDE_BG_HOLD = "1";
    process.env.FAKE_CLAUDE_BG_ASKS = "0";
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-stop", text: "__fixture_background__" });
    await recorder.until((e) => e.type === "turn.subtask" && (e as any).subtask.id === "bgtask3");
    await expect.poll(() => readFileSync(log, "utf8")).toContain("held");
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.interruptTurn("t-bg-stop");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("ends at the cap with a plain note, and stops the helpers", async () => {
    await create({ backgroundTaskCapMs: 300 });
    process.env.FAKE_CLAUDE_BG_HOLD = "1";
    process.env.FAKE_CLAUDE_BG_ASKS = "0";
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-cap", text: "__fixture_background__" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "background_wait_cap" });
    const note = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text" && /still running/.test((e as any).text)) as any;
    expect(note.text).not.toMatch(/—/);
    expect(note.turnId).toBe(turnId);
    const subs = recorder.events.filter((e) => e.type === "turn.subtask") as any[];
    expect(subs[subs.length - 1].subtasks.every((s: any) => s.status === "failed")).toBe(true);
  });

  it("settles on the first result when no background task is open (unchanged)", async () => {
    await create();
    process.env.FAKE_CLAUDE_BG_TASKS = "0";
    process.env.FAKE_CLAUDE_BG_ASKS = "0";
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg-none", text: "__fixture_background__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(recorder.events.some((e) => e.type === "turn.subtask")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("passes only the folders the server granted as --add-dir, and not in Ask mode", async () => {
    const grant = join(scratch, "granted");
    mkdirSync(grant);
    const argvOf = async (config: Partial<ClaudeConfig>, thread: string, addDirs?: string[]) => {
      await create(config);
      const dump = join(scratch, `dump-${thread}.json`);
      process.env.FAKE_CLAUDE_DUMP = dump;
      const { turnId } = await instance.adapter.sendTurn({ threadId: thread, text: "hi", ...(addDirs ? { addDirs } : {}) });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
      recorder.stop();
      await instance.dispose();
      return argv;
    };
    const auto = await argvOf({ permissionMode: "acceptEdits" }, "t-dir-auto", [grant, "relative/dir", "/does/not/exist-xyz"]);
    expect(auto.filter((_a, i) => auto[i - 1] === "--add-dir")).toEqual([realpathSync(grant)]); // the driver canonicalizes (macOS /var is /private/var)
    expect(await argvOf({ permissionMode: "default" }, "t-dir-ask", [grant])).not.toContain("--add-dir");
    expect(await argvOf({ permissionMode: "acceptEdits" }, "t-dir-none")).not.toContain("--add-dir");
  });
});
