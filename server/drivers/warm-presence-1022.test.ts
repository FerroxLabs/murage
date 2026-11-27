// designs/WARM-W1-1022-presence.md (r2, ASTRA + FABLE AGREE) and MAIN-RULING warm1022-driver-D2, on the real warm pool and the
// real owner-presence clock, wired the way server/index.ts wires them (setPresence, onAway -> ownerAway). The clock is injected.
// Each `// <ID>` comment names the assertion its mutant targets (receipts.tsv).
import { describe, expect, it } from "vitest";
import { createPrewarmGate, createWarmPool, type WarmEngine } from "./warm-pool.ts";

// The same file runs on the pre-fix base for the BASE-RED receipts: there the pool has no presence hooks and there is no presence
// clock, which is exactly the base behaviour (always "present", no away edge), so every cell reaches its behavioural assertion.
type Presence = { present(): boolean; input(): void; turnBegan(): () => void; away(cause: "locked" | "asleep" | "restart"): void; resumed(): void; onAway(cb: (cause: string) => void): () => void };
const presenceModule = await import("../owner-presence.ts").catch(() => null) as { createOwnerPresence: (deps: object) => Presence } | null;
const basePresence = (): Presence => ({ present: () => true, input() {}, turnBegan: () => () => {}, away() {}, resumed() {}, onAway: () => () => {} });
const PREWARM_HOLD_MS = 120_000;

const MB = 1024 * 1024;
const WINDOW = 15 * 60_000;

