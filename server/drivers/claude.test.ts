// Claude driver contract tests, run against the scripted fake CLI in
// server/testing/fake-claude-cli.ts — the driver must normalize the
// stream-json protocol into canonical events, keep argv hygiene (prompt
// over stdin, secrets stripped), and broker permission asks.
//
// These used to be POSIX-only: the fake CLI is a shebang script Windows
// cannot exec, and the broker is a unix socket. Both now go through
// resolveCliSpawn / permissionSocketPath, so they run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { brokerSocketCandidates, ClaudeDriver, createPermissionBroker, permissionSocketPath, type ClaudeConfig } from "./claude.ts";
import { removeTempDir } from "../testing/cleanup.ts";

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
    delete process.env.FAKE_CLAUDE_TRANSIENTS;
    delete process.env.FAKE_CLAUDE_PARTIAL_FAILS;
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
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
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
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
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
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(FLUX_TEST_KEY);
    expect(seen.env.ANTHROPIC_API_KEY).toBe(FLUX_TEST_KEY);
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
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(FLUX_TEST_KEY);
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
    expect(JSON.stringify(seen.env)).not.toContain(FLUX_TEST_KEY);
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
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
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
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
      expect(seen.env.ANTHROPIC_API_KEY).toBe("unsloth-secret");
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
      env: { MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: "tok" },
    });
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
      MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_COMMS_TOKEN: "tok",
    });
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

  it("interrupt kills the turn and settles it as failed, not hung", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
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
    expect(seen.mcpConfig.mcpServers["murage-memory"]).toEqual(memory);
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
    const integrations = (token: string) => ({
      agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_COMMS_TOKEN: token } },
      composio: { command: process.execPath, args: ["fixture-composio-proxy"], env: { MURAGE_CONNECTOR_PROXY_TOKEN: token } },
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

      const third = await instance.adapter.sendTurn({ threadId, text: "__fixture_hold_authority__ third", resumeCursor: session, integrations: integrations("rotated-fake-capability") });
      await recorder.until(event => event.type === "session.started" && event.turnId === third.turnId);
      const thirdDump = JSON.parse(readFileSync(dump, "utf8"));
      pids.add(thirdDump.pid);
      expect(thirdDump.pid).not.toBe(firstDump.pid);
      expect(thirdDump.argv[thirdDump.argv.indexOf("--resume") + 1]).toBe(session);
      expect(thirdDump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN).toBe("rotated-fake-capability");
      expect(thirdDump.mcpConfig.mcpServers.composio.env.MURAGE_CONNECTOR_PROXY_TOKEN).toBe("rotated-fake-capability");
      expect(JSON.stringify(thirdDump.mcpConfig)).not.toContain("first-fake-capability");
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

  it("rotates internal capabilities while resuming the same conversation", async () => {
    await create();
    const dumpPath = join(scratch, "rotated-capability.json");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    const agents = (token: string) => ({
      command: process.execPath, args: ["fixture-agents-proxy"],
      env: { MURAGE_BOT_ID: "fixture-bot", MURAGE_THREAD_ID: "t-rotate", MURAGE_COMMS_TOKEN: token },
    });
    const first = await instance.adapter.sendTurn({ threadId: "t-rotate", text: "one", integrations: { agents: agents("first-capability") } });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    const firstDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const session = (recorder.events.find((event) => event.type === "session.started") as { sessionId: string }).sessionId;
    rmSync(dumpPath);
    const second = await instance.adapter.sendTurn({ threadId: "t-rotate", text: "two", resumeCursor: session, integrations: { agents: agents("second-capability") } });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    const secondDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(secondDump.pid).not.toBe(firstDump.pid);
    expect(secondDump.argv[secondDump.argv.indexOf("--resume") + 1]).toBe(session);
    expect(secondDump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN).toBe("second-capability");
    expect(JSON.stringify(secondDump.mcpConfig)).not.toContain("first-capability");
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

  it("auto-retries transient exits, then completes with exactly one final message", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "2";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-retry", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    // exactly one settled reply across all three launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
  }, 20_000);

  it("stops retrying at the attempt cap and settles the turn as failed", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cap");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("gives a later turn on the same thread a fresh retry budget", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-fresh-budget");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();

    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "one" });
    const firstDone = await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.eventId !== firstDone.eventId);

    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1, 2, 1, 2]);
  }, 20_000);

  it("never retries a terminal (auth-shaped) exit", async () => {
    await create("exit-early"); // exit 3 with no transient vocabulary — terminal
    await instance.adapter.sendTurn({ threadId: "t-terminal", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

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
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cancel");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });

    await recorder.until((e) => e.type === "turn.retrying");
    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    // no second launch ever happened: no further retries, no extra replies
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(0);
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
      message: "Murage: duplicate ask id — skipping this request.",
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
      message: "Murage: duplicate ask id — skipping this request.",
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
      message: "Murage: duplicate ask id — skipping this request.",
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
      message: "Murage: the turn is ending — wrap up.",
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
