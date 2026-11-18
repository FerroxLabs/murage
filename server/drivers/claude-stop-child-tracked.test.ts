// Producer: trainred-stopwrite (turnChildTracked, Claude); consumer: the
// server's Stop-held folder lease (ProjectTurnLeases.releaseStopHeld).
// A Stop holds the turn's folder past its terminal event only when it reached
// a live child of that turn. A turn that ended with no proof (its child gone
// before any Stop) must say so, never leave the folder on a close that no
// one will report. Every process here is the isolated fake CLI.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { heldProbeLauncher } from "../testing/held-probe-cli.ts";
import { admittedFixtureInstance } from "../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import * as guards from "./claude-guards.ts";
import { ClaudeDriver } from "./claude.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import * as procs from "../procs.ts";

const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
let instance: ProviderInstance | undefined, root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await instance?.dispose(); instance = undefined; resetClaudeVersionGate();
  if (root) await removeTempDir(root); root = undefined;
});
const start = async (environment: Record<string, string>, engine = cli) => {
  ensureDirs();
  instance = await admittedFixtureInstance(ClaudeDriver.create({ instanceId: "stop-child", displayName: "fixture", enabled: true,
    environment: { FAKE_CLAUDE_MCP_STATUS: "error", ...environment }, config: { cli: engine, permissionMode: "bypassPermissions" } }));
  return instance;
};
const waitFor = async (what: string, ready: () => boolean) => {
  for (const at = Date.now(); !ready();) {
    if (Date.now() - at > 30000) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const posix = it.skipIf(process.platform === "win32");

it("a Stop that finds no running child (it lands before the turn spawned one) leaves the turn untracked", async () => {
  root = mkdtempSync(join(tmpdir(), "claude-stop-child-"));
  const dump = join(root, "dump.json");
  const adapter = (await start({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump })).adapter;
  const events = recordEvents(adapter);
  try {
    const sending = adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "starting", text: "hello" });
    const stopping = adapter.interruptTurn("starting");
    const { turnId } = await sending;
    await stopping.catch(() => undefined);
    await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
    expect(existsSync(dump)).toBe(false);
    expect(adapter.turnChildTracked?.("starting", turnId)).toBe(false);
    // MAIN Q1=B: the setup ended before anything launched, so its Stop is confirmed and its close resolves.
    expect(await adapter.awaitTurnTeardown?.("starting", turnId)).toEqual({ closeConfirmed: true });
    await adapter.awaitTurnClose?.("starting", turnId);
  } finally { events.stop(); }
}, 60000);

it("a turn that ended on its own is tracked by its completion proof, whose close resolves", async () => {
  const adapter = (await start({ FAKE_CLAUDE_MODE: "exit-early" })).adapter;
  const events = recordEvents(adapter);
  try {
    const { turnId } = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "ended", text: "hello" });
    await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
    // The owner's Stop lands after the turn's own end: no live turn to reach.
    await adapter.interruptTurn("ended");
    expect(adapter.turnChildTracked?.("ended", turnId)).toBe(true);
    await adapter.awaitTurnClose?.("ended", turnId);
    expect(adapter.turnChildTracked?.("ended", "unknown-turn")).toBe(false);
  } finally { events.stop(); }
}, 60000);

it("a Stop that reached the live child tracks it, for that thread only, until and after its close", async () => {
  root = mkdtempSync(join(tmpdir(), "claude-stop-child-"));
  const dump = join(root, "dump.json");
  const adapter = (await start({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_SIGTERM_DELAY_MS: "300" })).adapter;
  const events = recordEvents(adapter);
  try {
    const { turnId } = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "live", text: "hello" });
    for (const at = Date.now(); !existsSync(dump);) {
      expect(Date.now() - at).toBeLessThan(30000);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(adapter.turnChildTracked?.("live", turnId)).toBe(false);
    await adapter.interruptTurn("live");
    expect(adapter.turnChildTracked?.("live", turnId)).toBe(true);
    expect(adapter.turnChildTracked?.("other", turnId)).toBe(false);
    await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
    await adapter.awaitTurnClose?.("live", turnId);
    expect(adapter.turnChildTracked?.("live", turnId)).toBe(true);
  } finally { events.stop(); }
}, 60000);
// MAIN Q1=B (11-17): a Stop that reached the turn while its setup waited on the
// version probe, before any engine or MCP child existed, is confirmed once the
// setup ends StoppedBeforeLaunch. The probe answers only after the Stop (the
// race): the stopped setup spawns nothing, and it leaves no held entry behind,
// so the thread's next turn is admitted and does start its engine.
posix("a Stop during the version probe is confirmed, the later probe answer spawns nothing, and the thread takes its next turn", async () => {
  root = mkdtempSync(join(tmpdir(), "claude-stop-child-"));
  const dump = join(root, "dump.json"), probe = heldProbeLauncher(root, cli);
  const adapter = (await start({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump }, probe.cli)).adapter;
  const spawned = vi.spyOn(procs, "spawnCli");
  const events = recordEvents(adapter);
  try {
    writeFileSync(probe.hold, "hold");
    const sending = adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "setup", text: "hello" });
    await waitFor("the setup to wait on the version probe", () => existsSync(probe.held));
    expect(await adapter.interruptTurn("setup")).toEqual({ closeConfirmed: true });
    expect(existsSync(probe.answered)).toBe(false);
    // Let even a broken cancellation continue to its spawn before checking its outcome.
    writeFileSync(probe.release, "answer");
    await waitFor("the held probe to answer", () => existsSync(probe.answered));
    const { turnId } = await sending;
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(dump)).toBe(false);
    await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
    expect(adapter.turnChildTracked?.("setup", turnId)).toBe(false);
    expect(await adapter.awaitTurnTeardown?.("setup", turnId)).toEqual({ closeConfirmed: true });
    await adapter.awaitTurnClose?.("setup", turnId);
    // A second, exact-turn Stop reads the same confirmed proof.
    expect(await adapter.interruptTurn("setup", turnId)).toEqual({ closeConfirmed: true });
    expect(existsSync(dump)).toBe(false);
    const next = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "setup", text: "again" });
    expect(next.turnId).not.toBe(turnId);
    await waitFor("the next turn's engine", () => existsSync(dump));
  } finally { events.stop(); }
}, 60000);