function rig(opts: { budgetMB?: number; sizeMB?: number; env?: NodeJS.ProcessEnv; free?: { mb: number } } = {}) {
  const clock = { t: 50_000_000 };
  const closed: string[] = [];
  const logs: string[] = [];
  const scheduled: { at: number; fn: () => void; live: boolean }[] = [];
  const env: NodeJS.ProcessEnv = { MURAGE_WARM_POOL_MIN_FREE_MB: "0", MURAGE_WARM_POOL_BUDGET_MB: String(opts.budgetMB ?? 64_000), ...opts.env };
  const pool = createWarmPool({
    now: () => clock.t, totalmem: () => 64 * 1024 * MB, freemem: () => (opts.free?.mb ?? 64_000) * MB, env, timer: false, sampleFree: async () => {},
    log: (line) => logs.push(line),
    measure: async (pids) => new Map(pids.map((p) => [p, (opts.sizeMB ?? 100) * MB])),
    schedule: (fn, ms) => { const job = { at: clock.t + ms, fn, live: true }; scheduled.push(job); return () => { job.live = false; }; },
  });
  const presence = presenceModule ? presenceModule.createOwnerPresence({ now: () => clock.t, windowMs: () => WINDOW, log: (line: string) => logs.push(line) }) : basePresence();
  const hooks = pool as typeof pool & { setPresence?: (fn: () => boolean) => void; ownerAway?: (cause: string) => number; admitPrewarm?: (thread: string) => { ok: boolean; reason?: string } };
  hooks.setPresence?.(() => presence.present());
  presence.onAway((cause) => { hooks.ownerAway?.(cause); });
  /** Advance the injected clock, running the pool's scheduled checks (hold ends, early re-measures) on the way. */
  const advance = async (ms: number) => {
    const end = clock.t + ms;
    for (;;) {
      const due = scheduled.filter((j) => j.live && j.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.t = Math.max(clock.t, due.at);
      due.live = false;
      due.fn();
      await pool.tick();
    }
    clock.t = end;
    await pool.tick();
  };
  const keys = new Map<string, object>();
  const dead = new WeakSet<object>();
  const closer = (thread: string, key: object) => (reason: string) => { dead.add(key); closed.push(`${thread}:${reason}`); };
  /** The thread's current engine key: a fresh one once the old engine closed (a cold spawn). */
  const keyFor = (thread: string) => { let key = keys.get(thread); if (!key || dead.has(key)) { key = {}; keys.set(thread, key); } return key; };
  const pidOf = (thread: string) => Number(thread.replace(/\D/g, "")) || 1;
  /** An owner turn on bot/thread: what the driver calls at send, then its engine settling idle. */
  const ownerTurn = async (bot: string, thread: string, engine: WarmEngine = "claude") => {
    const end = presence.turnBegan();
    pool.noteTurn({ botId: bot, audience: "owner" }, thread);
    pool.sent(thread);
    const key = keyFor(thread);
    pool.release(key);
    end();
    await pool.markIdle(key, { engine, threadId: thread, bot, pid: () => pidOf(thread), close: closer(thread, key) });
  };
  /** A prewarm: admission (warmThread), then the driver's engine parking idle with `hold` (claude.ts armIdle). */
  const prewarm = async (bot: string, thread: string, engine: WarmEngine = "claude", between?: () => Promise<void> | void): Promise<{ ok: boolean; reason?: string }> => {
    pool.warmIntent(thread, bot);
    const admitted: { ok: boolean; reason?: string } = hooks.admitPrewarm ? hooks.admitPrewarm(thread) : { ok: true };
    if (!admitted.ok) return admitted;
    await between?.();
    const key = {};
    keys.set(thread, key);
    await pool.markIdle(key, { engine, threadId: thread, hold: true, pid: () => pidOf(thread), close: closer(thread, key) });
    return admitted;
  };
  /** Threads whose current engine is still open. */
  const live = () => [...keys].filter(([, k]) => !dead.has(k)).map(([t]) => t).sort();
  /** An engine that settled on its own (no owner turn noted, a borrowed or background one). */
  const settle = async (thread: string, info: { bot?: string; background?: boolean }) => {
    const key = keyFor(thread);
    await pool.markIdle(key, { engine: "claude", threadId: thread, ...info, pid: () => pidOf(thread), close: closer(thread, key) });
  };
  return { pool, presence, clock, closed, logs, advance, ownerTurn, prewarm, live, keys, settle };
}

describe("MAIN-RULING warm1022-driver-D2: an asleep bot's hold is 120 s, an active bot's keeps the window", () => {
  it("D2: a focus hold on an asleep bot's idle engine is released at 120 s, not at the 15-min window", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.advance(WINDOW + 1_000); // bot-a asleep: no owner turn in the window, but he is present (input below)
    r.presence.input();
    await r.prewarm("bot-a", "t1");
    expect(r.pool.idleCount()).toBe(1);
    await r.advance(PREWARM_HOLD_MS - 1_000);
    r.presence.input();
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(1); // D2:held-inside
    await r.advance(2_000);
    expect(r.closed.filter((c) => c.startsWith("t1:")).at(-1)).toBe("t1:prewarm unused"); // D2:released-at-120s
    expect(r.pool.idleCount()).toBe(0);
  });

  it("D2b: a focus taken while the bot was active does not outlive its sleep by more than 120 s (judged now, not at the beat)", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.advance(14 * 60_000);
    r.presence.input();
    r.pool.warmIntent("t1", "bot-a"); // bot-a still active: the hold keeps the window while it is
    await r.advance(60_000 + 1_000); // bot-a asleep now (15 min + 1 s since its owner turn), hold 61 s old
    r.presence.input();
    await r.pool.tick();
    expect(r.live()).toEqual(["t1"]);
    await r.advance(60_000); // 121 s after the beat
    r.presence.input();
    await r.pool.tick();
    expect(r.live()).toEqual([]); // D2b:asleep-after-beat
  });
});

