import "../testing/port-integrity.ts";
import { admittedFixtureInstance } from "../testing/mcp-admission-fixture.ts";
import { createHash } from "node:crypto";
import { releaseTransaction } from "../memory/release-transaction.ts";
import { randomUUID } from "node:crypto";
import { assertConsumingMountAdmission } from "./mcp-mounts.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
// One warm `codex app-server` per chat thread: reused while every spawn input
// is unchanged, recycled otherwise, with the per-turn capability token read from
// a per-process 0600 file instead of the long-lived environment.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { bindCredentialPathInArgs, CodexDriver } from "./codex.ts";
import { CRED_FILE_PLACEHOLDER, connectorScopeOf, connectorMountRefsOf, anyMountHoldsStandIn, anyMountIncomplete, clearMountsIncomplete } from "./turn-credentials.ts";
import { bindFixtureAdapter, fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { codexMountConfiguration } from "../testing/codex-mount-configuration.ts";
import { warmKey, diffWarmKey } from "./warm-key.ts";
import { cacheEnvFromProcess, markMountIncomplete, markMountReady } from "../connector-cache.ts";
import { PrewarmRefused, warmPool } from "./warm-pool.ts";
import { reuseStats } from "./reuse-stats.ts";
import { TurnSubmissionBoundary } from "../turn-dispatch-guard.ts";
import { resetIsolationCache } from "./isolation-cache.ts";
import { HOOK_CONTROL_FRAMES, hookSocketPath } from "./codex-hook.ts";
import { setWarmS2rSource, warmS2rOn } from "./warm-s2r-flag.ts";
import { HELD_RELAY_PID, holdBotRelay } from "../testing/held-relay-fixture.ts";
import { decorateOwnerTurnInstance, setOwnerTurnResolver } from "../harness/power-owner-adapter.ts";
import { assertRelayAvailable } from "./cli-mount-relay.ts";

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
const hooks = vi.hoisted(() => ({ stuck: false, failClear: false, clears: 0,
  stores: [] as Array<{ path: string; mode: number; dirMode: number; isFile: boolean; writes: Array<Record<string, Record<string, string>>> }>,
  keyParts: [] as unknown[], hang: null as null | Promise<boolean>, releaseStops: async () => {} }));
// q1024-steerquar: the held relay's stand-in engine and mount children (testing/held-relay-fixture.ts HELD_RELAY_PID; a literal, as a mock factory may not import procs' importers).
const heldRelayPid = vi.hoisted(() => 2_000_000_017);
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  const held = new Set<Parameters<typeof actual.killCliTree>[0]>();
  hooks.releaseStops = async () => {
    if (hooks.stuck) return;
    const children = [...held]; held.clear();
    for (const child of children) actual.killCliTree(child);
    await Promise.all(children.map(child => actual.cliTreeStoppedSignal(child)));
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return {
    ...actual,
    // a process that ignores the kill: nothing is signalled and it never reports stopped
    killCliTree: (...args: Parameters<typeof actual.killCliTree>) => {
      if (args[0].pid === heldRelayPid) return;
      if (hooks.stuck) held.add(args[0]); else actual.killCliTree(...args);
    },
    // a close still in flight: the answer comes when the test says so
    awaitCliTreeStopped: (...args: Parameters<typeof actual.awaitCliTreeStopped>) => (args[0].pid === heldRelayPid ? Promise.resolve(false) : hooks.hang ? hooks.hang : hooks.stuck ? Promise.resolve(false) : actual.awaitCliTreeStopped(...args)),
    cliTreeStoppedSignal: (...args: Parameters<typeof actual.cliTreeStoppedSignal>) => (args[0].pid === heldRelayPid ? new Promise<true>(() => {}) : actual.cliTreeStoppedSignal(...args)),
  };
});
vi.mock("./turn-credentials.ts", async (original) => {
  const actual = await original<typeof import("./turn-credentials.ts")>();
  return {
    ...actual,
    createTurnCredentialStore: () => {
      const store = actual.createTurnCredentialStore();
      const observed = { path: store.path, mode: statSync(store.path).mode & 0o777, dirMode: statSync(dirname(store.path)).mode & 0o777, isFile: statSync(store.path).isFile(), writes: [] as Array<Record<string, Record<string, string>>> };
      hooks.stores.push(observed);
      return { ...store,
        write: (secrets: Parameters<typeof store.write>[0]) => {
          store.write(secrets);
          observed.writes.push(JSON.parse(readFileSync(store.path, "utf8")));
        },
        clear: () => { if (hooks.failClear) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); hooks.clears++; store.clear(); } };
    },
  };
});
vi.mock("./warm-key.ts", async (original) => {
  const actual = await original<typeof import("./warm-key.ts")>();
  return { ...actual, warmKey: (parts: Record<string, unknown>) => { hooks.keyParts.push(parts); return actual.warmKey(parts); } };
});

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const ENV = ["FAKE_CODEX_IGNORE_TERM", "FAKE_CODEX_USAGE_DIR", "FAKE_CODEX_RESUME_GATE", "MURAGE_PREWARM_WAIT_MS", "MURAGE_PREWARM_TAKEOVER_MS", "FAKE_CODEX_DUMP", "FAKE_CODEX_SPAWN_LOG", "FAKE_CODEX_WARM", "FAKE_CODEX_MODE_FILE", "FAKE_CODEX_MODE", "MURAGE_CODEX_SESSION_IDLE_MS", "MURAGE_CODEX_SESSION_IDLE_MIN_MS", "FAKE_CODEX_CALL_LOG", "FLUX_API_KEY", "FAKE_CODEX_RESUME_MODEL", "FAKE_CODEX_VERSION", "FAKE_CODEX_TOOLS"];

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
    instance = await admittedFixtureInstance(CodexDriver.create({
      instanceId: "codex-warm-test", displayName: "Codex Warm Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    }));
    bindFixtureAdapter(instance.adapter);
    recorder = recordEvents(instance.adapter);
    catalogSpawns = allSpawns().length;
  };
  const agents = (token: string, bot = "b1") => ({
    agents: { command: process.execPath, args: [fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url))], env: { MURAGE_BOT_ID: bot, MURAGE_COMMS_TOKEN: token } },
  });
  let botNamespace = "";
  const identity = (botId = "b1", audience: "owner" | "non-owner" = "owner") => ({ botId: `${botNamespace}:${botId}`, audience });
  const base = { integrations: agents("tok-1"), warmIdentity: identity() } satisfies Partial<SendTurnInput>;
  // F4 tests keep a process across turns; a mounted turn is single use (S1 section 0), so they run unmounted (same bot identity).
  const unmountedBase = { warmIdentity: base.warmIdentity } satisfies Partial<SendTurnInput>;
  // red-at-4df086541; design 397: neither cold nor resumed external mounts
  // have final ingress. Configuration/credential controls use real producers.
  const refusedMount = async (threadId: string, text: string, extra: Partial<SendTurnInput>) => {
    const input = { threadId, text, ...extra };
    expect(() => assertConsumingMountAdmission(fixtureMountTurn(input), "external", true)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(recorder.events).toEqual([]);
    expect(spawns()).toEqual([]);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
    return codexMountConfiguration(input);
  };
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
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    const completed = last("turn.completed");
    let seen: any = null;
    try { seen = JSON.parse(readFileSync(dump, "utf8")); } catch {}
    return { seen, pid: seen?.pid as number | undefined, cred: seen?.credFile as { path: string; content: Record<string, Record<string, string>> | null } | undefined, completed };
  };
  // These tests prove the reuse KEY (same inputs, or only a rotated token, keep the process). The settle probe
  // fails closed by design (an unreadable process table recycles, see process-tree.ts), and on Windows the
  // native table read is not guaranteed in full under CI load, which recycled the process for a reason that is not
  // the key (CODEX-WARM-WIN-CRED). Pin the probe to "nothing new under the engine" so only the key decides;
  // the probe's own fail-closed behaviour has its own tests below (probe.override per test).
  const pinQuietProbe = () => { probe.override = async () => new Set<number>(); };
  const runOpen = async (threadId: string) => {
    process.env.FAKE_CODEX_IGNORE_TERM = "1";
    setMode("approval");
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "one", ...base });
    await recorder.until(e => e.type === "request.opened" && e.turnId === sent.turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    setMode("resume");
    delete process.env.FAKE_CODEX_IGNORE_TERM;
    return { pid: seen.pid as number, seen };
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
    // Quarantine is bot-wide and survives a fixture whose stop was intentionally unconfirmed.
    botNamespace = randomUUID(); base.warmIdentity = identity();
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
    hooks.stuck = false; hooks.failClear = false; hooks.clears = 0; hooks.keyParts.length = 0; hooks.stores.length = 0;
  });
  afterEach(async () => {
    for (const key of ENV) delete process.env[key];
    probe.override = null;
    hooks.stuck = false; await hooks.releaseStops(); hooks.failClear = false;
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  // MAIN-RULING warm-active-only through the real send path (OPUS 38cebb4cde High): an owner turn wakes its own bot and maps
  // its thread on the shared warm pool; a non-owner (channel audience) turn wakes no bot and marks its thread non-owner.
  it("W-DRV-X: an owner turn wakes its bot on the warm pool and maps its thread; a non-owner turn wakes none", async () => {
    await create();
    await run("t-drv-owner", "one", base);
    expect(warmPool.activityFor("t-drv-owner")).toEqual({ bot: base.warmIdentity.botId, active: true, nonOwner: false }); // W-DRV-X:owner
    await run("t-drv-guest", "one", { ...base, warmIdentity: identity("b-guest", "non-owner") });
    expect(warmPool.activityFor("t-drv-guest")).toEqual({ bot: undefined, active: false, nonOwner: true }); // W-DRV-X:non-owner
  });

  // q1024-steerquar (Codex driver path, OPUS 583d64b809 H3 + H2): through the registry's owner decorator, the owner's mounted send
  // runs past a held bot relay, and its relay starts no second copy of the integration whose held mount child is unconfirmed; an
  // integration the held relay did not have starts, and a guest send and the held relay stay fenced.
  it("q1024-steerquar Codex: the owner's mounted send passes a held relay without a second copy of its unconfirmed integration", async () => {
    expect(HELD_RELAY_PID, "fixture: the mocked pid is the held engine").toBe(heldRelayPid);
    await create();
    const marks = join(scratch, "marks"); mkdirSync(marks);
    const integration = (name: string) => ({ command: process.execPath, args: ["-e", "require('fs').appendFileSync(process.argv[1], 'started\\n'); process.stdin.resume()", join(marks, name)], env: {} });
    const starts = (name: string) => existsSync(join(marks, name)) ? readFileSync(join(marks, name), "utf8").split("\n").filter(Boolean).length : 0;
    const held = await holdBotRelay(base.warmIdentity.botId, { notes: integration("notes-held") });
    setOwnerTurnResolver(threadId => threadId.startsWith("owner-"));
    try {
      const adapter = decorateOwnerTurnInstance(instance).adapter;
      const integrations = { custom: { notes: integration("notes"), calendar: integration("calendar") } };
      const guest = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "guest-quar", text: "one", integrations, warmIdentity: identity("b1", "non-owner") })
        .then(() => "sent", (error: unknown) => String(error));
      expect(guest, "a guest send to the held bot is still refused").toContain("MOUNT_RELAY_STOP_UNCONFIRMED");
      const owner = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "owner-quar", text: "one", integrations, warmIdentity: base.warmIdentity })
        .then(({ turnId }) => turnId, (error: unknown) => `refused: ${String(error)}`);
      expect(owner, "the owner's send is never refused by the held relay").not.toMatch(/^refused:/);
      expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === owner, 20_000), "the owner's turn runs to its reply").toMatchObject({ threadId: "owner-quar", ok: true });
      expect(starts("calendar"), "an integration the held relay did not have starts for the owner").toBe(1);
      expect(starts("notes"), "no second copy of the integration whose held child is unconfirmed").toBe(0);
      expect(() => assertRelayAvailable(held), "the held relay stays quarantined").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    } finally { setOwnerTurnResolver(() => false); }
  }, 40_000);

  // q1024-steerquar (ASTRA 0faec876bb High, cli-mount-relay.ts #skipHeldMount): a bot switched from Antigravity to Codex. The held relay
  // ran each integration under Antigravity's key (murage-computer, murage-agents, murage-custom-<name>); Codex mounts the same process
  // as computer, agents, <name>, with this turn's own env. The owner's send gets no second copy of the held one; one key per row, the
  // other two start.
  it.each([["murage-computer", "computer"], ["murage-agents", "agents"], ["murage-custom-notes", "notes"]])("q1024-steerquar Codex after Antigravity: no second copy of a held %s child as %s", async (heldKey, codexName) => {
    expect(HELD_RELAY_PID, "fixture: the mocked pid is the held engine").toBe(heldRelayPid);
    await create();
    const marks = join(scratch, "marks"); mkdirSync(marks);
    const integration = (name: string) => ({ command: process.execPath, args: ["-e", "require('fs').appendFileSync(process.argv[1], 'started\\n'); process.stdin.resume()", join(marks, name)], env: {} });
    const starts = (name: string) => existsSync(join(marks, name)) ? readFileSync(join(marks, name), "utf8").split("\n").filter(Boolean).length : 0;
    const held = await holdBotRelay(base.warmIdentity.botId, { [heldKey]: { ...integration(codexName), env: { FIXTURE_TURN_TOKEN: "earlier-turn" } } });
    setOwnerTurnResolver(threadId => threadId.startsWith("owner-"));
    try {
      const adapter = decorateOwnerTurnInstance(instance).adapter;
      const integrations = { localComputer: integration("computer"), agents: integration("agents"), custom: { notes: integration("notes") } };
      const owner = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "owner-switch", text: "one", integrations, warmIdentity: base.warmIdentity })
        .then(({ turnId }) => turnId, (error: unknown) => `refused: ${String(error)}`);
      expect(owner, "the owner's send is never refused by the held relay").not.toMatch(/^refused:/);
      expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === owner, 20_000), "the owner's turn runs to its reply").toMatchObject({ threadId: "owner-switch", ok: true });
      expect(["computer", "agents", "notes"].filter(name => name !== codexName).map(starts), "the integrations the held relay did not have start for the owner").toEqual([1, 1]);
      expect(starts(codexName), "no second copy of the integration whose held Antigravity child is unconfirmed").toBe(0);
      expect(() => assertRelayAvailable(held), "the held relay stays quarantined").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    } finally { setOwnerTurnResolver(() => false); }
  }, 40_000);

  it("a second mounted turn starts a fresh app-server and resumes the conversation", async () => {
    pinQuietProbe();
    await create();
    const first = await run("t-hot", "one", base);
    const second = await run("t-hot", "two", { ...base, integrations: agents("tok-2") });
    // before the pid: a second process then fails here, and the line says why it was started
    expect(dispatches()[0]).toBe("codex dispatch thread=t-hot process=spawned reason=no-process");
    // a "no-process" respawn says nothing by itself: the close line of the first process names why it was not kept
    expect(dispatches()[1], `close lines: ${closes().join(" | ") || "none"}`).toBe("codex dispatch thread=t-hot process=spawned reason=no-process");
    expect(second.pid).not.toBe(first.pid);
    expect(spawns()).toHaveLength(2);
    const methods = (second.seen.calls as Array<{ method: string }>).map((c) => c.method);
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
    expect(methods.filter((m) => m === "thread/start")).toHaveLength(0);
    expect(methods.filter((m) => m === "thread/resume")).toHaveLength(1);
    expect(methods.filter((m) => m === "turn/start")).toHaveLength(1);
    expect(closes()).toEqual(["codex close thread=t-hot reason=mounted-single-use", "codex close thread=t-hot reason=mounted-single-use"]);
    expect(recorder.events.filter((e) => e.type === "turn.completed" && (e as any).ok === true)).toHaveLength(2);
  });

  // WARM W1 r3.5 W-FLAG (Codex part) [R3.1-2]: the flag reads OFF with no setting written, and in this build `warm.s2r` ON keeps every
  // mounted Codex turn single use too (fail closed: the CODEX-REUSE short design has no Fable AGREE yet, warm1022-codex QUESTIONS.md).
  it.each([false, true])("W-FLAG warm.s2r=%s: mounted Codex turns 2+ spawn fresh (mounted-single-use) and resume", async (flag) => {
    expect(warmS2rOn()).toBe(false);
    if (flag) setWarmS2rSource(() => ({ warmS2r: true }));
    try {
      expect(warmS2rOn()).toBe(flag);
      pinQuietProbe();
      await create();
      const first = await run("t-flag", "one", base);
      const second = await run("t-flag", "two", { ...base, integrations: agents("tok-2") });
      const third = await run("t-flag", "three", { ...base, integrations: agents("tok-3") });
      expect(new Set([first.pid, second.pid, third.pid]).size).toBe(3);
      expect(closes()).toEqual(Array(3).fill("codex close thread=t-flag reason=mounted-single-use"));
      expect((third.seen.calls as Array<{ method: string }>).filter((c) => c.method === "thread/resume")).toHaveLength(1);
    } finally { setWarmS2rSource(() => undefined); }
  });

  it("memory r3: a submission fence that refuses during adapter setup sends no turn/start, cold or on the reused app-server", async () => {
    const callLog = join(scratch, "calls.log");
    writeFileSync(callLog, "");
    process.env.FAKE_CODEX_CALL_LOG = callLog;
    const turnStarts = () => readFileSync(callLog, "utf8").split("\n").filter((line) => line.endsWith(" turn/start")).length;
    await create();
    // cold: sendTurn hands the id back first; the fence runs after the handshake and refuses
    let calls = 0;
    const refused = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fence", text: "one", ...base, beforeSubmit: () => { calls++; throw new Error("MEMORY_CONTEXT_REVOKED"); } });
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
    const again = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fence", text: "three", ...base, resumeCursor: sessions.get("t-fence"), beforeSubmit: () => { throw new Error("MEMORY_CONTEXT_REVOKED"); } });
    // refused before the id came back, the harness stops it by id; after, it settles itself
    const settled = await Promise.race([recorder.until((e) => e.type === "turn.completed" && e.turnId === again.turnId).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
    if (!settled) await instance.adapter.interruptTurn("t-fence");
    await new Promise((r) => setTimeout(r, 100));
    expect(turnStarts()).toBe(1);
  });

  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: keep the frozen ID; additional coverage has its own ID.
  it("SC-SAFETY added coverage: memory r3: a submission fence that refuses during adapter setup sends no turn/start, cold or on the reused app-server", async () => {
    const callLog = join(scratch, "calls.log");
    writeFileSync(callLog, "");
    process.env.FAKE_CODEX_CALL_LOG = callLog;
    const turnStarts = () => readFileSync(callLog, "utf8").split("\n").filter((line) => line.endsWith(" turn/start")).length;
    await create();
    // cold: sendTurn hands the id back first; the fence runs after the handshake and refuses
    let calls = 0;
    // D2 (1.0.19): through the REAL boundary. The refused attempt is recorded unwritten by the boundary itself, so (refused before the
    // first write) the withdraw happens exactly once and the turn may rebuild; the driver makes no arg-less notWritten call of its own.
    const boundary = new TurnSubmissionBoundary();
    const notWritten = vi.fn();
    boundary.onNotWritten(notWritten);
    boundary.started();
    const driverNotWritten = vi.fn();
    const refused = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fence", text: "one", ...base, notWritten: driverNotWritten, beforeSubmit: () => { calls++; return boundary.beforeSubmit(() => { throw new Error("MEMORY_CONTEXT_REVOKED"); }); } });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === refused.turnId);
    expect(recorder.events.find((e) => e.type === "turn.completed" && e.turnId === refused.turnId)).toMatchObject({ ok: false, stopReason: "submission_refused" });
    expect(recorder.events.some((e) => e.type === "runtime.error" && e.turnId === refused.turnId)).toBe(false);
    expect(calls).toBe(1);
    expect(notWritten).toHaveBeenCalledOnce();
    // the driver itself makes no arg-less notWritten call (D2): only the boundary withdraws, and only when every attempt is unwritten
    expect(driverNotWritten).not.toHaveBeenCalled();
    expect(boundary.canRetry).toBe(true);
    expect(turnStarts()).toBe(0);
    // a passing fence runs once per write and lets the turn through
    let passes = 0;
    await run("t-fence", "two", { ...base, beforeSubmit: () => { passes++; } });
    expect(passes).toBe(1);
    expect(turnStarts()).toBe(1);
    // warm: the reused app-server is not written to either
    const again = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fence", text: "three", ...base, resumeCursor: sessions.get("t-fence"), beforeSubmit: () => { throw new Error("MEMORY_CONTEXT_REVOKED"); } });
    // refused before the id came back, the harness stops it by id; after, it settles itself
    const settled = await Promise.race([recorder.until((e) => e.type === "turn.completed" && e.turnId === again.turnId).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
    if (!settled) await instance.adapter.interruptTurn("t-fence");
    await new Promise((r) => setTimeout(r, 100));
    expect(turnStarts()).toBe(1);
  });

  it("H1-SENDLOCK: the turn/start frame is written inside turn.fencedWrite, after beforeSubmit; a refusal there writes no turn/start", async () => {
    const callLog = join(scratch, "calls.log");
    writeFileSync(callLog, "");
    process.env.FAKE_CODEX_CALL_LOG = callLog;
    const turnStarts = () => readFileSync(callLog, "utf8").split("\n").filter((line) => line.endsWith(" turn/start")).length;
    await create();
    expect(instance.adapter.capabilities?.fencedLearningWrite).toBe(true);
    // a passing fence: beforeSubmit first, then the frame leaves while fencedWrite runs (one turn/start written inside it)
    const order: string[] = [];
    let admitted: SendTurnInput;
    admitted = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: "t-sendlock", text: "one", ...base,
      beforeSubmit: () => { order.push("beforeSubmit"); },
      fencedWrite: <R>(write: () => R, validate?: Parameters<NonNullable<SendTurnInput["fencedWrite"]>>[1]): R =>
        releaseTransaction(admitted.releaseBinding!.db!, { validate, emit: () => {
          order.push(`enter:${turnStarts()}`);
          const out = write();
          order.push(`leave:${turnStarts()}`);
          return out;
        } }),
    });
    await run("t-sendlock", "one", admitted);
    // the fake logs the frame when it reads it; the write itself is synchronous inside fencedWrite, so the log may trail it
    expect(order.slice(0, 2)).toEqual(["beforeSubmit", "enter:0"]);
    expect(turnStarts()).toBe(1);
    // a refusal inside fencedWrite (the gate refused or the lock was busy): nothing written, the turn settles refused
    let refusedCalls = 0;
    // refused before the id came back, the harness stops it by id; after, it settles itself as submission_refused
    const settledOrStopped = async (threadId: string, turnId: string) => {
      const settled = await Promise.race([recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1_000))]);
      if (!settled) await instance.adapter.interruptTurn(threadId);
      return settled;
    };
    const refused = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-sendlock-2", text: "two", ...base, fencedWrite: () => { refusedCalls++; throw new Error("MEMORY_SEND_FENCED"); } });
    if (await settledOrStopped("t-sendlock-2", refused.turnId)) expect(recorder.events.find((e) => e.type === "turn.completed" && e.turnId === refused.turnId)).toMatchObject({ ok: false, stopReason: "submission_refused" });
    expect(refusedCalls).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(turnStarts()).toBe(1);
    // a beforeSubmit refusal still stops first: fencedWrite never runs
    let reached = false;
    const stopped = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-sendlock-3", text: "three", ...base, beforeSubmit: () => { throw new Error("MEMORY_CONTEXT_REVOKED"); }, fencedWrite: <R>(write: () => R): R => { reached = true; return write(); } });
    await settledOrStopped("t-sendlock-3", stopped.turnId);
    await new Promise((r) => setTimeout(r, 100));
    expect(reached).toBe(false);
    expect(turnStarts()).toBe(1);
  });

  it("books each turn's own usage from the thread total, not the running total", async () => {
    process.env.FAKE_CODEX_USAGE_DIR = scratch;
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
    // control: lifecycle evidence comes from the admitted driver and fake
    // process, never a configuration helper or a test-cleared credential file.
    pinQuietProbe();
    await create();
    const first = await run("t-cred", "one", base);
    expect(existsSync(first.cred!.path)).toBe(false);
    const second = await run("t-cred", "two", { ...base, integrations: agents("tok-2") });
    expect(second.pid).not.toBe(first.pid);
    expect(spawns()).toHaveLength(2);
    expect(first.cred?.content?.agents?.MURAGE_COMMS_TOKEN).toBe("tok-1");
    expect(second.cred?.content?.agents?.MURAGE_COMMS_TOKEN).toBe("tok-2");
    expect(second.cred?.path).not.toBe(first.cred?.path);
    expect(JSON.stringify(second.cred?.content)).not.toContain("tok-1");
    // the process environment never held a token, and argv names no token value
    expect(first.seen.env.MURAGE_COMMS_TOKEN).toBeUndefined();
    expect(JSON.stringify(first.seen.argv)).not.toContain("tok-");
    expect(JSON.stringify(first.seen.argv)).toContain("MURAGE_CRED_SERVER");
    // empty between turns; owner-only file in an owner-only directory
    expect(existsSync(first.cred!.path)).toBe(false);
    if (process.platform === "win32") {
      // no POSIX mode bits on Windows: the file sits in a fresh per-process directory under the per-user temp dir
      expect(hooks.stores.find(store => store.path === first.cred!.path)!.isFile).toBe(true);
      expect(dirname(dirname(first.cred!.path)).toLowerCase()).toBe(tmpdir().toLowerCase());
    } else {
      expect(hooks.stores.find(store => store.path === first.cred!.path)!.mode).toBe(0o600);
      expect(hooks.stores.find(store => store.path === first.cred!.path)!.dirMode).toBe(0o700);
    }
  });

  it("without a warm identity the mounted token still belongs in the credential file", async () => {
    await create();
    const first = await refusedMount("t-anon", "one", { integrations: agents("tok-1") });
    expect(first.secrets.agents.MURAGE_COMMS_TOKEN).toBe("tok-1");
    expect(first.env.MURAGE_COMMS_TOKEN).toBeUndefined();
    const second = await refusedMount("t-anon", "two", { integrations: agents("tok-2") });
    expect(second.secrets.agents.MURAGE_COMMS_TOKEN).toBe("tok-2");
    expect(second.env.MURAGE_COMMS_TOKEN).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain("tok-1");
    // Design 397 supersedes launching two unretained external processes.
    expect(spawns()).toEqual([]); expect(dispatches()).toEqual([]); expect(closes()).toEqual([]);
  });

  const respawned = (name: string, reason: string, change: () => Partial<SendTurnInput>) =>
    it(`respawns on ${name} (reason=${reason})`, async () => {
      await create();
      if (reason === "mcp") {
        const one = await refusedMount("t-key", "one", base);
        const two = await refusedMount("t-key", "two", { ...base, ...change(), resumeCursor: "fixture-prior-session" });
        expect(diffWarmKey(warmKey({ mcp: one.stableServers }), warmKey({ mcp: two.stableServers }))).toBe(reason);
        expect(spawns()).toEqual([]); expect(dispatches()).toEqual([]);
        return;
      }
      const one = await run("t-key", "one", base);
      const two = await run("t-key", "two", { ...base, ...change() });
      expect(two.pid).not.toBe(one.pid);
      expect(spawns()).toHaveLength(2);
      expect(dispatches()[1]).toBe("codex dispatch thread=t-key process=spawned reason=no-process");
      expect(closes()[0]).toContain("codex close thread=t-key reason=mounted-single-use");
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
      const one = await refusedMount("t-scope", "one", { ...base, ...withScope("rev-1") });
      const two = await refusedMount("t-scope", "two", { ...base, ...withScope("rev-2"), resumeCursor: "fixture-prior-session" });
      expect(connectorScopeOf(one.secrets)).toBe(`${"a".repeat(32)}|rev-1`);
      expect(connectorScopeOf(two.secrets)).toBe(`${"a".repeat(32)}|rev-2`);
      expect(diffWarmKey(warmKey({ connectorScope: connectorScopeOf(one.secrets) }), warmKey({ connectorScope: connectorScopeOf(two.secrets) }))).toBe("connectorScope");
      expect(spawns()).toEqual([]); expect(dispatches()).toEqual([]);
    });
    it("recycles an engine the bridge handed only the stand-in list (it lists once), same thread; the fresh mount is then kept (reason=connector-mount-incomplete)", async () => {
      pinQuietProbe();
      await create();
      const dir = mkdtempSync(join(tmpdir(), "murage-mount-"));
      const cacheEnv = { MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}) };
      const scoped = (): Partial<SendTurnInput> => ({
        integrations: { ...agents("tok-1"), composio: { command: process.execPath, args: ["fixture-connectors"], env: { MURAGE_CONNECTOR_IDENTITY: "a".repeat(32), MURAGE_CONNECTOR_REVISION: "rev-1", ...cacheEnv } } },
      });
      try {
        const one = await refusedMount("t-mount", "one", { ...base, ...scoped() });
        // The bridge of that engine served the provisional list and filed it.
        const ref = { cache: cacheEnvFromProcess(cacheEnv), identity: "a".repeat(32), revision: "rev-1", thread: "t-mount" };
        markMountIncomplete(ref);
        const refs = connectorMountRefsOf(one.stableServers, one.secrets, "t-mount");
        expect(refs).toEqual([ref]);
        // Discovery keeps failing (the real list is not confirmed): five turns, the warm engine stays, zero recycles.
        for (let turn = 1; turn <= 5; turn++) {
          const same = await refusedMount("t-mount", `wait ${turn}`, { ...base, ...scoped(), resumeCursor: "fixture-prior-session" });
          expect(same.stableServers).toEqual(one.stableServers);
          expect(anyMountHoldsStandIn(refs)).toBe(true);
        }
        // The bridge's probe got the real list (cached under the current generation): exactly one recycle.
        markMountReady(ref, "");
        expect(anyMountIncomplete(refs)).toBe(true);
        const two = await refusedMount("t-mount", "two", { ...base, ...scoped() });
        clearMountsIncomplete(refs);
        expect(anyMountIncomplete(refs)).toBe(false);
        const three = await refusedMount("t-mount", "three", { ...base, ...scoped() });
        expect(three.stableServers).toEqual(two.stableServers);
        expect(spawns()).toEqual([]); expect(dispatches()).toEqual([]);
      } finally {
        removeTempDir(dir);
      }
    });
    it("keeps the warm process when only the turn's token rotates under the same revision", async () => {
      pinQuietProbe();
      await create();
      const one = await refusedMount("t-scope2", "one", { ...base, ...withScope("rev-1", "tok-1") });
      const two = await refusedMount("t-scope2", "two", { ...base, ...withScope("rev-1", "tok-2"), resumeCursor: "fixture-prior-session" });
      expect(two.stableServers).toEqual(one.stableServers);
      expect(connectorScopeOf(two.secrets)).toBe(connectorScopeOf(one.secrets));
      expect(two.secrets.agents!.MURAGE_COMMS_TOKEN).toBe("tok-2");
      expect(JSON.stringify(two.secrets)).not.toContain("tok-1");
      expect(spawns()).toEqual([]); expect(dispatches()).toEqual([]);
    });
  });

  it("respawns on sessionReset and starts a new conversation", async () => {
    await create();
    const one = await run("t-reset", "one", base);
    const two = await run("t-reset", "two", { ...base, sessionReset: true });
    expect(two.pid).not.toBe(one.pid);
    expect(dispatches()[1]).toBe("codex dispatch thread=t-reset process=spawned reason=no-process");
    expect(closes()[0]).toBe("codex close thread=t-reset reason=mounted-single-use");
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
    expect(dispatches().slice(1).every((line) => line === "codex dispatch thread=t-sealed process=spawned reason=no-process")).toBe(true);
    expect(closes().slice(0, 3).every((line) => line === "codex close thread=t-sealed reason=mounted-single-use")).toBe(true);
    for (const earlier of pids.slice(0, 3)) await eventually(() => exited(earlier));
  });

  it("respawns when the harness resumes a different conversation than the one the process holds", async () => {
    await create();
    await run("t-cur", "one", base);
    await run("t-cur", "two", { ...base, resumeCursor: "some-other-conversation" });
    expect(dispatches()[1]).toBe("codex dispatch thread=t-cur process=spawned reason=no-process");
  });

  it("recycles after Stop, and the next turn spawns fresh", async () => {
    await create();
    const one = await run("t-stop", "one", base);
    setMode("approval");
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-stop", text: "two", resumeCursor: sessions.get("t-stop"), ...base });
    await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-stop");
    await instance.adapter.interruptTurn("t-stop");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(closes().at(-1)).toBe("codex close thread=t-stop reason=mounted-single-use");
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
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-auth", text: "two", resumeCursor: sessions.get("t-auth"), ...base });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect((last("turn.completed") as any).ok).toBe(false);
    expect(closes().at(-1)).toBe("codex close thread=t-auth reason=mounted-single-use");
    setMode("resume");
    await run("t-auth", "three", base);
    expect(spawns()).toHaveLength(3);
  });

  it("does not replay a failed turn on the retained process: it fails once, the process closes, the next turn spawns fresh", async () => {
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await run("t-noretry", "one", base);
    // a transient failure would be relaunched for the turn that launched the process; this turn did not
    setMode("transient-503");
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-noretry", text: "two", resumeCursor: sessions.get("t-noretry"), ...base });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    delete process.env.FAKE_CODEX_RETRY_SCALE;
    expect((last("turn.completed") as any).ok).toBe(false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(spawns()).toHaveLength(2);
    expect(closes().at(-1)).toBe("codex close thread=t-noretry reason=mounted-single-use");
    setMode("resume");
    await run("t-noretry", "three", base);
    expect(spawns()).toHaveLength(3);
  });

  it("closes the process after the idle window and spawns fresh on the next turn", async () => {
    process.env.MURAGE_CODEX_SESSION_IDLE_MIN_MS = "1";
    process.env.MURAGE_CODEX_SESSION_IDLE_MS = "150";
    await create();
    const one = await run("t-idle", "one", base);
    await eventually(() => closes().some((l) => l === "codex close thread=t-idle reason=mounted-single-use"));
    await eventually(() => exited(one.pid!));
    const two = await run("t-idle", "two", base);
    expect(two.pid).not.toBe(one.pid);
    expect(dispatches()[1]).toBe("codex dispatch thread=t-idle process=spawned reason=no-process");
  });

  it("recycles when the process died while idle", async () => {
    await create();
    const one = await run("t-dead", "one", base);
    expect(() => process.kill(one.pid!, 0)).toThrow();
    expect(closes()).toContain("codex close thread=t-dead reason=mounted-single-use");
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
      await eventually(() => closes().some((l) => l === "codex close thread=t-leak reason=mounted-single-use"));
      const two = await run("t-leak", "two", base);
      expect(two.pid).not.toBe(one.pid);
      expect(dispatches()[1]).toBe("codex dispatch thread=t-leak process=spawned reason=no-process");
    });

    it("retires the mounted process even when only an MCP server's own child appeared", async () => {
      const mcpServer = 777_100;
      // the MCP server is in the baseline and still the only thing under the app-server at settle
      probe.override = async () => new Set([mcpServer]);
      await create();
      const one = await run("t-mcp", "one", base);
      const two = await run("t-mcp", "two", base);
      expect(two.pid).not.toBe(one.pid);
      expect(closes()).toEqual(["codex close thread=t-mcp reason=mounted-single-use", "codex close thread=t-mcp reason=mounted-single-use"]);
    });

    it("fails closed when the probe has no answer", async () => {
      probe.override = async () => null;
      await create();
      await run("t-null", "one", base);
      await eventually(() => closes().some((l) => l === "codex close thread=t-null reason=mounted-single-use"));
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
      expect(dispatches()[1]).toBe("codex dispatch thread=t-flux process=spawned reason=no-process");
    });

    it("2. a credential file that cannot be emptied settles the turn and closes the process", async () => {
      hooks.failClear = true;
      await create();
      const one = await run("t-clear", "one", base);
      expect(one.cred?.content?.agents?.MURAGE_COMMS_TOKEN).toBe("tok-1");
      expect(one.completed.ok).toBe(true);
      expect(closes().at(-1)).toBe("codex close thread=t-clear reason=mounted-single-use");
      await eventually(() => exited(one.pid!));
      hooks.failClear = false;
      const two = await run("t-clear", "two", base);
      expect(two.pid).not.toBe(one.pid);
    });

    it("3. keeps no plaintext secret in the warm key's parts", async () => {
      await create();
      const local = { command: process.execPath, args: ["--token=sekret-arg"], env: { BOX_TOKEN_X: "sekret-env", CUSTOM_CRED: "sekret-custom" } };
      await refusedMount("t-parts", "one", { ...base, integrations: { ...agents("tok-1"), localComputer: local as never } });
      // No external spawn contract is constructed at all (design 397).
      expect(hooks.keyParts).toEqual([]);
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
      await eventually(() => closes().some((l) => l === "codex close thread=t-late reason=mounted-single-use"));
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
      // S1:10: retained settle probes exist only for mount-free turns.
      const send = instance.adapter.sendTurn.bind(instance.adapter);
      instance.adapter.sendTurn = input => send({ ...input, integrations: undefined });
      await run("t-slot", "one", base);
      const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-slot", text: "two", resumeCursor: sessions.get("t-slot"), ...base });
      await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-slot", text: "three", ...base })).rejects.toThrow(/already running/);
      await instance.adapter.interruptTurn("t-slot");
      release();
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
      expect(last("turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(spawns()).toHaveLength(1);
      expect(dispatches()).toHaveLength(1);
    });

    // CLOSE-STOP-1014 Rev 3: the before-launch slot reads the latch at its one terminal. A Stop then a quit stays the
    // owner's Stop; when the end arrives against the listener clear is the accepted residual CODEX-PRELAUNCH-QUIT-ORDER.
    it("6b. Stop while a settle probe holds the slot, then quit: any end delivered is the Stop, once", async () => {
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
      // S1:10: retained settle probes exist only for mount-free turns.
      const send = instance.adapter.sendTurn.bind(instance.adapter);
      instance.adapter.sendTurn = input => send({ ...input, integrations: undefined });
      await run("t-slot-quit", "one", base);
      const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-slot-quit", text: "two", resumeCursor: sessions.get("t-slot-quit"), ...base });
      await instance.adapter.interruptTurn("t-slot-quit");
      const disposing = instance.dispose();
      release();
      await disposing;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const ends = recorder.events.filter((e) => e.type === "turn.completed" && e.turnId === second.turnId);
      expect(ends.length).toBeLessThanOrEqual(1);
      for (const end of ends) expect(end).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(recorder.events.filter((e) => e.type === "runtime.error" && e.turnId === second.turnId)).toEqual([]);
      expect(spawns()).toHaveLength(1);
    });

    it("7. a process that will not stop stays owned: Stop and dispose report it until it is gone", async () => {
      await create();
      await runOpen("t-stuck");
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-stuck")).rejects.toThrow(/still pending/);
      expect(recorder.events.filter(e => e.threadId === "t-stuck" && e.type === "request.resolved")).toEqual([expect.objectContaining({ behavior: "deny", source: "system" })]);
      await expect(instance.dispose()).rejects.toThrow(/still pending/);
      hooks.stuck = false; await hooks.releaseStops();
      await instance.dispose();
    });

    it("9. a partial approval begun under one turn and finished after it settled is never delivered to the next turn", async () => {
      await create();
      // fullAuto would accept whatever reached the next turn's handler
      await instance.dispose();
      instance = await admittedFixtureInstance(CodexDriver.create({ instanceId: "codex-warm-test", displayName: "Codex Warm Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } }));
      bindFixtureAdapter(instance.adapter);
      recorder = recordEvents(instance.adapter);
      catalogSpawns = allSpawns().length;
      setMode("split-approval");
      const one = await run("t-split", "one", base);
      setMode("resume");
      const two = await run("t-split", "two", base);
      await new Promise((r) => setTimeout(r, 600));
      expect(closes()).toContain("codex close thread=t-split reason=mounted-single-use");
      expect(two.pid).not.toBe(one.pid);
      expect(spawns()).toHaveLength(2);
      expect(recorder.events.filter((e) => e.type === "request.opened")).toEqual([]);
    });

    it("10. a second Stop on a process that survived the first reports failure until it is gone", async () => {
      await create();
      const one = await runOpen("t-stop2");
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-stop2")).rejects.toThrow(/still pending/);
      await expect(instance.adapter.interruptTurn("t-stop2")).rejects.toThrow(/still pending/);
      expect(exited(one.pid!)).toBe(false);
      hooks.stuck = false; await hooks.releaseStops();
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
      const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-base-stop", text: "one", ...base });
      await eventually(() => probing);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-base-stop")).rejects.toThrow(/still pending/);
      release();
      await new Promise((r) => setTimeout(r, 500));
      expect(readFileSync(callLog, "utf8")).not.toContain("turn/start");
      expect(recorder.events.some((e) => e.type === "turn.completed" && e.turnId === sent.turnId && (e as any).stopReason === "completed")).toBe(false);
      hooks.stuck = false; await hooks.releaseStops();
    });

    it("8. binds a Windows credential path so its backslashes survive in the generated config", () => {
      const winPath = "C:\\Users\\exampleuser\\AppData\\Local\\Temp\\murage-cred-ab12\\cred.json";
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
      // resume_model_changed is presented by the server as a localized send notice.
      expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
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
      instance = await admittedFixtureInstance(CodexDriver.create({
        instanceId: "codex-warm-gated", displayName: "Codex Warm Test", environment: { CODEX_HOME: ownerHome }, enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      }));
      bindFixtureAdapter(instance.adapter);
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

    it("F13 + F14: each conversation's process has its own file; a reused turn keeps its authenticated bytes; a close removes it", async () => {
      await gated();
      // a first conversation names the scope; closing it removes its process's file
      const w = await run("t-env-0", "one", { ...unmountedBase, cwd: scratch });
      const envW = envOf(w);
      const home = dirname(envW);
      expect(home).toBe(join(w.seen.env.CODEX_HOME, "hook-env"));
      expect(existsSync(envW)).toBe(true);
      await instance.adapter.interruptTurn("t-env-0");
      await eventually(() => !existsSync(envW));
      holdThreads.add("t-env-a");
      try {
        // A is busy on an open card: its process and its file are live
        const a = await instance.adapter.sendTurn({ threadId: "t-env-a", text: "one", ...unmountedBase, cwd: scratch });
        const card: any = await recorder.until((e: any) => e.type === "request.opened" && e.turnId === a.turnId);
        const filesNow = () => readdirSync(home).filter((f) => f.endsWith(".env"));
        expect(filesNow()).toHaveLength(1);
        const envA = join(home, filesNow()[0]!);
        const tokenA = readFileSync(envA, "utf8");
        // B's two turns on one kept process
        const b1 = await run("t-env-b", "one", { ...unmountedBase, cwd: scratch });
        const envB = envOf(b1);
        expect(envB).not.toBe(envA);
        expect(dirname(envB)).toBe(home);
        const tokenB = readFileSync(envB, "utf8");
        expect(tokenB).not.toBe(tokenA); // distinct children still have distinct credentials
        const b2 = await run("t-env-b", "two", { ...unmountedBase, cwd: scratch });
        expect(lines.join(" | ")).toContain("thread=t-env-b process=reused");
        expect(b2.pid).toBe(b1.pid);
        expect(envOf(b2)).toBe(envB);
        // Rev 8: the env hash and token are fixed for one child lifetime.
        expect(readFileSync(envB, "utf8")).toBe(tokenB);
        expect(tokenB).not.toBe(tokenA);
        expect(createHash("sha256").update(tokenB).digest("hex")).toBe(b2.seen.env.MURAGE_CODEX_HOOK_ENV_SHA256);
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

    // Pins the mounted contract the F4 cases above no longer exercise (they run unmounted): a MOUNTED turn is single use (S1 section 0).
    it("F13 mounted: a second mounted turn starts a new process, and the hook env file of the first is removed, never reused", async () => {
      await gated();
      const m1 = await run("t-env-m", "one", { ...base, cwd: scratch });
      const envM1 = envOf(m1);
      await eventually(() => !existsSync(envM1));
      const m2 = await run("t-env-m", "two", { ...base, cwd: scratch });
      expect(lines.join(" | ")).not.toContain("thread=t-env-m process=reused");
      expect(m2.pid).toBeTruthy();
      expect(m2.pid).not.toBe(m1.pid);
      expect(envOf(m2)).not.toBe(envM1);
    });

    it("F19: a close whose kill is not confirmed keeps the file and the conversation owned; a hook whose file was swept is blocked", async () => {
      await gated();
      const a1 = await run("t-env-stuck", "one", { ...unmountedBase, cwd: scratch });
      const envA = envOf(a1);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-env-stuck")).rejects.toThrow(/still pending/);
      expect(existsSync(envA)).toBe(true);
      await expect(instance.adapter.sendTurn({ threadId: "t-env-stuck", text: "again", ...unmountedBase, cwd: scratch })).rejects.toThrow(/has not closed yet/);
      hooks.stuck = false;
      await instance.adapter.interruptTurn("t-env-stuck");
      await eventually(() => !existsSync(envA));
      // a leftover engine of an earlier Murage run finds no file: its hook blocks, it is never handed another process's socket
      const blocked = spawnSync(process.execPath, [join(a1.seen.env.CODEX_HOME, "murage-hook.mjs")], {
        windowsHide: true,
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "x" }),
        env: { ...process.env, MURAGE_CODEX_HOOK_ENV: envA },
      });
      // PreToolUse blocks with the documented deny on stdout and exit 0 since 1.0.3 (codex-hook.ts block()).
      expect(blocked.status).toBe(0);
      expect(JSON.parse(String(blocked.stdout)).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(String(blocked.stderr)).toContain("Murage blocked this call");
    });

  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: keep the frozen ID; additional coverage has its own ID.
  it("SC-SAFETY added coverage: F19: a close whose kill is not confirmed keeps the file and the conversation owned; a hook whose file was swept is blocked", async () => {
      await gated();
      const a1 = await run("t-env-stuck", "one", { ...unmountedBase, cwd: scratch });
      const envA = envOf(a1);
      hooks.stuck = true;
      await expect(instance.adapter.interruptTurn("t-env-stuck")).rejects.toThrow(/still pending/);
      expect(existsSync(envA)).toBe(true);
      await expect(instance.adapter.sendTurn({ threadId: "t-env-stuck", text: "again", ...unmountedBase, cwd: scratch })).rejects.toThrow(/has not closed yet/);
      hooks.stuck = false;
      await instance.adapter.interruptTurn("t-env-stuck");
      await eventually(() => !existsSync(envA));
      // The current bound hook finds the swept file and emits only the exact
      // fixed refusal frame. Filesystem details must not reach the model.
      const boundBlocked = spawnSync(process.execPath, [join(a1.seen.env.CODEX_HOME, "murage-hook.mjs")], {
        windowsHide: true,
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "x" }),
        env: { ...process.env, MURAGE_CODEX_HOOK_ENV: envA },
      });
      expect(boundBlocked.status).toBe(0);
      expect(boundBlocked.stdout.toString()).toBe(HOOK_CONTROL_FRAMES["deny.unchecked"]);
      expect(boundBlocked.stderr.toString()).toBe("Murage blocked this call\n");
      expect(boundBlocked.stdout.toString() + boundBlocked.stderr.toString()).not.toContain("ENOENT");
      expect(existsSync(envA)).toBe(false);

      // An earlier Murage run used the real unbound hook archived from 7c9ce6fe
      // (source blob a6338e8b575b284b406db3d51345e10a25433ddb). Its diagnostics
      // belong to that older contract. The legacy env remains readable while
      // its socket is gone; the current swept-env case above remains separate.
      // The archived script is copied unchanged, never rewritten for this test.
      const legacyHome = join(scratch, "legacy-hook");
      mkdirSync(join(legacyHome, "hook-env"), { recursive: true, mode: 0o700 });
      const legacyBytes = readFileSync(new URL("../testing/fixtures/codex-hook-legacy-7c9ce6fe.mjs", import.meta.url));
      expect(createHash("sha256").update(legacyBytes).digest("hex")).toBe("fdb23c85d18cdd4dd371bfc1265d134477ed77b19360d13131009cc4421d12bc");
      const legacyScript = join(legacyHome, "murage-hook.mjs");
      writeFileSync(legacyScript, legacyBytes, { mode: 0o600 });
      const legacySocket = hookSocketPath(), legacyEnv = join(legacyHome, "hook-env", "retired.env");
      expect(existsSync(legacySocket)).toBe(false);
      const legacyEnvBytes = `SOCKET=${legacySocket}\nTOKEN=fixture\n`;
      writeFileSync(legacyEnv, legacyEnvBytes, { mode: 0o600 });
      const blocked = spawnSync(process.execPath, [legacyScript], {
        windowsHide: true,
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "x" }),
        env: { ...process.env, MURAGE_CODEX_HOOK_ENV: legacyEnv, MURAGE_CODEX_HOOK_ENV_SHA256: createHash("sha256").update(legacyEnvBytes).digest("hex") },
      });
      // PreToolUse refusals print a deny with exit 0 so Codex reads the decision on every shell.
      expect(blocked.status).toBe(0);
      expect(JSON.parse(String(blocked.stdout)).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(JSON.parse(blocked.stdout.toString())).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringMatching(/^Murage blocked this call: .*ENOENT/),
        },
      });
      expect(String(blocked.stderr)).toContain("Murage blocked this call");
    });

    it("F21: a second Codex instance on the same scope sweeps at its start and keeps the first instance's live file; the first's hooks keep working", async () => {
      await gated();
      const x = instance;
      const xRecorder = recorder;
      const x1 = await run("t-env-x", "one", { ...unmountedBase, cwd: scratch });
      const envX = envOf(x1);
      const home = x1.seen.env.CODEX_HOME as string;
      const dead = join(home, "hook-env", "999999-0dead.env");
      writeFileSync(dead, "SOCKET=x\nTOKEN=y\n");
      // the second instance: its own driver start, the same bot scope
      await gated();
      const y1 = await run("t-env-y", "one", { ...unmountedBase, cwd: scratch });
      expect(y1.seen.env.CODEX_HOME).toBe(home);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(envX)).toBe(true);
      const y = instance;
      recorder.stop();
      await y.dispose();
      // back on the first instance: its retained process's hook still reaches its own turn (an in-project edit is allowed by the hook)
      instance = x;
      recorder = xRecorder;
      const x2 = await run("t-env-x", "two", { ...unmountedBase, cwd: scratch });
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
    integrations: { agents: { command: process.execPath, args: [fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url))], env: { MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: "tok-1" } } },
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
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.turnId === sent.turnId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    return sent;
  };
  const goCold = async (threadId: string) => {
    await run(threadId, "one", base);
    await eventually(() => warmPool.idleCount() === 0);
    await eventually(() => lines.some((l) => l.startsWith(`codex close thread=${threadId} reason=mounted-single-use`)));
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    sessions.clear();
    base.warmIdentity.botId = randomUUID();
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
    hooks.stuck = false; hooks.failClear = false; hooks.clears = 0; hooks.keyParts.length = 0; hooks.stores.length = 0;
  });
  afterEach(async () => {
    for (const key of [...ENV, "MURAGE_WARM_ACTIVITY_WINDOW_MS"]) delete process.env[key];
    hooks.stuck = false; await hooks.releaseStops();
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });
  const create = async () => {
    instance = await admittedFixtureInstance(CodexDriver.create({
      instanceId: "codex-prewarm-test", displayName: "Codex Prewarm Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    }));
    bindFixtureAdapter(instance.adapter);
    recorder = recordEvents(instance.adapter);
    catalogSpawns = readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  };

  it("mounted prewarm starts no app-server, emits nothing and leaves no idle slot", async () => {
    await create();
    await goCold("t-pw-release");
    const before = recorder.events.length;
    expect(await instance.adapter.prewarm!("t-pw-release")).toBe(false);
    expect(await instance.adapter.prewarm!("t-pw-release")).toBe(false);
    expect(spawns()).toHaveLength(1);
    expect(recorder.events).toHaveLength(before);
    await warmPool.tick();
    expect(warmPool.idleCount()).toBe(0);
    expect(lines.filter(l => l.startsWith("codex close thread=t-pw-release reason=mounted-single-use"))).toHaveLength(1);
  });

  it.each(["ordinary", "confirmation pending", "unconfirmed stop", "spawn race"])(
    "mounted prewarm is refused before holdIdle with %s", async fault => {
      await create();
      await goCold("t-pw-hold");
      const held = Number(spawns().at(-1));
      expect(exitedPid(held)).toBe(true);
      if (fault === "confirmation pending") hooks.hang = new Promise<boolean>(() => {});
      if (fault === "unconfirmed stop") hooks.stuck = true;
      try {
        const warming = instance.adapter.prewarm!("t-pw-hold");
        const hold = await instance.adapter.holdIdle!();
        try {
          expect(await warming).toBe(false);
          expect(hold.confirmed).toBe(true); // no prewarm child exists to hold
          expect(await instance.adapter.prewarm!("t-pw-hold")).toBe(false);
        } finally { hold.release(); }
        expect(await instance.adapter.prewarm!("t-pw-hold")).toBe(false);
        expect(spawns()).toHaveLength(1);
        expect(warmPool.idleCount()).toBe(0);
      } finally { hooks.hang = null; hooks.stuck = false; }
    });

  it("refused mounted prewarm then send starts a second app-server", async () => {
    await create();
    await goCold("t-pw-reuse");
    // goCold needed the short window; now the parked engine must outlive the send. The pool
    // judges the window when its size probe answers, and a real Windows listing (~0.5 s)
    // outlasts 250 ms, so the engine would be let go as idle first (reason=no-process).
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    expect(await instance.adapter.prewarm!("t-pw-reuse")).toBe(false);
    await run("t-pw-reuse", "two", base);
    expect(spawns()).toHaveLength(2);
    expect(dispatches().at(-1)).toContain("process=spawned reason=no-process");
  });

  it("a changed key after refused mounted prewarm still takes the cold path", async () => {
    await create();
    await goCold("t-pw-key");
    // goCold needed the short window; now the parked engine must outlive the send. The pool
    // judges the window when its size probe answers, and a real Windows listing (~0.5 s)
    // outlasts 250 ms, so the engine would be let go as idle first (reason=no-process).
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    expect(await instance.adapter.prewarm!("t-pw-key")).toBe(false);
    await run("t-pw-key", "two", { ...base, routeAsks: true });
    expect(spawns()).toHaveLength(2);
    expect(dispatches().at(-1)).toContain("process=spawned reason=no-process");
  });

  it("mounted intent-prewarm creates no new credentials or process (S1)", async () => {
    await create();
    await goCold("t-pw-cred");
    const before = hooks.clears;
    expect(await instance.adapter.prewarm!("t-pw-cred")).toBe(false);
    expect(hooks.clears).toBe(before);
    // The counted clear must belong to a real, populated driver store. A
    // mount-free prewarm cannot satisfy this disk/lifecycle evidence.
    expect(hooks.stores.length).toBe(1);
    const store = hooks.stores.at(-1)!;
    expect(store.writes.some(secrets => secrets.agents?.MURAGE_COMMS_TOKEN === "tok-1")).toBe(true);
    expect(existsSync(store.path)).toBe(false);
    expect(warmPool.idleCount()).toBe(0);
  });

  it("mounted prewarm never reaches credential clear, even when clear would fail (S1)", async () => {
    await create();
    await goCold("t-pw-cred-fail");
    hooks.failClear = true;
    expect(await instance.adapter.prewarm!("t-pw-cred-fail")).toBe(false);
    expect(hooks.stores.length).toBe(1);
    expect(hooks.stores.at(-1)!.writes.some(secrets => secrets.agents?.MURAGE_COMMS_TOKEN === "tok-1")).toBe(true);
    expect(warmPool.idleCount()).toBe(0);
    expect(lines.some((l) => l.startsWith("codex prewarm thread=t-pw-cred-fail"))).toBe(false);
  });

  it.each(["slow resume", "failed takeover", "unconfirmed clear"])(
    "mounted prewarm never enters %s and the next admitted turn starts cold", async fault => {
      await create();
      await goCold("t-pw-fault");
      const first = Number(spawns().at(-1));
      const gate = join(scratch, "resume-gate");
      process.env.FAKE_CODEX_RESUME_GATE = gate;
      process.env.MURAGE_PREWARM_WAIT_MS = "50";
      process.env.MURAGE_PREWARM_TAKEOVER_MS = "400";
      hooks.stuck = fault !== "slow resume";
      hooks.failClear = fault === "unconfirmed clear";
      try {
        expect(await instance.adapter.prewarm!("t-pw-fault")).toBe(false);
        expect(spawns()).toHaveLength(1);
        expect(exitedPid(first)).toBe(true);
        expect(hooks.stores).toHaveLength(1);
        expect(warmPool.idleCount()).toBe(0);
      } finally {
        hooks.stuck = false; hooks.failClear = false;
        delete process.env.MURAGE_PREWARM_TAKEOVER_MS;
        writeFileSync(gate, "open");
      }
      const next = await run("t-pw-fault", "two", base);
      expect(next.turnId).toBeTruthy();
      expect(spawns()).toHaveLength(2);
      expect(Number(spawns().at(-1))).not.toBe(first);
      expect(dispatches().at(-1)).toContain("process=spawned reason=no-process");
    });

  // RULED (MurageMain, s21): a mounted prewarm is refused before any spawn (codex.ts mountedTurn gate), so the takeover path
  // (codex.ts prewarm takeover) is reachable only by an UNMOUNTED prewarm, e.g. a bot with no integrations. The tip assertions
  // for that path are restored here on an unmounted turn, unchanged apart from the base and the close reason of an unmounted goCold.
  const unmounted = { warmIdentity: base.warmIdentity } satisfies Partial<SendTurnInput>;
  const goColdUnmounted = async (threadId: string) => {
    await run(threadId, "one", unmounted);
    await eventually(() => warmPool.idleCount() === 0);
    await eventually(() => lines.some((l) => l.startsWith(`codex close thread=${threadId} reason=activity window`)));
  };

  it("unmounted: a send that outwaits a slow prewarm takes over: the prewarm is cancelled and its slot freed, never already running", async () => {
    await create();
    await goColdUnmounted("t-pw-slow");
    const gate = join(scratch, "resume-gate");
    process.env.FAKE_CODEX_RESUME_GATE = gate;
    process.env.MURAGE_PREWARM_WAIT_MS = "100";
    const warming = instance.adapter.prewarm!("t-pw-slow");
    await eventually(() => spawns().length === 2);
    await new Promise((r) => setTimeout(r, 200));
    setTimeout(() => writeFileSync(gate, "open"), 500);
    const sent = await run("t-pw-slow", "two", unmounted);
    expect(sent.turnId).toBeTruthy();
    await warming;
  });

  // Changed with presence P-FENCE 2 (MAIN-RULING presence-held 2026-11-22T21:52Z, "an owner send never fails behind a prewarm"): this cell
  // used to expect the send to FAIL with TAKEOVER_FAILED_MESSAGE when the prewarm would not stop. The send now detaches the hung prewarm
  // and dispatches cold at once; the same setup (a prewarm whose process ignores the kill) is kept.
  it("unmounted: a prewarm that cannot be ended never fails the send: it is detached and the send dispatches cold within its bound, never already running", async () => {
    await create();
    await goColdUnmounted("t-pw-stuck");
    process.env.FAKE_CODEX_RESUME_GATE = join(scratch, "never-opens");
    process.env.MURAGE_PREWARM_WAIT_MS = "50";
    process.env.MURAGE_PREWARM_TAKEOVER_MS = "400";
    const warming = instance.adapter.prewarm!("t-pw-stuck");
    await eventually(() => spawns().length === 2);
    hooks.stuck = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let sent: { turnId: string } | null = null;
    try {
      const t0 = Date.now();
      const before = dispatches().filter((l) => l.startsWith("codex dispatch thread=t-pw-stuck ")).length;
      const result = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-pw-stuck", text: "two", ...unmounted }).then((r) => ({ r, error: null }), (e: Error) => ({ r: null, error: e }));
      expect(result.error?.message ?? null).toBeNull();
      sent = result.r;
      await eventually(() => dispatches().filter((l) => l.startsWith("codex dispatch thread=t-pw-stuck ")).length === before + 1);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(lines.some((l) => l === "codex prewarm detach thread=t-pw-stuck reason=hung")).toBe(true);
      expect(warn.mock.calls.some(([l]) => String(l).startsWith("codex prewarm takeover thread=t-pw-stuck failed=true"))).toBe(false);
    } finally {
      warn.mockRestore();
      hooks.stuck = false;
      writeFileSync(process.env.FAKE_CODEX_RESUME_GATE!, "open");
      delete process.env.MURAGE_PREWARM_TAKEOVER_MS;
    }
    if (sent) await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent!.turnId);
    await warming;
  });

  // RULED (MurageMain, s21): the tip test "a prewarm whose close is unconfirmed stays owned in the stuck registry" (held pid alive,
  // send rejects /has not closed yet/, interruptTurn rejects /still pending/, spawns 2 then 3) is retired together with the dead
  // codex.ts branch it covered (prewarm credential-clear failure). An unmounted prewarm has no credential store to fail clearing.

  it("a prewarm whose close is unconfirmed stays owned in the stuck registry: the next send is refused until it is gone", async () => {
    await create();
    await goColdUnmounted("t-pw-unclosed");
    // D5: exercise real retained-process ownership through the stop I/O edge.
    await instance.adapter.prewarm!("t-pw-unclosed");
    hooks.stuck = true; // and its app-server will not stop
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(instance.adapter.interruptTurn("t-pw-unclosed")).rejects.toThrow(/still pending/);
      expect(await instance.adapter.prewarm!("t-pw-unclosed")).toBe(false);
      const held = Number(spawns().at(-1));
      expect(exitedPid(held)).toBe(false);
      hooks.failClear = false;
      // nothing new starts beside the process that is still owned
      await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-pw-unclosed", text: "two", ...base })).rejects.toThrow(/has not closed yet/);
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

  it("the fence runs at the spawn with the cursor the launch resumes; a pass starts the engine", async () => {
    await create();
    // S1 admits intent prewarm only without mounted integrations. Keep its
    // real fence/spawn path alive while the process-table probe completes.
    await goColdUnmounted("t-pw-fence");
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    const fence = vi.fn();
    expect(await instance.adapter.prewarm!("t-pw-fence", { fence })).toBe(true);
    expect(fence.mock.calls).toEqual([[sessions.get("t-pw-fence")]]);
  });

  it("a fence refusal spawns nothing, answers false and ends the spare lost fence:<reason>", async () => {
    await create();
    await goColdUnmounted("t-pw-refused");
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "30000";
    const before = spawns().length;
    const lost = () => reuseStats.snapshot().spares.lost["fence:cursor-moved"] ?? 0;
    const was = lost();
    const events = recorder.events.length;
    expect(await instance.adapter.prewarm!("t-pw-refused", { fence: () => { throw new PrewarmRefused("cursor-moved"); } })).toBe(false);
    expect(spawns()).toHaveLength(before);
    expect(lost()).toBe(was + 1);
    expect(recorder.events.length).toBe(events); // nobody is told
    expect(instance.adapter.hasSession("t-pw-refused")).toBe(false);
    expect(await instance.adapter.prewarm!("t-pw-refused")).toBe(true); // nothing stays held
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

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
