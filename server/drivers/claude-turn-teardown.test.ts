// SPDX-License-Identifier: AGPL-3.0-or-later
// Proof producer: tri3-g1 (Claude); durable consumer: tri3-g2 (server).
// The durable completion listener asks for the exact lease before sendTurn
// returns. Every process and mount belongs to this isolated fixture.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance, ProviderStopResult } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as claudeGuards from "./claude-guards.ts";
import * as procs from "../procs.ts";
import * as gates from "./stop-gate.ts";
import * as processTree from "./process-tree.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { execEnvFilePath } from "./murage-exec.ts";
// Use the same isolated qualification receipt as the S2 protocol fixtures.
vi.mock("./claude-s2-qualification.ts", async original => {
  const api = await original<typeof import("./claude-s2-qualification.ts")>();
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-wire-fixture" };
  const qualified = () => api.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]);
  return { ...api, claudeS2QualifiedCli: async () => qualified(), claudeS2QualifiedCliNow: qualified };
});
const stopSignals = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../procs.ts", async original => {
  const api = await original<typeof import("../procs.ts")>();
  return { ...api, cliTreeStoppedSignal: (...args: Parameters<typeof api.cliTreeStoppedSignal>) => {
    stopSignals.reads++;
    return api.cliTreeStoppedSignal(...args);
  } };
});
const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const idle = fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url));
let instance: ProviderInstance | undefined, root: string | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; if (root) await removeTempDir(root); root = undefined; });
it.each([false, true])("completion publishes its exact teardown proof before listeners (single-use=%s)", async mounted => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-turn-close-"));
  const dump = join(root, "dump.json");
  instance = await ClaudeDriver.create({ instanceId: "turn-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: root, FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1", FAKE_CLAUDE_MCP_STATUS: "error" } });
  const events = recordEvents(instance.adapter);
  let captured: Promise<ProviderStopResult> | undefined;
  const stop = instance.adapter.onEvent(event => {
    if (event.type === "turn.completed") captured = instance!.adapter.awaitTurnTeardown!(event.threadId, event.turnId);
  });
  const turn = () => fixtureMountTurn({ threadId: "turn-close", cwd: root, text: "fixture", draftOnly: mounted ? undefined : true,
    ...(mounted ? { integrations: { agents: { command: process.execPath, args: [idle], env: {} } } } : {}) });
  try {
    const first = await instance.adapter.sendTurn(turn());
    expect(await events.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
    expect(captured).toBeDefined();
    expect(await captured).toMatchObject({ closeConfirmed: true });
    expect(await instance.adapter.awaitTurnTeardown!("another-thread", first.turnId)).toMatchObject({ closeConfirmed: false });
    expect(await instance.adapter.awaitTurnTeardown!("turn-close", "unknown-turn")).toMatchObject({ closeConfirmed: false });
    await instance.adapter.awaitTurnClose!("turn-close", first.turnId);
    if (!mounted) {
      const pid = JSON.parse(readFileSync(dump, "utf8")).pid;
      expect(() => process.kill(pid, 0)).not.toThrow();
      const next = await instance.adapter.sendTurn(turn());
      expect(await events.until(event => event.type === "turn.completed" && event.turnId === next.turnId)).toMatchObject({ ok: true });
      expect(await captured).toMatchObject({ closeConfirmed: true });
      expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(pid);
    }
  } finally { stop(); events.stop(); }
}, 30000);


