import * as processTree from "./process-tree.ts";
import { DatabaseSync } from "node:sqlite";
import { steerBuilt } from "./engine-input.ts";
import { fencedTurnInput } from "./engine-input.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDirs } from "../config.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { recordEvents } from "../testing/events.ts";
import { hasClaudeS2Pending, claudeS2HasLiveTurn, claudeS2SteerAdapter } from "./claude-s2-pending.ts";
import type { SendTurnInput } from "../contracts.ts";
import { decorateOwnerTurnInstance, setOwnerTurnResolver } from "../harness/power-owner-adapter.ts";

// The executable is an isolated wire-protocol fixture, so qualification is
// an explicit injected receipt at this I/O edge, never an ambient test unlock.
vi.mock("./claude-s2-qualification.ts", async original => {
  const actual = await original<typeof import("./claude-s2-qualification.ts")>();
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-wire-fixture" };
  const qualified = () => actual.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]);
  // Inject the isolated protocol receipt at both identity I/O edges.
  return { ...actual, claudeS2QualifiedCli: async () => qualified(), claudeS2QualifiedCliNow: qualified };
});
vi.mock("./process-tree.ts", async original => ({ ...await original<typeof import("./process-tree.ts")>(),
  descendantBaseline: async () => new Set<number>(), untrackedDescendants: async () => new Set<number>(),
}));
const stdinProbe = vi.hoisted(() => ({ write: undefined as undefined | ((wire: string) => void) }));
// q1024-steerquar H1: a kept CLI whose stop can never be confirmed (it is not signalled and never reads stopped).
const heldProbe = vi.hoisted(() => ({ pid: null as number | null }));
vi.mock("../procs.ts", async original => {
  const api = await original<typeof import("../procs.ts")>();
  const held = (child: { pid?: number }) => heldProbe.pid !== null && child.pid === heldProbe.pid;
  return { ...api,
    killCliTree: (...args: Parameters<typeof api.killCliTree>) => { if (!held(args[0])) api.killCliTree(...args); },
    awaitCliTreeStopped: (...args: Parameters<typeof api.awaitCliTreeStopped>) => held(args[0]) ? Promise.resolve(false) : api.awaitCliTreeStopped(...args),
    cliTreeStoppedSignal: (...args: Parameters<typeof api.cliTreeStoppedSignal>) => held(args[0])
      ? new Promise<void>(resolve => { const t = setInterval(() => { if (!held(args[0])) { clearInterval(t); resolve(); } }, 50); }).then(() => api.cliTreeStoppedSignal(...args))
      : api.cliTreeStoppedSignal(...args),
    cliTreeConfirmedStopped: (...args: Parameters<typeof api.cliTreeConfirmedStopped>) => held(args[0]) ? false : api.cliTreeConfirmedStopped(...args),
    spawnCli: (...args: Parameters<typeof api.spawnCli>) => {
    const child = api.spawnCli(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: any, ...rest: any[]) => {
      stdinProbe.write?.(String(chunk));
      return (write as any)(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child;
  } };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  stdinProbe.write = undefined;
  if (heldProbe.pid !== null) { try { process.kill(heldProbe.pid, "SIGKILL"); } catch {} heldProbe.pid = null; }
  vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("S2 production fixture deadline"); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(fail: boolean, incoming?: string, unsupported = false) {
  ensureDirs(); // server/testing/setup.ts owns the isolated test data HOME
  const root = mkdtempSync(join(tmpdir(), "s2-production-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "claude.mjs");
  const runtime = readFileSync(new URL("claude-s2-runtime-cli.fixture.mjs", import.meta.url), "utf8");
  // The copied executable still loads the real process-visibility helper;
  // its repository-relative import cannot resolve from a temporary directory.
  writeFileSync(cli, runtime.replace('import "../../shared/win-hide-child-process.mjs";',
    `import ${JSON.stringify(new URL("../../shared/win-hide-child-process.mjs", import.meta.url).href)};`));
  chmodSync(cli, 0o755);
  const log = join(root, "stdin.jsonl"), release = join(root, "release");
  const failChild = join(root, "fail-one-mount");
  const mountCode = `const fs=require('node:fs'); const flag=${JSON.stringify(failChild)}; if(fs.existsSync(flag)){fs.unlinkSync(flag);process.exit(1);} process.stdin.resume();`;
  vi.stubEnv("FAKE_CLAUDE_S2_LOG", log); vi.stubEnv("FAKE_CLAUDE_S2_RELEASE", release);
  vi.stubEnv("FAKE_CLAUDE_S2_FAIL", fail ? "1" : "0"); vi.stubEnv("FAKE_CLAUDE_S2_INCOMING", incoming ?? "");
  vi.stubEnv("FAKE_CLAUDE_S2_UNSUPPORTED", unsupported ? "1" : "0");
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "isolated S2", enabled: true,
    environment: { FAKE_CLAUDE_S2_LOG: log, FAKE_CLAUDE_S2_RELEASE: release,
      FAKE_CLAUDE_S2_FAIL: fail ? "1" : "0", FAKE_CLAUDE_S2_INCOMING: incoming ?? "",
      FAKE_CLAUDE_S2_UNSUPPORTED: unsupported ? "1" : "0" }, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter);
  const bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  function turn(text: string): SendTurnInput {
    const f = consumingFixture(undefined, { threadId, botId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    const input: SendTurnInput = { text, threadId, cwd: root, draftOnly: true, releaseBinding: f.binding,
      mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1"),
      integrations: { composio: { command: process.execPath, args: ["-e", mountCode], env: {} } } };
    return fencedTurnInput({ ...input, prompt: buildPrompt(f.turn, [promptPart(input.text, [noneRef("owner-turn")])]) },
      { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  }
  const rows = (): Array<{ pid: number; frame: any }> => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  const first = await instance.adapter.sendTurn(turn("first"));
  await events.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
  await expect.poll(() => rows().find(r => r.frame.type === "user"), {
    timeout: 20_000, message: "S2 production fixture must receive the first user frame",
  }).toBeDefined();
  const userFrame = rows().find(r => r.frame.type === "user");
  expect(userFrame, "S2 production fixture first user frame").toBeDefined();
  const pid = userFrame!.pid;
  return { instance, events, turn, rows, pid, threadId, release, failChild, bindings };
}
it("T-S2-S1-PARITY-ELIGIBILITY: unsupported production Claude uses cold processes and never reconnects", async () => {
  const x = await fixture(false, undefined, true);
  await x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 2);
  expect(x.rows().filter(r => r.frame.type === "user")[1]!.pid).not.toBe(x.pid);
  expect(x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect")).toBe(false);
}, 60_000);
it.each([false, true])("T-S2-STEER-MID-BARRIER runtime: production settlement, prompt-first and cold=%s", async fail => {
  const x = await fixture(fail);
  const sent = x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  expect(hasClaudeS2Pending(x.threadId)).toBe(true);
  expect(claudeS2HasLiveTurn(x.threadId)).toBe(false);
  // M-TURN-STARTED-EARLY must fail here, while a real child holds reconnect.
  expect(x.events.events.filter(e => e.type === "turn.started")).toHaveLength(1);
  const adapter = claudeS2SteerAdapter(x.threadId)!;
  const fence = vi.fn();
  const one = adapter.steer(x.threadId, "steer-one", fence);
  const two = adapter.steer(x.threadId, "steer-two", fence);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content)).toEqual(["first"]);
  writeFileSync(x.release, "release");
  await sent; expect(await one).toBe(true); expect(await two).toBe(true);
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 4);
  const users = x.rows().filter(r => r.frame.type === "user");
  expect(users.map(r => r.frame.message.content)).toEqual(["first", "second", "steer-one", "steer-two"]);
  expect(users[1]!.pid === x.pid).toBe(!fail);
  // MAIN RULING 1115-RECALL-R5 (GrokBuild)
  expect(fence).toHaveBeenCalledTimes(6); // admission, preparation and actual write
  expect(x.bindings.every(f => f.refusals === 0)).toBe(true);
}, 60_000);
it.each([false, true])("T-S2-DEFERRED-FENCE: revoked queued steer writes no bytes, cold=%s", async fail => {
  const x = await fixture(fail);
  const sent = x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  let valid = true;
  const fence = vi.fn(() => { if (!valid) throw new Error("MEMORY_CONTEXT_REVOKED"); });
  const held = claudeS2SteerAdapter(x.threadId)!.steer(x.threadId, "revoked-steer", fence);
  expect(fence).toHaveBeenCalledOnce();
  valid = false;
  writeFileSync(x.release, "release");
  await sent;
  expect(await held).toBe(false);
  expect(fence).toHaveBeenCalledTimes(2);
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 2);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content)).toEqual(["first", "second"]);
}, 60_000);
it("T-S2-BARRIER-CHILD-EXIT: startup death retires before supervision, then uses fresh cold admission", async () => {
  const x = await fixture(false);
  writeFileSync(x.failChild, "fail this generation only");
  await x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 2);
  const users = x.rows().filter(r => r.frame.type === "user");
  expect(users[1]!.pid).not.toBe(x.pid);
  expect(users.map(r => r.frame.message.content)).toEqual(["first", "second"]);
  expect(x.bindings.every(f => f.refusals === 0)).toBe(true);
}, 60_000);
it.each(["elicitation", "can_use_tool"])("T-S2-ELICIT-MID-BARRIER runtime: %s produces cold without a warm response", async incoming => {
  const x = await fixture(false, incoming);
  let held: Promise<boolean> | undefined;
  // Capture arrival before the request-triggered fallback consumes the queue.
  const sent = x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => hasClaudeS2Pending(x.threadId));
  expect(claudeS2HasLiveTurn(x.threadId)).toBe(false);
  held = claudeS2SteerAdapter(x.threadId)!.steer(x.threadId, "steer");
  expect(x.events.events.filter(e => e.type === "turn.started")).toHaveLength(1);
  writeFileSync(x.release + ".incoming", "send request");
  await sent; expect(await held).toBe(true);
  await until(() => x.rows().some(r => r.pid !== x.pid && r.frame.type === "user"));
  expect(x.rows().filter(r => r.pid === x.pid && (r.frame.type === "user" || r.frame.type === "control_response"))
    .map(r => r.frame.message?.content)).toEqual(["first"]);
  expect(x.bindings.every(f => f.refusals === 0)).toBe(true);
}, 60_000);
it("T-S2-STEER-MID-BARRIER release window: turn.started listener stays behind the prompt", async () => {
  const x = await fixture(false);
  let windowInput: Promise<unknown> | undefined;
  const off = x.instance.adapter.onEvent(event => {
    if (event.type === "turn.started" && hasClaudeS2Pending(x.threadId)) {
      windowInput = x.instance.adapter.steer!(x.threadId, "window-steer");
    }
  });
  cleanup.push(off);
  const sent = x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  writeFileSync(x.release, "release"); await sent;
  expect(windowInput).toBeDefined(); expect(await windowInput).toBe(true);
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 3);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content)).toEqual(["first", "second", "window-steer"]);
}, 60_000);

