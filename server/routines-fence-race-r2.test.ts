// FENCE-RACE-1018 r2 (design FENCE-RACE-1018-r2.md, r6): the acceptance-bound channel run, its pre-acceptance buffers, the replay queue
// and the exits of a passed-by turn's rebuild, at the RoutineManager boundary. Written ahead of the implementation: tests that need
// confirmChannelTurn / channelStartOwner / the replay queue fail on the base until FR-BUILD2's code merges. Each name carries its design ref.
// The index.ts ticket itself (take / decideOwedNone, E1-E4 and E11-E14 as desktop events) is covered by the it.todo rows at the end:
// it needs the verification-server fixture of direct-rebuild-hold-late-api.test.ts, which this file does not duplicate.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string;
let cachedPrincipal: ReturnType<typeof resolveHumanBinding> | undefined;
beforeEach(() => {
  cachedPrincipal = undefined;
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  dir = mkdtempSync(join(tmpdir(), "murage-routines-fence-race-r2-"));
});
afterEach(() => { vi.restoreAllMocks(); removeTempDirSync(dir); });

function principal() {
  if (cachedPrincipal) return cachedPrincipal;
  const id = observeVerifiedHuman({ platform: "whatsapp", connectionId: "c", authorityId: "15551230000@s.whatsapp.net", userId: "15557654321@s.whatsapp.net" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" });
  return (cachedPrincipal = resolveHumanBinding(id));
}
const THREAD = "channel-thread";
type Token = { runId: string; seq: number };
type StartTurn = (...args: unknown[]) => Promise<void>;
/** The r2 surface not on the base yet, reached through one cast. */
type R2 = RoutineManager & {
  confirmChannelTurn(token: Token, turnId: string): void;
  passRefusedTurn(token: { runId: string; seq?: number }, turnId: string): void;
  settleDispatch(token: { runId: string; seq?: number }, message: string): void;
};
const r2 = (m: RoutineManager) => m as R2;

/** `awaiting` is index.ts's awaitingHandback (threadId -> token); channelStartOwner reads it, never a direct run's phase (3.2 r4). */
function build(owed: (turnId: string, runId: string) => boolean = () => false) {
  const awaiting = new Map<string, Token>();
  const emitted: string[] = [];
  const startTurn = vi.fn<StartTurn>(async () => {});
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), automaticPaused: () => false, botState: () => "ready",
    createTask: () => ({ threadId: "task-1" }), channelThread: () => ({ threadId: THREAD }),
    startTurn, interruptTurn: async () => {}, isChannelCurrent: () => true, emit: (...a: unknown[]) => { emitted.push(JSON.stringify(a)); },
    memoryRebuildOwed: owed,
    channelStartOwner: (event: { threadId: string }) => awaiting.get(event.threadId),
  } as unknown as ConstructorParameters<typeof RoutineManager>[0]);
  return { manager, startTurn, awaiting, emitted };
}
function enqueue(manager: RoutineManager, id: string) {
  return manager.enqueueWebhook({ webhookId: "whatsapp:c:k", webhookName: "Telegram message", prompt: "hello", botId: "bot", runOn: "ember", deliveryId: id, receivedAt: Date.now(),
    channelOrigin: { platform: "whatsapp", connectionId: "c" }, humanPrincipal: principal() } as Parameters<RoutineManager["enqueueWebhook"]>[0]).id;
}
/** Dispatch a run and mark its handback as pending, as admission does just before sendTurn. */
async function start(h: ReturnType<typeof build>, id: string) {
  const before = h.startTurn.mock.calls.length;
  const runId = enqueue(h.manager, id);
  await vi.waitFor(() => expect(h.startTurn.mock.calls.length).toBe(before + 1), { timeout: 5_000 });
  const args = h.startTurn.mock.calls[before] as unknown[];
  const token: Token = { runId, seq: args[9] as number };
  h.awaiting.set(THREAD, token);
  return { runId, token, onError: args[5] as (m: string) => void };
}
const ev = (type: string, turnId: string, extra: object = {}) => ({ eventId: `${type}-${turnId}-${Math.random()}`, provider: "fake", threadId: THREAD, turnId, createdAt: new Date().toISOString(), type, ...extra }) as never;
const started = (t: string) => ev("turn.started", t);
const said = (t: string, text: string) => ev("item.completed", t, { itemType: "assistant_text", text });
const done = (t: string) => ev("turn.completed", t, { ok: true });
const refused = (t: string) => ev("turn.completed", t, { ok: false, stopReason: "submission_refused" });
const run = (m: RoutineManager, id: string) => m.listRuns().find((r) => r.id === id);
const failedNotices = (h: ReturnType<typeof build>) => h.emitted.filter((e) => e.includes('"status":"failed"')).length;
type Entry = { seq: number; candidates: Map<string, unknown[]>; provenanceLost: boolean };
const entry = (m: RoutineManager, id: string) => (m as unknown as { liveDispatch: Map<string, Entry> }).liveDispatch.get(id)!;
/** The handback: the acceptance callback ends, awaitingHandback clears, then (in production) the replay runs in its own task. */
const accept = (h: ReturnType<typeof build>, token: Token, turnId: string) => { r2(h.manager).confirmChannelTurn(token, turnId); h.awaiting.delete(THREAD); };
const settled = async (m: RoutineManager, id: string, status = "completed") => vi.waitFor(() => expect(run(m, id)?.status).toBe(status), { timeout: 5_000 });
const LOST = "Murage lost track of this reply; send the message again";