it.each([false, true])("confirms stopped setup only after its unlaunched dispatch unwinds (prewarm=%s)", async prewarm => {
  let entry: gates.GateEntry | undefined;
  const createGate = gates.createStopGate;
  const gateSpy = vi.spyOn(gates, "createStopGate").mockImplementation(env => {
    const gate = createGate(env), enter = gate.enter;
    gate.enter = (...args) => { const entered = enter(...args); entry = entered; return entered; };
    return gate;
  });
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-setup-close-"));
  instance = await ClaudeDriver.create({ instanceId: "setup-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root } });
  const recorded = recordEvents(instance.adapter);
  if (prewarm) {
    const first = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "setup-close", cwd: root, text: "fixture", draftOnly: true }));
    await recorded.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
    await instance.adapter.resetSession!("setup-close");
  }
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached = false, heldEntry: gates.GateEntry | undefined;
  const probe = vi.spyOn(claudeGuards, "requireClaudeCliVersion").mockImplementation(async () => { heldEntry = entry; reached = true; await gate; });
  const spawned = vi.spyOn(procs, "spawnCli");
  let closed: Promise<void> | undefined;
  let closeObserved = false;
  const off = instance.adapter.onEvent(event => {
    if (event.type === "turn.completed" && event.threadId === "setup-close") {
      closed = instance!.adapter.awaitTurnClose!(event.threadId, event.turnId);
      void closed.then(() => { closeObserved = true; });
    }
  });
  if (prewarm) {
    void instance.adapter.prewarm!("setup-close");
    await expect.poll(() => reached).toBe(true);
  }
  const sending = instance.adapter.sendTurn(fixtureMountTurn({ threadId: "setup-close", cwd: root, text: "fixture", draftOnly: true }));
  try {
    await expect.poll(() => reached).toBe(true);
    const stopping = instance.adapter.interruptTurn("setup-close");
    let stopSettled = false;
    void stopping.then(() => { stopSettled = true; });
    expect(instance.adapter.hasSession("setup-close")).toBe(true);
    expect(spawned).not.toHaveBeenCalled();
    let earlyClosed = false;
    let pendingClose: Promise<void> | undefined;
    let earlyTeardown: Promise<ProviderStopResult> | undefined;
    let teardownSettled = false;
    if (!prewarm) {
      expect(heldEntry).toMatchObject({ asked: true, live: false });
      earlyTeardown = instance.adapter.awaitTurnTeardown!("setup-close", heldEntry!.turnId);
      void earlyTeardown.then(() => { teardownSettled = true; });
      pendingClose = instance.adapter.awaitTurnClose!("setup-close", heldEntry!.turnId);
      void pendingClose.then(() => { earlyClosed = true; });
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
      expect(earlyClosed).toBe(false);
      // Never confirmed while setup is held: the proof is still waiting, not a settled false.
      expect(teardownSettled).toBe(false);
      expect(stopSettled).toBe(false);
    }
    release();
    const sent = await sending;
    const stopResult = await stopping;
    if (!prewarm) { expect(stopResult).toEqual({ closeConfirmed: true }); expect(await earlyTeardown).toEqual({ closeConfirmed: true }); }
    expect(spawned).not.toHaveBeenCalled();
    expect(instance.adapter.hasSession("setup-close")).toBe(false);
    expect(await instance.adapter.awaitTurnTeardown!("setup-close", sent.turnId)).toEqual({ closeConfirmed: true });
    expect(await instance.adapter.awaitTurnTeardown!("another-thread", sent.turnId)).toMatchObject({ closeConfirmed: false });
    expect(closed).toBeDefined();
    expect(closeObserved).toBe(true);
    await closed;
    if (pendingClose) { await pendingClose; expect(earlyClosed).toBe(true); }
  } finally { release(); await sending; off(); recorded.stop(); probe.mockRestore(); spawned.mockRestore(); gateSpy.mockRestore(); }
});

it.skipIf(process.platform === "win32")("a Stop during the exec version lookup prevents writing the thread's exec environment", async () => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-exec-stop-"));
  const threadId = basename(root);
  const execFile = execEnvFilePath(threadId);
  instance = await ClaudeDriver.create({ instanceId: "exec-stop", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root } });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const version = claudeGuards.knownClaudeCliVersion;
  const probe = vi.spyOn(claudeGuards, "knownClaudeCliVersion")
    .mockImplementationOnce(version)
    .mockImplementationOnce(async () => { enter(); await held; return version(cli); });
  vi.stubEnv("TMPDIR", root);
  const sending = instance.adapter.sendTurn(fixtureMountTurn({ threadId, cwd: root, text: "fixture" }));
  try {
    // If the driver exits setup early, propagate the failure instead of waiting for a lookup that will never run.
    await Promise.race([entered, sending.then(() => { throw new Error("exec lookup was not reached"); })]);
    const mcpConfigs = readdirSync(root).filter(name => name.startsWith("murage-mcp-"));
    expect(mcpConfigs).toHaveLength(1);
    const stopped = instance.adapter.interruptTurn(threadId);
    release();
    await sending;
    expect(existsSync(execFile)).toBe(false);
    expect(existsSync(join(root, mcpConfigs[0]!))).toBe(false);
    expect(await stopped).toEqual({ closeConfirmed: true });
  } finally {
    release();
    await sending.catch(() => undefined);
    probe.mockRestore();
    vi.unstubAllEnvs();
    rmSync(execFile, { force: true });
  }
});