describe("P-AWAY / P-SIG: away retires everything", () => {
  it("W-PR1a: owner turns on A and B, then no owner input for W: 0 engines and the idle log line", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.ownerTurn("bot-b", "t2", "codex");
    await r.advance(WINDOW + 1_000);
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(0); // W-PR1a:zero
    expect(r.logs).toContain("presence warm state=away cause=idle"); // W-PR1a:idle-log
  });

  it("W-PR1b: a lock retires every idle engine and clears C's focus hold at once", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.prewarm("bot-c", "t3", "codex");
    expect(r.pool.idleCount()).toBe(2);
    r.presence.away("locked");
    expect(r.pool.idleCount()).toBe(0); // W-PR1b:zero-at-lock
    expect(r.closed).toEqual(expect.arrayContaining(["t1:owner away locked", "t3:owner away locked"])); // W-PR1b:C-cleared
    expect(r.logs).toContain("presence warm state=away cause=locked");
  });

  it("W-PR1c: asleep, then 2 h, then a resume: nothing kept", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    r.presence.away("asleep");
    await r.advance(2 * 60 * 60_000);
    r.presence.resumed();
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(0); // W-PR1c:zero
    expect(r.presence.present()).toBe(false);
  });

  it("W-PR1d: a lock is an edge: phone input after it makes him present and the next owner turn's engine is kept", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    r.presence.away("locked");
    r.presence.input(); // the phone's send through the door
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    expect(r.presence.present()).toBe(true); // W-PR1d:edge-not-sticky
    expect(r.pool.idleCount()).toBe(1);
  });

  it("W-PR1f/f': an owner turn running past W keeps him present while in flight and its settle keeps its engine", async () => {
    const r = rig();
    r.presence.input();
    const end = r.presence.turnBegan();
    r.pool.noteTurn({ botId: "bot-a", audience: "owner" }, "t1");
    await r.advance(WINDOW + 60_000);
    expect(r.presence.present()).toBe(true); // W-PR1f':in-flight
    await r.advance(4 * 60_000);
    end();
    r.pool.noteTurn({ botId: "bot-a", audience: "owner" }, "t1");
    await r.settle("t1", { bot: "bot-a" });
    await r.advance(5 * 60_000);
    await r.pool.tick();
    expect(r.live()).toEqual(["t1"]); // W-PR1f:kept-after-settle
  });

  it("Fable M1 / W-PR6c: a lock during an owner turn: the turn's settle does not make him present, and its engine closes owner away", async () => {
    const r = rig();
    r.presence.input();
    const end = r.presence.turnBegan();
    r.pool.noteTurn({ botId: "bot-a", audience: "owner" }, "t1");
    r.presence.away("locked");
    end();
    expect(r.presence.present()).toBe(false); // FM1:settle-after-lock
    await r.settle("t1", { bot: "bot-a" });
    expect(r.closed).toEqual(["t1:owner away"]); // W-PR6c:closed-at-settle
  });

  it("W-PR2: a background turn while away borrows nothing and keeps nothing", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    r.presence.away("locked");
    expect(r.pool.idleCount()).toBe(0); // W-PR2:lock-retired
    await r.settle("t1", { bot: "bot-a", background: true });
    expect(r.pool.idleCount()).toBe(0); // W-PR2:zero-after
    expect(r.presence.present()).toBe(false);
  });

  it("W-PR5b/c: presence starts away (restart), and every presence log line is content-free", async () => {
    const r = rig();
    expect(r.presence.present()).toBe(false); // W-PR5b:restart-away
    r.presence.input();
    r.presence.away("locked");
    r.presence.input();
    await r.advance(WINDOW + 1);
    r.presence.present();
    const lines = r.logs.filter((l) => l.startsWith("presence "));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).toMatch(/^presence warm state=(present|away) cause=(input|turn|idle|locked|asleep|restart)$/); // W-PR5c:format
  });
});

