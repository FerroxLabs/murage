// MAIN-RULING warm-active-only (2026-11-22T04:30:19Z) and design WARM-W1 r3.5 (e) E1 / W-P2, on the real warm pool.
// A warm engine is kept only for a bot with an owner turn in the last 15 minutes, at most one per active bot,
// at most 3 per engine kind across bots; 15 minutes without an owner turn retires it; on budget pressure the
// least recently active bot's engine goes first. Memory figures and the clock are injected.
import { describe, expect, it } from "vitest";
import { createWarmPool, type WarmEngine } from "./warm-pool.ts";

const MB = 1024 * 1024;
const WINDOW = 15 * 60_000;

function rig(opts: { budgetMB?: number; sizeMB?: number } = {}) {
  const clock = { t: 10_000_000 };
  const closed: string[] = [];
  const env: NodeJS.ProcessEnv = { MURAGE_WARM_POOL_MIN_FREE_MB: "0", MURAGE_WARM_POOL_BUDGET_MB: String(opts.budgetMB ?? 64_000) };
  const pool = createWarmPool({
    now: () => clock.t, totalmem: () => 64 * 1024 * MB, freemem: () => 64_000 * MB, env, timer: false, sampleFree: async () => {},
    log: () => {},
    measure: async (pids) => new Map(pids.map((p) => [p, (opts.sizeMB ?? 100) * MB])),
  });
  const keys = new Map<string, object>();
  /** An owner turn on bot/thread (what each driver calls at send) followed by that engine settling idle. */
  const ownerTurn = async (bot: string, thread: string, engine: WarmEngine = "claude", pid = Number(thread.replace(/\D/g, "")) || 1) => {
    pool.noteUserActivity(bot, thread);
    const key = keys.get(thread) ?? {};
    keys.set(thread, key);
    pool.release(key);
    await pool.markIdle(key, { engine, threadId: thread, bot, pid: () => pid, close: (reason) => closed.push(`${thread}:${reason}`) });
  };
  /** An engine left idle on a bot that had no owner turn (a prewarm, a background-borrowed engine, a stale spare). */
  const settleWithoutTurn = async (bot: string, thread: string, engine: WarmEngine = "claude", pid = Number(thread.replace(/\D/g, "")) || 1) => {
    const key = {};
    keys.set(thread, key);
    await pool.markIdle(key, { engine, threadId: thread, bot, pid: () => pid, close: (reason) => closed.push(`${thread}:${reason}`) });
  };
  const kept = () => [...keys].filter(([t]) => !closed.some((c) => c.startsWith(`${t}:`))).map(([t]) => t).sort();
  return { pool, clock, closed, ownerTurn, settleWithoutTurn, kept };
}