describe("3.1 / 3.2 binding is the acceptance", () => {
  it("3.1 an unbound run is not bound by a turn.started inside the pre-id window; confirmChannelTurn binds it", async () => {
    const h = build(); const { runId, token } = await start(h, "b1");
    expect(h.manager.handleRuntimeEvent(started("t1"))).toBeNull();
    expect(run(h.manager, runId)?.channelTurnId).toBeUndefined();
    accept(h, token, "t1");
    expect(run(h.manager, runId)?.channelTurnId).toBe("t1");
  });
  it("3.1 confirmChannelTurn is idempotent for the same turn id and ignores a stale seq", async () => {
    const h = build(); const { runId, token } = await start(h, "b2");
    r2(h.manager).confirmChannelTurn({ runId, seq: token.seq + 99 }, "tX");
    expect(run(h.manager, runId)?.channelTurnId).toBeUndefined();
    accept(h, token, "t1"); r2(h.manager).confirmChannelTurn(token, "t1");
    expect(run(h.manager, runId)?.channelTurnId).toBe("t1");
  });
  it("3.1 rule 3: no buffer for the named turn and nothing lost: bind, replay nothing", async () => {
    const h = build(); const { runId, token } = await start(h, "b3");
    accept(h, token, "t1");
    expect(run(h.manager, runId)?.channelTurnId).toBe("t1");
    expect(entry(h.manager, runId).candidates.size).toBe(0);
    h.manager.handleRuntimeEvent(started("t1")); h.manager.handleRuntimeEvent(said("t1", "ok")); h.manager.handleRuntimeEvent(done("t1"));
    expect(run(h.manager, runId)?.status).toBe("completed");
  });
  it("3.1 the new dispatch clears the binding: T3 of the next dispatch binds after a BUSY requeue (High 4)", async () => {
    const h = build(); const a = await start(h, "b4");
    accept(h, a.token, "t1");
    a.onError("database is locked");
    await h.manager.tick();
    await vi.waitFor(() => expect(h.startTurn.mock.calls.length).toBe(2), { timeout: 5_000 });
    expect(run(h.manager, a.runId)?.channelTurnId).toBeUndefined();
    const seq2 = (h.startTurn.mock.calls[1] as unknown[])[9] as number;
    h.awaiting.set(THREAD, { runId: a.runId, seq: seq2 });
    h.manager.handleRuntimeEvent(started("t3")); h.manager.handleRuntimeEvent(said("t3", "second")); h.manager.handleRuntimeEvent(done("t3"));
    accept(h, { runId: a.runId, seq: seq2 }, "t3");
    await settled(h.manager, a.runId);
    expect(run(h.manager, a.runId)?.output).toBe("second");
  });
  it("3.1 / H3b an owner's desktop turn starting while the run is unbound is never bound (its buffer is dropped at acceptance)", async () => {
    const h = build(); const { runId, token } = await start(h, "b5");
    h.manager.handleRuntimeEvent(started("owner-turn")); h.manager.handleRuntimeEvent(said("owner-turn", "owner's"));
    h.manager.handleRuntimeEvent(started("u1")); h.manager.handleRuntimeEvent(said("u1", "mine")); h.manager.handleRuntimeEvent(done("u1"));
    accept(h, token, "u1");
    await settled(h.manager, runId);
    expect(run(h.manager, runId)?.output).toBe("mine");
    expect(entry(h.manager, runId).candidates.size).toBe(0);
  });
});

