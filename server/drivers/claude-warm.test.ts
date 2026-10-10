// Hot engine instance, step 1: one warm `claude` process per conversation
// thread, reused while every spawn input is unchanged, recycled otherwise, with
// the per-turn capability token delivered through a per-process 0600 file that
// is emptied at every settle and unlinked when the process goes away.
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer, type Server } from "node:http";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput, SteerDelivery } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { execFileSync } from "node:child_process";
import { ClaudeDriver, claudeGitRoots, claudeSettingsRevision, managedClaudeSettingsPaths, type ClaudeConfig } from "./claude.ts";
import { credentialDigest, diffWarmKey, warmKey } from "./warm-key.ts";
import { warmPool } from "./warm-pool.ts";

// The process probe, replaceable per test: `probe.override` answers instead of `ps`.
const probe = vi.hoisted(() => ({
  override: null as null | ((pid: number) => Promise<Set<number> | null>),
  /** answers the init-time baseline instead of `ps` (default: nothing started by init) */
  baselineOverride: null as null | ((pid: number, initAt: number) => Promise<Set<number> | null>),
  /** true: use the real `ps` for baseline and settle probes (one test only) */
  real: false,
  /** holds the driver's tree-stop confirmations until it resolves (one test only) */
  treeGate: null as null | Promise<void>,
  /** tree-stop confirmations that reached the gate (proof the CLI's "close" fired) */
  treeGated: 0,
  /** true: the forced stop reports "not confirmed" without touching the process (one test only) */
  forceFails: false,
  /** a pid whose forced stop reports "not confirmed" while every other tree is really stopped (one test only) */
  forceFailPid: null as number | null,
  /** true: every tree-stop confirmation reports "not confirmed" (one test only) */
  stopFails: false,
  /** true: the lifecycle proves every tree stopped while each caller-facing confirmation says "not confirmed", and every call is counted (one test only) */
  disagree: false,
  calls: { await: 0, force: 0, outcome: 0 },
}));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return {
    ...actual,
    cliTreeStopOutcome: (...args: Parameters<typeof actual.cliTreeStopOutcome>) => {
      probe.calls.outcome++;
      if (probe.disagree) return Promise.resolve(true);
      // a simulated unconfirmable stop must read unconfirmed through the lifecycle too
      if (probe.stopFails || probe.forceFails || (probe.forceFailPid !== null && args[0].pid === probe.forceFailPid)) return Promise.resolve(false);
      const real = actual.cliTreeStopOutcome(...args);
      return probe.treeGate ? probe.treeGate.then(() => real) : real;
    },
    awaitCliTreeStopped: (...args: Parameters<typeof actual.awaitCliTreeStopped>) => (probe.disagree
      ? (probe.calls.await++, Promise.resolve(false))
      : probe.stopFails
      ? Promise.resolve(false)
      : probe.treeGate
      ? (probe.treeGated++, probe.treeGate.then(() => actual.awaitCliTreeStopped(...args)))
      : actual.awaitCliTreeStopped(...args)),
    forceCliTreeStopped: (...args: Parameters<typeof actual.forceCliTreeStopped>) => (probe.disagree
      ? (probe.calls.force++, Promise.resolve(false))
      : probe.forceFails || (probe.forceFailPid !== null && args[0].pid === probe.forceFailPid)
      ? Promise.resolve(false)
      : actual.forceCliTreeStopped(...args)),
  };
});
vi.mock("./process-tree.ts", async (original) => {
  const actual = await original<typeof import("./process-tree.ts")>();
  return {
    ...actual,
    descendantBaseline: (pid: number, initAt: number) => (probe.baselineOverride
      ? probe.baselineOverride(pid, initAt)
      : probe.real ? actual.descendantBaseline(pid, initAt) : Promise.resolve(new Set<number>())),
    // The override answers a flat set, so "untracked" is what it adds over the baseline.
    // By default nothing is alive: no test here depends on how fast `ps` is.
    untrackedDescendants: (pid: number, baseline: ReadonlySet<number>) => (probe.override
      ? probe.override(pid).then((now) => (now ? new Set([...now].filter((p) => !baseline.has(p))) : null))
      : probe.real ? actual.untrackedDescendants(pid, baseline) : Promise.resolve(new Set<number>())),
  };
});