describe("MAIN-RULING warm-active-only: warm engines only for active bots", () => {
  it("W-ACT1: 5 bots, 1 active -> exactly 1 kept engine, the active bot's", async () => {
    const r = rig();
    await r.ownerTurn("bot-a", "t1", "claude");
    await r.settleWithoutTurn("bot-b", "t2", "codex");
    await r.settleWithoutTurn("bot-c", "t3", "acp");
    await r.settleWithoutTurn("bot-d", "t4", "claude");
    await r.settleWithoutTurn("bot-e", "t5", "claude");
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(1); // W-ACT1:count
    expect(r.kept()).toEqual(["t1"]); // W-ACT1:which
  });

  it("W-ACT1b: an active bot keeps at most ONE engine, whatever its engine kinds and threads", async () => {
    const r = rig();
    await r.ownerTurn("bot-a", "t1", "claude");
    await r.ownerTurn("bot-a", "t2", "codex");
    await r.ownerTurn("bot-a", "t3", "acp");
    await r.pool.tick();
    expect(r.kept()).toEqual(["t3"]); // W-ACT1b:one-per-bot
  });

  it("W-ACT2: the active bot idle 15 min -> its engine retired, although another bot is still active", async () => {
    const r = rig();
    await r.ownerTurn("bot-a", "t1", "claude");
    r.clock.t += 10 * 60_000;
    await r.ownerTurn("bot-b", "t2", "claude");
    r.clock.t += WINDOW - 10 * 60_000 + 1_000; // bot-a: 15 min + 1 s since its owner turn; bot-b: 5 min
    await r.pool.tick();
    expect(r.closed).toEqual(["t1:activity window"]); // W-ACT2:retired
    r.clock.t += 10 * 60_000; // bot-b now idle 15 min too
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(0); // W-ACT2:zero
  });

  it("W-ACT3: budget pressure retires the least recently ACTIVE bot first, not the least recently idle engine", async () => {
    const r = rig({ budgetMB: 1500, sizeMB: 600 });
    // owner activity order: bot-a (oldest), bot-b, bot-c; idle order: t3 (bot-c) first
    r.pool.noteUserActivity("bot-a", "t1"); r.clock.t += 1_000;
    r.pool.noteUserActivity("bot-b", "t2"); r.clock.t += 1_000;
    r.pool.noteUserActivity("bot-c", "t3"); r.clock.t += 1_000;
    await r.settleWithoutTurn("bot-c", "t3", "acp");
    await r.settleWithoutTurn("bot-b", "t2", "codex");
    await r.settleWithoutTurn("bot-a", "t1", "claude"); // third 600 MB engine: over 1500 MB
    expect(r.closed).toEqual(["t1:pool budget"]); // W-ACT3:lru-bot
  });

  it("W-P2: two bots alternating owner turns keep both engines (spare limit 3 per kind, E1)", async () => {
    const r = rig();
    for (let i = 0; i < 4; i++) { await r.ownerTurn("bot-a", "t1"); await r.ownerTurn("bot-b", "t2"); }
    expect(r.closed).toEqual([]); // W-P2:both-kept
  });

  it("W-P2b: four active bots on one engine kind keep 3; the least recently active bot's engine goes", async () => {
    const r = rig();
    await r.ownerTurn("bot-a", "t1"); r.clock.t += 1_000;
    await r.ownerTurn("bot-b", "t2"); r.clock.t += 1_000;
    await r.ownerTurn("bot-c", "t3"); r.clock.t += 1_000;
    await r.ownerTurn("bot-d", "t4");
    expect(r.closed).toEqual(["t1:spare limit"]); // W-P2b:cap3
  });

  // The drivers never name the bot in markIdle: the pool resolves it from the thread's last owner turn
  // (noteUserActivity(botId, threadId), claude.ts/codex.ts/acp/core.ts) or the owner's intent (warmIntent(threadId, botId), index.ts).
  const driverIdle = (r: ReturnType<typeof rig>, thread: string, engine: WarmEngine = "claude", hold = false) => {
    const pid = Number(thread.replace(/\D/g, "")) || 1;
    return r.pool.markIdle({}, { engine, threadId: thread, hold, pid: () => pid, close: (reason) => r.closed.push(`${thread}:${reason}`) });
  };

  it("W-ACT4: driver path (no bot on the member): two active bots keep one engine each, a thread with no owner turn keeps none", async () => {
    const r = rig();
    r.pool.noteUserActivity("bot-a", "t1"); await driverIdle(r, "t1");
    r.pool.noteUserActivity("bot-b", "t2"); await driverIdle(r, "t2", "codex");
    await driverIdle(r, "t3", "acp"); // no owner turn on t3's bot
    expect(r.closed).toEqual(["t3:activity window"]); // W-ACT4:per-thread-bot
  });

  // MAIN 2026-11-23 (binding, warm1022-presence-r6): "speculative parks must never evict owner engines via the same-bot path or memory-pressure checks" (answers QUESTION warm1022-presence-samebot with option A): the bot's one slot stays with the engine that settled its owner turn; the unclaimed prewarm gives way.
  it("W-ACT5: the owner's intent warm on a NEW thread of an active bot never takes that bot's one slot from its owner engine", async () => {
    const r = rig();
    r.pool.noteUserActivity("bot-a", "t1"); await driverIdle(r, "t1");
    r.pool.warmIntent("t2", "bot-a"); await driverIdle(r, "t2", "claude", true);
    expect(r.closed).toEqual(["t2:spare limit"]); // W-ACT5:intent-bot
    expect(r.pool.idleCount()).toBe(1);
  });

  it("an intent hold on an asleep bot keeps only that thread's engine, for the 120 s prewarm hold; then it is retired", async () => {
    // MAIN-RULING warm1022-driver-D2 (presence slice): the asleep bot's hold is the designed 120 s, no longer the 15-min window
    const r = rig();
    r.pool.warmIntent("t9", "bot-z"); await driverIdle(r, "t9", "claude", true);
    expect(r.closed).toEqual([]);
    r.clock.t += 119_000; await r.pool.tick();
    expect(r.closed).toEqual([]);
    r.clock.t += 2_000; await r.pool.tick();
    expect(r.closed).toEqual(["t9:prewarm unused"]);
  });

  it("a turn that names no bot never moves a known thread off its bot", async () => {
    const r = rig();
    r.pool.noteUserActivity("bot-a", "t1");
    r.pool.noteUserActivity(undefined, "t1");
    r.clock.t += WINDOW + 1_000; // bot-a asleep; "" (the botless turn) also asleep
    await driverIdle(r, "t1");
    expect(r.closed).toEqual(["t1:activity window"]);
    r.pool.noteUserActivity("bot-a", "t5"); r.pool.noteUserActivity(undefined, "t5");
    await driverIdle(r, "t5");
    await driverIdle(r, "t6"); // an unknown thread falls in the "" bucket, which the botless turn woke
    expect(r.closed).toEqual(["t1:activity window"]); // t5 counts as bot-a's, t6 as ""'s: not merged
  });

  // FABLE 38cebb4cde M4: a channel (non-owner) turn on a thread that earlier had an owner turn never takes that bot's one slot.
  it("W-NO1: a non-owner turn's engine never evicts the owner's engine of the same bot", async () => {
    const r = rig();
    const owner = { botId: "bot-a", audience: "owner" as const };
    r.pool.noteTurn(owner, "t2"); await driverIdle(r, "t2"); // t2 had an owner turn of bot-a once
    r.pool.noteTurn(owner, "t1"); await driverIdle(r, "t1"); // the owner's current thread: bot-a's one engine
    r.pool.noteTurn({ botId: "bot-a", audience: "non-owner" }, "t2"); await driverIdle(r, "t2"); // a channel turn on t2 settles
    expect(r.closed).toEqual(["t2:spare limit", "t2:activity window"]); // W-NO1:owner-kept
    expect(r.pool.idleCount()).toBe(1);
  });

  it("W-NO2: the pool's own guard: a non-owner turn wakes no bot and maps no thread", async () => {
    const r = rig();
    r.pool.noteTurn({ botId: "bot-g", audience: "non-owner" }, "t7");
    expect(r.pool.activityFor("t7")).toEqual({ bot: undefined, active: false, nonOwner: true }); // W-NO2:no-wake
    r.pool.noteTurn({ botId: "bot-g", audience: "owner" }, "t7");
    expect(r.pool.activityFor("t7")).toEqual({ bot: "bot-g", active: true, nonOwner: false });
  });

  // FABLE 38cebb4cde M4 (second half): under budget pressure the owner's newer intent hold counts as recent use of its thread.
  // MAIN 2026-11-23 (binding, warm1022-presence-r6): "speculative parks must never evict owner engines via the same-bot path or memory-pressure checks" (answers QUESTION warm1022-presence-samebot with option A): an UNCLAIMED prewarm goes first under budget pressure; among engines that settled an owner turn, the intent stays recent use.
  it("W-ACT3b: budget pressure retires an unclaimed prewarm before an older owner-turn engine", async () => {
    const r = rig({ budgetMB: 1000, sizeMB: 600 });
    r.pool.noteUserActivity("bot-a", "t1"); await driverIdle(r, "t1");
    r.clock.t += 10 * 60_000;
    r.pool.warmIntent("t9", "bot-z"); await driverIdle(r, "t9", "claude", true); // second 600 MB engine: over 1000 MB
    expect(r.closed).toEqual(["t9:pool budget"]); // W-ACT3b:intent-recent
  });
});
