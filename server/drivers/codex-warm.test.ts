// One warm `codex app-server` per chat thread: reused while every spawn input
// is unchanged, recycled otherwise, with the per-turn capability token read from
// a per-process 0600 file instead of the long-lived environment.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { bindCredentialPathInArgs, CodexDriver } from "./codex.ts";
import { CRED_FILE_PLACEHOLDER } from "./turn-credentials.ts";
import { warmPool } from "./warm-pool.ts";

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
const hooks = vi.hoisted(() => ({ stuck: false, failClear: false, clears: 0, keyParts: [] as unknown[] }));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return {
    ...actual,
    // a process that ignores the kill: nothing is signalled and it never reports stopped
    killCliTree: (...args: Parameters<typeof actual.killCliTree>) => { if (!hooks.stuck) actual.killCliTree(...args); },
    awaitCliTreeStopped: (...args: Parameters<typeof actual.awaitCliTreeStopped>) => (hooks.stuck ? Promise.resolve(false) : actual.awaitCliTreeStopped(...args)),
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
const ENV = ["FAKE_CODEX_RESUME_GATE", "MURAGE_PREWARM_WAIT_MS", "MURAGE_PREWARM_TAKEOVER_MS", "FAKE_CODEX_DUMP", "FAKE_CODEX_SPAWN_LOG", "FAKE_CODEX_WARM", "FAKE_CODEX_MODE_FILE", "FAKE_CODEX_MODE", "MURAGE_CODEX_SESSION_IDLE_MS", "MURAGE_CODEX_SESSION_IDLE_MIN_MS", "FAKE_CODEX_CALL_LOG", "FLUX_API_KEY"];

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

  it("respawns on sessionReset and starts a new conversation", async () => {
    await create();
    const one = await run("t-reset", "one", base);
    const two = await run("t-reset", "two", { ...base, sessionReset: true });
    expect(two.pid).not.toBe(one.pid);
    expect(dispatches()[1]).toBe("codex dispatch thread=t-reset process=spawned reason=sessionReset");
    expect(closes()[0]).toBe("codex close thread=t-reset reason=context reset");
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