it("a setup Stop that is never unwound reads unconfirmed at the caller deadline", async () => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-setup-deadline-"));
  instance = await ClaudeDriver.create({ instanceId: "setup-deadline", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached = false;
  const probe = vi.spyOn(claudeGuards, "requireClaudeCliVersion").mockImplementation(async () => { reached = true; await gate; });
  const sending = instance.adapter.sendTurn(fixtureMountTurn({ threadId: "setup-deadline", cwd: root, text: "fixture", draftOnly: true }));
  try {
    await expect.poll(() => reached).toBe(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = instance.adapter.interruptTurn("setup-deadline");
    let result: ProviderStopResult | void | undefined, settled = false;
    void stopping.then(value => { result = value; settled = true; });
    await vi.advanceTimersByTimeAsync(procs.CLI_CALLER_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(result).toMatchObject({ closeConfirmed: false });
    vi.useRealTimers();
    release();
    await sending;
  } finally { vi.useRealTimers(); release(); await sending; probe.mockRestore(); }
});

it("W12b: a retained idle child must exit before a stopped reservation confirms", async () => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-retained-close-"));
  const exitGate = join(root, "exit"), dump = join(root, "dump.json");
  instance = await ClaudeDriver.create({ instanceId: "retained-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
      FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_SIGTERM_DELAY_MS: "1", FAKE_CLAUDE_SIGTERM_GATE: exitGate } });
  const recorded = recordEvents(instance.adapter);
  const turn = () => fixtureMountTurn({ threadId: "retained-close", cwd: root, text: "fixture", draftOnly: true });
  const first = await instance.adapter.sendTurn(turn());
  await recorded.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
  expect(() => process.kill(JSON.parse(readFileSync(dump, "utf8")).pid, 0)).not.toThrow();
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probe = vi.spyOn(claudeGuards, "requireClaudeCliVersion").mockImplementation(async () => { reached = true; await gate; });
  const sending = instance.adapter.sendTurn(turn());
  let stopping: Promise<unknown> | undefined;
  try {
    await expect.poll(() => reached).toBe(true);
    stopping = instance.adapter.interruptTurn("retained-close");
    release();
    const sent = await sending;
    let confirmed = false, closed = false;
    const proof = instance.adapter.awaitTurnTeardown!("retained-close", sent.turnId);
    const close = instance.adapter.awaitTurnClose!("retained-close", sent.turnId);
    void proof.then(value => { confirmed = value.closeConfirmed; });
    void close.then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(confirmed).toBe(false);
    expect(closed).toBe(false);
    writeFileSync(exitGate, "");
    await stopping;
    expect(await proof).toMatchObject({ closeConfirmed: true });
    await close;
    expect(closed).toBe(true);
  } finally { release(); writeFileSync(exitGate, ""); await sending; await stopping; recorded.stop(); probe.mockRestore(); }
});

it("W12c: a launched turn confirms only after its child tree exits", async () => {
  let entry: gates.GateEntry | undefined;
  const createGate = gates.createStopGate;
  const gateSpy = vi.spyOn(gates, "createStopGate").mockImplementation(env => {
    const gate = createGate(env), enter = gate.enter;
    gate.enter = (...args) => { const entered = enter(...args); entry = entered; return entered; };
    return gate;
  });
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-launched-close-"));
  const exitGate = join(root, "exit"), dump = join(root, "dump.json");
  instance = await ClaudeDriver.create({ instanceId: "launched-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
      FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_SIGTERM_DELAY_MS: "1", FAKE_CLAUDE_SIGTERM_GATE: exitGate } });
  const recorded = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "launched-close", cwd: root, text: "fixture", draftOnly: true }));
  try {
    await expect.poll(() => { try { return JSON.parse(readFileSync(dump, "utf8")).pid; } catch { return undefined; } }).toBeTypeOf("number");
    // interruptTurn now resolves with the exact teardown proof, which waits for the gated child exit: do not await it before the gate opens.
    const interrupted = instance.adapter.interruptTurn("launched-close");
    expect(entry).toMatchObject({ asked: true, live: true });
    // A live gate's finally may never manufacture an unlaunched proof, even on re-entry after Stop.
    const source = readFileSync(new URL("./claude.ts", import.meta.url), "utf8");
    const from = source.indexOf("            // The gate never launched this turn");
    const to = source.indexOf("          }\n        }, classify);", from);
    expect(from).toBeGreaterThan(-1); expect(to).toBeGreaterThan(from);
    const remember = vi.fn(), confirm = vi.fn();
    new Function("e", "rememberStopProof", "stopProofs", "threadId", "turnId", source.slice(from, to))(
      entry, remember, new Map([[sent.turnId, { threadId: "launched-close", confirmUnlaunched: confirm }]]), "launched-close", sent.turnId);
    expect(remember).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    const proof = instance.adapter.awaitTurnTeardown!("launched-close", sent.turnId);
    const close = instance.adapter.awaitTurnClose!("launched-close", sent.turnId);
    let confirmed = false, closed = false;
    void proof.then(value => { confirmed = value.closeConfirmed; });
    void close.then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(confirmed).toBe(false);
    expect(closed).toBe(false);
    expect(() => process.kill(JSON.parse(readFileSync(dump, "utf8")).pid, 0)).not.toThrow();
    writeFileSync(exitGate, "");
    expect(await proof).toMatchObject({ closeConfirmed: true });
    expect(await interrupted).toMatchObject({ closeConfirmed: true });
    await close;
    expect(closed).toBe(true);
  } finally { writeFileSync(exitGate, ""); recorded.stop(); gateSpy.mockRestore(); }
});