describe("3.2 buffering by dispatch", () => {
  it("3.2 r4 a stale terminal before handback does not end the window: U's whole lifecycle is held and replays at acceptance", async () => {
    const h = build(); const { runId, token } = await start(h, "w1");
    h.manager.handleRuntimeEvent(started("stale")); h.manager.handleRuntimeEvent(ev("turn.completed", "stale", { ok: false, stopReason: "crashed" }));
    expect(run(h.manager, runId)?.status).toBe("running");
    h.manager.handleRuntimeEvent(started("u")); h.manager.handleRuntimeEvent(said("u", "U's answer")); h.manager.handleRuntimeEvent(done("u"));
    expect(run(h.manager, runId)?.status).toBe("running");
    expect(entry(h.manager, runId).candidates.has("u")).toBe(true);
    accept(h, token, "u");
    await settled(h.manager, runId);
    expect(run(h.manager, runId)?.output).toBe("U's answer");
    expect(failedNotices(h)).toBe(0);
  });
  it("3.2 r3 one buffer per distinct turn id: a stale start first cannot crowd out the named turn", async () => {
    const h = build(); const { runId, token } = await start(h, "w2");
    h.manager.handleRuntimeEvent(started("stale")); h.manager.handleRuntimeEvent(started("u"));
    expect([...entry(h.manager, runId).candidates.keys()].sort()).toEqual(["stale", "u"]);
    h.manager.handleRuntimeEvent(said("u", "x")); h.manager.handleRuntimeEvent(done("u"));
    accept(h, token, "u");
    await settled(h.manager, runId);
  });
  it("3.2 r3 overflow: a 17th distinct turn id sets provenanceLost; the named turn's missing buffer settles with the stated line", async () => {
    const h = build(); const { runId, token } = await start(h, "w3");
    for (let i = 0; i < 16; i += 1) h.manager.handleRuntimeEvent(started(`stale-${i}`));
    h.manager.handleRuntimeEvent(started("u"));
    expect(entry(h.manager, runId).provenanceLost).toBe(true);
    accept(h, token, "u");
    expect(run(h.manager, runId)?.status).toBe("failed");
    expect(run(h.manager, runId)?.error).toBe(LOST);
    expect(run(h.manager, runId)?.channelTurnId).not.toBe("stale-0");
  });
  it("3.2 r3 overflow: a named buffer past 512 events settles at confirmation instead of replaying a partial stream", async () => {
    const h = build(); const { runId, token } = await start(h, "w4");
    h.manager.handleRuntimeEvent(started("u"));
    for (let i = 0; i < 520; i += 1) h.manager.handleRuntimeEvent(said("u", `part ${i}`));
    h.manager.handleRuntimeEvent(done("u"));
    accept(h, token, "u");
    expect(run(h.manager, runId)?.status).toBe("failed");
    expect(run(h.manager, runId)?.error).toBe(LOST);
  });
  it("3.2 rule 2 (coordinator ruling): a stale buffer's overflow with the named buffer intact binds and replays the named turn; the run stays RUNNING, bound to it", async () => {
    const h = build(); const { runId, token } = await start(h, "w5");
    h.manager.handleRuntimeEvent(started("u")); h.manager.handleRuntimeEvent(said("u", "named answer"));
    h.manager.handleRuntimeEvent(started("stale"));
    for (let i = 0; i < 520; i += 1) h.manager.handleRuntimeEvent(said("stale", `p${i}`));
    expect(entry(h.manager, runId).provenanceLost).toBe(true);
    accept(h, token, "u");
    expect(run(h.manager, runId)?.status).toBe("running");
    expect(run(h.manager, runId)?.channelTurnId).toBe("u");
    expect(run(h.manager, runId)?.error).toBeUndefined();
    h.manager.handleRuntimeEvent(done("u"));
    await settled(h.manager, runId);
    expect(run(h.manager, runId)?.output).toContain("named answer");
  });
  it("3.2 without channelStartOwner wired (bare unit tests) the first fresh start binds, as today", async () => {
    const startTurn = vi.fn<StartTurn>(async () => {});
    const manager = new RoutineManager({ file: join(dir, "routines.json"), automaticPaused: () => false, botState: () => "ready", createTask: () => ({ threadId: "task-1" }),
      channelThread: () => ({ threadId: THREAD }), startTurn, interruptTurn: async () => {}, isChannelCurrent: () => true, emit: () => {} } as unknown as ConstructorParameters<typeof RoutineManager>[0]);
    const id = enqueue(manager, "w6");
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled(), { timeout: 5_000 });
    manager.handleRuntimeEvent(started("t1"));
    expect(run(manager, id)?.channelTurnId).toBe("t1");
  });
});