it("T-S2-STOP-AT-START: cancellation during release resolves without writing the prompt", async () => {
  const x = await fixture(false);
  const off = x.instance.adapter.onEvent(event => {
    if (event.type === "turn.started" && hasClaudeS2Pending(x.threadId)) void x.instance.adapter.interruptTurn(x.threadId);
  });
  cleanup.push(off);
  const sending = x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  writeFileSync(x.release, "release");
  const sent = await sending;
  const done = await x.events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
  expect(done).toMatchObject({ stopReason: "cancelled" });
  expect(x.events.events.filter(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toHaveLength(1);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content)).toEqual(["first"]);
}, 60_000);

it("T-S2-KEY-CHANGE: confirmed retirement precedes a fresh mounted process", async () => {
  const x = await fixture(false);
  const sent = await x.instance.adapter.sendTurn({ ...x.turn("second"), sessionReset: true });
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 2);
  expect(x.rows().filter(r => r.frame.type === "user")[1]!.pid).not.toBe(x.pid);
  expect(x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect")).toBe(false);
  expect(() => process.kill(x.pid, 0)).toThrow();
  expect(x.events.events.filter(e => e.type === "turn.started" && e.turnId === sent.turnId)).toHaveLength(1);
}, 60_000);

it.each([false, true])("R1-S2 actual prompt and held steer own the DB writer, cold=%s", async fail => {
  const x = await fixture(fail);
  const input = x.turn("second");
  const f = x.bindings.at(-1)!;
  f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(f.f.db.prepare("PRAGMA database_list").get()!.file));
  other.exec("PRAGMA busy_timeout=0");
  cleanup.push(() => other.close());
  const observed: Array<{ text: string; locked: boolean; transaction: boolean }> = [];
  stdinProbe.write = wire => {
    const frame = JSON.parse(wire);
    if (frame.type !== "user") return;
    let locked = false;
    try { other.exec("BEGIN IMMEDIATE; COMMIT"); } catch (error) { locked = /busy|locked/i.test(String(error)); }
    observed.push({ text: frame.message.content, locked, transaction: f.f.db.isTransaction });
  };
  const sending = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  const before = f.budget.counts;
  const prompt = buildPrompt(f.turn, [promptPart("held-owner-text", [noneRef("owner-turn")])]);
  const steer = steerBuilt(claudeS2SteerAdapter(x.threadId)!, x.threadId, prompt,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  expect(f.budget.counts.attempts).toBe(before.attempts);
  writeFileSync(x.release, "release");
  await sending; expect(await steer).toBe(true);
  expect(observed).toEqual([
    { text: "second", locked: true, transaction: true },
    { text: "held-owner-text", locked: true, transaction: true },
  ]);
  expect(f.budget.counts.attempts - before.attempts).toBe(2);
  other.exec("BEGIN IMMEDIATE; COMMIT");
  f.flip();
  const denied = await steerBuilt(x.instance.adapter, x.threadId, prompt,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  expect(denied).toBe(false); expect(observed).toHaveLength(2);
}, 60_000);

it("R1-S2 Stop inside the writer owner prevents an emitted charge", async () => {
  const x = await fixture(false), input = x.turn("second"), f = x.bindings.at(-1)!;
  const owner = input.fencedWrite!;
  let stopped = false;
  input.fencedWrite = (write, validate, bytes) => owner(write, context => {
    if (!stopped) { stopped = true; void x.instance.adapter.interruptTurn(x.threadId); }
    validate?.(context);
  }, bytes);
  const sending = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  const before = f.budget.counts.attempts;
  writeFileSync(x.release, "release");
  await sending;
  expect(stopped).toBe(true);
  expect(f.budget.counts.attempts).toBe(before);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content)).toEqual(["first"]);
  expect(f.refusals).toBe(0);
}, 60_000);