// os.tmpdir() reads TMPDIR on POSIX but TEMP/TMP on Windows, so redirecting the
// temp directory for a test has to set all three.
const TMP_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const originalTmp = Object.fromEntries(TMP_KEYS.map((key) => [key, process.env[key]]));
const useTmp = (dir: string) => { for (const key of TMP_KEYS) process.env[key] = dir; };
const restoreTmp = () => { for (const key of TMP_KEYS) { const value = originalTmp[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

describe("ClaudeDriver warm process (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let dump: string;
  let traces: string[];
  let info: ReturnType<typeof vi.spyOn>;
  const sessions = new Map<string, string>();

  const create = async (config: Partial<ClaudeConfig> = {}) => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-warm-test", displayName: "Claude Warm Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits", ...config },
    });
    recorder = recordEvents(instance.adapter);
  };
  const agents = (token: string, bot = "b1") => ({
    agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_BOT_ID: bot, MURAGE_COMMS_TOKEN: token, MURAGE_TURN_DEPTH: "0" } },
  });
  const identity = (botId = "b1", audience: "owner" | "non-owner" = "owner") => ({ botId, audience });
  /** One whole turn; returns what the fake CLI saw at the start of it. */
  const run = async (threadId: string, text: string, extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    return { seen, pid: seen.pid as number, cred: seen.credFile as { path: string; content: Record<string, Record<string, string>> }, trace: traces.at(-1) ?? "" };
  };
  const base = { integrations: agents("tok-1"), warmIdentity: identity() } satisfies Partial<SendTurnInput>;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    sessions.clear();
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-warm-"));
    // hermetic: the revision stats the CLI's global settings, which a real
    // ~/.claude (or %USERPROFILE%\\.claude, which a temp HOME does not move) can change mid-test
    process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config-default");
    dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    process.env.FAKE_CLAUDE_CHILD_PID = join(scratch, "child.pid");
    traces = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith("claude dispatch")) traces.push(line);
    });
  });
  afterEach(async () => {
    for (const key of ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_DUMP_EACH_TURN", "FAKE_CLAUDE_CHILD_PID", "FAKE_CLAUDE_BG_HOLD", "FAKE_CLAUDE_BG_ASKS", "MURAGE_CLAUDE_BACKGROUND_CAP_MIN_MS", "FAKE_CLAUDE_FINISH_GATE_DIR"]) delete process.env[key];
    probe.override = null;
    probe.baselineOverride = null;
    probe.real = false;
    probe.treeGate = null;
    probe.treeGated = 0;
    probe.forceFails = false;
    probe.forceFailPid = null;
    probe.stopFails = false; probe.disagree = false;
    for (const key of ["FAKE_CLAUDE_AUTH", "FAKE_CLAUDE_HOLD_MARKER", "FAKE_CLAUDE_HOLD_GATE", "FAKE_CLAUDE_HOLD_SEEN", "FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS", "FAKE_CLAUDE_STATE", "FAKE_CLAUDE_RETRY_SCALE", "CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_MODE"]) delete process.env[key];
    restoreTmp();
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("two turns on one thread with unchanged inputs spawn exactly one process", async () => {
    await create();
    const first = await run("t-hot", "one", base);
    const second = await run("t-hot", "two", { ...base, integrations: agents("tok-2") });
    expect(second.pid).toBe(first.pid);
    expect(traces).toHaveLength(2);
    expect(traces[0]).toContain("process=spawned reason=no-process");
    expect(traces[1]).toContain("process=reused");
  });

  it("a settle check that outlives its session never closes the replacement process", async () => {
    // Turn one's baseline is held back; the thread's process is replaced
    // (resetSession) while the check waits; the late probe then reports a
    // leftover child for the OLD pid. Only the old session may be closed.
    let release: (baseline: Set<number>) => void = () => {};
    let calls = 0;
    probe.baselineOverride = () => (++calls === 1 ? new Promise<Set<number>>((resolve) => { release = resolve; }) : Promise.resolve(new Set<number>()));
    await create();
    const first = await run("t-late-check", "one", base);
    await instance.adapter.resetSession!("t-late-check");
    const second = await run("t-late-check", "two", base);
    expect(second.pid).not.toBe(first.pid);
    probe.override = async (pid) => new Set(pid === first.pid ? [999_999] : []);
    release(new Set());
    await new Promise((r) => setTimeout(r, 300));
    const third = await run("t-late-check", "three", base);
    expect(third.pid).toBe(second.pid);
    expect(traces.at(-1)).toContain("process=reused");
  });

  it("writes each turn's token to the file at its start and empties it at settle; turn N's token is absent in N+1", async () => {
    await create();
    const first = await run("t-tok", "one", base);
    expect(first.cred.content.agents.MURAGE_COMMS_TOKEN).toBe("tok-1");
    expect(JSON.parse(readFileSync(first.cred.path, "utf8"))).toEqual({});
    const second = await run("t-tok", "two", { ...base, integrations: agents("tok-2") });
    expect(second.cred.path).toBe(first.cred.path);
    expect(second.cred.content.agents.MURAGE_COMMS_TOKEN).toBe("tok-2");
    expect(JSON.stringify(second.cred.content)).not.toContain("tok-1");
    expect(JSON.parse(readFileSync(second.cred.path, "utf8"))).toEqual({});
    // and no token anywhere in the spawn contract
    expect(JSON.stringify(first.seen.mcpConfig)).not.toContain("tok-1");
    expect(JSON.stringify(first.seen.argv)).not.toContain("tok-1");
  });

  it("gives every process its own 0600 file in its own 0700 directory, unguessable from the thread", async () => {
    await create();
    const a = await run("t-iso-a", "one", { ...base, integrations: agents("tok-a") });
    const b = await run("t-iso-b", "one", { ...base, integrations: agents("tok-b") });
    expect(b.pid).not.toBe(a.pid);
    expect(b.cred.path).not.toBe(a.cred.path);
    expect(dirname(b.cred.path)).not.toBe(dirname(a.cred.path));
    for (const cred of [a.cred, b.cred]) {
      if (process.platform === "win32") {
        // Windows has no POSIX mode bits (statSync reports 0o666/0o777 whatever the ACL says).
        // The equivalent guarantee is that the directory is created fresh under the per-user
        // temp directory, whose ACL the new directory inherits.
        expect(statSync(cred.path).isFile()).toBe(true);
        expect(statSync(dirname(cred.path)).isDirectory()).toBe(true);
        expect(dirname(dirname(cred.path)).toLowerCase()).toBe(tmpdir().toLowerCase());
      } else {
        expect(statSync(cred.path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(cred.path)).mode & 0o777).toBe(0o700);
      }
      expect(cred.path).not.toContain("t-iso");
    }
    expect(b.cred.content.agents.MURAGE_COMMS_TOKEN).toBe("tok-b");
    expect(JSON.stringify(b.cred.content)).not.toContain("tok-a");
    // the second process's launch carries only its own path
    expect(JSON.stringify(b.seen)).not.toContain(a.cred.path);
  });

  const recycled = (name: string, reason: string, change: () => Partial<SendTurnInput>, config: Partial<ClaudeConfig> = {}, first: Partial<SendTurnInput> = base) =>
    it(`recycles the process on ${name} (reason=${reason})`, async () => {
      await create(config);
      const one = await run("t-recycle", "one", first);
      const two = await run("t-recycle", "two", { ...base, ...change() });
      expect(two.pid).not.toBe(one.pid);
      expect(two.trace).toContain(`process=spawned reason=${reason}`);
      // the retired process's credential file is gone, not just emptied
      expect(existsSync(one.cred.path)).toBe(false);
      expect(existsSync(two.cred.path)).toBe(true);
    });
  recycled("an audience change", "audience", () => ({ warmIdentity: identity("b1", "non-owner") }));
  recycled("a different bot", "bot", () => ({ warmIdentity: identity("b2") }));
  recycled("a permission-mode change", "permissionMode", () => ({ stopLine: true }), { permissionMode: "bypassPermissions" });
  recycled("a model change", "model", () => ({ model: "claude-other" }));
  const route = (revision: string) => ({ connectionId: "c1", revision, preset: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "fixture-only-not-real", model: "claude-fixture" }) as unknown as SendTurnInput["providerRoute"];
  recycled("a provider-route change", "providerRoute", () => ({ providerRoute: route("r2") }), {}, { ...base, model: "claude-fixture", providerRoute: route("r1") });
  recycled("a credential kind change (a memory token appears)", "mcp", () => ({ integrations: { ...agents("tok-1"), memory: { command: process.execPath, args: ["m"], env: { MURAGE_MEMORY_TOKEN: "mem-1" } } } }));
  recycled("a browser mount change", "mcp", () => ({ integrations: { ...agents("tok-1"), browser: { command: process.execPath, args: ["b"], env: { MURAGE_BROWSER_TOKEN: "br-1" } } } }));
  recycled("a computer mount change", "mcp", () => ({ integrations: { ...agents("tok-1"), computer: { boxId: "box", token: "box-token" } } }));
  recycled("a sessionReset", "sessionReset", () => ({ sessionReset: true }));

  it("a different thread never adopts another thread's process even with identical inputs", async () => {
    await create();
    const a = await run("t-own-a", "one", base);
    const b = await run("t-own-b", "one", base);
    expect(b.pid).not.toBe(a.pid);
    expect(b.trace).toContain("process=spawned reason=no-process");
  });

  it("recycles the process after a Stop", async () => {
    await create();
    const one = await run("t-stop", "one", base);
    const held = await instance.adapter.sendTurn({ threadId: "t-stop", text: "__fixture_hold_authority__ two", resumeCursor: sessions.get("t-stop"), ...base });
    await recorder.until((e) => e.type === "session.started" && e.turnId === held.turnId);
    await instance.adapter.interruptTurn("t-stop", held.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === held.turnId);
    const three = await run("t-stop", "three", base);
    expect(three.pid).not.toBe(one.pid);
    expect(three.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
  });

  it("recycles the process when a background shell task is still running at settle", async () => {
    await create();
    const one = await run("t-shell", "one", base);
    const two = await run("t-shell", "__fixture_shell_task__", base);
    expect(two.pid).toBe(one.pid);
    const three = await run("t-shell", "three", base);
    expect(three.pid).not.toBe(two.pid);
    expect(three.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
  });

  it("recycles the process when a sub-agent is still running at the cap", async () => {
    process.env.MURAGE_CLAUDE_BACKGROUND_CAP_MIN_MS = "50";
    process.env.FAKE_CLAUDE_BG_HOLD = "1";
    process.env.FAKE_CLAUDE_BG_ASKS = "0";
    await create({ backgroundTaskCapMs: 300 });
    const one = await run("t-agent", "__fixture_background__", base);
    const two = await run("t-agent", "two", base);
    expect(two.pid).not.toBe(one.pid);
    expect(two.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
  });

  it("resetSession on a session whose CLI already closed confirms the tree, not a close event that already fired", async () => {
    // The CLI closed while idle and the driver is still confirming its tree
    // stopped, so the session is still in the map. A reset in that window
    // used to wait for a second "close" that never comes and fail the next
    // send with CLAUDE_SESSION_RESET_TIMEOUT after 10 s.
    await create();
    const one = await run("t-dead", "one", base);
    let release: () => void = () => {};
    probe.treeGate = new Promise<void>((resolve) => { release = resolve; });
    process.kill(one.pid, "SIGKILL");
    // Wait for the close handler itself (it starts the tree confirmation), so
    // the reset below always lands after "close" fired, never before it.
    await vi.waitFor(() => expect(probe.treeGated).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    const started = Date.now();
    const reset = instance.adapter.resetSession!("t-dead").then(() => "reset", (error: unknown) => String(error));
    setTimeout(() => { probe.treeGate = null; release(); }, 500);
    expect(await reset).toBe("reset");
    expect(Date.now() - started).toBeLessThan(5_000);
    const two = await run("t-dead", "two", base);
    expect(two.pid).not.toBe(one.pid);
  }, 20_000);

  it("resetSession on a wedged CLI (ignores SIGTERM and stdin EOF) kills its tree and never fails: the next send runs on a fresh session", async () => {
    // 1.0.1.1: a CLI that would not close in 10 s failed the owner's turn
    // with CLAUDE_SESSION_RESET_TIMEOUT. A reset now waits a short grace,
    // then kills the whole tree and goes on.
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    try {
      await create();
      const one = await run("t-wedged", "one", base);
      const started = Date.now();
      const reset = await instance.adapter.resetSession!("t-wedged").then(() => "reset", (error: unknown) => String(error));
      const took = Date.now() - started;
      expect(reset).toBe("reset");
      expect(took).toBeLessThan(3_500);
      // the old process is gone: it cannot answer for the thread
      expect(() => process.kill(one.pid, 0)).toThrow();
      const two = await run("t-wedged", "two", { ...base, sessionReset: true });
      expect(two.pid).not.toBe(one.pid);
      expect(two.trace).toMatch(/process=spawned reason=(no-process|sessionReset)/);
      const replies = recorder.events.filter((e) => e.type === "turn.completed" && e.threadId === "t-wedged");
      expect(replies).toHaveLength(2);
    } finally {
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
    }
  }, 20_000);

  it("a reset whose old tree cannot be confirmed keeps the thread blocked: the next send fails retryably, then runs once the tree is confirmed", async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    try {
      await create();
      const one = await run("t-blocked", "one", base);
      probe.forceFails = true;
      await instance.adapter.resetSession!("t-blocked");
      // never beside a live old tree: the old process is still there
      expect(() => process.kill(one.pid, 0)).not.toThrow();
      const blocked = await instance.adapter.sendTurn({ threadId: "t-blocked", text: "two", ...base, sessionReset: true }).then(() => "sent", (error: unknown) => String(error));
      expect(blocked).toMatch(/CLAUDE_SESSION_NOT_STOPPED/);
      expect(() => process.kill(one.pid, 0)).not.toThrow();
      probe.forceFails = false;
      const two = await run("t-blocked", "two", { ...base, sessionReset: true });
      expect(two.pid).not.toBe(one.pid);
      expect(() => process.kill(one.pid, 0)).toThrow();
    } finally {
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
    }
  }, 30_000);

  it("a late init frame from a retired session is ignored: no session.started, no resume cursor", async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    process.env.FAKE_CLAUDE_LATE_INIT = "1";
    try {
      await create();
      await run("t-late-init", "one", base);
      const before = recorder.events.filter((e) => e.type === "session.started" && e.threadId === "t-late-init").length;
      const started = Date.now();
      await instance.adapter.resetSession!("t-late-init");
      expect(Date.now() - started).toBeLessThan(3_500);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = recorder.events.filter((e) => e.type === "session.started" && e.threadId === "t-late-init");
      expect(after).toHaveLength(before);
      expect(JSON.stringify(after)).not.toContain("late-retired-session");
    } finally {
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
      delete process.env.FAKE_CLAUDE_LATE_INIT;
    }
  }, 20_000);

  it("a send and a prewarm that arrive while a reset is in progress wait for it: nothing launches beside the old tree", async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    try {
      await create();
      const one = await run("t-barrier", "one", base);
      const order: string[] = [];
      info.mockImplementation((line: unknown) => {
        if (typeof line !== "string") return;
        if (line.startsWith("claude dispatch")) { traces.push(line); order.push("dispatch"); }
        else if (line.startsWith("claude reset thread=")) order.push("reset-done");
      });
      const reset = instance.adapter.resetSession!("t-barrier");
      // both arrive inside the reset's wait for the wedged old tree
      const warmed = instance.adapter.prewarm!("t-barrier");
      const sent = await instance.adapter.sendTurn({ threadId: "t-barrier", text: "two", ...base, sessionReset: true });
      await reset;
      expect(await warmed).toBe(false);
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
      expect(order[0]).toBe("reset-done");
      expect(order.filter((entry) => entry === "dispatch")).toHaveLength(1);
      expect(() => process.kill(one.pid, 0)).toThrow();
      const two = JSON.parse(readFileSync(dump, "utf8")).pid as number;
      expect(two).not.toBe(one.pid);
    } finally {
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
    }
  }, 30_000);

  it("a late init from a closing session whose stopped turn is still open is ignored", async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    process.env.FAKE_CLAUDE_LATE_INIT = "1";
    process.env.FAKE_CLAUDE_MODE = "hang";
    try {
      await create();
      const sent = await instance.adapter.sendTurn({ threadId: "t-late-active", text: "go", ...base });
      await recorder.until((e) => e.type === "session.started" && e.threadId === "t-late-active");
      const before = recorder.events.filter((e) => e.type === "session.started" && e.threadId === "t-late-active").length;
      await instance.adapter.resetSession!("t-late-active");
      await new Promise((resolve) => setTimeout(resolve, 400));
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
      const after = recorder.events.filter((e) => e.type === "session.started" && e.threadId === "t-late-active");
      expect(after).toHaveLength(before);
      expect(JSON.stringify(after)).not.toContain("late-retired-session");
    } finally {
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
      delete process.env.FAKE_CLAUDE_LATE_INIT;
    }
  }, 30_000);

  it("a tree that cannot be confirmed stopped still settles the turn; the thread then refuses a launch retryably until a confirmation succeeds", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    await create();
    const sent = await instance.adapter.sendTurn({ threadId: "t-quarantine", text: "go", ...base });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-quarantine");
    probe.stopFails = true;
    probe.forceFails = true;
    await instance.adapter.interruptTurn("t-quarantine").catch(() => undefined);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId) as { ok?: boolean };
    expect(done.ok).toBe(false);
    expect(recorder.events.some((e) => e.type === "runtime.error" && String((e as { message?: string }).message).startsWith("CLAUDE_SESSION_NOT_STOPPED"))).toBe(true);
    // settled, but quarantined: the retry is refused, retryably, and nothing is launched
    process.env.FAKE_CLAUDE_MODE = "happy";
    const refused = await instance.adapter.sendTurn({ threadId: "t-quarantine", text: "again", ...base }).then(() => "sent", (error: unknown) => String(error));
    expect(refused).toMatch(/CLAUDE_SESSION_NOT_STOPPED/);
    // a later confirmation succeeds: the thread is free
    probe.stopFails = false;
    probe.forceFails = false;
    const again = await run("t-quarantine", "again", base);
    expect(again.pid).toBeGreaterThan(0);
  }, 30_000);

  it("termination fails and the root's close never arrives: the turn still settles, quarantined, without waiting for the close", async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    process.env.FAKE_CLAUDE_MODE = "hang";
    try {
      await create();
      const sent = await instance.adapter.sendTurn({ threadId: "t-noclose", text: "go", ...base });
      await recorder.until((e) => e.type === "session.started" && e.threadId === "t-noclose");
      probe.stopFails = true;
      probe.forceFails = true;
      const stoppedAt = Date.now();
      await instance.adapter.interruptTurn("t-noclose").catch(() => undefined);
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId) as { ok?: boolean };
      // settled before the real SIGKILL escalation could have closed the root
      expect(Date.now() - stoppedAt).toBeLessThan(2_500);
      expect(done.ok).toBe(false);
      expect(recorder.events.some((e) => e.type === "runtime.error" && String((e as { message?: string }).message).startsWith("CLAUDE_SESSION_NOT_STOPPED"))).toBe(true);
      process.env.FAKE_CLAUDE_MODE = "happy";
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
      const refused = await instance.adapter.sendTurn({ threadId: "t-noclose", text: "again", ...base }).then(() => "sent", (error: unknown) => String(error));
      expect(refused).toMatch(/CLAUDE_SESSION_NOT_STOPPED/);
      probe.stopFails = false;
      probe.forceFails = false;
      const again = await run("t-noclose", "again", base);
      expect(again.pid).toBeGreaterThan(0);
    } finally {
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
    }
  }, 30_000);

  it("confirmations that permanently disagree with the lifecycle proof never spin: bounded calls over 2 s, the event loop stays live, the turn gets the retryable error", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    try {
      await create();
      const sent = await instance.adapter.sendTurn({ threadId: "t-disagree", text: "go", ...base });
      await recorder.until((e) => e.type === "session.started" && e.threadId === "t-disagree");
      probe.disagree = true;
      probe.calls = { await: 0, force: 0, outcome: 0 };
      await instance.adapter.interruptTurn("t-disagree").catch(() => undefined);
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId) as { ok?: boolean };
      expect(done.ok).toBe(false);
      expect(recorder.events.some((e) => e.type === "runtime.error" && String((e as { message?: string }).message).startsWith("CLAUDE_SESSION_NOT_STOPPED"))).toBe(true);
      let ticks = 0;
      const ticker = setInterval(() => { ticks++; }, 100);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      clearInterval(ticker);
      expect(ticks).toBeGreaterThanOrEqual(10); // timers kept firing: no microtask spin
      const total = probe.calls.await + probe.calls.force + probe.calls.outcome;
      expect(total).toBeLessThan(40);
    } finally {
      probe.disagree = false;
      process.env.FAKE_CLAUDE_MODE = "happy";
    }
  }, 30_000);

  it("a stopped turn past its 5 s deadline leads into quarantine recovery, not a dead end: it settles, then the send waits for the confirmation", async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = "1";
    process.env.FAKE_CLAUDE_MODE = "hang";
    process.env.MURAGE_PROVIDER_CLOSE_MS = "300";
    let release = () => {};
    probe.treeGate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await create();
      const sent = await instance.adapter.sendTurn({ threadId: "t-deadline", text: "go", ...base });
      await recorder.until((e) => e.type === "session.started" && e.threadId === "t-deadline");
      // the stop is requested but its confirmation hangs: no close, no quarantine yet
      await instance.adapter.interruptTurn("t-deadline").catch(() => undefined);
      probe.forceFails = true;
      process.env.FAKE_CLAUDE_MODE = "happy";
      const refused = await instance.adapter.sendTurn({ threadId: "t-deadline", text: "again", ...base }).then(() => "sent", (error: unknown) => String(error));
      // the old turn was settled by the quarantine, and the refusal is the retryable one
      expect(refused).toMatch(/CLAUDE_SESSION_NOT_STOPPED/);
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
      probe.forceFails = false;
      const again = await run("t-deadline", "again", base);
      expect(again.pid).toBeGreaterThan(0);
    } finally {
      release();
      probe.treeGate = null;
      delete process.env.FAKE_CLAUDE_IGNORE_TERM;
      delete process.env.MURAGE_PROVIDER_CLOSE_MS;
    }
  }, 30_000);

  it("a quarantine or reset that arises during launch setup is waited out (bounded): the in-flight turn is cancelled by the reset, the next send goes through once", async () => {
    await create();
    const one = await run("t-late-wait", "one", base);
    const spy = vi.spyOn(warmPool, "beforeSpawn").mockImplementationOnce(async () => {
      // a reset begins after the dispatch's early check: its barrier is up when setup reaches the spawn
      void instance.adapter.resetSession!("t-late-wait");
    });
    try {
      const two = await run("t-late-wait", "two", { ...base, sessionReset: true });
      // The reset that arose during setup stops the in-flight turn by design (it never
      // fails it with an error): "two" settles as cancelled and nothing is refused.
      expect(two.pid).toBe(one.pid); // the dump is still the first process's: "two" never spawned
      const completed = recorder.events.filter((e) => e.type === "turn.completed" && e.threadId === "t-late-wait") as Array<{ ok?: boolean; stopReason?: string }>;
      expect(completed).toHaveLength(2);
      expect(completed[1]?.stopReason).toBe("cancelled");
      expect(recorder.events.some((e) => e.type === "runtime.error" && String((e as { message?: string }).message).startsWith("CLAUDE_SESSION_NOT_STOPPED"))).toBe(false);
      // the thread then recovers: the next send is really delivered to a fresh process
      const three = await run("t-late-wait", "three", { ...base, sessionReset: true });
      expect(JSON.stringify(three.seen.prompt)).toContain("three");
      expect(three.pid).not.toBe(one.pid);
      expect(recorder.events.some((e) => e.type === "runtime.error" && String((e as { message?: string }).message).startsWith("CLAUDE_SESSION_NOT_STOPPED"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("recycles the process when a child process of the CLI is still alive at settle", async () => {
    await create();
    const one = await run("t-child", "one", base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // a listing that shows one process beyond the (empty) baseline at settle
    probe.override = async () => new Set([4_000_000]);
    const two = await run("t-child", "__fixture_spawn_child__", base);
    const kid = Number(readFileSync(process.env.FAKE_CLAUDE_CHILD_PID!, "utf8"));
    try {
      expect(two.pid).toBe(one.pid);
      const three = await run("t-child", "three", base);
      expect(three.pid).not.toBe(two.pid);
      expect(three.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
    } finally {
      try { process.kill(kid, "SIGKILL"); } catch { /* already gone with its parent */ }
    }
  });


  // Background-work detection fails closed: anything short of a clean answer recycles.
  it("recycles when the process probe has no answer (null)", async () => {
    await create();
    const one = await run("t-null", "one", base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    probe.override = async () => null;
    const two = await run("t-null", "two", base);
    expect(two.pid).toBe(one.pid);
    const three = await run("t-null", "three", base);
    expect(three.pid).not.toBe(two.pid);
    expect(three.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
  });

  it("recycles when the process probe throws", async () => {
    await create();
    const one = await run("t-throw", "one", base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    probe.override = async () => { throw new Error("ps blew up"); };
    const two = await run("t-throw", "two", base);
    expect(two.pid).toBe(one.pid);
    const three = await run("t-throw", "three", base);
    expect(three.pid).not.toBe(two.pid);
  });

  it("recycles when no baseline was ever taken (the init-time probe failed)", async () => {
    probe.baselineOverride = async () => null;
    await create();
    const one = await run("t-nobase", "one", base);
    probe.baselineOverride = null;
    const two = await run("t-nobase", "two", base);
    expect(two.pid).not.toBe(one.pid);
  });

  it("recycles when the baseline probe rejects", async () => {
    probe.baselineOverride = async () => { throw new Error("ps blew up"); };
    await create();
    const one = await run("t-basethrow", "one", base);
    probe.baselineOverride = null;
    const two = await run("t-basethrow", "two", base);
    expect(two.pid).not.toBe(one.pid);
  });

  it("a baseline probe that never answers is bounded at settle and the process is recycled", async () => {
    probe.baselineOverride = () => new Promise(() => {});
    await create();
    const one = await run("t-basehang", "one", base);
    probe.baselineOverride = null;
    const two = await run("t-basehang", "two", base);
    expect(two.pid).not.toBe(one.pid);
  }, 60_000);

  it("the baseline probe is handed the CLI's pid and an init time taken when init was handled", async () => {
    const calls: Array<{ pid: number; initAt: number }> = [];
    const before = Date.now();
    probe.baselineOverride = async (pid, initAt) => { calls.push({ pid, initAt }); return new Set(); };
    await create();
    const one = await run("t-initat", "one", base);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pid).toBe(one.pid);
    expect(calls[0]!.initAt).toBeGreaterThanOrEqual(before);
    expect(calls[0]!.initAt).toBeLessThanOrEqual(Date.now());
  });

  it("R3-3: a steer queued before init settles when the pre-accept launch dies and the turn is retried", async () => {
    useTmp(scratch);
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "state");
    await create();
    const sending = instance.adapter.sendTurn({ threadId: "t-steer-retry", text: "x".repeat(4 * 1024 * 1024), ...base });
    // queue the steer while the launch is pre-init (a settled-false answer means it was not queued yet)
    const pending = Symbol("pending");
    let steered: Promise<boolean | SteerDelivery> | null = null;
    for (let i = 0; i < 2000 && !steered; i++) {
      const attempt = instance.adapter.steer!("t-steer-retry", "STEER-STRANDED");
      if ((await Promise.race([attempt, Promise.resolve(pending)])) === pending) steered = attempt;
      else await new Promise((resolve) => setImmediate(resolve));
    }
    expect(steered).not.toBeNull();
    const sent = await sending;
    await recorder.until((e) => e.type === "turn.retrying" && e.turnId === sent.turnId);
    const outcome = await Promise.race([steered!, new Promise<string>((resolve) => setTimeout(() => resolve("stranded"), 3000))]);
    expect(outcome).toBe(false);
    await instance.adapter.interruptTurn("t-steer-retry", sent.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
  }, 30_000);

  it("has the settle check in place before turn.completed reaches a listener that dispatches at once", async () => {
    await create();
    const route = { connectionId: "c1", revision: "r1", preset: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "fixture-only-not-real", model: "claude-fixture" } as unknown as SendTurnInput["providerRoute"];
    const routed = { ...base, model: "claude-fixture", providerRoute: route };
    const one = await run("t-order", "one", routed);
    await new Promise((resolve) => setTimeout(resolve, 300));
    probe.override = async () => null;
    let followUp: Promise<unknown> | null = null;
    const unsubscribe = instance.adapter.onEvent((event) => {
      if (event.type === "turn.completed" && event.threadId === "t-order" && !followUp) {
        followUp = instance.adapter.sendTurn({ threadId: "t-order", text: "three", resumeCursor: sessions.get("t-order"), ...routed });
      }
    });
    const two = await run("t-order", "two", routed);
    await followUp;
    unsubscribe();
    expect(two.pid).toBe(one.pid);
    expect(traces.at(-1)).toMatch(/process=spawned reason=(no-process|process-exited)/);
  });

  it("a second dispatch that raced the settle check cannot kill the first turn's process", async () => {
    await create();
    await run("t-race", "one", base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    probe.override = async () => { await gate; return new Set<number>(); };
    await run("t-race", "two", base);
    probe.override = async () => { await gate; return new Set<number>(); };
    const first = instance.adapter.sendTurn({ threadId: "t-race", text: "three", resumeCursor: sessions.get("t-race"), ...base });
    const second = instance.adapter.sendTurn({ threadId: "t-race", text: "four", resumeCursor: sessions.get("t-race"), ...base });
    release();
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === (a as PromiseFulfilledResult<{ turnId: string }>).value.turnId);
    const finished = recorder.events.filter((e) => e.type === "turn.completed" && e.threadId === "t-race");
    expect(finished.every((e) => (e as { ok?: boolean }).ok)).toBe(true);
  });

  it("two overlapping first dispatches on one thread start one process, and the loser is refused", async () => {
    await create();
    const first = instance.adapter.sendTurn({ threadId: "t-overlap", text: "one", ...base });
    const second = instance.adapter.sendTurn({ threadId: "t-overlap", text: "two", ...base });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason)).toContain("a turn is already running on this thread");
    const winner = (settled.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ turnId: string }>).value;
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === winner.turnId);
    expect(recorder.events.filter((e) => e.type === "session.started" && e.threadId === "t-overlap")).toHaveLength(1);
    const finished = recorder.events.filter((e) => e.type === "turn.completed" && e.threadId === "t-overlap");
    expect(finished).toHaveLength(1);
    expect((finished[0] as { ok?: boolean }).ok).toBe(true);
  });

  // The emptying rename is made to fail by putting a non-empty directory where the
  // credential file is: a rename onto it fails on every platform and for root too
  // (a chmod on the directory does nothing on Windows and nothing to root).
  it("recycles the process when the credential cannot be emptied at settle", async () => {
    const gateFile = join(scratch, "hold.gate");
    process.env.FAKE_CLAUDE_HOLD_MARKER = "__hold_here__";
    process.env.FAKE_CLAUDE_HOLD_GATE = gateFile;
    process.env.FAKE_CLAUDE_HOLD_SEEN = join(scratch, "hold.seen");
    await create();
    const one = await run("t-clear", "one", base);
    const held = await instance.adapter.sendTurn({ threadId: "t-clear", text: "__hold_here__ two", resumeCursor: sessions.get("t-clear"), ...base });
    for (let i = 0; i < 100 && !existsSync(process.env.FAKE_CLAUDE_HOLD_SEEN!); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    rmSync(one.cred.path, { force: true });
    mkdirSync(one.cred.path); // the emptying rename now fails
    writeFileSync(join(one.cred.path, "keep"), "x");
    writeFileSync(gateFile, "go");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === held.turnId);
    const three = await run("t-clear", "three", base);
    expect(three.pid).not.toBe(one.pid);
  });

  it("recycles the process after a sign-in failure, so the next turn starts with fresh auth", async () => {
    await create();
    process.env.FAKE_CLAUDE_MODE = "not-logged-in";
    const one = await run("t-auth", "one", base);
    delete process.env.FAKE_CLAUDE_MODE;
    const two = await run("t-auth", "two", base);
    expect(two.pid).not.toBe(one.pid);
    expect(two.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
  });

  it("recycles when the CLI's settings change between turns (settingsRev)", async () => {
    const configDir = join(scratch, "claude-config");
    mkdirSync(configDir);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await create();
    const one = await run("t-rev", "one", base);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ hooks: {} }));
    const two = await run("t-rev", "two", base);
    expect(two.pid).not.toBe(one.pid);
    expect(two.trace).toContain("process=spawned reason=settingsRev");
  });

  it("recycles when the project's .claude/settings.json or settings.local.json changes between turns", async () => {
    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ effortLevel: "low" }));
    await create();
    const one = await run("t-proj", "one", { ...base, cwd: project });
    const same = await run("t-proj", "same", { ...base, cwd: project });
    expect(same.pid).toBe(one.pid);
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ effortLevel: "high", hooks: {} }));
    const two = await run("t-proj", "two", { ...base, cwd: project });
    expect(two.pid).not.toBe(one.pid);
    expect(two.trace).toContain("process=spawned reason=settingsRev");
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: {} }));
    const three = await run("t-proj", "three", { ...base, cwd: project });
    expect(three.pid).not.toBe(two.pid);
    expect(three.trace).toContain("process=spawned reason=settingsRev");
  });

  it("the settings revision covers the repository root's and the main checkout's settings.local.json (subdirectory and worktree)", () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
    mkdirSync(join(scratch, "rev-repo", "sub", "deeper"), { recursive: true });
    const repo = realpathSync.native(join(scratch, "rev-repo"));
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const env = { CLAUDE_CONFIG_DIR: join(scratch, "rev-config") };
    const sub = join(repo, "sub", "deeper");
    expect(claudeGitRoots(sub)).toEqual([repo]);
    const before = claudeSettingsRevision(env, sub, []);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: {} }));
    const after = claudeSettingsRevision(env, sub, []);
    expect(after).not.toBe(before);
    // A linked worktree resolves the local file at the main checkout's root as well as its own.
    const tree = join(scratch, "rev-tree");
    git(repo, "worktree", "add", "-q", tree);
    const treeReal = realpathSync.native(tree);
    expect(claudeGitRoots(treeReal)).toEqual([treeReal, repo]);
    const treeBefore = claudeSettingsRevision(env, treeReal, []);
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
    expect(claudeSettingsRevision(env, treeReal, [])).not.toBe(treeBefore);
    // Outside git there are no extra roots, and nothing throws.
    const plain = join(scratch, "rev-plain");
    mkdirSync(plain, { recursive: true });
    expect(claudeGitRoots(join(plain, "missing"))).toEqual([]);
  });

  it("the settings revision covers managed settings and never carries file contents", () => {
    const project = join(scratch, "rev-project");
    const managed = join(scratch, "managed-settings.json");
    mkdirSync(join(project, ".claude"), { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: join(scratch, "rev-config") };
    const before = claudeSettingsRevision(env, project, [managed]);
    writeFileSync(managed, JSON.stringify({ secretMarker: "do-not-leak" }));
    const after = claudeSettingsRevision(env, project, [managed]);
    expect(after).not.toBe(before);
    expect(after).not.toContain("do-not-leak");
    expect(after).not.toContain("secretMarker");
    expect(managedClaudeSettingsPaths().length).toBeGreaterThan(0);
  });

  it("unlinks the credential file of a launch that died before accepting before the relaunch, not only at it", async () => {
    useTmp(scratch);
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "state");
    await create();
    // a prompt larger than any pipe buffer makes the pre-accept launch refuse the write
    let leftAtRetry: string[] | null = null;
    const unsubscribe = instance.adapter.onEvent((event) => {
      if (event.type === "turn.retrying") leftAtRetry = readdirSync(scratch).filter((name) => name.startsWith("murage-cred-"));
    });
    const sent = await instance.adapter.sendTurn({ threadId: "t-retry", text: "x".repeat(4 * 1024 * 1024), ...base });
    await recorder.until((e) => e.type === "turn.retrying" && e.turnId === sent.turnId);
    unsubscribe();
    // the dead launch's file is gone while the retry waits out its backoff
    expect(leftAtRetry).toEqual([]);
    await instance.adapter.interruptTurn("t-retry", sent.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
  }, 20_000);

  // Design T3 end to end: the real capability registry gates a stand-in route,
  // the driver delivers each turn's real token through the file, and during
  // turn N+1 the route refuses turn N's token while the file holds N+1's.
  it("refuses turn N's token at the route during turn N+1 on the same warm process", async () => {
    const registry = new InternalCapabilities();
    const route: Server = createServer((req, res) => { req.resume(); res.writeHead(registry.resolve(req.headers.authorization) ? 200 : 401).end(); });
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
    const port = (route.address() as { port: number }).port;
    const hit = async (token: string) => (await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${token}` } })).status;
    const gateFile = join(scratch, "t3.gate");
    process.env.FAKE_CLAUDE_HOLD_MARKER = "__hold_here__";
    process.env.FAKE_CLAUDE_HOLD_GATE = gateFile;
    process.env.FAKE_CLAUDE_HOLD_SEEN = join(scratch, "t3.seen");
    try {
      await create();
      const turnWith = (generation: string) => {
        registry.begin("bot", "t-e2e", generation);
        const token = registry.mint({ botId: "bot", threadId: "t-e2e", generation, kind: "agents", depth: 0, skillAuthoring: false });
        return { token, input: { ...base, integrations: agents(token) } };
      };
      const first = turnWith("g1");
      const one = await run("t-e2e", "one", first.input);
      expect(await hit(first.token)).toBe(200); // still the live generation until the harness settles it
      registry.revokeGeneration("t-e2e", "g1"); // harness: turn N settled
      const second = turnWith("g2");
      const held = await instance.adapter.sendTurn({ threadId: "t-e2e", text: "__hold_here__ two", resumeCursor: sessions.get("t-e2e"), ...second.input });
      for (let i = 0; i < 100 && !existsSync(process.env.FAKE_CLAUDE_HOLD_SEEN!); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const inFile = JSON.parse(readFileSync(one.cred.path, "utf8")) as Record<string, Record<string, string>>;
      expect(JSON.stringify(inFile)).toContain(second.token);
      expect(JSON.stringify(inFile)).not.toContain(first.token);
      expect(await hit(first.token)).toBe(401);
      expect(await hit(second.token)).toBe(200);
      writeFileSync(gateFile, "go");
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === held.turnId);
      expect(readFileSync(one.cred.path, "utf8")).toBe("{}");
    } finally {
      await new Promise<void>((resolve) => route.close(() => resolve()));
    }
  });

  it("unlinks the credential file when the instance is disposed", async () => {
    await create();
    const one = await run("t-dispose", "one", base);
    expect(existsSync(one.cred.path)).toBe(true);
    await instance.dispose();
    expect(existsSync(one.cred.path)).toBe(false);
    expect(existsSync(dirname(one.cred.path))).toBe(false);
  });
  it("A: a Stop during the settle-check wait reaches the dispatch, and nothing is launched for it", async () => {
    await create();
    await run("t-stopwait", "one", base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    probe.override = async () => { await gate; return new Set<number>(); };
    const two = await run("t-stopwait", "two", base);
    const dispatched = traces.length;
    const third = instance.adapter.sendTurn({ threadId: "t-stopwait", text: "three", resumeCursor: sessions.get("t-stopwait"), ...base });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.adapter.hasSession("t-stopwait")).toBe(true);
    await instance.adapter.interruptTurn("t-stopwait");
    // the Stop ends the waiting dispatch without the probe ever answering
    const outcome = await Promise.race([third, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000))]);
    expect(outcome).not.toBe("hung");
    const stopped = outcome as { turnId: string };
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === stopped.turnId);
    expect((done as { stopReason?: string }).stopReason).toBe("cancelled");
    expect(traces).toHaveLength(dispatched);
    // a message sent right after the Stop waits for the stopped dispatch's close, then runs on the same warm process
    const fourth = instance.adapter.sendTurn({ threadId: "t-stopwait", text: "four", resumeCursor: sessions.get("t-stopwait"), ...base });
    release();
    const sent = await fourth;
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.pid).toBe(two.pid);
    expect(traces).toHaveLength(dispatched + 1);
  });

  it("C: a rotated credential with the same model, URL and connection respawns with reason=credentials", async () => {
    await create();
    const keyed = (apiKey: string) => ({ ...route("r1"), apiKey }) as unknown as SendTurnInput["providerRoute"];
    const one = await run("t-rotate", "one", { ...base, model: "claude-fixture", providerRoute: keyed("fixture-key-one") });
    const same = await run("t-rotate", "same", { ...base, model: "claude-fixture", providerRoute: keyed("fixture-key-one") });
    expect(same.pid).toBe(one.pid);
    const rotated = await run("t-rotate", "rotated", { ...base, model: "claude-fixture", providerRoute: keyed("fixture-key-two") });
    expect(rotated.pid).not.toBe(one.pid);
    expect(rotated.trace).toContain("process=spawned reason=credentials");
    expect(rotated.trace).not.toContain("fixture-key");
  });

  it("R1: the baseline is taken at init, so a first-turn child is leftover work and MCP-style children are not (real ps)", async () => {
    const seen: number[] = [];
    probe.real = true;
    const real = await vi.importActual<typeof import("./process-tree.ts")>("./process-tree.ts");
    probe.baselineOverride = (pid, initAt) => { seen.push(pid); return real.descendantBaseline(pid, initAt); };
    await create();
    const one = await run("t-base", "__fixture_spawn_child__ one", base);
    const kid = Number(readFileSync(process.env.FAKE_CLAUDE_CHILD_PID!, "utf8"));
    try {
      // taken exactly once, with the CLI's own pid, for the init message
      expect(seen).toEqual([one.pid]);
      probe.baselineOverride = null;
      const two = await run("t-base", "two", base);
      expect(two.pid).not.toBe(one.pid);
      expect(two.trace).toMatch(/process=spawned reason=(no-process|process-exited)/);
    } finally {
      try { process.kill(kid, "SIGKILL"); } catch { /* gone with its parent */ }
    }
  }, 60_000);

  it("the event loop is not blocked while the baseline probe is pending", async () => {
    probe.baselineOverride = () => new Promise((resolve) => { setTimeout(() => resolve(new Set()), 1_000); });
    await create();
    const sending = run("t-loop", "one", base);
    // a timer scheduled while the probe is outstanding fires on time
    const lag = await new Promise<number>((resolve) => { const at = Date.now(); setTimeout(() => resolve(Date.now() - at - 100), 100); });
    expect(lag).toBeLessThan(400);
    await sending;
  }, 60_000);

  it("R3: a Stop raised while turn.started is delivered writes nothing, cold and warm, and settles cancelled", async () => {
    await create();
    const stopOnStart = (threadId: string) => instance.adapter.onEvent((event) => {
      if (event.type === "turn.started" && event.threadId === threadId) void instance.adapter.interruptTurn(threadId);
    });
    // cold: no process exists yet
    let off = stopOnStart("t-r3-cold");
    const cold = await instance.adapter.sendTurn({ threadId: "t-r3-cold", text: "never written", ...base });
    const coldDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === cold.turnId);
    off();
    expect((coldDone as { stopReason?: string }).stopReason).toBe("cancelled");
    expect(existsSync(dump)).toBe(false);
    // warm: the process exists and is idle
    await run("t-r3-warm", "one", base);
    rmSync(dump, { force: true });
    off = stopOnStart("t-r3-warm");
    const warm = await instance.adapter.sendTurn({ threadId: "t-r3-warm", text: "never written either", resumeCursor: sessions.get("t-r3-warm"), ...base });
    const warmDone = await recorder.until((e) => e.type === "turn.completed" && e.turnId === warm.turnId);
    off();
    expect((warmDone as { stopReason?: string }).stopReason).toBe("cancelled");
    expect(existsSync(dump)).toBe(false);
  });

});

describe("warm key", () => {
  it("names the first differing field, in declared order", () => {
    const a = warmKey({ bot: "b1", audience: "owner", args: ["--x"] });
    expect(diffWarmKey(a, warmKey({ bot: "b1", audience: "owner", args: ["--x"] }))).toBeNull();
    expect(diffWarmKey(a, warmKey({ bot: "b1", audience: "non-owner", args: ["--y"] }))).toBe("audience");
  });

  it("D: keeps no plaintext secret, only digests and field names", () => {
    const secret = "box-token-SECRET-123";
    const key = warmKey({
      bot: "bot-identity-xyz",
      mcp: { computer: { command: "node", args: ["--token", secret], env: { MURAGEBOX_BOX_TOKEN: secret }, headers: { Authorization: `Bearer ${secret}` } } },
      args: ["--x"],
    });
    expect(JSON.stringify(key)).not.toContain(secret);
    expect(JSON.stringify(key)).not.toContain("MURAGEBOX_BOX_TOKEN");
    expect(JSON.stringify(key)).not.toContain("bot-identity-xyz");
    // the reason is still the field's name
    const rotated = warmKey({ bot: "bot-identity-xyz", mcp: { computer: { command: "node", args: ["--token", "other"], env: { MURAGEBOX_BOX_TOKEN: "other" } } }, args: ["--x"] });
    expect(diffWarmKey(key, rotated)).toBe("mcp");
    expect(diffWarmKey(key, key)).toBeNull();
  });

  it("C: a credential digest changes with the value and never contains it", () => {
    const one = credentialDigest({ ANTHROPIC_AUTH_TOKEN: "sk-one", ANTHROPIC_BASE_URL: "http://h" });
    expect(credentialDigest({ ANTHROPIC_AUTH_TOKEN: "sk-one", ANTHROPIC_BASE_URL: "http://h" })).toBe(one);
    expect(credentialDigest({ ANTHROPIC_AUTH_TOKEN: "sk-two", ANTHROPIC_BASE_URL: "http://h" })).not.toBe(one);
    expect(one).not.toContain("sk-one");
  });
});

// A minimal stand-in CLI for what the full fake cannot do: frames nobody asked
// for, an earlier turn's task notices inside the next turn, and a process that
// ignores both stdin EOF and SIGTERM (only SIGKILL ends it).
const MINI_CLI_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (process.env.MINI_PIDS) fs.appendFileSync(process.env.MINI_PIDS, process.pid + "\\n");
if (process.env.MINI_STUBBORN === "1") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  setInterval(() => {}, 1000);
}
const stream = (text) => out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const result = (origin) => out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, ...(origin ? { origin: { kind: origin } } : {}) });
let turns = 0;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    const text = typeof msg.message.content === "string" ? msg.message.content : "";
    const log = (line) => { if (process.env.MINI_LOG) fs.appendFileSync(process.env.MINI_LOG, line + "\\n"); };
    log("recv:" + text);
    if (text.startsWith("STEER")) continue;
    turns += 1;
    if (text.includes("SLOW_INIT")) {
      setTimeout(() => { log("init"); out({ type: "system", subtype: "init", session_id: "mini-session", model: "mini" }); stream("OWN-" + turns); out({ type: "assistant", message: { content: [{ type: "text", text: "OWN-" + turns }] } }); result(); }, 300);
      continue;
    }
    log("init");
    out({ type: "system", subtype: "init", session_id: "mini-session", model: "mini" });
    if (text.includes("BG_OWN_FOREIGN")) {
      out({ type: "system", subtype: "task_started", task_id: "own1", description: "own agent", task_type: "local_agent", subagent_type: "Explore", is_backgrounded: true });
      result();
      out({ type: "system", subtype: "task_notification", task_id: "own1", status: "completed" });
      out({ type: "system", subtype: "task_notification", task_id: "ghost", status: "completed" });
      stream("FOREIGN-TEXT");
      out({ type: "assistant", message: { content: [{ type: "text", text: "FOREIGN-TEXT" }] } });
      result("task-notification");
      stream("OWN-FINAL");
      out({ type: "assistant", message: { content: [{ type: "text", text: "OWN-FINAL" }] } });
      result("task-notification");
      continue;
    }
    if (text.includes("STALE_SETUP")) {
      out({ type: "system", subtype: "task_started", task_id: "bg1", description: "old shell", task_type: "local_bash" });
      out({ type: "system", subtype: "task_notification", task_id: "bg1", status: "completed" });
    }
    if (text.includes("FOREIGN")) {
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", description: "old shell", task_type: "local_bash" }] });
      out({ type: "system", subtype: "task_notification", task_id: "ghost", status: "completed" });
      stream("FOREIGN-TEXT");
      out({ type: "assistant", message: { content: [{ type: "text", text: "FOREIGN-TEXT" }] } });
      result("task-notification");
    }
    stream("OWN-" + turns);
    out({ type: "assistant", message: { content: [{ type: "text", text: "OWN-" + turns }] } });
    result();
    if (text.includes("LATE_IDLE")) {
      setTimeout(() => {
        stream("LATE-IDLE-TEXT");
        out({ type: "assistant", message: { content: [{ type: "text", text: "LATE-IDLE-TEXT" }] } });
        result("task-notification");
      }, 250);
    }
  }
});
`;

describe("ClaudeDriver warm process (stale frames and shutdown)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let cli: string;
  let pids: string;
  let closes: string[];
  let info: ReturnType<typeof vi.spyOn>;
  const cursors = new Map<string, string>();
  const mine = () => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const identity = { botId: "b1", audience: "owner" as const };

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-mini-test", displayName: "Claude Mini Test", environment: {}, enabled: true,
      config: { cli, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };
  const turn = async (threadId: string, text: string, extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ threadId, text, warmIdentity: identity, ...(cursors.has(threadId) ? { resumeCursor: cursors.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    cursors.set(threadId, "mini-session");
    return sent.turnId;
  };
  const eventsOf = (turnId: string) => recorder.events.filter((e) => e.turnId === turnId);
  const deltas = (turnId: string) => eventsOf(turnId).filter((e) => e.type === "content.delta").map((e) => (e as { delta: string }).delta).join("|");

  beforeEach(() => {
    ensureDirs();
    cursors.clear();
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-mini-"));
    cli = join(scratch, "mini-claude");
    writeFileSync(cli, MINI_CLI_SOURCE, { mode: 0o755 });
    pids = join(scratch, "pids");
    process.env.MINI_PIDS = pids;
    process.env.MINI_LOG = join(scratch, "mini.log");
    closes = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith("claude close")) closes.push(line);
    });
  });
  afterEach(async () => {
    delete process.env.MINI_PIDS;
    delete process.env.MINI_STUBBORN;
    delete process.env.MINI_LOG;
    info.mockRestore();
    recorder?.stop();
    try { await instance?.dispose(); } catch { /* a stubborn fixture is ended below */ }
    for (const pid of mine()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await removeTempDir(scratch);
  });

  it("F: frames that arrive while the process is idle belong to no turn: dropped, and the process is recycled", async () => {
    await create();
    const first = await turn("t-late", "one LATE_IDLE");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(recorder.events.some((e) => e.type === "content.delta" && (e as { delta: string }).delta.includes("LATE-IDLE-TEXT"))).toBe(false);
    expect(closes.some((line) => line.includes("reason=late frames while idle"))).toBe(true);
    const second = await turn("t-late", "two");
    expect(deltas(second)).toBe("OWN-1");
    expect(mine()).toHaveLength(2);
    expect(eventsOf(first).some((e) => e.type === "content.delta" && (e as { delta: string }).delta.includes("LATE"))).toBe(false);
  });

  it("F: another turn's task frames and follow-up never attach to the next turn, which then recycles", async () => {
    await create();
    await turn("t-foreign", "one STALE_SETUP");
    expect(mine()).toHaveLength(1);
    const second = await turn("t-foreign", "two FOREIGN");
    // no subtask card for the old shell or the ghost, and none of the earlier continuation's text
    expect(eventsOf(second).filter((e) => e.type === "turn.subtask")).toEqual([]);
    expect(deltas(second)).toBe("OWN-2");
    expect(eventsOf(second).some((e) => e.type === "item.completed" && (e as { text?: string }).text === "FOREIGN-TEXT")).toBe(false);
    expect((eventsOf(second).find((e) => e.type === "turn.completed") as { ok?: boolean }).ok).toBe(true);
    expect(closes.some((line) => line.includes("reason=late task notification"))).toBe(true);
    await turn("t-foreign", "three");
    expect(mine()).toHaveLength(2);
  });

  const miniLog = () => (existsSync(process.env.MINI_LOG!) ? readFileSync(process.env.MINI_LOG!, "utf8").split("\n").filter(Boolean) : []);

  it("R4: a steer sent right after a cold dispatch is written only after init has been handled", async () => {
    await create();
    const sent = await instance.adapter.sendTurn({ threadId: "t-steer-cold", text: "one SLOW_INIT", warmIdentity: identity });
    const steered = instance.adapter.steer!("t-steer-cold", "STEER-ME");
    // the CLI has the first prompt; its init is 300 ms away, so the steer has not been written
    for (let i = 0; i < 100 && miniLog().length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(miniLog()).toEqual(["recv:one SLOW_INIT"]);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    await expect(steered).resolves.toBe(true);
    for (let i = 0; i < 50 && miniLog().length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(miniLog()).toEqual(["recv:one SLOW_INIT", "init", "recv:STEER-ME"]);
  });

  it("R4: a steer queued before init is dropped, not written, when the turn is stopped first", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-steer-stop", text: "one SLOW_INIT", warmIdentity: identity });
    const steered = instance.adapter.steer!("t-steer-stop", "STEER-LATE");
    await instance.adapter.interruptTurn("t-steer-stop");
    await expect(steered).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(miniLog().some((line) => line.includes("STEER-LATE"))).toBe(false);
  });

  it("memory r3: a submission fence that refuses during adapter setup writes nothing, on a cold launch and on a reused process", async () => {
    await create();
    const revoked = () => { throw new Error("MEMORY_CONTEXT_REVOKED"); };
    // cold: the fence runs after setup, right before the spawn and first write
    await expect(instance.adapter.sendTurn({ threadId: "t-fence", text: "COLD-REFUSED", warmIdentity: identity, beforeSubmit: revoked })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(mine()).toHaveLength(0);
    expect(instance.adapter.hasSession("t-fence")).toBe(false);
    // warm: a live idle process is not written to either
    await turn("t-fence", "one");
    let calls = 0;
    await expect(instance.adapter.sendTurn({ threadId: "t-fence", text: "WARM-REFUSED", warmIdentity: identity, resumeCursor: "mini-session", beforeSubmit: () => { calls++; revoked(); } })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(miniLog().some((line) => line.includes("REFUSED"))).toBe(false);
    // the fence runs on every write, and a passing one lets the next turn through
    let passes = 0;
    await turn("t-fence", "three", { beforeSubmit: () => { passes++; } });
    expect(passes).toBe(1);
    expect(miniLog().filter((line) => line.startsWith("recv:"))).toEqual(["recv:one", "recv:three"]);
  });

  it("memory r3: a steer queued before init is not written when its session went invalid while it waited", async () => {
    await create();
    const sent = await instance.adapter.sendTurn({ threadId: "t-steer-invalid", text: "one SLOW_INIT", warmIdentity: identity });
    let valid = true;
    const steered = instance.adapter.steer!("t-steer-invalid", "STEER-STALE", () => { if (!valid) throw new Error("MEMORY_CONTEXT_REVOKED"); });
    // the revoke lands while the steer waits for init
    valid = false;
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    await expect(steered).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(miniLog().some((line) => line.includes("STEER-STALE"))).toBe(false);
  });

  it("R5: a foreign continuation's result never completes this turn, even while it is held for its own background agent", async () => {
    await create();
    const id = await turn("t-r5", "go BG_OWN_FOREIGN");
    expect(deltas(id)).toBe("OWN-FINAL");
    expect(eventsOf(id).some((e) => e.type === "item.completed" && (e as { text?: string }).text === "FOREIGN-TEXT")).toBe(false);
    const done = eventsOf(id).filter((e) => e.type === "turn.completed");
    expect(done).toHaveLength(1);
    expect((done[0] as { ok?: boolean }).ok).toBe(true);
    expect(closes.some((line) => line.includes("reason=late task notification"))).toBe(true);
    expect(closes.some((line) => line.includes("late frames while idle"))).toBe(false);
  });

  it("B: a replaced session whose shutdown is pending is still reached by Stop, which confirms it stopped", async () => {
    process.env.MINI_STUBBORN = "1";
    await create();
    await turn("t-replace", "one");
    const [old] = mine();
    // a changed spawn contract replaces the session while the old process ignores EOF and SIGTERM
    await turn("t-replace", "two", { model: "claude-other" });
    expect(mine()).toHaveLength(2);
    expect(alive(old!)).toBe(true);
    await instance.adapter.interruptTurn("t-replace");
    expect(alive(old!)).toBe(false);
  }, 30_000);

  it("B: dispose reaches a replaced session whose shutdown is pending", async () => {
    process.env.MINI_STUBBORN = "1";
    await create();
    await turn("t-replace-d", "one");
    const [old] = mine();
    await turn("t-replace-d", "two", { model: "claude-other" });
    expect(alive(old!)).toBe(true);
    await instance.dispose();
    expect(mine().every((pid) => !alive(pid))).toBe(true);
  }, 30_000);

  it("reset confirms EVERY older retiring process: A retiring, B current, A alive after reset keeps the thread quarantined so C cannot launch", async () => {
    process.env.MINI_STUBBORN = "1";
    await create();
    await turn("t-older", "one");
    const [old] = mine();
    // a changed spawn contract replaces A with B; A ignores EOF and SIGTERM and stays retiring
    await turn("t-older", "two", { model: "claude-other" });
    expect(mine()).toHaveLength(2);
    expect(alive(old!)).toBe(true);
    // the forced stop cannot confirm A (B's is real)
    probe.forceFailPid = old!;
    await instance.adapter.resetSession!("t-older");
    expect(alive(old!)).toBe(true);
    const refused = await instance.adapter.sendTurn({ threadId: "t-older", text: "three", warmIdentity: identity, resumeCursor: "mini-session" }).then(() => "sent", (error: unknown) => String(error));
    expect(refused).toMatch(/CLAUDE_SESSION_NOT_STOPPED/);
    expect(mine()).toHaveLength(2); // C never launched
    // A is confirmed on a later attempt: the thread is free and A is really gone
    probe.forceFailPid = null;
    await turn("t-older", "three");
    expect(alive(old!)).toBe(false);
    expect(mine()).toHaveLength(3);
  }, 40_000);
});

describe("ClaudeDriver intent prewarm (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let lines: string[];
  let info: ReturnType<typeof vi.spyOn>;
  const sessions = new Map<string, string>();
  const agents = (token: string) => ({
    agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: token, MURAGE_TURN_DEPTH: "0" } },
  });
  const base = { integrations: agents("tok-1"), warmIdentity: { botId: "b1", audience: "owner" as const } } satisfies Partial<SendTurnInput>;
  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-prewarm-test", displayName: "Claude Prewarm Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };
  const run = async (threadId: string, text: string, extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    return sent;
  };
  const dispatches = () => lines.filter((l) => l.startsWith("claude dispatch"));
  const prewarms = () => lines.filter((l) => l.startsWith("claude prewarm"));
  const eventually = async (check: () => boolean, ms = 8_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(check()).toBe(true);
  };
  /** A first user turn, then wait for the pool to let its engine go (the window is tiny), so the next prewarm starts cold. */
  const goCold = async (threadId: string) => {
    await run(threadId, "one", base);
    await eventually(() => warmPool.idleCount() === 0);
    await eventually(() => lines.some((l) => l.includes(`claude close thread=${threadId} reason=activity window`)));
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    sessions.clear();
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-prewarm-"));
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "dump.json");
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
    lines = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => { if (typeof line === "string") lines.push(line); });
  });
  afterEach(async () => {
    for (const key of ["FAKE_CLAUDE_DUMP", "MURAGE_WARM_ACTIVITY_WINDOW_MS", "MURAGE_PREWARM_FILE_GRACE_MS", "FAKE_CLAUDE_START_DELAY_MS", "FAKE_CLAUDE_START_LOG", "FAKE_CLAUDE_START_BANNER", "FAKE_CLAUDE_START_FRAMES", "FAKE_CLAUDE_INIT_ERROR"]) delete process.env[key];
    restoreTmp();
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("starts a cold engine once, parks it held, and releases it when no send follows", async () => {
    await create();
    await goCold("t-pw-release");
    expect(dispatches()).toHaveLength(1);
    expect(await instance.adapter.prewarm!("t-pw-release")).toBe(true);
    expect(dispatches()).toHaveLength(2);
    expect(dispatches()[1]).toMatch(/process=spawned reason=(no-process|process-exited)/);
    expect(prewarms()).toHaveLength(1);
    expect(warmPool.idleCount()).toBe(1);
    // a second warm while the engine is live starts nothing
    expect(await instance.adapter.prewarm!("t-pw-release")).toBe(false);
    expect(dispatches()).toHaveLength(2);
    // the hold lapses with the window: no send followed, so the pool lets it go
    await new Promise((r) => setTimeout(r, 400));
    await warmPool.tick();
    expect(warmPool.idleCount()).toBe(0);
    await eventually(() => lines.filter((l) => l.includes("claude close thread=t-pw-release reason=activity window")).length === 2);
  });

  it("emits nothing for the warm itself: no turn, no session.started until a real turn adopts the engine", async () => {
    await create();
    await goCold("t-pw-quiet");
    const turns = () => recorder.events.filter((e) => e.type === "turn.started").length;
    const before = recorder.events.length;
    expect(await instance.adapter.prewarm!("t-pw-quiet")).toBe(true);
    expect(recorder.events.length).toBe(before);
    expect(turns()).toBe(1);
  });

  it("prewarm then send reuses the engine: no second spawn, and the turn still announces its session", async () => {
    await create();
    await goCold("t-pw-reuse");
    expect(await instance.adapter.prewarm!("t-pw-reuse")).toBe(true);
    const sent = await run("t-pw-reuse", "two", base);
    expect(dispatches()).toHaveLength(3);
    expect(dispatches()[2]).toContain("process=reused reason=unchanged");
    const mine = recorder.events.filter((e) => e.turnId === sent.turnId).map((e) => e.type);
    expect(mine).toContain("turn.started");
    expect(mine).toContain("session.started");
    expect(mine.at(-1)).toBe("turn.completed");
    // the send ended the hold: the engine follows the normal rules again
    expect(prewarms()).toHaveLength(1);
  });

  it("prewarm then a changed warm key recycles the process instead of reusing it", async () => {
    await create();
    await goCold("t-pw-key");
    expect(await instance.adapter.prewarm!("t-pw-key")).toBe(true);
    await run("t-pw-key", "two", { ...base, model: "claude-other" });
    expect(dispatches()).toHaveLength(3);
    expect(dispatches()[2]).toContain("process=spawned reason=model");
    // routeAsks is a permission change too
    await goCold("t-pw-routeasks");
    expect(await instance.adapter.prewarm!("t-pw-routeasks")).toBe(true);
    await run("t-pw-routeasks", "two", { ...base, routeAsks: true });
    expect(dispatches().at(-1)).toContain("process=spawned reason=routeAsks");
  });

  it("a prewarmed engine keeps no credentials or config on disk while it idles", async () => {
    useTmp(scratch);
    await create();
    await run("t-pw-files", "one", { ...base, system: "be brief" });
    await eventually(() => warmPool.idleCount() === 0);
    await eventually(() => lines.some((l) => l.includes("claude close thread=t-pw-files reason=activity window")));
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000"; // see t-pw-slowstart: a Windows size probe outlasts the 250 ms test window
    expect(await instance.adapter.prewarm!("t-pw-files")).toBe(true);
    const mine = () => readdirSync(scratch).filter((name) => /^murage-(mcp|system|cred)-/.test(name));
    const credBodies = () => mine().filter((name) => name.startsWith("murage-cred-"))
      .flatMap((dir) => readdirSync(join(scratch, dir)).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(scratch, dir, f), "utf8")));
    // the token is gone at once; the config and prompt files go once the CLI has started from them
    expect(credBodies().length).toBeGreaterThan(0);
    expect(credBodies().every((body) => body === "{}")).toBe(true);
    await eventually(() => !mine().some((name) => name.startsWith("murage-mcp-") || name.startsWith("murage-system-")));
    expect(warmPool.idleCount()).toBe(1);
  });

  it("a slow-starting prewarm keeps its config and prompt files until the CLI confirms it started, then drops them", async () => {
    useTmp(scratch);
    process.env.MURAGE_PREWARM_FILE_GRACE_MS = "5000";
    await create();
    await run("t-pw-slowstart", "one", { ...base, system: "be brief" });
    await eventually(() => lines.some((l) => l.includes("claude close thread=t-pw-slowstart reason=activity window")));
    const startLog = join(scratch, "start.log");
    process.env.FAKE_CLAUDE_START_LOG = startLog;
    process.env.FAKE_CLAUDE_START_DELAY_MS = "600"; // slower than any fixed grace the files used to get
    // The pool judges the window when its size probe answers. A real Windows
    // listing takes ~0.5 s, longer than this file's 250 ms test window, so the
    // parked engine would be (correctly) let go as idle before the check below.
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    expect(await instance.adapter.prewarm!("t-pw-slowstart")).toBe(true);
    const mine = () => readdirSync(scratch).filter((name) => /^murage-(mcp|system)-/.test(name));
    await eventually(() => existsSync(startLog));
    expect(readFileSync(startLog, "utf8").trim()).toBe("mcp=ok system=ok");
    // dropped on the CLI's confirmation, not at the end of the bound
    await eventually(() => mine().length === 0, 1_500);
    expect(warmPool.idleCount()).toBe(1);
    expect(lines.some((l) => l.includes("reason=startup not confirmed"))).toBe(false);
  });

  it("a launcher banner on stdout never confirms startup: the files stay while the CLI has not read them", async () => {
    useTmp(scratch);
    process.env.MURAGE_PREWARM_FILE_GRACE_MS = "5000";
    await create();
    await run("t-pw-banner", "one", { ...base, system: "be brief" });
    await eventually(() => lines.some((l) => l.includes("claude close thread=t-pw-banner reason=activity window")));
    const startLog = join(scratch, "start.log");
    process.env.FAKE_CLAUDE_START_LOG = startLog;
    process.env.FAKE_CLAUDE_START_BANNER = "claude-wrapper v1.2 starting";
    process.env.FAKE_CLAUDE_START_DELAY_MS = "700";
    expect(await instance.adapter.prewarm!("t-pw-banner")).toBe(true);
    const mine = () => readdirSync(scratch).filter((name) => /^murage-(mcp|system)-/.test(name));
    // the banner (and a non-protocol JSON line) arrived; the CLI has not read its files yet
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(startLog)).toBe(false);
    expect(mine().length).toBeGreaterThan(0);
    await eventually(() => existsSync(startLog));
    expect(readFileSync(startLog, "utf8").trim()).toBe("mcp=ok system=ok");
    // then the real protocol frame confirms it and they go
    await eventually(() => mine().length === 0, 1_500);
    expect(lines.some((l) => l.includes("reason=startup not confirmed"))).toBe(false);
  });

  it.each([
    ["a keep_alive frame", [{ type: "keep_alive" }]],
    ["a system frame that is not init", [{ type: "system", subtype: "task_started", task_id: "x" }, { type: "system", subtype: "status" }]],
    ["a control_response that answers someone else's request", [{ type: "control_response", response: { subtype: "success", request_id: "not-ours", response: {} } }]],
    ["a control_response with our id that did not succeed", null],
  ] as const)("%s never confirms startup: the files stay until the real answer", async (name, frames) => {
    useTmp(scratch);
    process.env.MURAGE_PREWARM_FILE_GRACE_MS = "5000";
    const thread = `t-pw-bogus-${name.length}`;
    await create();
    await run(thread, "one", { ...base, system: "be brief" });
    await eventually(() => lines.some((l) => l.includes(`claude close thread=${thread} reason=activity window`)));
    const startLog = join(scratch, "start.log");
    process.env.FAKE_CLAUDE_START_LOG = startLog;
    process.env.FAKE_CLAUDE_START_DELAY_MS = "700";
    // The parked engine must outlive the 250 ms test activity window: past it the pool
    // (correctly) lets an idle engine go and its close removes the files, which is not the
    // behaviour under test. Same as the slow-start case.
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    if (frames) process.env.FAKE_CLAUDE_START_FRAMES = JSON.stringify(frames);
    else process.env.FAKE_CLAUDE_INIT_ERROR = "1";
    expect(await instance.adapter.prewarm!(thread)).toBe(true);
    const mine = () => readdirSync(scratch).filter((n) => /^murage-(mcp|system)-/.test(n));
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(startLog)).toBe(false);
    expect(mine().length).toBeGreaterThan(0);
    await eventually(() => existsSync(startLog));
    if (frames) {
      // the matching successful initialize answer is the confirmation
      await eventually(() => mine().length === 0, 1_500);
    } else {
      // a refused initialize is not a confirmation either: the files are still there
      await new Promise((r) => setTimeout(r, 400));
      expect(mine().length).toBeGreaterThan(0);
    }
  });

  it("a system/init event confirms startup: the files go at once", async () => {
    useTmp(scratch);
    process.env.MURAGE_PREWARM_FILE_GRACE_MS = "5000";
    await create();
    await run("t-pw-init", "one", { ...base, system: "be brief" });
    await eventually(() => lines.some((l) => l.includes("claude close thread=t-pw-init reason=activity window")));
    const startLog = join(scratch, "start.log");
    process.env.FAKE_CLAUDE_START_LOG = startLog;
    process.env.FAKE_CLAUDE_START_DELAY_MS = "900";
    process.env.FAKE_CLAUDE_START_FRAMES = JSON.stringify([{ type: "system", subtype: "init", session_id: "s", model: "m", tools: [] }]);
    expect(await instance.adapter.prewarm!("t-pw-init")).toBe(true);
    const mine = () => readdirSync(scratch).filter((n) => /^murage-(mcp|system)-/.test(n));
    await eventually(() => mine().length === 0, 600);
    expect(existsSync(startLog)).toBe(false);
  });

  it("a prewarm that does not confirm startup within its bound is retired first, and its files go with its close", async () => {
    useTmp(scratch);
    await create();
    await run("t-pw-nostart", "one", { ...base, system: "be brief" });
    await eventually(() => lines.some((l) => l.includes("claude close thread=t-pw-nostart reason=activity window")));
    const startLog = join(scratch, "start.log");
    process.env.FAKE_CLAUDE_START_LOG = startLog;
    process.env.FAKE_CLAUDE_START_DELAY_MS = "800";
    process.env.MURAGE_PREWARM_FILE_GRACE_MS = "200";
    expect(await instance.adapter.prewarm!("t-pw-nostart")).toBe(true);
    await eventually(() => lines.some((l) => l.includes("claude close thread=t-pw-nostart reason=startup not confirmed")));
    expect(warmPool.idleCount()).toBe(0);
    const mine = () => readdirSync(scratch).filter((name) => /^murage-(mcp|system)-/.test(name));
    // never removed under a process that may still read them
    await eventually(() => existsSync(startLog));
    expect(readFileSync(startLog, "utf8").trim()).toBe("mcp=ok system=ok");
    await eventually(() => mine().length === 0, 8_000);
  });

  it("a cold send after the pool let the engine go says it is waking up, before the engine starts", async () => {
    await create();
    await goCold("t-pw-wake");
    const sent = await run("t-pw-wake", "two", base);
    const mine = recorder.events.filter((e) => e.turnId === sent.turnId);
    const types = mine.map((e) => e.type);
    const wake = mine.findIndex((e) => e.type === "item.started" && String((e as { title?: string }).title).startsWith("Waking up"));
    expect(wake).toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(types.indexOf("turn.started"));
    expect(wake).toBeLessThan(types.indexOf("session.started"));
    expect(types.at(-1)).toBe("turn.completed");
    // told once: the next send on the live engine does not wake
    const next = await run("t-pw-wake", "three", base);
    expect(recorder.events.filter((e) => e.turnId === next.turnId && e.type === "item.started" && String((e as { title?: string }).title).startsWith("Waking up"))).toHaveLength(0);
  });

  it("with no remembered args (a restart, an unknown thread) prewarm is a no-op", async () => {
    await create();
    expect(await instance.adapter.prewarm!("t-never-seen")).toBe(false);
    expect(dispatches()).toHaveLength(0);
    expect(warmPool.idleCount()).toBe(0);
  });

  it("a routine or memory turn is background: it remembers nothing to warm and keeps no spare", async () => {
    await create();
    await run("t-pw-bg", "routine", { ...base, background: true });
    expect(warmPool.idleCount()).toBe(0);
    expect(lines.some((l) => l.includes("claude close thread=t-pw-bg reason=background turn"))).toBe(true);
    expect(await instance.adapter.prewarm!("t-pw-bg")).toBe(false);
    expect(dispatches()).toHaveLength(1);
  });
});
