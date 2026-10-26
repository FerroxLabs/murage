// One warm `codex app-server` per chat thread: reused while every spawn input
// is unchanged, recycled otherwise, with the per-turn capability token read from
// a per-process 0600 file instead of the long-lived environment.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { bindCredentialPathInArgs, CodexDriver } from "./codex.ts";
import { CRED_FILE_PLACEHOLDER } from "./turn-credentials.ts";
import { cacheEnvFromProcess, markMountIncomplete, markMountReady } from "../connector-cache.ts";
import { warmPool } from "./warm-pool.ts";
import { resetIsolationCache } from "./isolation-cache.ts";

// The process probe, replaceable per test: `probe.override` answers instead of `ps`.
const probe = vi.hoisted(() => ({ override: null as null | ((pid: number) => Promise<Set<number> | null>) }));
vi.mock("./process-tree.ts", async (original) => {
  const actual = await original<typeof import("./process-tree.ts")>();
  return {
    ...actual,
    descendantPids: (pid: number) => (probe.override ? probe.override(pid) : actual.descendantPids(pid)),
    untrackedDescendants: (pid: number, baseline: ReadonlySet<number>) => (probe.override
      ? probe.override(pid).then((now) => (now ? new Set([...now].filter((p) => !baseline.has(p))) : null))
      : actual.untrackedDescendants(pid, baseline)),
  };
});

// Hooks the tests flip: a process that will not stop, a credential file that cannot be emptied,
// and every warm key's parts as the driver built them.
const hooks = vi.hoisted(() => ({ stuck: false, failClear: false, clears: 0, keyParts: [] as unknown[], hang: null as null | Promise<boolean> }));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return {
    ...actual,
    // a process that ignores the kill: nothing is signalled and it never reports stopped
    killCliTree: (...args: Parameters<typeof actual.killCliTree>) => { if (!hooks.stuck) actual.killCliTree(...args); },
    // a close still in flight: the answer comes when the test says so
    awaitCliTreeStopped: (...args: Parameters<typeof actual.awaitCliTreeStopped>) => (hooks.hang ? hooks.hang : hooks.stuck ? Promise.resolve(false) : actual.awaitCliTreeStopped(...args)),
  };
});
vi.mock("./turn-credentials.ts", async (original) => {
  const actual = await original<typeof import("./turn-credentials.ts")>();
  return {
    ...actual,
    createTurnCredentialStore: () => {
      const store = actual.createTurnCredentialStore();
      return { ...store, clear: () => { if (hooks.failClear) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); hooks.clears++; store.clear(); } };
    },
  };
});
vi.mock("./warm-key.ts", async (original) => {
  const actual = await original<typeof import("./warm-key.ts")>();
  return { ...actual, warmKey: (parts: Record<string, unknown>) => { hooks.keyParts.push(parts); return actual.warmKey(parts); } };
});

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const ENV = ["FAKE_CODEX_RESUME_GATE", "MURAGE_PREWARM_WAIT_MS", "MURAGE_PREWARM_TAKEOVER_MS", "FAKE_CODEX_DUMP", "FAKE_CODEX_SPAWN_LOG", "FAKE_CODEX_WARM", "FAKE_CODEX_MODE_FILE", "FAKE_CODEX_MODE", "MURAGE_CODEX_SESSION_IDLE_MS", "MURAGE_CODEX_SESSION_IDLE_MIN_MS", "FAKE_CODEX_CALL_LOG", "FLUX_API_KEY", "FAKE_CODEX_RESUME_MODEL", "FAKE_CODEX_VERSION", "FAKE_CODEX_TOOLS"];

