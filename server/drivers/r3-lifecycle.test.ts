import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import * as procs from "../procs.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { PiDriver } from "./pi.ts";
import { stopBudget } from "./child-teardown.ts";
import { createFixtureAcpDriver as createAcpDriver } from "../testing/acp-support-fixture.ts";
import { CliMountRelay, assertRelayAvailable } from "./cli-mount-relay.ts";
import { ChatMcpDescendants } from "./chat-mcp-client.ts";

vi.mock("node:child_process", async original => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
type Engine = "AGY" | "PI" | "HERMES";
let root: string, instance: ProviderInstance | undefined;
let children: ChildProcess[], relays: CliMountRelay[], recover: Array<() => void>;
beforeEach(() => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "r3-lifecycle-"));
  mkdirSync(join(root, "home")); mkdirSync(join(root, "work"));
  children = []; relays = []; recover = [];
  vi.stubEnv("MURAGE_ACP_POOL", "1");
  vi.stubEnv("FAKE_ACP_MCP_LIST", "all:ready");
  vi.stubEnv("FAKE_ACP_SPAWN_LOG", join(root, "acp-pids"));
  vi.stubEnv("FAKE_AGY_MCP_DUMP", join(root, "agy-mounts"));
  const spawn = procs.spawnCli;
  vi.spyOn(procs, "spawnCli").mockImplementation((...args) => { const child = spawn(...args); children.push(child); return child; });
  const create = CliMountRelay.create;
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => { const relay = await create(...args); relays.push(relay); return relay; });
});
afterEach(async () => {
  for (const release of recover) release();
  vi.restoreAllMocks();
  try { await instance?.dispose(); }
  finally {
    instance = undefined;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) procs.killCliTree(child);
    vi.unstubAllEnvs(); await removeTempDir(root);
  }
});
async function create(engine: Engine, fullAuto = true) {
  const cli = fileURLToPath(new URL(`../testing/${engine === "AGY" ? "fake-agy-cli.ts" : engine === "PI" ? "fake-pi-cli.ts" : "fake-acp-cli.ts"}`, import.meta.url));
  chmodSync(cli, 0o755);
  const driver = engine === "AGY" ? AntigravityDriver : engine === "PI" ? PiDriver : createAcpDriver({
    fluxReach: () => "elsewhere", // The lifecycle peer has no model upstream.
    driverKind: "hermesAgent", displayName: "R3 Hermes", defaultCli: cli, nativeSource: "r3.lifecycle",
    models: { default: "", options: [] }, loginNote: "fixture", spawnArgs: () => [],
    pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
    pooledSessions: true, mcpListMethod: "_fuigo/mcp/list",
  });
  instance = await driver.create({ instanceId: `r3-${engine}`, displayName: engine === "PI" ? "Pi" : engine, enabled: true,
    environment: { HOME: join(root, "home") }, config: { cli, fullAuto } });
  instance.adapter.onEvent(event => {
    if (event.type === "request.opened") void instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: "allow" });
  });
  return recordEvents(instance.adapter);
}
function turn(mounted: boolean, extra: Partial<SendTurnInput> = {}) {
  return fixtureMountTurn({ threadId: root, cwd: join(root, "work"), text: "hello",
    warmIdentity: { botId: root, audience: "owner", decidedOwner: true },
    ...(mounted ? { integrations: { agents: { command: process.execPath,
      args: [fileURLToPath(new URL("../testing/r3-mounted-server.mjs", import.meta.url))],
      env: { R3_MCP_LOG: join(root, "mcp-log"), ...(process.env.R3_MCP_GATE ? { R3_MCP_GATE: process.env.R3_MCP_GATE } : {}) } } } } : {}), ...extra });
}
const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** An unconfirmed tree has neither an ordinary stop receipt nor the forced
 * route's independent receipt. The explicit held signal is its only proof. */