it("T-S2-STOP-DURING-RECONNECT: exact pending Stop retires the kept process without a prompt", async () => {
  const x = await fixture(false), input = x.turn("second");
  const sending = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  const stopping = x.instance.adapter.interruptTurn(x.threadId);
  const outcome = await Promise.allSettled([sending, stopping]);
  expect(outcome[0]!.status).toBe("fulfilled");
  const sent = (outcome[0] as PromiseFulfilledResult<{ turnId: string }>).value;
  expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ stopReason: "cancelled" });
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content)).toEqual(["first"]);
  expect(() => process.kill(x.pid, 0)).toThrow();
  expect(x.bindings.at(-1)!.refusals).toBe(0);
}, 60_000);

it("T-S2-LATENCY-OFFLINE: measure reconnect release and cold fallback at actual stdin enqueue", async () => {
  const samples: Array<{ cold: boolean; dispatchMs: number; releaseToPromptMs: number }> = [];
  for (const cold of [false, true]) {
    for (let sample = 0; sample < 3; sample++) {
      const x = await fixture(cold);
      let promptAt = 0;
      stdinProbe.write = wire => { if (JSON.parse(wire).type === "user") promptAt ||= performance.now(); };
      const dispatchAt = performance.now();
      const sending = x.instance.adapter.sendTurn(x.turn("second"));
      await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
      expect(promptAt).toBe(0);
      const releaseAt = performance.now(); writeFileSync(x.release, "release");
      await sending;
      await until(() => x.rows().filter(r => r.frame.type === "user").length === 2);
      const pid = x.rows().filter(r => r.frame.type === "user")[1]!.pid;
      expect(pid === x.pid).toBe(!cold);
      expect(promptAt).toBeGreaterThanOrEqual(releaseAt);
      expect(x.bindings.every(f => f.refusals === 0)).toBe(true);
      samples.push({ cold, dispatchMs: promptAt - dispatchAt, releaseToPromptMs: promptAt - releaseAt });
      await x.instance.dispose();
      expect(() => process.kill(pid, 0)).toThrow();
      stdinProbe.write = undefined;
    }
  }
  // Measurements on a shared fake-CLI runner are evidence, not production
  // performance qualification or an invented real-CLI latency threshold.
  const receipt = { kind: "offline-stdin-enqueue", platform: process.platform, arch: process.arch, samples };
  console.info(`S2_OFFLINE_LATENCY ${JSON.stringify(receipt)}`);
  if (process.env.MURAGE_QUAL_S2_LATENCY) appendFileSync(process.env.MURAGE_QUAL_S2_LATENCY, JSON.stringify(receipt) + "\n");
  expect(samples).toHaveLength(6);
}, 120_000);