// MAIN 15:56Z C1: a setup Stop while a child of the thread is up (the kept
// engine from the turn before, with its MCP servers) is never confirmed by the
// setup ending: only that child's own close confirms it.
posix("a Stop during the version probe while the kept engine is up confirms only after that engine closed", async () => {
  root = mkdtempSync(join(tmpdir(), "claude-stop-child-"));
  const dump = join(root, "dump.json"), gate = join(root, "sigterm-gate"), probe = heldProbeLauncher(root, cli);
  const adapter = (await start({ FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_SIGTERM_DELAY_MS: "1", FAKE_CLAUDE_SIGTERM_GATE: gate }, probe.cli)).adapter;
  const events = recordEvents(adapter);
  try {
    const first = await adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kept", text: "hello" });
    await events.until(event => event.type === "turn.completed" && event.turnId === first.turnId, 30000);
    const { pid } = JSON.parse(readFileSync(dump, "utf8")) as { pid: number };
    expect(alive(pid)).toBe(true);
    resetClaudeVersionGate();
    writeFileSync(probe.hold, "hold");
    const sending = adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kept", text: "again" });
    sending.catch(() => undefined);
    await waitFor("the next turn's setup to wait on the version probe", () => existsSync(probe.held));
    let answered = false;
    const stopping = Promise.resolve(adapter.interruptTurn("kept")).then(result => { answered = true; return result; });
    writeFileSync(probe.release, "answer");
    await waitFor("the held probe to answer", () => existsSync(probe.answered));
    await new Promise(resolve => setTimeout(resolve, 500));
    // The kept engine has not closed (its SIGTERM is held): the Stop is not confirmed.
    expect(alive(pid)).toBe(true);
    expect(answered).toBe(false);
    writeFileSync(gate, "close");
    expect(await stopping).toEqual({ closeConfirmed: true });
    expect(alive(pid)).toBe(false);
  } finally { events.stop(); writeFileSync(join(root!, "sigterm-gate"), "cleanup"); }
}, 60000);

// MAIN 15:56Z C1: a setup Stop that lands while the turn's MCP relay is
// starting cannot prove that relay closed: it stays unconfirmed (strict 409).
posix("a Stop while the turn's MCP relay is starting stays unconfirmed even though nothing launched", async () => {
  root = mkdtempSync(join(tmpdir(), "claude-stop-child-"));
  const dump = join(root, "dump.json");
  let entered = () => {}, release = () => {};
  const creating = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const create = CliMountRelay.create.bind(CliMountRelay);
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args: Parameters<typeof CliMountRelay.create>) => {
    entered(); await held; return create(...args);
  });
  const adapter = (await start({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump })).adapter;
  const events = recordEvents(adapter);
  try {
    const sending = adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "relay", text: "hello" });
    await creating;
    const stopping = adapter.interruptTurn("relay");
    release();
    const { turnId } = await sending;
    await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
    expect(await stopping).toEqual({ closeConfirmed: false, reason: "stop-failed" });
    expect(existsSync(dump)).toBe(false);
  } finally { release(); events.stop(); }
}, 60000);
it("a probe released after Stop cannot spawn the stopped turn", async () => {
  const adapter = (await start({ FAKE_CLAUDE_MODE: "hang" })).adapter;
  let entered = () => {}, release = () => {};
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(guards, "requireClaudeCliVersion").mockImplementation(async () => { entered(); await held; });
  const spawned = vi.spyOn(procs, "spawnCli");
  const sending = adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "no-spawn", text: "hello" });
  let stopping: ReturnType<typeof adapter.interruptTurn> | undefined;
  try {
    await pending;
    stopping = adapter.interruptTurn("no-spawn");
    release();
    await sending;
    // Check the forbidden operation before reading the Stop result or its proof.
    expect(spawned).not.toHaveBeenCalled();
    expect(await stopping).toEqual({ closeConfirmed: true });
  } finally { release(); await sending; await stopping; }
}, 60000);
useOutsideStoreFixture();