describe("3.3 registry and eviction (I-B)", () => {
  it("3.3 a turn.started of a refused turn opens no buffer", async () => {
    const h = build(); const { runId } = await start(h, "r1");
    r2(h.manager).passRefusedTurn({ runId }, "t1");
    expect(h.manager.handleRuntimeEvent(started("t1"))).toBeNull();
    expect(entry(h.manager, runId).candidates.has("t1")).toBe(false);
  });
  it("Astra r1 High 2: after 4097 retirements evict T, a pre-id replay of T becomes a candidate but acceptance naming T' binds T' and drops T", async () => {
    const h = build(); const { runId, token } = await start(h, "r2");
    r2(h.manager).passRefusedTurn({ runId: "none" }, "T");
    for (let i = 0; i < 4_096; i += 1) r2(h.manager).passRefusedTurn({ runId: "none" }, `f-${i}`);
    expect(h.manager.hasRefusedTurn("T")).toBe(false);
    h.manager.handleRuntimeEvent(started("T")); h.manager.handleRuntimeEvent(refused("T"));
    h.manager.handleRuntimeEvent(started("Tp")); h.manager.handleRuntimeEvent(said("Tp", "own")); h.manager.handleRuntimeEvent(done("Tp"));
    accept(h, token, "Tp");
    await settled(h.manager, runId);
    expect(run(h.manager, runId)?.output).toBe("own");
  });
  it("3.3 / H3 a deleted run never lets a replacement bind the passed-by turn, with or without the registry (I-B)", async () => {
    const h = build((t) => t === "t1"); const a = await start(h, "r3");
    accept(h, a.token, "t1"); h.manager.handleRuntimeEvent(started("t1")); h.manager.handleRuntimeEvent(refused("t1"));
    h.awaiting.set(THREAD, a.token);
    h.manager.handleRuntimeEvent(started("t2")); h.manager.handleRuntimeEvent(said("t2", "rebuilt")); h.manager.handleRuntimeEvent(done("t2"));
    accept(h, a.token, "t2"); await settled(h.manager, a.runId);
    h.manager.deleteRun(a.runId);
    expect(h.manager.hasRefusedTurn("t1")).toBe(true);
    const b = await start(h, "r3b");
    for (let i = 0; i < 4_096; i += 1) r2(h.manager).passRefusedTurn({ runId: "none" }, `g-${i}`);
    expect(h.manager.hasRefusedTurn("t1")).toBe(false); // registry gone: acceptance alone must still protect R'
    h.manager.handleRuntimeEvent(started("t1")); h.manager.handleRuntimeEvent(refused("t1"));
    h.manager.handleRuntimeEvent(started("t5")); h.manager.handleRuntimeEvent(said("t5", "own")); h.manager.handleRuntimeEvent(done("t5"));
    accept(h, b.token, "t5"); await settled(h.manager, b.runId);
    expect(run(h.manager, b.runId)?.output).toBe("own");
  });
  it("3.3 M deleting a run and retention never prune the registry; 4097 retirements hold 4096", async () => {
    const h = build(); const { runId } = await start(h, "r4");
    r2(h.manager).passRefusedTurn({ runId }, "t1");
    h.manager.cancelRun(runId); h.manager.deleteRun(runId);
    expect(h.manager.hasRefusedTurn("t1")).toBe(true);
    for (let i = 0; i < 4_096; i += 1) r2(h.manager).passRefusedTurn({ runId: "none" }, `h-${i}`);
    expect(h.manager.hasRefusedTurn("t1")).toBe(false);
    expect(h.manager.hasRefusedTurn("h-4095")).toBe(true);
  });
});