// The server can release a completed turn after a checked pool handoff. A
// failed idle inspection instead keeps ownership until the real child closes.
it.each([true, false])("S2 exact-turn lease waits for idle inspection, reusable=%s", async reusable => {
  let release!: (value: Set<number> | null) => void;
  const inspected = new Promise<Set<number> | null>(resolve => { release = resolve; });
  const inspect = vi.spyOn(processTree, "untrackedDescendants").mockImplementation(() => inspected);
  try {
    const x = await fixture(false);
    const completed = x.events.events.find(event => event.type === "turn.completed")!;
    const turnId = completed.turnId!;
    let confirmed = false, closed = false;
    const proof = x.instance.adapter.awaitTurnTeardown!(x.threadId, turnId).then(result => { confirmed = true; return result; });
    const close = x.instance.adapter.awaitTurnClose!(x.threadId, turnId).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(confirmed).toBe(false);
    expect(closed).toBe(false);
    expect(() => process.kill(x.pid, 0)).not.toThrow();
    release(reusable ? new Set() : null);
    expect(await proof).toEqual({ closeConfirmed: true });
    await close;
    if (reusable) expect(() => process.kill(x.pid, 0)).not.toThrow();
    else expect(() => process.kill(x.pid, 0)).toThrow();
  } finally { release(null); inspect.mockRestore(); }
}, 30_000);