it("W12d: an unasked setup creates no unlaunched stop proof", async () => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-unasked-close-"));
  instance = await ClaudeDriver.create({ instanceId: "unasked-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root } });
  const recorded = recordEvents(instance.adapter);
  const probe = vi.spyOn(claudeGuards, "requireClaudeCliVersion").mockRejectedValue(new claudeGuards.ClaudeProbeMissing("fixture missing"));
  try {
    const sent = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "unasked-close", cwd: root, text: "fixture", draftOnly: true }));
    await recorded.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
    expect(await instance.adapter.awaitTurnTeardown!("unasked-close", sent.turnId)).toMatchObject({ closeConfirmed: false });
    let closed = false;
    void instance.adapter.awaitTurnClose!("unasked-close", sent.turnId).then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(false);
  } finally { recorded.stop(); probe.mockRestore(); }
});
it.each([false, true])("retained completion keeps its process without per-turn close subscriptions (mounted=%s)", async mounted => {
  resetClaudeMcpReadinessForTests();
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-retained-close-"));
  const dump = join(root, "dump.json");
  const retirement = vi.spyOn(CliMountRelay.prototype, "retireGeneration");
  // The fake MCP client's transient helpers are outside this protocol-retirement witness.
  const baseline = vi.spyOn(processTree, "descendantBaseline").mockResolvedValue(new Set<number>());
  const descendants = vi.spyOn(processTree, "untrackedDescendants").mockResolvedValue(new Set<number>());
  instance = await ClaudeDriver.create({ instanceId: "retained-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: root, FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1" } });
  const events = recordEvents(instance.adapter);
  const proofs: Array<Promise<ProviderStopResult>> = [];
  const stop = instance.adapter.onEvent(event => {
    if (event.type === "turn.completed") proofs.push(instance!.adapter.awaitTurnTeardown!(event.threadId, event.turnId));
  });
  let pid: number | undefined, subscriptions: number | undefined;
  try {
    for (let i = 0; i < 3; i++) {
      const sent = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "retained-close", cwd: root, text: "fixture",
        draftOnly: mounted ? undefined : true,
        ...(mounted ? { integrations: { agents: { command: process.execPath, args: [idle], env: {} } } } : {}) }));
      expect(await events.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true });
      expect(await proofs[i]).toEqual({ closeConfirmed: true });
      await instance.adapter.awaitTurnClose!("retained-close", sent.turnId);
      const currentPid = JSON.parse(readFileSync(dump, "utf8")).pid;
      pid ??= currentPid;
      expect(currentPid).toBe(pid);
      expect(() => process.kill(currentPid, 0)).not.toThrow();
      if (mounted) {
        expect(retirement).toHaveBeenCalledTimes(i + 1);
        expect(await retirement.mock.results[i]!.value).toBe(true);
      } else {
        subscriptions ??= stopSignals.reads;
        expect(stopSignals.reads).toBe(subscriptions);
      }
    }
    expect(proofs).toHaveLength(3);
  } finally { stop(); events.stop(); retirement.mockRestore(); baseline.mockRestore(); descendants.mockRestore(); }
}, 30000);

// Producer owner: this lane; consumer owner: the waiting turn's Stop proof.
it.each(["empty", "child-started", "unknown"])("a waiting setup inherits the warm-up's child evidence (%s)", async state => {
  const source = readFileSync(new URL("./claude.ts", import.meta.url), "utf8");
  const from = source.indexOf("        // An intent warm is still starting this thread");
  const to = source.indexOf("        const running = active.get(threadId);", from);
  expect(from).toBeGreaterThan(-1); expect(to).toBeGreaterThan(from);
  const waiting = { mcp: false }, warm = { mcp: false };
  const records = new Map([["waiting", waiting]]);
  if (state !== "unknown") records.set("warm", warm);
  const stopped = new Error("stopped");
  const run = new Function("relaunch", "prewarming", "threadId", "turnId", "stopGate", "e", "active", "setupEnds",
    "return (async () => {" + stripTypeScriptTypes(source.slice(from, to)) + "})();");
  await expect(run(false, { has: () => true, wait: async () => { warm.mcp = state === "child-started"; } }, "thread", "waiting",
    { step: async (_entry: unknown, pending: Promise<void>) => { await pending; throw stopped; } }, {},
    new Map([["thread", { turnId: "warm" }]]), records)).rejects.toBe(stopped);
  expect(waiting.mcp).toBe(state !== "empty");
});