describe("3.4 passing a refused turn by", () => {
  it("3.4 candidate drop: passRefusedTurn drops a buffer for that turn; acceptance of the rebuilt turn binds it", async () => {
    const h = build(); const { runId, token } = await start(h, "p1");
    h.manager.handleRuntimeEvent(started("T")); h.manager.handleRuntimeEvent(refused("T"));
    expect(entry(h.manager, runId).candidates.has("T")).toBe(true);
    r2(h.manager).passRefusedTurn(token, "T");
    expect(entry(h.manager, runId).candidates.has("T")).toBe(false);
    expect(h.manager.hasRefusedTurn("T")).toBe(true);
  });
  it("3.4 setup path (E10): a turn bound at acceptance and then refused at setup is released; the rebuilt turn binds at its own acceptance", async () => {
    const h = build(); const { runId, token } = await start(h, "p2");
    accept(h, token, "T");
    r2(h.manager).passRefusedTurn(token, "T");
    expect(run(h.manager, runId)?.channelTurnId).toBeUndefined();
    expect(run(h.manager, runId)?.status).toBe("running");
    h.awaiting.set(THREAD, token);
    h.manager.handleRuntimeEvent(started("U")); h.manager.handleRuntimeEvent(said("U", "rebuilt")); h.manager.handleRuntimeEvent(done("U"));
    accept(h, token, "U"); await settled(h.manager, runId);
  });
  it("3.4 late path: the bound refused terminal is passed by only when the predicate holds, and only a submission refusal", async () => {
    const h = build((t) => t === "T"); const { runId, token } = await start(h, "p3");
    accept(h, token, "T");
    h.manager.handleRuntimeEvent(ev("turn.completed", "T", { ok: false, stopReason: "crashed" }));
    expect(run(h.manager, runId)?.status).toBe("failed");
    const h2 = build(() => false); const b = await start(h2, "p3b");
    accept(h2, b.token, "T"); h2.manager.handleRuntimeEvent(refused("T"));
    expect(run(h2.manager, b.runId)?.status).toBe("failed");
  });
  it("3.4 passRefusedTurn is idempotent and a stale seq retires the id but leaves the run's binding", async () => {
    const h = build(); const { runId, token } = await start(h, "p4");
    accept(h, token, "T");
    r2(h.manager).passRefusedTurn({ runId, seq: token.seq + 5 }, "T");
    expect(h.manager.hasRefusedTurn("T")).toBe(true);
    expect(run(h.manager, runId)?.channelTurnId).toBe("T");
    r2(h.manager).passRefusedTurn(token, "T"); r2(h.manager).passRefusedTurn(token, "T");
    expect(run(h.manager, runId)?.channelTurnId).toBeUndefined();
  });
});