describe("P-PRE / P-FENCE: prewarm limits, admission and epoch", () => {
  it("W-PR3c: an unclaimed prewarm with no send is retired `prewarm unused` at 120 s + 1 tick", async () => {
    const r = rig();
    r.presence.input();
    expect((await r.prewarm("bot-x", "t9")).ok).toBe(true);
    await r.advance(PREWARM_HOLD_MS + 1_000);
    expect(r.closed).toEqual(["t9:prewarm unused"]); // W-PR3c:retired
  });

  it("W-PR3d: five chats opened in 20 s: at most 3 starts, at most 1 unclaimed per kind alive", async () => {
    const r = rig();
    r.presence.input();
    const results = [];
    for (let i = 1; i <= 5; i++) { results.push(await r.prewarm(`bot-${i}`, `t${i}`)); await r.advance(4_000); }
    expect(results.filter((x) => x.ok).length).toBe(3); // W-PR3d:three-starts
    expect(results.slice(3).map((x) => !x.ok && x.reason)).toEqual(["rate", "rate"]);
    expect(r.pool.idleCount()).toBe(1); // W-PR3d:one-per-kind
  });

  it("W-PR3d': the same thread opened twice within 60 s starts once", async () => {
    const r = rig();
    r.presence.input();
    expect((await r.prewarm("bot-a", "t1")).ok).toBe(true);
    r.presence.away("locked"); // retired
    r.presence.input();
    await r.advance(10_000);
    const second = await r.prewarm("bot-a", "t1");
    expect(second).toEqual({ ok: false, reason: "rate" }); // W-PR3d2:per-thread
  });

  it("W-PR3e: an away edge between admission and park closes the prewarm by its epoch, although he is present again", async () => {
    const r = rig();
    r.presence.input();
    const admitted = await r.prewarm("bot-a", "t1", "claude", () => { r.presence.away("locked"); r.presence.input(); });
    expect(admitted.ok).toBe(true);
    expect(r.presence.present()).toBe(true);
    expect(r.closed).toEqual(["t1:owner away"]); // W-PR3e:epoch-close
    expect(r.pool.idleCount()).toBe(0);
  });

  it("W-PR3e (codex): a prewarm the driver answered false for (its start still going on) keeps its epoch: an away edge before it parks closes it", async () => {
    const r = rig();
    r.presence.input();
    // warmThread's order: admission, the driver answers false past its wait (codex.ts prewarm) and the start is given back, then it parks
    const admitted = await r.prewarm("bot-a", "t1", "codex", () => { (r.pool as { unadmitPrewarm?(t: string): void }).unadmitPrewarm?.("t1"); r.presence.away("locked"); r.presence.input(); });
    expect(admitted.ok).toBe(true);
    expect(r.presence.present()).toBe(true);
    expect(r.closed).toEqual(["t1:owner away"]); // W-PR3e-codex:epoch-kept
  });

  it("W-PR3e (codex retry, ASTRA 4ee774eaee): a given-back start still running, an away edge, then a second /warm on the same thread that Codex refuses as a duplicate: the first start still parks under its own (older) epoch and is closed", async () => {
    const r = rig();
    r.presence.input();
    // optional calls: on the pre-fix base the pool has no admission hooks, so the cell still reaches its behavioural assertion there
    const pool = r.pool as unknown as { admitPrewarm?(t: string): { ok: boolean }; unadmitPrewarm?(t: string): void };
    const admitted = await r.prewarm("bot-a", "t1", "codex", async () => {
      pool.unadmitPrewarm?.("t1"); // codex.ts prewarm answered false past its wait; warmThread gave the start back
      r.presence.away("locked");
      r.presence.input();
      await r.advance(61_000); // past the per-thread rate window: the retry is admitted
      expect((pool.admitPrewarm?.("t1") ?? { ok: true }).ok).toBe(true);
      pool.unadmitPrewarm?.("t1"); // Codex refuses the duplicate (prewarming.begin null): given back too
    });
    expect(admitted.ok).toBe(true);
    expect(r.closed).toEqual(["t1:owner away"]); // W-PR3e-codex-retry:older-epoch
  });

  it("W-PR3f: budget = one engine, A's owner engine idle: opening B is skipped `budget` and A is still kept", async () => {
    const r = rig({ budgetMB: 150, sizeMB: 100 });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    const b = await r.prewarm("bot-b", "t2");
    expect(b).toEqual({ ok: false, reason: "budget" }); // W-PR3f:skipped
    expect(r.live()).toEqual(["t1"]); // W-PR3f:A-kept
  });

  it("W-PR3f' (ASTRA High f47d347b39): budget = one engine, A's owner engine idle: a prewarm's spawn headroom (beforeSpawn, as claude.ts/codex.ts call it for turn.prewarm) never evicts A; an owner send's still makes room", async () => {
    const r = rig({ budgetMB: 150, sizeMB: 100 });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    await (r.pool.beforeSpawn as (opts?: { speculative?: boolean }) => Promise<void>)({ speculative: true });
    expect({ closed: r.closed, live: r.live() }).toEqual({ closed: [], live: ["t1"] }); // W-PR3f2:speculative-keeps-owner
    await r.pool.beforeSpawn();
    expect(r.closed).toEqual(["t1:pool reserve"]); // W-PR3f2:owner-send-makes-room
  });

  // ASTRA 831b2c39bc LATE High (warm-pool.ts:580 enforce), across bots (design P-PRE 3/6: an engine that settled an owner turn is never
  // closed by opening another chat).
  // Same bot (ASTRA d0f7e5e5d3 High warm-pool.ts:526/:587, MAIN 2026-11-23 warm1022-presence-r6 "speculative parks must never evict
  // owner engines via the same-bot path"): an unclaimed prewarm on T2 never takes bot A's one slot from A's owner engine on T1.
  it("W-PR3k: bot A's owner engine idle on t1; a prewarm on A's other thread t2 parks: t1 is kept, the prewarm gives way", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    expect((await r.prewarm("bot-a", "t2")).ok).toBe(true);
    await r.pool.tick();
    expect({ t1Closed: r.closed.filter((c) => c.startsWith("t1:")), t1Live: r.live().includes("t1") }).toEqual({ t1Closed: [], t1Live: true }); // W-PR3k:same-bot-owner-kept
  });

  // Memory pressure (ASTRA d0f7e5e5d3 High warm-pool.ts:597-599): a prewarm admitted with room, then an owner engine settles; when the
  // pool budget or the free-memory floor is crossed at park, the unclaimed prewarm goes, never an engine that settled an owner turn.
  it("W-PR3m: pool budget crossed when a prewarm parks (an owner engine settled meanwhile): the prewarm is closed, both owner engines kept", async () => {
    const r = rig({ budgetMB: 250, sizeMB: 100 });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    await r.advance(1_000);
    r.presence.input();
    const admitted = await r.prewarm("bot-c", "t3", "claude", async () => { await r.ownerTurn("bot-b", "t2"); await r.pool.tick(); });
    expect(admitted.ok).toBe(true);
    await r.pool.tick();
    expect({ ownerClosed: r.closed.filter((c) => !c.startsWith("t3:")), t3: r.closed.filter((c) => c.startsWith("t3:")) }).toEqual({ ownerClosed: [], t3: ["t3:pool budget"] }); // W-PR3m:budget-owner-kept
  });

  it("W-PR3m': free memory under the floor when a prewarm parks: the prewarm is closed, the owner engine kept", async () => {
    const free = { mb: 64_000 };
    const r = rig({ free, env: { MURAGE_WARM_POOL_MIN_FREE_MB: "1000" } });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    await r.advance(1_000);
    r.presence.input();
    // the park's own check (markIdle) is the one under test: free memory does not move until a kill lands, one engine per check
    const admitted = await r.prewarm("bot-c", "t3", "claude", () => { free.mb = 500; });
    expect(admitted.ok).toBe(true);
    expect({ ownerClosed: r.closed.filter((c) => !c.startsWith("t3:")), t3: r.closed.filter((c) => c.startsWith("t3:")) }).toEqual({ ownerClosed: [], t3: ["t3:low memory"] }); // W-PR3m2:low-memory-owner-kept
  });

  // the across-bots cap (3 per engine kind): a parking prewarm never closes another bot's owner engine to stay
  it("W-PR3k': three bots' owner engines idle (the cap); a fourth bot's prewarm parks: all three owner engines are kept", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.ownerTurn("bot-b", "t2");
    await r.ownerTurn("bot-c", "t3");
    await r.pool.tick();
    await r.prewarm("bot-d", "t4");
    await r.pool.tick();
    expect({ ownerClosed: r.closed.filter((c) => !c.startsWith("t4:")), live: ["t1", "t2", "t3"].every((t) => r.live().includes(t)) }).toEqual({ ownerClosed: [], live: true }); // W-PR3k2:owner-kept
  });

  // Opus r6 self-review High: free memory just above the floor admits a prewarm whose own start then pushes it under; a pressure check
  // BEFORE its park (the timer, another engine settling) finds no unclaimed engine idle yet. Admission leaves room for the engine it
  // starts, so that start never happens and the owner engine is never closed for it.
  it("W-PR3m'': free memory just above the floor: the prewarm is refused (budget), so no check before a park closes the owner engine", async () => {
    const free = { mb: 1_050 };
    const r = rig({ free, env: { MURAGE_WARM_POOL_MIN_FREE_MB: "1000" } });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    await r.advance(1_000);
    r.presence.input();
    // admitted: its spawn takes ~100 MB and a pool check runs while it starts (before it parks)
    await r.prewarm("bot-c", "t3", "claude", async () => { free.mb = 950; await r.pool.tick(); });
    expect(r.closed.filter((c) => c.startsWith("t1:"))).toEqual([]); // W-PR3m3:start-headroom-owner-kept
  });

  // Astra r6 pass 1 High: a start bigger than its estimate (or two admitted against one sample) crosses the floor before it parks. While
  // a prewarm start is in flight a pressure check closes only unclaimed engines, and admission reserves room for every start in flight.
  it("W-PR3m''': a prewarm start bigger than estimated crosses the floor before it parks: the owner engine is kept, the prewarm goes at park", async () => {
    const free = { mb: 1_150 };
    const r = rig({ free, env: { MURAGE_WARM_POOL_MIN_FREE_MB: "1000" } });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    await r.advance(1_000);
    r.presence.input();
    expect((await r.prewarm("bot-c", "t3", "claude", async () => { free.mb = 800; await r.pool.tick(); })).ok).toBe(true);
    expect({ ownerClosed: r.closed.filter((c) => c.startsWith("t1:")), t3: r.closed.filter((c) => c.startsWith("t3:")) }).toEqual({ ownerClosed: [], t3: ["t3:low memory"] }); // W-PR3m4:inflight-owner-kept
  });

  it("W-PR3m4: two prewarms against one free-memory sample: the second is refused (room is reserved for the start in flight)", async () => {
    const r = rig({ free: { mb: 1_150 }, env: { MURAGE_WARM_POOL_MIN_FREE_MB: "1000" } });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    await r.advance(1_000);
    r.presence.input();
    const admit = (t: string) => (r.pool as { admitPrewarm?: (t: string) => { ok: boolean; reason?: string } }).admitPrewarm?.(t) ?? { ok: true };
    r.pool.warmIntent("t3", "bot-c"); r.pool.warmIntent("t4", "bot-d");
    expect(admit("t3").ok).toBe(true);
    expect(admit("t4")).toEqual({ ok: false, reason: "budget" }); // W-PR3m5:reserved
  });

  // Astra r6 pass 2 Highs: (1) with a start in flight and owner engines over the pool budget, the budget check stops (no endless loop);
  // (2) a Codex start given back past its wait (codex.ts prewarm: startStillRunning) stays in flight, so a low-memory check before it
  // parks still never closes an owner engine.
  it("W-PR3m5: a start given back while still running (Codex past its wait) keeps owner engines safe from pressure; the budget check ends", async () => {
    const free = { mb: 1_150 };
    const r = rig({ free, budgetMB: 250, sizeMB: 100, env: { MURAGE_WARM_POOL_MIN_FREE_MB: "1000" } });
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.pool.tick();
    r.presence.input();
    const pool = r.pool as { admitPrewarm?(t: string): { ok: boolean }; unadmitPrewarm?(t: string): void; startStillRunning?(t: string): void };
    r.pool.warmIntent("t3", "bot-c");
    pool.admitPrewarm?.("t3");
    pool.startStillRunning?.("t3"); // codex.ts prewarm: answered false past its wait, the start goes on
    pool.unadmitPrewarm?.("t3"); // warmThread gives the start back
    await r.ownerTurn("bot-b", "t2");
    await r.ownerTurn("bot-d", "t4"); // 300 MB idle, over the 250 MB budget: with a start in flight the check stops, it never spins
    free.mb = 800;
    await r.pool.tick();
    expect(r.closed.filter((c) => /^t[124]:/.test(c))).toEqual([]); // W-PR3m6:given-back-owner-kept
  });

  it("W-PR3i: A and B (same kind) had owner turns 2 min ago; opening chat C keeps both", async () => {
    const r = rig();
    r.presence.input();
    await r.ownerTurn("bot-a", "t1");
    await r.ownerTurn("bot-b", "t2");
    await r.advance(2 * 60_000);
    r.presence.input();
    expect((await r.prewarm("bot-c", "t3")).ok).toBe(true);
    await r.pool.tick();
    expect(r.closed.filter((c) => c.endsWith("intent-moved"))).toEqual([]); // W-PR3i:no-intent-moved
    expect(r.live()).toEqual(["t1", "t2", "t3"]);
  });

  it("W-PR1e: away, a /warm without a gesture does not make him present and admits nothing (`away`)", async () => {
    const r = rig();
    const skipped = await r.prewarm("bot-a", "t1");
    expect(skipped).toEqual({ ok: false, reason: "away" }); // W-PR1e:away
    expect(r.pool.idleCount()).toBe(0);
  });

  it("W-PR4: five bots opened and typed in over 2 min, one owner turn on A: 1 kept at +5 min, 0 at settle + W + 1 s", async () => {
    const r = rig();
    r.presence.input();
    for (let i = 1; i <= 5; i++) { await r.prewarm(`bot-${i}`, `t${i}`); r.presence.input(); await r.advance(24_000); }
    await r.ownerTurn("bot-1", "t1");
    await r.advance(5 * 60_000 - 2 * 60_000);
    r.presence.input();
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(1); // W-PR4:one-kept
    expect(r.live()).toContain("t1");
    for (const c of r.closed) expect(c).toMatch(/:(prewarm unused|intent-moved)$/);
    await r.advance(WINDOW + 1_000);
    await r.pool.tick();
    expect(r.pool.idleCount()).toBe(0); // W-PR4:zero
  });
});

