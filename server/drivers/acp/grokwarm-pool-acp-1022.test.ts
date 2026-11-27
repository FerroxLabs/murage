// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// design-1022-grokwarm r2 section P / contract C7, the ACP side (Side M): a parked Fuigo process is a warm-pool member that
// names its bot (`WarmMember.bot`) and the ACP owner turn passes its bot to the pool's activity signal, so the pool owner's
// per-bot rules (MAIN-RULING warm-active-only, warm-pool.ts) apply to ACP engines: one kept engine per active bot, and a bot
// with no owner turn in its window keeps none. Real ACP driver, the real shared warm pool, real fake-ACP processes.
// Cells WM-P1a (+ MP-1a: the ACP driver passes no bot to the pool), WM-P1b (+ MP-1b: the parked member names no bot).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordAdmittedEvents as recordEvents, type EventRecorder } from "../../testing/admitted-events.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { warmPool } from "../warm-pool.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";

const flagPath = "../warm-acp-reuse-flag.ts";
const flag = existsSync(new URL(flagPath, import.meta.url)) ? await import(flagPath) as { setWarmAcpReuseSource(source: () => unknown): void } : null;
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const WINDOW_MS = 6_000;
const SUPPORT: AcpSupport = {
  driverKind: "fuigoAgent",
  fluxReach: () => "elsewhere" as const,
  displayName: "Pool ACP Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-pool-acp",
  nativeSource: "poolacp.acp",
  loginNote: "never reached",
  spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  pooledSessions: true,
};
const Driver = createAcpDriver(SUPPORT);
const zombie = (pid: number) => {
  try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { windowsHide: true, encoding: "utf8" }).trim().startsWith("Z"); }
  catch { try { process.kill(pid, 0); return false; } catch { return true; } }
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  return !zombie(pid);
};
async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("grokwarm C7 ACP members on the per-bot warm pool (real driver, real pool)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const turn = async (threadId: string, botId: string, input: Partial<SendTurnInput> = {}) => {
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "go", warmIdentity: { botId, audience: "owner" }, ...input } as SendTurnInput);
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    await instance!.adapter.awaitTurnTeardown?.(threadId, turnId);
    return done;
  };

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-grokwarm-pool-"));
    spawnLog = join(scratch, "spawns.log");
    vi.stubEnv("FAKE_ACP_SPAWN_LOG", spawnLog);
    vi.stubEnv("FAKE_ACP_PROMPT_SCOPE", "1");
    vi.stubEnv("MURAGE_ACP_POOL", "1");
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", String(WINDOW_MS));
    flag?.setWarmAcpReuseSource(() => ({ warmAcpReuse: true }));
    instance = await Driver.create({ instanceId: "grokwarm-pool", displayName: "Pool", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  });
  afterEach(async () => {
    recorder?.stop();
    const pids = spawns();
    await instance?.dispose();
    instance = undefined;
    flag?.setWarmAcpReuseSource(() => undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await until(() => pids.every((pid) => !alive(pid)), "every engine process to exit");
    resetAcpMcpReadinessForTests();
    await removeTempDir(scratch);
  });

  // WM-P1a: bots A and B each run a Fuigo-shaped owner turn: two active bots keep one parked engine each. Then only bot B
  // has owner turns past A's window: A's engine is retired (its process exits), B's is kept and reused; A's next turn spawns
  // and resumes. Mutant MP-1a (the ACP driver passes no bot to noteUserActivity/markIdle): both engines count as one bot's,
  // so only one is kept, RED at the "both kept" assertion.
  it("WM-P1a one kept ACP engine per active bot; a bot past its window keeps none", async () => {
    await turn("t-bot-a", "bot-a");
    await sleep(WINDOW_MS / 2);
    await turn("t-bot-b", "bot-b");
    const [a, b] = spawns();
    await sleep(300);
    expect([alive(a!), alive(b!)], "WM-P1a both kept").toEqual([true, true]);
    // past bot A's window, while bot B stays active: B's owner turn (on its kept engine) runs the pool check
    await sleep(WINDOW_MS / 2);
    await turn("t-bot-b", "bot-b", { resumeCursor: "fake-acp-session" });
    expect(spawns(), "bot B's turn reused its kept engine").toHaveLength(2);
    await until(() => !alive(a!), "bot A's idle engine to be retired", 5_000);
    expect(alive(b!)).toBe(true);
    const back = await turn("t-bot-a", "bot-a", { resumeCursor: "fake-acp-session" });
    expect(back).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(3);
  }, 15_000);

  // WM-P1b (MAIN-RULING warm-active-only, ASTRA b3d38873ee/e5de7f00bb High): bot A has an owner turn on thread a1, then a
  // NON-owner (channel audience) turn on thread a2. The non-owner engine never names bot A, so it never takes bot A's one slot:
  // the owner's a1 engine stays kept. Mutant MP-1b (the ACP member names its turn's bot whatever the audience): a2 is bot A's
  // most recent engine and evicts a1, RED at the "a1 kept" assertion.
  it("WM-P1b a non-owner turn's ACP engine never takes its bot's slot from the owner's engine", async () => {
    await turn("t-a1", "bot-a");
    await turn("t-a2", "bot-a", { warmIdentity: { botId: "bot-a", audience: "non-owner" } });
    const [a1] = spawns();
    await sleep(300);
    expect(alive(a1!), "WM-P1b a1 kept").toBe(true);
  });

  // WM-P1c (ASTRA fc6839da31 LATE High, core.ts:6952): the SAME thread that parked an owner engine gets a non-owner turn that
  // resumes the owner's session. A non-owner turn never adopts the owner's parked engine: it spawns its own. Mutant MP-1c (the
  // adopt gate drops its audience clause): the non-owner turn adopts the owner's engine, RED at the "spawned its own" assertion.
  it("WM-P1c a non-owner turn on the owner's own thread does not adopt the owner's parked engine", async () => {
    const first = await turn("t-same", "bot-same");
    const [sessionId] = recorder.events.flatMap((event) => event.type === "session.started" && event.turnId === first.turnId ? [event.sessionId] : []);
    expect(sessionId).toEqual(expect.any(String));
    const [ownerPid] = spawns();
    await sleep(300);
    expect(alive(ownerPid!), "WM-P1c owner engine parked").toBe(true);
    const other = await turn("t-same", "bot-same", { warmIdentity: { botId: "bot-same", audience: "non-owner" }, resumeCursor: sessionId });
    expect(other).toMatchObject({ ok: true });
    expect(spawns(), "WM-P1c non-owner turn spawned its own engine").toHaveLength(2);
  }, 15_000);

  // WM-P2a (ASTRA fc6839da31 LATE High, warm-pool.ts:585): a focus-intent prewarm starts while its bot is active and the owner
  // window ends BEFORE the engine's first park. The prewarm park carries a hold, but a Fuigo engine lives on its bot's owner
  // activity only, so it is retired at park, with no pool tick (before this fix the hold kept it for a window). Entry:
  // adapter.prewarm on the real driver. Mutant MP-2b (markIdle's park-time window check AND enforce's
  // owner-activity-only clause removed; either alone is backed by the other): the hold keeps the engine, RED at the "retired at park" assertion.
  it("WM-P2a a prewarm engine whose owner window ended before its first park is retired at park", async () => {
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", String(15 * 60_000));
    await turn("t-prepark", "bot-prepark");
    const [first] = spawns();
    process.kill(first!, "SIGKILL"); // this thread has no engine now, but a remembered owner turn
    await until(() => !alive(first!), "the first engine to exit");
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", "700");
    await turn("t-prepark-other", "bot-prepark"); // the bot is active as the prewarm begins
    vi.stubEnv("FAKE_ACP_INIT_DELAY_MS", "1000");
    const before = spawns().length;
    await instance!.adapter.prewarm?.("t-prepark"); // resolves false once the engine is retired at park
    const pids = spawns();
    expect(pids, "WM-P2a the prewarm spawned its own engine").toHaveLength(before + 1);
    const pid = pids[pids.length - 1]!;
    // bounded inside the hold's own window, so only retirement at park passes
    for (let attempt = 0; attempt < 16 && alive(pid); attempt++) await sleep(25);
    expect(alive(pid), "WM-P2a retired at park").toBe(false);
  }, 20_000);

  it("WM-P1 exactly one of five bots keeps a Fuigo engine when only one had an owner turn", async () => {
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", String(15 * 60_000));
    await turn("t-owner", "bot-owner");
    for (const botId of ["bot-b", "bot-c", "bot-d", "bot-e"]) {
      await turn(`t-${botId}`, botId, { warmIdentity: { botId, audience: "non-owner" } });
    }
    await warmPool.tick();
    const pids = spawns();
    expect(pids).toHaveLength(5);
    for (let attempt = 0; attempt < 40 && pids.slice(1).some(alive); attempt++) await sleep(25);
    expect(pids.map(alive), "WM-P1 only the owner engine remains").toEqual([true, false, false, false, false]);
  }, 20_000);

  it("WM-P2 a focus hold cannot keep a Fuigo process past its bot's owner window", async () => {
    const windowMs = 15 * 60_000;
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", String(windowMs));
    vi.stubEnv("FAKE_ACP_UNIQUE_SESSIONS", "1");
    const first = await turn("t-expire", "bot-expire");
    const [sessionId] = recorder.events.flatMap((event) => event.type === "session.started" && event.turnId === first.turnId ? [event.sessionId] : []);
    expect(sessionId).toEqual(expect.any(String));
    await warmPool.tick();
    const [pid] = spawns();
    expect(alive(pid!)).toBe(true);
    // Expire the owner window while leaving the existing focus hold live.
    warmPool.warmIntent("t-expire", "bot-expire");
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", "1");
    await warmPool.tick();
    for (let attempt = 0; attempt < 40 && alive(pid!); attempt++) await sleep(25);
    expect(alive(pid!), "WM-P2 expired owner process exited").toBe(false);
    const next = await turn("t-expire", "bot-expire", { resumeCursor: sessionId });
    expect(next).toMatchObject({ ok: true });
    expect(recorder.events.find((event) => event.type === "session.started" && event.turnId === next.turnId)).toMatchObject({ sessionId });
    expect(spawns()).toHaveLength(2);
  }, 15_000);

  it("WM-P3 memory pressure retires the least recently active bot while another turn is running", async () => {
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", String(15 * 60_000));
    vi.stubEnv("MURAGE_WARM_POOL_BUDGET_MB", "8192");
    await turn("t-lru-a", "bot-lru-a");
    await turn("t-lru-b", "bot-lru-b");
    await turn("t-lru-c", "bot-lru-c");
    const gate = join(scratch, "finish-pressure-turn");
    vi.stubEnv("FAKE_ACP_MODE", "fuigo-script");
    vi.stubEnv("FAKE_ACP_SCRIPT", JSON.stringify([
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture underway" } } },
      { gate, result: { stopReason: "end_turn" } },
    ]));
    const active = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-lru-active", text: "active", warmIdentity: { botId: "bot-lru-a", audience: "owner" } });
    try {
      await recorder.until((event) => event.turnId === active.turnId && event.type === "content.delta");
      await warmPool.tick();
      vi.stubEnv("MURAGE_WARM_POOL_BUDGET_MB", String(warmPool.poolBytes() * 0.9 / (1024 * 1024)));
      await warmPool.tick();
      const pids = spawns();
      expect(pids).toHaveLength(4);
      for (let attempt = 0; attempt < 40 && alive(pids[1]!); attempt++) await sleep(25);
      expect(pids.map(alive), "WM-P3 keep the recently used bots and running process").toEqual([true, false, true, true]);
    } finally { writeFileSync(gate, "ready"); }
    expect(await recorder.until((event) => event.turnId === active.turnId && event.type === "turn.completed")).toMatchObject({ ok: true });
  }, 20_000);

  it("WM-P5 an expired bot cannot prewarm a Fuigo process", async () => {
    await turn("t-prewarm", "bot-prewarm");
    vi.stubEnv("MURAGE_WARM_ACTIVITY_WINDOW_MS", "1");
    await warmPool.tick();
    await until(() => !alive(spawns()[0]!), "expired process to exit");
    await instance!.adapter.prewarm?.("t-prewarm");
    expect(spawns(), "WM-P5 expired bot did not prewarm").toHaveLength(1);
  }, 15_000);
});