function holdTreeConfirmation(uncertain: () => boolean, confirmation: Promise<true>) {
  const confirmTree = procs.awaitCliTreeStopped;
  const forceTree = procs.forceCliTreeStopped;
  const stoppedSignal = procs.cliTreeStoppedSignal;
  vi.spyOn(procs, "awaitCliTreeStopped").mockImplementation((...args) => uncertain() ? Promise.resolve(false) : confirmTree(...args));
  vi.spyOn(procs, "forceCliTreeStopped").mockImplementation((...args) => uncertain() ? Promise.resolve(false) : forceTree(...args));
  vi.spyOn(procs, "cliTreeStoppedSignal").mockImplementation(child => uncertain() ? confirmation : stoppedSignal(child));
}

describe("R3 mounted driver lifecycle", () => {
  for (const engine of ["AGY", "HERMES"] as const) {
    for (const stop of [true, false]) {
      it(`T-R3-${engine}-MOUNTED-LATE-RESULT${stop ? "" : "-CONTROL"}`, async () => {
        const gate = join(root, "mount-result");
        vi.stubEnv("R3_MCP_GATE", gate);
        vi.stubEnv("FAKE_AGY_MODE", "ask-peer");
        if (engine === "HERMES") vi.stubEnv("FAKE_CUSTOM_TOOL_SERVER", "agents");
        recover.push(() => writeFileSync(`${gate}.release`, "cleanup"));
        const records = await create(engine);
        const forwarded: string[] = [];
        const write = Socket.prototype.write;
        vi.spyOn(Socket.prototype, "write").mockImplementation(function (this: Socket, ...args: any[]) {
          if (String(args[0]).includes("R3-MOUNT-LATE")) forwarded.push(String(args[0]));
          return Reflect.apply(write, this, args);
        });
        const retire = vi.spyOn(CliMountRelay.prototype, "retire");
        const sent = await instance!.adapter.sendTurn(turn(true));
        await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15_000 }).toBe(true);
        const pid = Number(readFileSync(`${gate}.waiting`, "utf8"));
        expect(children.some(child => child.pid === pid)).toBe(true);
        expect(forwarded).toEqual([]);
        let stopping: ReturnType<ProviderInstance["adapter"]["interruptTurn"]> | undefined;
        if (stop) {
          stopping = instance!.adapter.interruptTurn(root, sent.turnId);
          // Stop must retire ingress before the held real MCP result is emitted.
          await expect.poll(() => retire.mock.calls.length).toBeGreaterThan(0);
        }
        writeFileSync(`${gate}.release`, "emit held MCP result");
        await expect.poll(() => existsSync(`${gate}.attempted`)).toBe(true);
        expect(readFileSync(`${gate}.attempted`, "utf8")).toBe(String(pid));
        if (stopping) expect(await stopping).toMatchObject({ closeConfirmed: true });
        await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
        expect(await relays[0]!.finish()).toBe(true);
        await relays[0]!.stopped;
        if (stop) {
          expect(forwarded).toEqual([]);
          expect(JSON.stringify(records.events)).not.toContain("R3-MOUNT-LATE");
        } else {
          expect(forwarded.length).toBeGreaterThan(0);
          expect(JSON.stringify(records.events)).toContain("R3-MOUNT-LATE");
        }
        await expect.poll(() => children.every(ended)).toBe(true);
      }, 30_000);
    }
  }

  for (const engine of ["AGY", "HERMES"] as const) {
    for (const fault of [true, false]) {
      it(`T-R3-${engine}-FAILED-DESCENDANT-QUARANTINE${fault ? "" : "-CONTROL"}`, async () => {
        const records = await create(engine);
        const stop = ChatMcpDescendants.prototype.stop;
        const gone = ChatMcpDescendants.prototype.goneSignal;
        let confirm!: (value: true) => void;
        const confirmation = new Promise<true>(resolve => { confirm = resolve; });
        recover.push(() => confirm(true));
        vi.spyOn(ChatMcpDescendants.prototype, "stop").mockImplementation(function (this: ChatMcpDescendants) {
          return fault ? Promise.resolve(false) : stop.call(this);
        });
        vi.spyOn(ChatMcpDescendants.prototype, "goneSignal").mockImplementation(function (this: ChatMcpDescendants) {
          return fault ? confirmation : gone.call(this);
        });
        const first = turn(true);
        const sent = await instance!.adapter.sendTurn(first);
        await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
        expect(relays).toHaveLength(1);
        const relay = relays[0]!;
        expect(await relay.finish()).toBe(!fault);
        let released = false;
        void relay.stopped.then(() => { released = true; });
        await Promise.resolve();
        if (fault) {
          // A root exit is insufficient. Ownership remains in the same relay.
          expect(released).toBe(false);
          expect(() => assertRelayAvailable(first)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
          const count = children.length;
          await expect(instance!.adapter.sendTurn(turn(true))).rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
          expect(children).toHaveLength(count);
          expect(await relay.finish()).toBe(false);
          confirm(true);
          await relay.stopped;
          expect(await relay.finish()).toBe(true);
        } else expect(released).toBe(true);
        expect(() => assertRelayAvailable(first)).not.toThrow();
        // Late descendant confirmation releases quarantine without forgetting
        // the first generation or reusing its engine process.
        const before = new Set(children.map(child => child.pid));
        const next = await instance!.adapter.sendTurn(turn(true));
        await records.until(e => e.type === "turn.completed" && e.turnId === next.turnId);
        expect(children.some(child => !before.has(child.pid))).toBe(true);
        expect(relays).toHaveLength(2);
        confirm(true);
        await relays[1]!.finish();
      }, 30_000);
    }
  }

  for (const mounted of [true, false]) {
    it(`T-R3-AGY-MOUNTED-INTEGRATION${mounted ? "" : "-CONTROL"}`, async () => {
      vi.stubEnv("FAKE_AGY_MODE", mounted ? "ask-peer" : "happy");
      const records = await create("AGY");
      const sent = await instance!.adapter.sendTurn(turn(mounted));
      expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: true });
      if (mounted) {
        expect(relays).toHaveLength(1);
        const config = JSON.parse(readFileSync(join(root, "agy-mounts"), "utf8"));
        const servers = Object.values(config.mcpServers) as Array<{ args: string[]; env: Record<string, string> }>;
        expect(servers).toHaveLength(1);
        expect(servers[0]!.args[0]).toMatch(/cli-mount-shim/);
        expect(servers[0]!.env.MURAGE_RELAY_TICKET).toBeTruthy();
        expect(JSON.stringify(config)).not.toContain("r3-mounted-server.mjs");
        expect(JSON.stringify(records.events)).toContain("R3-MOUNT-DELIVERED");
        const log = readFileSync(join(root, "mcp-log"), "utf8");
        expect(log).toContain('"method":"tools/call"');
        expect(await relays[0]!.finish()).toBe(true);
        await relays[0]!.stopped;
        await expect.poll(() => children.every(ended)).toBe(true);
      } else {
        expect(relays).toEqual([]);
        expect(existsSync(join(root, "mcp-log"))).toBe(false);
        expect(JSON.stringify(records.events)).toContain("done from fake agy");
      }
    }, 30_000);
  }

  for (const engine of ["AGY", "PI"] as const) {
    for (const stale of [true, false]) {
      it(`T-R3-${engine}-STALE-PROCESS-TAKEOVER${stale ? "" : "-CONTROL"}`, async () => {
        const retirement = join(root, "retiring");
        vi.stubEnv("FAKE_R3_RETIRE", retirement);
        recover.push(() => writeFileSync(`${retirement}.release`, "cleanup"));
        const records = await create(engine);
        expect(instance!.adapter.prewarm).toBeUndefined();
        const first = await instance!.adapter.sendTurn(turn(engine === "AGY"));
        await records.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
        await expect.poll(() => existsSync(`${retirement}.waiting`)).toBe(true);
        const pid = Number(readFileSync(`${retirement}.waiting`, "utf8"));
        const old = children.find(child => child.pid === pid)!;
        expect(old).toBeDefined();
        expect(ended(old)).toBe(false);
        vi.stubEnv("FAKE_R3_RETIRE", "");
        if (stale) {
          const before = children.length;
          if (engine === "PI") {
            // Intended grace-plus-kill wait: see the Pi behaviour note in the lane evidence.
            const budget = stopBudget(procs.CLI_TERM_GRACE_MS).maxMs;
            const started = Date.now();
            const spawn = vi.mocked(procs.spawnCli).getMockImplementation()!;
            vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
              expect(ended(old)).toBe(true);
              return spawn(...args);
            });
            let resolved = false;
            const pending = instance!.adapter.sendTurn(turn(false, { resumeCursor: "/fake/stale-pi.json" }))
              .then(sent => { resolved = true; return sent; });
            await Promise.resolve();
            expect(resolved).toBe(false);
            expect(children).toHaveLength(before);
            const sent = await pending;
            expect(Date.now() - started).toBeLessThan(budget + 1_000);
            expect(ended(old)).toBe(true);
            expect(children.length).toBeGreaterThan(before);
            for (const child of children.slice(before)) expect(child.pid).not.toBe(pid);
            expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: true });
          } else {
            await expect(instance!.adapter.sendTurn(turn(engine === "AGY", { resumeCursor: "stale-session" }))).rejects.toThrow();
            expect(children).toHaveLength(before);
            expect(ended(old)).toBe(false);
          }
        }
        writeFileSync(`${retirement}.release`, "retirement confirmed");
        await expect.poll(() => children.every(ended)).toBe(true);
        if (engine === "AGY") await relays[0]!.stopped;
        else await instance!.adapter.awaitTurnClose!(root, first.turnId);
        const previous = new Set(children.map(child => child.pid));
        const second = await instance!.adapter.sendTurn(turn(engine === "AGY", { resumeCursor: engine === "PI" ? "/fake/stale-pi.json" : "stale-agy-session" }));
        expect(await records.until(e => e.type === "turn.completed" && e.turnId === second.turnId)).toMatchObject({ ok: true });
        expect(children.slice(previous.size).length).toBeGreaterThan(0);
        for (const child of children.slice(previous.size)) expect(previous.has(child.pid)).toBe(false);
      }, 30_000);
    }
  }

  it("T-R3-PI-STALE-PROCESS-UNKILLABLE", async () => {
    vi.stubEnv("MURAGE_PROVIDER_CLOSE_MS", "50");
    const retirement = join(root, "unkillable");
    vi.stubEnv("FAKE_R3_RETIRE", retirement);
    let release!: (value: true) => void;
    const confirmation = new Promise<true>(resolve => { release = resolve; });
    let uncertain = true;
    recover.push(() => {
      uncertain = false;
      writeFileSync(`${retirement}.release`, "cleanup");
      release(true);
    });
    holdTreeConfirmation(() => uncertain, confirmation);
    // Model a kill route that never delivers or confirms; recovery releases the real fake child.
    vi.spyOn(procs, "killCliTree").mockImplementation(() => {});
    const records = await create("PI");
    const first = await instance!.adapter.sendTurn(turn(false));
    await records.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
    await expect.poll(() => existsSync(`${retirement}.waiting`)).toBe(true);
    const pid = Number(readFileSync(`${retirement}.waiting`, "utf8"));
    const old = children.find(child => child.pid === pid)!;
    expect(old).toBeDefined();
    expect(ended(old)).toBe(false);
    const before = children.length;
    const started = Date.now();
    await expect(instance!.adapter.sendTurn(turn(false))).rejects.toThrow("Pi is still closing its last turn");
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(stopBudget(procs.CLI_TERM_GRACE_MS).maxMs + 1_000);
    expect(children).toHaveLength(before);
    expect(old.pid).toBe(pid);
    expect(ended(old)).toBe(false);
    expect(await instance!.adapter.awaitTurnTeardown!(root, first.turnId)).toMatchObject({ closeConfirmed: false });
  }, 30_000);

  for (const fault of [true, false]) {
    it(`T-R3-PI-FAILED-DESCENDANT-QUARANTINE${fault ? "" : "-CONTROL"}`, async () => {
      vi.stubEnv("MURAGE_PROVIDER_CLOSE_MS", "50");
      let release!: (value: true) => void;
      const confirmation = new Promise<true>(resolve => { release = resolve; });
      recover.push(() => release(true));
      let uncertain = fault;
      holdTreeConfirmation(() => uncertain, confirmation);
      // The fault is installed before the driver exists: its teardown tracker binds the stop confirmation when created.
      const records = await create("PI");
      const first = await instance!.adapter.sendTurn(turn(false));
      await records.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
      await expect.poll(() => children.every(ended)).toBe(true);
      if (fault) {
        expect(await instance!.adapter.awaitTurnTeardown!(root, first.turnId)).toMatchObject({ closeConfirmed: false });
        await expect(instance!.adapter.stopAll()).rejects.toMatchObject({ code: "provider_stop_unconfirmed" });
        // Repeating the exact wait proves ownership was not forgotten after
        // the first failed stop or after the engine root closed.
        expect(await instance!.adapter.awaitTurnTeardown!(root, first.turnId)).toMatchObject({ closeConfirmed: false });
        const before = children.length;
        await expect(instance!.adapter.sendTurn(turn(false))).rejects.toThrow();
        expect(children).toHaveLength(before);
      } else expect(await instance!.adapter.awaitTurnTeardown!(root, first.turnId)).toEqual({ closeConfirmed: true });
      uncertain = false; release(true);
      await instance!.adapter.awaitTurnClose!(root, first.turnId);
      expect(await instance!.adapter.awaitTurnTeardown!(root, first.turnId)).toEqual({ closeConfirmed: true });
      const next = await instance!.adapter.sendTurn(turn(false));
      expect(await records.until(e => e.type === "turn.completed" && e.turnId === next.turnId)).toMatchObject({ ok: true });
    }, 30_000);
  }

  for (const mounted of [true, false]) {
    it(`T-R3-HERMES-PREWARM-TAKEOVER${mounted ? "" : "-CONTROL"}`, async () => {
      vi.stubEnv("MURAGE_ACP_POOL_IDLE_MS", "150");
      vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", "60000");
      // A bypass-permissions instance is never pooled (acp/core.ts poolable), so the prewarm park needs fullAuto off.
      const records = await create("HERMES", false);
      const first = await instance!.adapter.sendTurn(turn(false));
      await records.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
      await expect.poll(() => children.every(ended), { timeout: 10_000 }).toBe(true);
      vi.stubEnv("MURAGE_ACP_POOL_IDLE_MS", "60000");
      expect(await instance!.adapter.prewarm!(root)).toBe(true);
      const warm = children.at(-1)!;
      expect(ended(warm)).toBe(false);
      const before = children.length;
      const next = await instance!.adapter.sendTurn(turn(mounted, { resumeCursor: "fake-acp-session" }));
      expect(await records.until(e => e.type === "turn.completed" && e.turnId === next.turnId)).toMatchObject({ ok: true });
      if (mounted) {
        expect(children.length).toBeGreaterThan(before);
        await expect.poll(() => ended(warm)).toBe(true);
        expect(relays).toHaveLength(1);
        expect(await relays[0]!.finish()).toBe(true);
        expect(await instance!.adapter.prewarm!(root)).toBe(false);
      } else {
        expect(children).toHaveLength(before);
        expect(ended(warm)).toBe(false);
      }
    }, 30_000);
  }
});