// q1024-steerquar H1 (FABLE/ASTRA/OPUS 583d64b809, MAIN "owner sends never fail"): the owner's own send is never refused because
// this thread's kept CLI (and so its relay) cannot be confirmed stopped, at the S2 key-change retire (claude.ts retained CLI retire)
// or the S2 cold fallback. It goes on to a fresh process after the bounded wait; any other audience is still refused there.
// Entry: the registry's owner decorator over the real ClaudeDriver and the isolated S2 wire fixture.
it.each([
  ["key-change retire", false, true], ["key-change retire", false, false], ["cold fallback", true, true], ["cold fallback", true, false],
] as const)("q1024-steerquar H1 Claude S2 %s with the kept CLI unconfirmed: cold=%s owner=%s", async (_row, cold, ownerTurn) => {
  const x = await fixture(cold);
  // Before the instance is disposed: the held CLI really ends and its confirmation is no longer withheld.
  cleanup.push(() => { heldProbe.pid = null; try { process.kill(x.pid, "SIGKILL"); } catch {} });
  setOwnerTurnResolver(threadId => ownerTurn && threadId === x.threadId);
  cleanup.push(() => setOwnerTurnResolver(() => false));
  const adapter = decorateOwnerTurnInstance(x.instance).adapter;
  heldProbe.pid = x.pid;
  // The S2 wire fixture answers a fresh process's first prompt only when it says "first".
  const input = cold ? x.turn("first again") : { ...x.turn("first again"), sessionReset: true };
  const sent = adapter.sendTurn(input).then(({ turnId }) => turnId, (error: unknown) => `refused: ${String(error)}`);
  if (cold) {
    await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
    writeFileSync(x.release, "release");
  }
  const turnId = await sent;
  if (!ownerTurn) {
    expect(turnId, "a non-owner send beside the unconfirmed kept CLI is still refused").toMatch(/^refused:.*MOUNT_RELAY_STOP_UNCONFIRMED/);
    return;
  }
  expect(turnId, "the owner's send is never refused by its own kept CLI's unconfirmed stop").not.toMatch(/^refused:/);
  const completed = await x.events.until(e => e.type === "turn.completed" && e.turnId === turnId, 30_000).catch((error: unknown) => {
    console.log(`DIAG events=${JSON.stringify(x.events.events.map(e => [e.type, (e as any).turnId, (e as any).message ?? (e as any).error ?? ""]))}`);
    console.log(`DIAG rows=${JSON.stringify(x.rows().map(r => [r.pid, r.frame.type, r.frame.request?.subtype ?? r.frame.message?.content ?? ""]))} held=${x.pid}`);
    throw error;
  });
  expect(completed, "the owner's turn runs to its reply").toMatchObject({ ok: true });
  const users = x.rows().filter(r => r.frame.type === "user");
  const owned = users.filter(r => JSON.stringify(r.frame.message.content).includes("first again"));
  expect(owned.length, "the owner's prompt reached one process").toBe(1);
  expect(owned[0]!.pid, "a fresh process, not the unconfirmed kept CLI").not.toBe(x.pid);
  // Only the kept CLI is unconfirmed; its mount child was confirmed gone, so the owner's relay starts that integration again.
  const notices = x.events.events.filter(e => e.type === "item.started" && (e as { toolKind?: string }).toolKind === "notice").map(e => String((e as { title?: string }).title));
  expect(notices, "no integration is dropped when only the kept CLI is unconfirmed").toEqual([]);
}, 90_000);