// P-FENCE 3 on the real prewarm gate both drivers use (claude.ts sendTurnCaptured body, codex.ts sendTurnBody): a send that finds a
// LIVE prewarm still starting waits for it until it is ready, bounded only against a hang, counted from the prewarm's own start.
describe("P-FENCE 3: a send's claim of a starting prewarm", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const claimOf = (gate: ReturnType<typeof createPrewarmGate>) => (gate as { claim?: (t: string) => Promise<boolean> }).claim?.bind(gate) ?? ((t: string) => gate.wait(t));

  it("W-PR6a': a hung prewarm (MURAGE_PREWARM_WAIT_MS 2 s), send 1.5 s after it started: the claim gives up at prewarm start + 2 s", async () => {
    const saved = process.env.MURAGE_PREWARM_WAIT_MS;
    process.env.MURAGE_PREWARM_WAIT_MS = "2000";
    try {
      const gate = createPrewarmGate();
      const startedAt = Date.now();
      gate.begin("t-hung");
      await sleep(1_500);
      const ready = await claimOf(gate)("t-hung");
      const elapsed = Date.now() - startedAt;
      expect({ ready, early: elapsed < 2_700 }).toEqual({ ready: false, early: true }); // W-PR6a2:bound-from-prewarm
    } finally {
      if (saved === undefined) delete process.env.MURAGE_PREWARM_WAIT_MS; else process.env.MURAGE_PREWARM_WAIT_MS = saved;
    }
  });

  it("W-PR6a'': a live prewarm that needs 5 s, send 1 s after it started: the claim waits for it and takes it (no short bound)", async () => {
    const gate = createPrewarmGate();
    const token = gate.begin("t-slow")!;
    setTimeout(() => gate.end("t-slow", token), 5_000);
    await sleep(1_000);
    const ready = await claimOf(gate)("t-slow");
    expect(ready).toBe(true); // W-PR6a3:waits-for-live
  }, 15_000);
});