describe("3.2 r4 replay isolated from acceptance", () => {
  it("3.2 r4 confirmChannelTurn never throws into the acceptance callback even when the first replayed event's handling throws", async () => {
    const h = build(); const { runId, token } = await start(h, "i1");
    h.manager.handleRuntimeEvent(started("u")); h.manager.handleRuntimeEvent(said("u", "answer")); h.manager.handleRuntimeEvent(done("u"));
    const real = (h.manager as unknown as { save: (...a: unknown[]) => unknown }).save.bind(h.manager);
    let thrown = 0;
    vi.spyOn(h.manager as unknown as { save: (...a: unknown[]) => unknown }, "save").mockImplementation((...a: unknown[]) => { if (!thrown++) throw new Error("disk full"); return real(...a); });
    expect(() => accept(h, token, "u")).not.toThrow();
    await settled(h.manager, runId);
    expect(run(h.manager, runId)?.output).toBe("answer");
    expect(failedNotices(h)).toBe(0);
  });
  it("3.2 r4 a replay throw retries the same head event with backoff: no event lost, never an acceptance failure", async () => {
    const h = build(); const { runId, token } = await start(h, "i2");
    h.manager.handleRuntimeEvent(started("u"));
    for (let i = 0; i < 3; i += 1) h.manager.handleRuntimeEvent(said("u", `p${i}`));
    h.manager.handleRuntimeEvent(done("u"));
    const real = (h.manager as unknown as { save: (...a: unknown[]) => unknown }).save.bind(h.manager);
    let calls = 0;
    vi.spyOn(h.manager as unknown as { save: (...a: unknown[]) => unknown }, "save").mockImplementation((...a: unknown[]) => { if (calls++ < 3) throw new Error("locked"); return real(...a); });
    accept(h, token, "u");
    await vi.waitFor(() => expect(run(h.manager, runId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(run(h.manager, runId)?.output).toContain("p2");
  });
  it("3.2 r4 live events of the bound turn while the replay queue is non-empty keep their order (answer before terminal)", async () => {
    const h = build(); const { runId, token } = await start(h, "i3");
    h.manager.handleRuntimeEvent(started("u")); h.manager.handleRuntimeEvent(said("u", "first"));
    accept(h, token, "u");
    h.manager.handleRuntimeEvent(said("u", "second")); h.manager.handleRuntimeEvent(done("u"));
    await settled(h.manager, runId);
    expect(run(h.manager, runId)?.output).toContain("second");
  });
});

/** Make the replay of the bound turn back off: every save throws until released. */
function backoff(h: ReturnType<typeof build>) {
  const real = (h.manager as unknown as { save: (...a: unknown[]) => unknown }).save.bind(h.manager);
  let blocked = true;
  vi.spyOn(h.manager as unknown as { save: (...a: unknown[]) => unknown }, "save").mockImplementation((...a: unknown[]) => { if (blocked) throw new Error("database is locked"); return real(...a); });
  return { release: () => { blocked = false; } };
}

describe("3.2 r5/r6 a terminal's pass-by decision is made in its own fold", () => {
  async function toBackedOffQueue(owedSet: Set<string>, id: string) {
    const h = build((t) => owedSet.has(t));
    const s = await start(h, id);
    h.manager.handleRuntimeEvent(started("T")); h.manager.handleRuntimeEvent(said("T", "partial"));
    h.manager.handleRuntimeEvent(started("T")); // buffered, so the replay queue holds several events
    const gate = backoff(h);
    accept(h, s.token, "T"); // replay starts and backs off on the first save fault
    return { h, s, gate };
  }
  it("3.2 r5 backoff, then a late submission_refused, then the fold takes the ticket, then replay: no failure notice, the rebuilt turn binds, the channel settles", async () => {
    const owedSet = new Set(["T"]);
    const { h, s, gate } = await toBackedOffQueue(owedSet, "q1");
    h.manager.handleRuntimeEvent(refused("T"));  // the live fold evaluates the predicate NOW
    owedSet.delete("T");                          // then the fold takes the ticket (owed = false)
    expect(h.manager.hasRefusedTurn("T")).toBe(true);
    expect(run(h.manager, s.runId)?.status).toBe("running");
    expect(run(h.manager, s.runId)?.channelTurnId).toBeUndefined();
    gate.release();
    await new Promise((r) => setTimeout(r, 300)); // replay resumes
    expect(run(h.manager, s.runId)?.status).toBe("running");
    expect(failedNotices(h)).toBe(0);
    h.awaiting.set(THREAD, s.token);              // the rebuild's dispatch
    h.manager.handleRuntimeEvent(started("U")); h.manager.handleRuntimeEvent(said("U", "rebuilt")); h.manager.handleRuntimeEvent(done("U"));
    accept(h, s.token, "U");
    await settled(h.manager, s.runId);
    expect(run(h.manager, s.runId)?.output).toBe("rebuilt");
    expect(failedNotices(h)).toBe(0);
  });
  it("3.2 r6 passBy unbinds synchronously and discards T's queue: U's whole pre-handback lifecycle is buffered, binds at acceptance, its terminal replays, the channel settles, no failure notice", async () => {
    const owedSet = new Set(["T"]);
    const { h, s, gate } = await toBackedOffQueue(owedSet, "q2");
    h.manager.handleRuntimeEvent(refused("T"));
    owedSet.delete("T");
    expect(run(h.manager, s.runId)?.channelTurnId).toBeUndefined();   // unbound before the same fold reaches the ticket
    h.awaiting.set(THREAD, s.token);                                   // rebuild U dispatched
    h.manager.handleRuntimeEvent(started("U"));
    h.manager.handleRuntimeEvent(said("U", "U's answer"));
    h.manager.handleRuntimeEvent(done("U"));                           // success terminal BEFORE handback
    expect(entry(h.manager, s.runId).candidates.has("U")).toBe(true);  // U was buffered
    expect(run(h.manager, s.runId)?.status).toBe("running");
    gate.release();                                                     // T's backed-off replay would resume here
    accept(h, s.token, "U");
    expect(run(h.manager, s.runId)?.channelTurnId).toBe("U");          // U binds
    await settled(h.manager, s.runId);                                  // U's terminal replayed
    expect(run(h.manager, s.runId)?.output).toBe("U's answer");
    expect(failedNotices(h)).toBe(0);
  });
  it("3.2 r5 redelivery, passBy case: a redelivered refused terminal finds T in the registry and is passed by", async () => {
    const owedSet = new Set(["T"]);
    const { h, s, gate } = await toBackedOffQueue(owedSet, "q3");
    h.manager.handleRuntimeEvent(refused("T")); owedSet.delete("T");
    expect(h.manager.handleRuntimeEvent(refused("T"))).toBeNull();
    gate.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(run(h.manager, s.runId)?.status).toBe("running");
    expect(failedNotices(h)).toBe(0);
  });
  it("3.2 r5 redelivery, base case: when the test fails the terminal queues once as decided:base; a redelivery appends nothing, and the run ends failed exactly once", async () => {
    const { h, s, gate } = await toBackedOffQueue(new Set(), "q4");
    const t = refused("T");
    h.manager.handleRuntimeEvent(t);
    h.manager.handleRuntimeEvent(t);   // redelivered fold of the same terminal
    gate.release();
    await settled(h.manager, s.runId, "failed");
    expect(failedNotices(h)).toBe(1);
  });
  it("3.2 r5 non-terminal events of T queue unmarked and replay in order; the marked terminal keeps its position (no event passes it)", async () => {
    const { h, s, gate } = await toBackedOffQueue(new Set(), "q5");
    h.manager.handleRuntimeEvent(said("T", "late text"));
    h.manager.handleRuntimeEvent(done("T"));
    gate.release();
    await settled(h.manager, s.runId);
    expect(run(h.manager, s.runId)?.output).toContain("late text");
  });
  it("3.2 r5 the empty-queue case is the existing late path: handled directly in its own fold", async () => {
    const h = build((t) => t === "T"); const { runId, token } = await start(h, "q6");
    accept(h, token, "T");
    h.manager.handleRuntimeEvent(refused("T"));
    expect(run(h.manager, runId)?.status).toBe("running");
    expect(run(h.manager, runId)?.channelTurnId).toBeUndefined();
    expect(h.manager.hasRefusedTurn("T")).toBe(true);
  });
});

describe("3.5 exits E1-E14: every exit that ends a passed-by run's rebuild without a bound terminal settles the run by token, once", () => {
  const STOPPED = "The run was stopped before it finished";
  async function passedBy() {
    const h = build((t) => t === "T"); const s = await start(h, "e");
    accept(h, s.token, "T"); h.manager.handleRuntimeEvent(refused("T"));
    expect(run(h.manager, s.runId)?.status).toBe("running");
    return { h, ...s };
  }
  it.each([
    ["E1 a newer run owns the thread (fold)"], ["E2 a Stop reached the refused turn"], ["E3 card: tool started / past last rebuild"],
    ["E11 ownership lost during the awaited teardown"], ["E12 retain without a watch / late-close outcome that never releases"],
    ["E13 setup catch, generation no longer owned"], ["E5 rebuild returns false"], ["E6 rebuild start throws before admission"],
    ["E7 rebuilt dispatch's detached setup fails"], ["E8 acceptedTurnCleanupFailed"], ["E14 retain throws before the watch exists"], ["E10 setup-path refusal"],
  ])("%s -> settleDispatch(ticket.routine) ends the live run once, a second call and a stale seq are no-ops", async (_label) => {
    const { h, runId, token } = await passedBy();
    r2(h.manager).settleDispatch({ runId, seq: token.seq + 7 }, "stale");
    expect(run(h.manager, runId)?.status).toBe("running");
    r2(h.manager).settleDispatch(token, STOPPED);
    expect(run(h.manager, runId)?.status).toBe("failed");
    r2(h.manager).settleDispatch(token, "again");
    expect(run(h.manager, runId)?.error).toBe(STOPPED);
    expect(failedNotices(h)).toBe(1);
  });
  it("E4 an owed ticket keeps the run live across ticks (nothing settles it) until a decision arrives", async () => {
    const { h, runId } = await passedBy();
    await h.manager.tick(); await h.manager.tick();
    expect(run(h.manager, runId)?.status).toBe("running");
  });
  it("E4 / H2d a later confirmed close rebuilds: the rebuilt turn binds the same run and it completes, with no failure notice", async () => {
    const { h, runId, token } = await passedBy();
    h.awaiting.set(THREAD, token);
    h.manager.handleRuntimeEvent(started("U")); h.manager.handleRuntimeEvent(said("U", "after the close")); h.manager.handleRuntimeEvent(done("U"));
    accept(h, token, "U"); await settled(h.manager, runId);
    expect(failedNotices(h)).toBe(0);
  });
  it("E9 rebuilt turn refused again: a new passBy; the last (predicate false) fails the run at that terminal and later settles are no-ops", async () => {
    const owed = new Set(["T", "U"]); const h = build((t) => owed.has(t)); const s = await start(h, "e9");
    accept(h, s.token, "T"); h.manager.handleRuntimeEvent(refused("T"));
    h.awaiting.set(THREAD, s.token); accept(h, s.token, "U"); h.manager.handleRuntimeEvent(refused("U"));
    expect(run(h.manager, s.runId)?.status).toBe("running");
    h.awaiting.set(THREAD, s.token); accept(h, s.token, "V"); h.manager.handleRuntimeEvent(refused("V"));
    expect(run(h.manager, s.runId)?.status).toBe("failed");
    r2(h.manager).settleDispatch(s.token, "E3 settle after");
    expect(failedNotices(h)).toBe(1);
  });
  it("E7 / H2a after a save fault rolls every run object back, a late setup failure still fails the LIVE clone", async () => {
    const { h, runId, token } = await passedBy();
    expect(() => (h.manager as unknown as { commitMutation(m: () => void): void }).commitMutation(() => { throw new Error("disk full"); })).toThrow();
    r2(h.manager).settleDispatch(token, "setup failed after the rollback");
    expect(run(h.manager, runId)?.status).toBe("failed");
  });
  it("E13 a run that is not live (terminal before handback released it) is not re-settled", async () => {
    const h = build(); const s = await start(h, "e13");
    h.manager.cancelRun(s.runId);
    r2(h.manager).settleDispatch(s.token, "late");
    expect(run(h.manager, s.runId)?.status).toBe("cancelled");
  });
});

describe("3.2 cleanup of buffers (M)", () => {
  it("M buffers are emptied at binding, by failRun at once, and after a cancel by the next tick; a live unbound run's are kept", async () => {
    const h = build();
    const a = await start(h, "m1"); h.manager.handleRuntimeEvent(started("x")); accept(h, a.token, "y");
    expect(entry(h.manager, a.runId).candidates.size).toBe(0);
    h.manager.handleRuntimeEvent(started("y")); h.manager.handleRuntimeEvent(done("y")); await settled(h.manager, a.runId); // a settles first: b needs the thread
    const b = await start(h, "m2"); h.manager.handleRuntimeEvent(started("x")); r2(h.manager).settleDispatch({ runId: b.runId }, "boom");
    expect(entry(h.manager, b.runId).candidates.size).toBe(0);
    const c = await start(h, "m3"); h.manager.handleRuntimeEvent(started("x")); h.manager.cancelRun(c.runId);
    await h.manager.tick();
    expect(entry(h.manager, c.runId).candidates.size).toBe(0);
    expect(entry(h.manager, c.runId).provenanceLost).toBe(false);
  });
});

// Index-side exits E1-E14 as desktop events: server/routines-fence-race-channel-api.test.ts (verification-server fixture).