describe("CodexDriver warm app-server (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let dump: string;
  let spawnLog: string;
  let modeFile: string;
  let lines: string[];
  let info: ReturnType<typeof vi.spyOn>;
  const sessions = new Map<string, string>();

  const create = async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-warm-test", displayName: "Codex Warm Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    catalogSpawns = allSpawns().length;
  };
  const agents = (token: string, bot = "b1") => ({
    agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_BOT_ID: bot, MURAGE_COMMS_TOKEN: token, MURAGE_TURN_DEPTH: "0" } },
  });
  const identity = (botId = "b1", audience: "owner" | "non-owner" = "owner") => ({ botId, audience });
  const base = { integrations: agents("tok-1"), warmIdentity: identity() } satisfies Partial<SendTurnInput>;
  // the model catalog read at create() starts one app-server of its own
  let catalogSpawns = 0;
  const allSpawns = () => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean);
  const spawns = () => allSpawns().slice(catalogSpawns);
  const dispatches = () => lines.filter((l) => l.startsWith("codex dispatch"));
  const closes = () => lines.filter((l) => l.startsWith("codex close"));
  const setMode = (mode: string) => writeFileSync(modeFile, mode);
  const last = (type: string) => [...recorder.events].reverse().find((e) => e.type === type) as any;
  /** One whole turn; returns what the fake saw at the end of it. */
  const run = async (threadId: string, text: string, extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    const completed = last("turn.completed");
    let seen: any = null;
    try { seen = JSON.parse(readFileSync(dump, "utf8")); } catch {}
    return { seen, pid: seen?.pid as number | undefined, cred: seen?.credFile as { path: string; content: Record<string, Record<string, string>> | null } | undefined, completed };
  };
  const exited = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const eventually = async (check: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    sessions.clear();
    scratch = mkdtempSync(join(tmpdir(), "murage-codex-warm-"));
    dump = join(scratch, "dump.json");
    spawnLog = join(scratch, "spawns.log");
    modeFile = join(scratch, "mode");
    writeFileSync(spawnLog, "");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
    process.env.FAKE_CODEX_WARM = "1";
    process.env.FAKE_CODEX_MODE_FILE = modeFile;
    process.env.FAKE_CODEX_MODE = "resume";
    lines = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith("codex ")) lines.push(line);
    });
    probe.override = null;
    hooks.stuck = false; hooks.failClear = false; hooks.clears = 0; hooks.keyParts.length = 0;
  });
  afterEach(async () => {
    for (const key of ENV) delete process.env[key];
    probe.override = null;
    hooks.stuck = false; hooks.failClear = false;
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("a second turn on the same thread reuses the app-server: one spawn, one thread/start, two turn/starts", async () => {
    await create();
    const first = await run("t-hot", "one", base);
    const second = await run("t-hot", "two", { ...base, integrations: agents("tok-2") });
    expect(second.pid).toBe(first.pid);
    expect(spawns()).toHaveLength(1);
    const methods = (second.seen.calls as Array<{ method: string }>).map((c) => c.method);
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
    expect(methods.filter((m) => m === "thread/start")).toHaveLength(1);
    expect(methods.filter((m) => m === "thread/resume")).toHaveLength(0);
    expect(methods.filter((m) => m === "turn/start")).toHaveLength(2);
    expect(dispatches()[0]).toBe("codex dispatch thread=t-hot process=spawned reason=no-process");
    expect(dispatches()[1]).toBe("codex dispatch thread=t-hot process=reused reason=unchanged");
    expect(closes()).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.completed" && (e as any).ok === true)).toHaveLength(2);
  });

  it("memory r3: a submission fence that refuses during adapter setup sends no turn/start, cold or on the reused app-server", async () => {
    const callLog = join(scratch, "calls.log");
    writeFileSync(callLog, "");
    process.env.FAKE_CODEX_CALL_LOG = callLog;
    const turnStarts = () => readFileSync(callLog, "utf8").split("\n").filter((line) => line.endsWith(" turn/start")).length;
    await create();
    // cold: sendTurn hands the id back first; the fence runs after the handshake and refuses
    let calls = 0;
    const refused = await instance.adapter.sendTurn({ threadId: "t-fence", text: "one", ...base, beforeSubmit: () => { calls++; throw new Error("MEMORY_CONTEXT_REVOKED"); } });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === refused.turnId);
    expect(recorder.events.find((e) => e.type === "turn.completed" && e.turnId === refused.turnId)).toMatchObject({ ok: false, stopReason: "submission_refused" });
    expect(recorder.events.some((e) => e.type === "runtime.error" && e.turnId === refused.turnId)).toBe(false);
    expect(calls).toBe(1);
    expect(turnStarts()).toBe(0);
    // a passing fence runs once per write and lets the turn through
    let passes = 0;
    await run("t-fence", "two", { ...base, beforeSubmit: () => { passes++; } });
    expect(passes).toBe(1);
    expect(turnStarts()).toBe(1);
    // warm: the reused app-server is not written to either
    const again = await instance.adapter.sendTurn({ threadId: "t-fence", text: "three", ...base, resumeCursor: sessions.get("t-fence"), beforeSubmit: () => { throw new Error("MEMORY_CONTEXT_REVOKED"); } });
    // refused before the id came back, the harness stops it by id; after, it settles itself
    const settled = await Promise.race([recorder.until((e) => e.type === "turn.completed" && e.turnId === again.turnId).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
    if (!settled) await instance.adapter.interruptTurn("t-fence");
    await new Promise((r) => setTimeout(r, 100));
    expect(turnStarts()).toBe(1);
  });

  it("books each turn's own usage from the thread total, not the running total", async () => {
    await create();
    const first = await run("t-use", "one", base);
    const second = await run("t-use", "two", base);
    const third = await run("t-use", "three", base);
    // a fresh thread has no earlier total to subtract, so its first turn books no figure (as before)
    expect(first.completed).not.toHaveProperty("usage");
    // every later turn books the difference from the previous total
    for (const turn of [second, third]) expect(turn.completed.usage).toEqual({ input: 7, output: 3, cachedInput: 4 });
    const totals = recorder.events.filter((e) => e.type === "thread.token-usage.updated") as any[];
    expect(totals.map((e) => e.input)).toEqual([7, 14, 21]);
  });

  it("never puts a turn's token in the process env or argv, and delivers it through the 0600 file", async () => {
    await create();
    const first = await run("t-cred", "one", base);
    const second = await run("t-cred", "two", { ...base, integrations: agents("tok-2") });
    expect(first.cred?.content?.agents?.MURAGE_COMMS_TOKEN).toBe("tok-1");
    expect(second.cred?.content?.agents?.MURAGE_COMMS_TOKEN).toBe("tok-2");
    expect(second.cred?.path).toBe(first.cred?.path);
    expect(JSON.stringify(second.cred?.content)).not.toContain("tok-1");
    // the process environment never held a token, and argv names no token value
    expect(first.seen.env.MURAGE_COMMS_TOKEN).toBeUndefined();
    expect(JSON.stringify(first.seen.argv)).not.toContain("tok-");
    expect(JSON.stringify(first.seen.argv)).toContain("MURAGE_CRED_SERVER");
    // empty between turns; owner-only file in an owner-only directory
    expect(JSON.parse(readFileSync(first.cred!.path, "utf8"))).toEqual({});
    if (process.platform === "win32") {
      // no POSIX mode bits on Windows: the file sits in a fresh per-process directory under the per-user temp dir
      expect(statSync(first.cred!.path).isFile()).toBe(true);
      expect(dirname(dirname(first.cred!.path)).toLowerCase()).toBe(tmpdir().toLowerCase());
    } else {
      expect(statSync(first.cred!.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(first.cred!.path)).mode & 0o777).toBe(0o700);
    }
  });

  it("without a warm identity the token still rides the env and the process is not kept", async () => {
    await create();
    const first = await run("t-anon", "one", { integrations: agents("tok-1") });
    expect(first.seen.env.MURAGE_COMMS_TOKEN).toBeTruthy();
    await run("t-anon", "two", { integrations: agents("tok-2") });
    expect(spawns()).toHaveLength(2);
    expect(dispatches().every((l) => l.includes("reason=no-warm-identity"))).toBe(true);
    expect(closes()[0]).toContain("reason=no warm identity");
  });

  const respawned = (name: string, reason: string, change: () => Partial<SendTurnInput>) =>
    it(`respawns on ${name} (reason=${reason})`, async () => {
      await create();
      const one = await run("t-key", "one", base);
      const two = await run("t-key", "two", { ...base, ...change() });
      expect(two.pid).not.toBe(one.pid);
      expect(spawns()).toHaveLength(2);
      expect(dispatches()[1]).toBe(`codex dispatch thread=t-key process=spawned reason=${reason}`);
      expect(closes()[0]).toContain(`codex close thread=t-key reason=spawn contract changed: ${reason}`);
      await eventually(() => exited(one.pid!));
    });
  respawned("a different bot", "bot", () => ({ warmIdentity: identity("b2") }));
  respawned("a different audience", "audience", () => ({ warmIdentity: identity("b1", "non-owner") }));
  respawned("a different model", "model", () => ({ model: "gpt-other" }));
  respawned("a different folder", "cwd", () => ({ cwd: tmpdir() }));
  respawned("a changed MCP server set", "mcp", () => ({ integrations: { ...agents("tok-1"), memory: { command: process.execPath, args: ["fixture-memory"], env: { MURAGE_MEMORY_TOKEN: "m-1" } } } }));
  respawned("the stop line", "stopLine", () => ({ stopLine: true }));

  describe("connected-apps access revision", () => {
    const withScope = (revision: string, token = "tok-1"): Partial<SendTurnInput> => ({
      integrations: { ...agents(token), composio: { command: process.execPath, args: ["fixture-connectors"], env: { MURAGE_CONNECTOR_IDENTITY: "a".repeat(32), MURAGE_CONNECTOR_REVISION: revision } } },
    });
    it("recycles when the bot's access revision changes, so the engine lists the tools again (reason=connectorScope)", async () => {
      await create();
      const one = await run("t-scope", "one", { ...base, ...withScope("rev-1") });
      const two = await run("t-scope", "two", { ...base, ...withScope("rev-2") });
      expect(two.pid).not.toBe(one.pid);
      expect(dispatches()[1]).toBe("codex dispatch thread=t-scope process=spawned reason=connectorScope");
      await eventually(() => exited(one.pid!));
    });
    it("recycles an engine the bridge handed only the stand-in list (it lists once), same thread; the fresh mount is then kept (reason=connector-mount-incomplete)", async () => {
      await create();
      const dir = mkdtempSync(join(tmpdir(), "murage-mount-"));
      const cacheEnv = { MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}) };
      const scoped = (): Partial<SendTurnInput> => ({
        integrations: { ...agents("tok-1"), composio: { command: process.execPath, args: ["fixture-connectors"], env: { MURAGE_CONNECTOR_IDENTITY: "a".repeat(32), MURAGE_CONNECTOR_REVISION: "rev-1", ...cacheEnv } } },
      });
      try {
        const one = await run("t-mount", "one", { ...base, ...scoped() });
        // The bridge of that engine served the provisional list and filed it.
        const ref = { cache: cacheEnvFromProcess(cacheEnv), identity: "a".repeat(32), revision: "rev-1", thread: "t-mount" };
        markMountIncomplete(ref);
        // Discovery keeps failing (the real list is not confirmed): five turns, the warm engine stays, zero recycles.
        for (let turn = 1; turn <= 5; turn++) {
          const same = await run("t-mount", `wait ${turn}`, { ...base, ...scoped() });
          expect(same.pid).toBe(one.pid);
          expect(dispatches()[turn]).toContain("process=reused");
        }
        // The bridge's probe got the real list (cached under the current generation): exactly one recycle.
        markMountReady(ref, "");
        const two = await run("t-mount", "two", { ...base, ...scoped() });
        expect(two.pid).not.toBe(one.pid);
        expect(dispatches()[6]).toBe("codex dispatch thread=t-mount process=spawned reason=connector-mount-incomplete");
        const three = await run("t-mount", "three", { ...base, ...scoped() });
        expect(three.pid).toBe(two.pid);
        expect(dispatches()[7]).toContain("process=reused");
        await eventually(() => exited(one.pid!));
      } finally {
        removeTempDir(dir);
      }
    });
    it("keeps the warm process when only the turn's token rotates under the same revision", async () => {
      await create();
      const one = await run("t-scope2", "one", { ...base, ...withScope("rev-1", "tok-1") });
      const two = await run("t-scope2", "two", { ...base, ...withScope("rev-1", "tok-2") });
      expect(two.pid).toBe(one.pid);
      expect(dispatches()[1]).toContain("process=reused");
    });
  });

  it("respawns on sessionReset and starts a new conversation", async () => {
    await create();
    const one = await run("t-reset", "one", base);
    const two = await run("t-reset", "two", { ...base, sessionReset: true });
    expect(two.pid).not.toBe(one.pid);
    expect(dispatches()[1]).toBe("codex dispatch thread=t-reset process=spawned reason=sessionReset");
    expect(closes()[0]).toBe("codex close thread=t-reset reason=context reset");
  });

  // Thread recall, design S5: a sealed thread dispatches sessionReset true with no cursor, turn after turn. Each turn
  // closes the app-server kept from the turn before and starts a new conversation: thread/start, never thread/resume.
  it("a sealed thread's consecutive turns each respawn and start a new conversation, never thread/resume", async () => {
    await create();
    const pre = await run("t-sealed", "before the seal", base);
    const pids = [pre.pid!];
    for (const text of ["sealed one", "sealed two", "sealed three"]) {
      const turn = await run("t-sealed", text, { ...base, sessionReset: true, resumeCursor: undefined });
      const methods = (turn.seen.calls as Array<{ method: string }>).map((c) => c.method);
      expect(methods).toContain("thread/start");
      expect(methods).not.toContain("thread/resume");
      expect(pids).not.toContain(turn.pid!);
      pids.push(turn.pid!);
    }
    expect(new Set(pids).size).toBe(4);
    expect(dispatches().slice(1).every((line) => line === "codex dispatch thread=t-sealed process=spawned reason=sessionReset")).toBe(true);
    expect(closes().slice(0, 3).every((line) => line === "codex close thread=t-sealed reason=context reset")).toBe(true);
    for (const earlier of pids.slice(0, 3)) await eventually(() => exited(earlier));
  });

  it("respawns when the harness resumes a different conversation than the one the process holds", async () => {
    await create();
    await run("t-cur", "one", base);
    await run("t-cur", "two", { ...base, resumeCursor: "some-other-conversation" });
    expect(dispatches()[1]).toBe("codex dispatch thread=t-cur process=spawned reason=cursor");
  });

  it("recycles after Stop, and the next turn spawns fresh", async () => {
    await create();
    const one = await run("t-stop", "one", base);
    setMode("approval");
    const sent = await instance.adapter.sendTurn({ threadId: "t-stop", text: "two", resumeCursor: sessions.get("t-stop"), ...base });
    await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-stop");
    await instance.adapter.interruptTurn("t-stop");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(closes().at(-1)).toBe("codex close thread=t-stop reason=stop");
    await eventually(() => exited(one.pid!));
    setMode("resume");
    const three = await run("t-stop", "three", base);
    expect(three.pid).not.toBe(one.pid);
    expect(dispatches().at(-1)).toBe("codex dispatch thread=t-stop process=spawned reason=no-process");
  });

  it("recycles after an auth failure", async () => {
    await create();
    await run("t-auth", "one", base);
    setMode("unauthorized");
    const sent = await instance.adapter.sendTurn({ threadId: "t-auth", text: "two", resumeCursor: sessions.get("t-auth"), ...base });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect((last("turn.completed") as any).ok).toBe(false);
    expect(closes().at(-1)).toBe("codex close thread=t-auth reason=auth required");
    setMode("resume");
    await run("t-auth", "three", base);
    expect(spawns()).toHaveLength(2);
  });

  it("does not replay a failed turn on the retained process: it fails once, the process closes, the next turn spawns fresh", async () => {
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await run("t-noretry", "one", base);
    // a transient failure would be relaunched for the turn that launched the process; this turn did not
    setMode("transient-503");
    const sent = await instance.adapter.sendTurn({ threadId: "t-noretry", text: "two", resumeCursor: sessions.get("t-noretry"), ...base });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    delete process.env.FAKE_CODEX_RETRY_SCALE;
    expect((last("turn.completed") as any).ok).toBe(false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(spawns()).toHaveLength(1);
    expect(closes().at(-1)).toBe("codex close thread=t-noretry reason=turn failed: rpc_error");
    setMode("resume");
    await run("t-noretry", "three", base);
    expect(spawns()).toHaveLength(2);
  });

  it("closes the process after the idle window and spawns fresh on the next turn", async () => {
    process.env.MURAGE_CODEX_SESSION_IDLE_MIN_MS = "1";
    process.env.MURAGE_CODEX_SESSION_IDLE_MS = "150";
    await create();
    const one = await run("t-idle", "one", base);
    await eventually(() => closes().some((l) => l === "codex close thread=t-idle reason=idle"));
    await eventually(() => exited(one.pid!));
    const two = await run("t-idle", "two", base);
    expect(two.pid).not.toBe(one.pid);
    expect(dispatches()[1]).toBe("codex dispatch thread=t-idle process=spawned reason=no-process");
  });

  it("recycles when the process died while idle", async () => {
    await create();
    const one = await run("t-dead", "one", base);
    process.kill(one.pid!, "SIGKILL");
    await eventually(() => closes().some((l) => l === "codex close thread=t-dead reason=process exited"));
    const two = await run("t-dead", "two", base);
    expect(two.pid).not.toBe(one.pid);
    expect(spawns()).toHaveLength(2);
  });

  describe("process probe at settle", () => {
    it("recycles when a new child is left under the app-server", async () => {
      // per process: the first answer is the baseline, every later one adds a child nobody started at launch
      const asked = new Map<number, number>();
      probe.override = async (pid) => {
        const n = (asked.get(pid) ?? 0) + 1;
        asked.set(pid, n);
        return n === 1 ? new Set([pid + 1]) : new Set([pid + 1, 777_001]);
      };
      await create();
      const one = await run("t-leak", "one", base);
      await eventually(() => closes().some((l) => l === "codex close thread=t-leak reason=child processes alive at settle (1)"));
      const two = await run("t-leak", "two", base);
      expect(two.pid).not.toBe(one.pid);
      expect(dispatches()[1]).toBe("codex dispatch thread=t-leak process=spawned reason=no-process");
    });

    it("keeps the process when only an MCP server's own child appeared", async () => {
      const mcpServer = 777_100;
      // the MCP server is in the baseline and still the only thing under the app-server at settle
      probe.override = async () => new Set([mcpServer]);
      await create();
      const one = await run("t-mcp", "one", base);
      const two = await run("t-mcp", "two", base);
      expect(two.pid).toBe(one.pid);
      expect(closes()).toEqual([]);
    });

    it("fails closed when the probe has no answer", async () => {
      probe.override = async () => null;
      await create();
      await run("t-null", "one", base);
      await eventually(() => closes().some((l) => l === "codex close thread=t-null reason=process probe has no baseline"));
      await run("t-null", "two", base);
      expect(spawns()).toHaveLength(2);
    });
  });

  describe("review round 1", () => {
    it("1. respawns when the Flux key rotates under an unchanged model", async () => {
      process.env.FLUX_API_KEY = "sk-flux-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // secret-scan: fixture
      await create();
      const one = await run("t-flux", "one", { ...base, model: "flux::flux-auto" });
      process.env.FLUX_API_KEY = "sk-flux-bbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // secret-scan: fixture
      const two = await run("t-flux", "two", { ...base, model: "flux::flux-auto" });
      expect(two.pid).not.toBe(one.pid);
      expect(dispatches()[1]).toBe("codex dispatch thread=t-flux process=spawned reason=env");
    });

    it("2. a credential file that cannot be emptied settles the turn and closes the process", async () => {
      hooks.failClear = true;
      await create();
      const one = await run("t-clear", "one", base);
      expect(one.completed.ok).toBe(true);
      expect(closes().at(-1)).toBe("codex close thread=t-clear reason=credential clear failed");
      await eventually(() => exited(one.pid!));
      hooks.failClear = false;
      const two = await run("t-clear", "two", base);
      expect(two.pid).not.toBe(one.pid);
    });

    it("3. keeps no plaintext secret in the warm key's parts", async () => {
      await create();
      const local = { command: process.execPath, args: ["--token=sekret-arg"], env: { BOX_TOKEN_X: "sekret-env", CUSTOM_CRED: "sekret-custom" } };
      await run("t-parts", "one", { ...base, integrations: { ...agents("tok-1"), localComputer: local as never } });
      expect(hooks.keyParts.length).toBeGreaterThan(0);
      const dumped = JSON.stringify(hooks.keyParts);
      for (const secret of ["sekret-arg", "sekret-env", "sekret-custom", "tok-1"]) expect(dumped).not.toContain(secret);
    });

    it("4. takes the descendant baseline before turn/start is submitted", async () => {
      const callLog = join(scratch, "calls.log");
      writeFileSync(callLog, "");
      process.env.FAKE_CODEX_CALL_LOG = callLog;
      const seenAtBaseline: boolean[] = [];
      const asked = new Set<number>();
      probe.override = async (pid) => {
        if (!asked.has(pid)) {
          asked.add(pid);
          seenAtBaseline.push(readFileSync(callLog, "utf8").includes("turn/start"));
        }
        return new Set([pid + 1]);
      };
      await create();
      await run("t-base", "one", base);
      expect(seenAtBaseline).toEqual([false]);
    });

    it("5. an approval in the same chunk as the completion is refused and the process is not reused", async () => {
      await create();
      setMode("late-approval");
      const one = await run("t-late", "one", base);
      await eventually(() => closes().some((l) => l === "codex close thread=t-late reason=permission ask while idle"));
      setMode("resume");
      const two = await run("t-late", "two", base);
      expect(two.pid).not.toBe(one.pid);
      expect(spawns()).toHaveLength(2);
    });

    it("6. holds the dispatch slot while a settle probe is pending: a second send is busy and Stop prevents the launch", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const asked = new Map<number, number>();
      probe.override = async (pid) => {
        const n = (asked.get(pid) ?? 0) + 1;
        asked.set(pid, n);
        if (n >= 2) await gate;
        return new Set([pid + 1]);
      };
      await create();
      await run("t-slot", "one", base);
      const second = await instance.adapter.sendTurn({ threadId: "t-slot", text: "two", resumeCursor: sessions.get("t-slot"), ...base });
      await expect(instance.adapter.sendTurn({ threadId: "t-slot", text: "three", ...base })).rejects.toThrow(/already running/);
      await instance.adapter.interruptTurn("t-slot");
      release();
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
      expect(last("turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(spawns()).toHaveLength(1);
      expect(dispatches()).toHaveLength(1);
    });

    it("7. a process that will not stop stays owned: Stop and dispose report it until it is gone", async () => {
      await create();
      await run("t-stuck", "one", base);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-stuck")).rejects.toThrow(/still pending/);
      await expect(instance.dispose()).rejects.toThrow(/still pending/);
      hooks.stuck = false;
      await instance.dispose();
    });

    it("9. a partial approval begun under one turn and finished after it settled is never delivered to the next turn", async () => {
      await create();
      // fullAuto would accept whatever reached the next turn's handler
      await instance.dispose();
      instance = await CodexDriver.create({ instanceId: "codex-warm-test", displayName: "Codex Warm Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
      recorder = recordEvents(instance.adapter);
      catalogSpawns = allSpawns().length;
      setMode("split-approval");
      const one = await run("t-split", "one", base);
      setMode("resume");
      const two = await run("t-split", "two", base);
      await new Promise((r) => setTimeout(r, 600));
      expect(closes()).toContain("codex close thread=t-split reason=partial frame at settle");
      expect(two.pid).not.toBe(one.pid);
      expect(spawns()).toHaveLength(2);
      expect(recorder.events.filter((e) => e.type === "request.opened")).toEqual([]);
    });

    it("10. a second Stop on a process that survived the first reports failure until it is gone", async () => {
      await create();
      const one = await run("t-stop2", "one", base);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-stop2")).rejects.toThrow(/still pending/);
      await expect(instance.adapter.interruptTurn("t-stop2")).rejects.toThrow(/still pending/);
      expect(exited(one.pid!)).toBe(false);
      hooks.stuck = false;
      await instance.adapter.interruptTurn("t-stop2");
      await eventually(() => exited(one.pid!));
    });

    it("11. Stop during the baseline probe never reaches turn/start, even when the kill fails", async () => {
      const callLog = join(scratch, "calls.log");
      writeFileSync(callLog, "");
      process.env.FAKE_CODEX_CALL_LOG = callLog;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let probing = false;
      probe.override = async (pid) => { probing = true; await gate; return new Set([pid + 1]); };
      await create();
      const sent = await instance.adapter.sendTurn({ threadId: "t-base-stop", text: "one", ...base });
      await eventually(() => probing);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-base-stop")).rejects.toThrow(/still pending/);
      release();
      await new Promise((r) => setTimeout(r, 500));
      expect(readFileSync(callLog, "utf8")).not.toContain("turn/start");
      expect(recorder.events.some((e) => e.type === "turn.completed" && e.turnId === sent.turnId && (e as any).stopReason === "completed")).toBe(false);
      hooks.stuck = false;
    });

    it("8. binds a Windows credential path so its backslashes survive in the generated config", () => {
      const winPath = "C:\\Users\\sean\\AppData\\Local\\Temp\\murage-cred-ab12\\cred.json";
      const arg = `mcp_servers.agents.env.MURAGE_CRED_FILE=${JSON.stringify(CRED_FILE_PLACEHOLDER)}`;
      const [bound] = bindCredentialPathInArgs([arg], winPath);
      const value = bound!.slice(bound!.indexOf("=") + 1);
      expect(JSON.parse(value)).toBe(winPath);
      expect(bound).toContain("C:\\\\Users");
    });
  });

  // F4 design 2b (03-2): a model change spawns a new process; the resumed thread must prove it runs on the chosen model.
  describe("F4: the chosen model answers on a resumed conversation", () => {
    const calls = (seen: any, method: string) => (seen?.calls ?? []).filter((c: { method: string }) => c.method === method).map((c: { params: any }) => c.params);
    afterEach(() => { delete process.env.FAKE_CODEX_RESUME_MODEL; });

    it("F7: a model switched between turns rides thread/resume, the answer proves it, and the turn runs on the resumed thread", async () => {
      await create();
      await run("t-f7", "one", { ...base, model: "gpt-a" });
      const second = await run("t-f7", "two", { ...base, model: "gpt-b" });
      expect(spawns()).toHaveLength(2);
      expect(calls(second.seen, "thread/resume")).toEqual([expect.objectContaining({ threadId: "codex-thread-1", model: "gpt-b" })]);
      expect(calls(second.seen, "thread/start")).toEqual([]);
      expect(calls(second.seen, "turn/start").at(-1)).toMatchObject({ threadId: "codex-thread-1", model: "gpt-b" });
      expect(last("session.started")).toMatchObject({ sessionId: "codex-thread-1", model: "gpt-b" });
      expect(second.completed).toMatchObject({ ok: true });
    });

    it.each(["stale", "none"])("F8: a resume answer naming another model (%s) => a new thread on the chosen model, the conversation replayed", async (answer) => {
      await create();
      await run("t-f8", "one", { ...base, model: "gpt-a" });
      process.env.FAKE_CODEX_RESUME_MODEL = answer;
      const second = await run("t-f8", "two", { ...base, model: "gpt-b", transcript: [{ role: "user", text: "one" }, { role: "assistant", text: "done from fake codex" }] });
      expect(calls(second.seen, "thread/resume")).toHaveLength(1);
      expect(calls(second.seen, "thread/start")).toEqual([expect.objectContaining({ model: "gpt-b" })]);
      expect(JSON.stringify(calls(second.seen, "turn/start").at(-1).input)).toContain("[Your previous session could not be restored");
      expect(second.completed).toMatchObject({ ok: true });
    });

    it("F16: a model mismatch on a resumed /compact settles failed before anything is written; the conversation keeps its thread", async () => {
      const callLog = join(scratch, "f16-calls.log");
      process.env.FAKE_CODEX_CALL_LOG = callLog;
      await create();
      await run("t-f16", "one", { ...base, model: "gpt-a" });
      process.env.FAKE_CODEX_RESUME_MODEL = "stale";
      const second = await run("t-f16", "", { ...base, model: "gpt-b", engineCommand: { name: "compact", args: "" } });
      expect(second.completed).toMatchObject({ ok: false, stopReason: "resume_model_changed" });
      // the second process (the model changed) was asked to resume and nothing else: no new thread, no compaction, no turn
      const secondPid = spawns().at(-1)!;
      const methods = readFileSync(callLog, "utf8").split("\n").filter((l) => l.startsWith(`${secondPid} `)).map((l) => l.split(" ")[1]);
      expect(methods).toContain("thread/resume");
      expect(methods.filter((m) => m === "thread/start" || m === "thread/compact/start" || m === "turn/start")).toEqual([]);
      expect(recorder.events.filter((e) => e.type === "runtime.error").map((e: any) => e.message)).toEqual(["The model for this conversation changed. Send a message first, then run /compact again."]);
      expect(sessions.get("t-f16")).toBe("codex-thread-1");
    });

    it("F17 (GUARD): the default selection resumes with no model, takes the answered model, and starts no new thread", async () => {
      await create();
      await run("t-f17", "one", base);
      await instance.adapter.interruptTurn("t-f17");
      const second = await run("t-f17", "two", base);
      expect(spawns()).toHaveLength(2);
      const [resume] = calls(second.seen, "thread/resume");
      expect(resume).toBeDefined();
      expect(resume).not.toHaveProperty("model");
      expect(calls(second.seen, "thread/start")).toEqual([]);
      expect(second.completed).toMatchObject({ ok: true });
    });
  });

  // F4 design 2c (03-1): one env file per gated process, rewritten only by its own turns, removed only with the process.
  describe("F4: hook env per process", () => {
    let ownerHome: string;
    const gated = async () => {
      resetIsolationCache();
      process.env.FAKE_CODEX_VERSION = "codex-cli 0.150.0";
      instance = await CodexDriver.create({
        instanceId: "codex-warm-gated", displayName: "Codex Warm Test", environment: { CODEX_HOME: ownerHome }, enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      recorder = recordEvents(instance.adapter);
      catalogSpawns = allSpawns().length;
      // the fake plays one shell call through the hook on every gated turn: its card is allowed
      const inst = instance;
      inst.adapter.onEvent((e: any) => { if (e.type === "request.opened" && !holdThreads.has(e.threadId)) void inst.adapter.respondToRequest(e.threadId, e.requestId, { behavior: "allow" }); });
    };
    const envOf = (r: { seen: any }) => r.seen.env.MURAGE_CODEX_HOOK_ENV as string;
    // a conversation whose card is left open: its process stays busy (the pool keeps one idle spare per engine)
    const holdThreads = new Set<string>();
    beforeEach(() => {
      ownerHome = join(scratch, "owner-home");
      mkdirSync(ownerHome, { recursive: true });
      writeFileSync(join(ownerHome, "config.toml"), 'model = "gpt-owner"\n');
      // two kept engines at once: the pool's memory admission must not evict one on a loaded test box
      process.env.MURAGE_WARM_POOL_MIN_FREE_MB = "0";
      process.env.MURAGE_WARM_POOL_BUDGET_MB = "1000000";
      // the settle-time probe is not under test here: nothing is left under the app-server
      probe.override = async () => new Set<number>();
    });
    // the probed version is cached per CLI: later tests must not inherit the gated one
    afterEach(() => {
      for (const name of ["FAKE_CODEX_VERSION", "FAKE_CODEX_TOOLS", "MURAGE_WARM_POOL_MIN_FREE_MB", "MURAGE_WARM_POOL_BUDGET_MB"]) delete process.env[name];
      resetIsolationCache();
    });

    it("F13 + F14: each conversation's process has its own file; a reused turn rewrites only its own; a close removes it", async () => {
      await gated();
      // a first conversation names the scope; closing it removes its process's file
      const w = await run("t-env-0", "one", { ...base, cwd: scratch });
      const envW = envOf(w);
      const home = dirname(envW);
      expect(home).toBe(join(w.seen.env.CODEX_HOME, "hook-env"));
      expect(existsSync(envW)).toBe(true);
      await instance.adapter.interruptTurn("t-env-0");
      await eventually(() => !existsSync(envW));
      holdThreads.add("t-env-a");
      try {
        // A is busy on an open card: its process and its file are live
        const a = await instance.adapter.sendTurn({ threadId: "t-env-a", text: "one", ...base, cwd: scratch });
        const card: any = await recorder.until((e: any) => e.type === "request.opened" && e.turnId === a.turnId);
        const filesNow = () => readdirSync(home).filter((f) => f.endsWith(".env"));
        expect(filesNow()).toHaveLength(1);
        const envA = join(home, filesNow()[0]!);
        const tokenA = readFileSync(envA, "utf8");
        // B's two turns on one kept process
        const b1 = await run("t-env-b", "one", { ...base, cwd: scratch });
        const envB = envOf(b1);
        expect(envB).not.toBe(envA);
        expect(dirname(envB)).toBe(home);
        const tokenB = readFileSync(envB, "utf8");
        const b2 = await run("t-env-b", "two", { ...base, cwd: scratch });
        expect(lines.join(" | ")).toContain("thread=t-env-b process=reused");
        expect(b2.pid).toBe(b1.pid);
        expect(envOf(b2)).toBe(envB);
        expect(readFileSync(envB, "utf8")).not.toBe(tokenB);
        // A's file was never touched by B's turns
        expect(readFileSync(envA, "utf8")).toBe(tokenA);
        holdThreads.delete("t-env-a");
        await instance.adapter.respondToRequest("t-env-a", card.requestId, { behavior: "allow" });
        await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === a.turnId);
        // a close removes the process's own file and leaves the other's
        await instance.adapter.interruptTurn("t-env-b");
        await eventually(() => !existsSync(envB));
      } finally {
        holdThreads.clear();
      }
    });

    it("F19: a close whose kill is not confirmed keeps the file and the conversation owned; a hook whose file was swept is blocked", async () => {
      await gated();
      const a1 = await run("t-env-stuck", "one", { ...base, cwd: scratch });
      const envA = envOf(a1);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-env-stuck")).rejects.toThrow(/still pending/);
      expect(existsSync(envA)).toBe(true);
      await expect(instance.adapter.sendTurn({ threadId: "t-env-stuck", text: "again", ...base, cwd: scratch })).rejects.toThrow(/has not closed yet/);
      hooks.stuck = false;
      await instance.adapter.interruptTurn("t-env-stuck");
      await eventually(() => !existsSync(envA));
      // a leftover engine of an earlier Murage run finds no file: its hook blocks, it is never handed another process's socket
      const blocked = spawnSync(process.execPath, [join(a1.seen.env.CODEX_HOME, "murage-hook.mjs")], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "x" }),
        env: { ...process.env, MURAGE_CODEX_HOOK_ENV: envA },
      });
      // PreToolUse blocks with the documented deny on stdout and exit 0 since 1.0.3 (codex-hook.ts block()).
      expect(blocked.status).toBe(0);
      expect(JSON.parse(String(blocked.stdout)).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(String(blocked.stderr)).toContain("Murage blocked this call");
    });

    it("F21: a second Codex instance on the same scope sweeps at its start and keeps the first instance's live file; the first's hooks keep working", async () => {
      await gated();
      const x = instance;
      const xRecorder = recorder;
      const x1 = await run("t-env-x", "one", { ...base, cwd: scratch });
      const envX = envOf(x1);
      const home = x1.seen.env.CODEX_HOME as string;
      const dead = join(home, "hook-env", "999999-0dead.env");
      writeFileSync(dead, "SOCKET=x\nTOKEN=y\n");
      // the second instance: its own driver start, the same bot scope
      await gated();
      const y1 = await run("t-env-y", "one", { ...base, cwd: scratch });
      expect(y1.seen.env.CODEX_HOME).toBe(home);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(envX)).toBe(true);
      const y = instance;
      recorder.stop();
      await y.dispose();
      // back on the first instance: its retained process's hook still reaches its own turn (an in-project edit is allowed by the hook)
      instance = x;
      recorder = xRecorder;
      const x2 = await run("t-env-x", "two", { ...base, cwd: scratch });
      expect(x2.pid).toBe(x1.pid);
      expect(x2.completed).toMatchObject({ ok: true });
      expect(x2.seen.hookLog.at(-1)).toMatchObject({ id: "i1", verdict: "allow" });
    });
  });
});

describe("CodexDriver intent prewarm (fake app-server)", () => {
  const exitedPid = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let lines: string[];
  let info: ReturnType<typeof vi.spyOn>;
  let catalogSpawns = 0;
  const sessions = new Map<string, string>();
  const base = {
    integrations: { agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: "tok-1", MURAGE_TURN_DEPTH: "0" } } },
    warmIdentity: { botId: "b1", audience: "owner" as const },
  } satisfies Partial<SendTurnInput>;
  const spawns = () => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).slice(catalogSpawns);
  const dispatches = () => lines.filter((l) => l.startsWith("codex dispatch"));
  const eventually = async (check: () => boolean, ms = 8_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(check()).toBe(true);
  };
  const run = async (threadId: string, text: string, extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.turnId === sent.turnId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    return sent;
  };
  const goCold = async (threadId: string) => {
    await run(threadId, "one", base);
    await eventually(() => warmPool.idleCount() === 0);
    await eventually(() => lines.some((l) => l.startsWith(`codex close thread=${threadId} reason=activity window`)));
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    sessions.clear();
    scratch = mkdtempSync(join(tmpdir(), "murage-codex-prewarm-"));
    spawnLog = join(scratch, "spawns.log");
    writeFileSync(spawnLog, "");
    process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
    process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
    process.env.FAKE_CODEX_WARM = "1";
    process.env.FAKE_CODEX_MODE_FILE = join(scratch, "mode");
    process.env.FAKE_CODEX_MODE = "resume";
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
    lines = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => { if (typeof line === "string" && line.startsWith("codex ")) lines.push(line); });
    probe.override = null;
    hooks.stuck = false; hooks.failClear = false; hooks.clears = 0; hooks.keyParts.length = 0;
  });
  afterEach(async () => {
    for (const key of [...ENV, "MURAGE_WARM_ACTIVITY_WINDOW_MS"]) delete process.env[key];
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });
  const create = async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-prewarm-test", displayName: "Codex Prewarm Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    catalogSpawns = readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  };

  it("starts a cold app-server once, parks it held, and releases it when no send follows", async () => {
    await create();
    await goCold("t-pw-release");
    expect(spawns()).toHaveLength(1);
    const before = recorder.events.length;
    expect(await instance.adapter.prewarm!("t-pw-release")).toBe(true);
    expect(spawns()).toHaveLength(2);
    expect(recorder.events.length).toBe(before); // a warm announces nothing
    expect(warmPool.idleCount()).toBe(1);
    expect(await instance.adapter.prewarm!("t-pw-release")).toBe(false); // live: nothing to start
    expect(spawns()).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 400));
    await warmPool.tick();
    expect(warmPool.idleCount()).toBe(0);
    await eventually(() => lines.filter((l) => l.startsWith("codex close thread=t-pw-release reason=activity window")).length === 2);
  });

  it("holdIdle (a deleted conversation is being removed from the engine's files) closes the parked app-server, warms nothing while held, and allows it again after", async () => {
    await create();
    await goCold("t-pw-hold");
    expect(await instance.adapter.prewarm!("t-pw-hold")).toBe(true);
    const hold = await instance.adapter.holdIdle!();
    expect(hold.confirmed).toBe(true);
    await eventually(() => lines.some((l) => l.startsWith("codex close thread=t-pw-hold reason=deletion-hold")));
    expect(await instance.adapter.prewarm!("t-pw-hold")).toBe(false);
    hold.release();
    expect(await instance.adapter.prewarm!("t-pw-hold")).toBe(true);
  });

  it("holdIdle waits for a close that is already in flight (the engine left `retained` but may still be writing): confirmed only if that process really stopped", async () => {
    for (const stopped of [true, false]) {
      await create();
      await goCold(`t-hold-flight-${stopped}`);
      expect(await instance.adapter.prewarm!(`t-hold-flight-${stopped}`)).toBe(true);
      let answer!: (value: boolean) => void;
      hooks.hang = new Promise<boolean>((resolve) => { answer = resolve; });
      const stopping = instance.adapter.interruptTurn(`t-hold-flight-${stopped}`).catch(() => "pending"); // closes the parked app-server; it is no longer retained, its close is in flight
      let settled = false;
      const holding = instance.adapter.holdIdle!().then((hold) => { settled = true; return hold; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled, "the hold waits for the close in flight").toBe(false);
      answer(stopped);
      const hold = await holding;
      expect(hold.confirmed, stopped ? "the process stopped" : "the process did not stop: it stays owned and the files stay alone").toBe(stopped);
      hooks.hang = null;
      hooks.stuck = false;
      hold.release();
      await stopping;
    }
  });

  it("a process that would not stop earlier keeps the hold unconfirmed until it does", async () => {
    await create();
    await goCold("t-hold-stuck");
    expect(await instance.adapter.prewarm!("t-hold-stuck")).toBe(true);
    hooks.stuck = true;
    await instance.adapter.interruptTurn("t-hold-stuck").catch(() => undefined); // closed, but never reported stopped: it is in the stuck registry
    const refused = await instance.adapter.holdIdle!();
    expect(refused.confirmed).toBe(false);
    refused.release();
    hooks.stuck = false;
    const allowed = await instance.adapter.holdIdle!();
    expect(allowed.confirmed).toBe(true);
    allowed.release();
  });

  it("a prewarm that is already starting meets the hold at its spawn: no app-server is started, and the hold is confirmed", async () => {
    await create();
    await goCold("t-pw-hold-race");
    const before = spawns().length;
    const warming = instance.adapter.prewarm!("t-pw-hold-race"); // admitted: nothing is held yet
    const hold = await instance.adapter.holdIdle!();
    expect(await warming).toBe(false);
    expect(hold.confirmed).toBe(true);
    expect(spawns()).toHaveLength(before);
    expect(warmPool.idleCount()).toBe(0);
    hold.release();
    expect(await instance.adapter.prewarm!("t-pw-hold-race")).toBe(true);
  });

  it("prewarm then send reuses the app-server: no second spawn", async () => {
    await create();
    await goCold("t-pw-reuse");
    // goCold needed the short window; now the parked engine must outlive the send. The pool
    // judges the window when its size probe answers, and a real Windows listing (~0.5 s)
    // outlasts 250 ms, so the engine would be let go as idle first (reason=no-process).
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    expect(await instance.adapter.prewarm!("t-pw-reuse")).toBe(true);
    await run("t-pw-reuse", "two", base);
    expect(spawns()).toHaveLength(2);
    expect(dispatches().at(-1)).toContain("process=reused reason=unchanged");
  });

  it("prewarm then a changed warm key recycles the process instead of reusing it", async () => {
    await create();
    await goCold("t-pw-key");
    // goCold needed the short window; now the parked engine must outlive the send. The pool
    // judges the window when its size probe answers, and a real Windows listing (~0.5 s)
    // outlasts 250 ms, so the engine would be let go as idle first (reason=no-process).
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    expect(await instance.adapter.prewarm!("t-pw-key")).toBe(true);
    await run("t-pw-key", "two", { ...base, routeAsks: true });
    expect(spawns()).toHaveLength(3);
    expect(dispatches().at(-1)).toContain("process=spawned reason=routeAsks");
  });

  it("a prewarmed app-server's credential file is emptied before it idles, as after a settled turn", async () => {
    await create();
    await goCold("t-pw-cred");
    const before = hooks.clears;
    expect(await instance.adapter.prewarm!("t-pw-cred")).toBe(true);
    expect(hooks.clears).toBe(before + 1);
  });

  it("a prewarm whose credential file cannot be emptied closes the process instead of parking it", async () => {
    await create();
    await goCold("t-pw-cred-fail");
    hooks.failClear = true;
    expect(await instance.adapter.prewarm!("t-pw-cred-fail")).toBe(false);
    expect(warmPool.idleCount()).toBe(0);
    await eventually(() => lines.some((l) => l.startsWith("codex close thread=t-pw-cred-fail reason=credential clear failed")));
  });

  it("a send that outwaits a slow prewarm takes over: the prewarm is cancelled and its slot freed, never 'already running'", async () => {
    await create();
    await goCold("t-pw-slow");
    const gate = join(scratch, "resume-gate");
    process.env.FAKE_CODEX_RESUME_GATE = gate;
    process.env.MURAGE_PREWARM_WAIT_MS = "100";
    const warming = instance.adapter.prewarm!("t-pw-slow");
    await eventually(() => spawns().length === 2);
    await new Promise((r) => setTimeout(r, 200)); // past the send's wait; the warm's start is still held
    setTimeout(() => writeFileSync(gate, "open"), 500); // the real send's own app-server may start once the warm is gone
    const sent = await run("t-pw-slow", "two", base);
    expect(sent.turnId).toBeTruthy();
    await warming;
  });

  it("a takeover that cannot end the prewarm fails the send clearly within its bound, never 'already running'", async () => {
    await create();
    await goCold("t-pw-stuck");
    process.env.FAKE_CODEX_RESUME_GATE = join(scratch, "never-opens");
    process.env.MURAGE_PREWARM_WAIT_MS = "50";
    process.env.MURAGE_PREWARM_TAKEOVER_MS = "400";
    const warming = instance.adapter.prewarm!("t-pw-stuck");
    await eventually(() => spawns().length === 2);
    hooks.stuck = true; // the warm's app-server ignores every kill
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t0 = Date.now();
      const error = await instance.adapter.sendTurn({ threadId: "t-pw-stuck", text: "two", ...base }).then(() => null, (e: Error) => e);
      expect(error?.message).toMatch(/did not stop in time/);
      expect(error?.message).not.toMatch(/already running/);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(warn.mock.calls.some(([l]) => String(l).startsWith("codex prewarm takeover thread=t-pw-stuck failed=true"))).toBe(true);
    } finally {
      warn.mockRestore();
      hooks.stuck = false;
      writeFileSync(process.env.FAKE_CODEX_RESUME_GATE!, "open");
      delete process.env.MURAGE_PREWARM_TAKEOVER_MS;
    }
    await warming;
  });

  it("a prewarm whose close is unconfirmed stays owned in the stuck registry: the next send is refused until it is gone", async () => {
    await create();
    await goCold("t-pw-unclosed");
    hooks.failClear = true;
    hooks.stuck = true; // and its app-server will not stop
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await instance.adapter.prewarm!("t-pw-unclosed")).toBe(false);
      const held = Number(spawns().at(-1));
      expect(exitedPid(held)).toBe(false);
      hooks.failClear = false;
      // nothing new starts beside the process that is still owned
      await expect(instance.adapter.sendTurn({ threadId: "t-pw-unclosed", text: "two", ...base })).rejects.toThrow(/has not closed yet/);
      expect(spawns()).toHaveLength(2);
      await expect(instance.adapter.interruptTurn("t-pw-unclosed")).rejects.toThrow(/still pending/);
      hooks.stuck = false;
      // once it is confirmed gone, the thread dispatches again
      await run("t-pw-unclosed", "three", base);
      await eventually(() => exitedPid(held));
      expect(spawns()).toHaveLength(3);
    } finally {
      warn.mockRestore();
      hooks.stuck = false; hooks.failClear = false;
    }
  });

  it("with no remembered args prewarm is a no-op, and a routine turn leaves nothing to warm", async () => {
    await create();
    expect(await instance.adapter.prewarm!("t-never-seen")).toBe(false);
    await run("t-pw-bg", "routine", { ...base, background: true });
    expect(warmPool.idleCount()).toBe(0);
    expect(await instance.adapter.prewarm!("t-pw-bg")).toBe(false);
    expect(spawns()).toHaveLength(1);
  });
});
