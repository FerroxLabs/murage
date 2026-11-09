// FENCE-RACE-1018 r2: a channel run follows a refused turn whose memory rebuild is owed. The dispatch token (settleDispatch), the
// manager-wide refused-turn registry and the passed-by turn are exercised here at the RoutineManager boundary.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  dir = mkdtempSync(join(tmpdir(), "murage-routines-fence-race-"));
});
afterEach(() => { removeTempDirSync(dir); });

function principal() {
  if (cachedPrincipal) return cachedPrincipal;
  const id = observeVerifiedHuman({ platform: "whatsapp", connectionId: "c", authorityId: "15551230000@s.whatsapp.net", userId: "15557654321@s.whatsapp.net" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" });
  return (cachedPrincipal = resolveHumanBinding(id));
}
const THREAD = "channel-thread";
type StartTurn = (...args: unknown[]) => Promise<void>;
function build(owed: (turnId: string, runId: string) => boolean) {
  const startTurn = vi.fn<StartTurn>(async () => {});
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), automaticPaused: () => false, botState: () => "ready",
    createTask: () => ({ threadId: "task-1" }), channelThread: () => ({ threadId: THREAD }),
    startTurn, interruptTurn: async () => {}, isChannelCurrent: () => true, emit: () => {},
    memoryRebuildOwed: owed,
  } as unknown as ConstructorParameters<typeof RoutineManager>[0]);
  return { manager, startTurn };
}
function enqueue(manager: RoutineManager, id: string) {
  return manager.enqueueWebhook({ webhookId: "whatsapp:c:k", webhookName: "Telegram message", prompt: "hello", botId: "bot", runOn: "ember", deliveryId: id, receivedAt: Date.now(),
    channelOrigin: { platform: "whatsapp", connectionId: "c" }, humanPrincipal: principal() } as Parameters<RoutineManager["enqueueWebhook"]>[0]).id;
}
async function start(manager: RoutineManager, startTurn: ReturnType<typeof vi.fn>, id: string) {
  const before = startTurn.mock.calls.length;
  const runId = enqueue(manager, id);
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBe(before + 1), { timeout: 5_000 });
  return runId;
}
const ev = (type: string, turnId: string, extra: object = {}) => ({ eventId: `${type}-${turnId}`, provider: "fake", threadId: THREAD, turnId, createdAt: new Date().toISOString(), type, ...extra }) as never;
const refused = (turnId: string) => ev("turn.completed", turnId, { ok: false, stopReason: "submission_refused" });
const statusOf = (manager: RoutineManager, id: string) => manager.listRuns().find((r) => r.id === id)?.status;
/** What the scheduler handed startTurn for the n-th dispatch: its failure callback and its token seq. */
const dispatchOf = (startTurn: ReturnType<typeof vi.fn>, n: number) => {
  const args = startTurn.mock.calls[n] as unknown[];
  return { onError: args[5] as (message: string) => void, runId: args[8] as string, seq: args[9] as number };
};
const settle = (manager: RoutineManager, id: string, turnId: string, answer: string) => {
  manager.handleRuntimeEvent(ev("turn.started", turnId));
  manager.handleRuntimeEvent(ev("item.completed", turnId, { itemType: "assistant_text", text: answer }));
  manager.handleRuntimeEvent(ev("turn.completed", turnId, { ok: true }));
  expect(statusOf(manager, id)).toBe("completed");
};

it("a refused turn whose rebuild is owed does not end the run; the rebuilt turn binds and settles it", async () => {
  const { manager, startTurn } = build((turn, run) => turn === "t1" && run !== "");
  const id = await start(manager, startTurn, "d1");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  expect(manager.handleRuntimeEvent(refused("t1"))).toBeNull();
  expect(statusOf(manager, id)).toBe("running");
  settle(manager, id, "t2", "the answer");
  expect(manager.listRuns().find((r) => r.id === id)?.output).toBe("the answer");
});

it("the predicate is asked with the run's own id", async () => {
  const asked: Array<[string, string]> = [];
  const { manager, startTurn } = build((turn, run) => { asked.push([turn, run]); return true; });
  const id = await start(manager, startTurn, "d1b");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  expect(asked).toEqual([["t1", id]]);
});

it("mutant: without a rebuild owed, the refusal fails the run as before", async () => {
  const { manager, startTurn } = build(() => false);
  const id = await start(manager, startTurn, "d2");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  expect(statusOf(manager, id)).toBe("failed");
  expect(manager.hasRefusedTurn("t1")).toBe(false);
});

it("only a submission refusal is passed by: another failed end still fails the run", async () => {
  const { manager, startTurn } = build(() => true);
  const id = await start(manager, startTurn, "d3");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(ev("turn.completed", "t1", { ok: false, stopReason: "crashed" }));
  expect(statusOf(manager, id)).toBe("failed");
});

it("replays of the passed-by turn (its start, its end) never bind or settle the run", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const id = await start(manager, startTurn, "d4");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  expect(manager.handleRuntimeEvent(ev("turn.started", "t1"))).toBeNull();
  expect(manager.handleRuntimeEvent(refused("t1"))).toBeNull();
  expect(manager.handleRuntimeEvent(ev("turn.completed", "t1", { ok: true }))).toBeNull();
  expect(statusOf(manager, id)).toBe("running");
  manager.handleRuntimeEvent(ev("turn.started", "t2"));
  expect(manager.handleRuntimeEvent(ev("turn.completed", "t1", { ok: false, stopReason: "crashed" }))).toBeNull();
  expect(statusOf(manager, id)).toBe("running");
  manager.handleRuntimeEvent(ev("turn.completed", "t2", { ok: true }));
  expect(statusOf(manager, id)).toBe("completed");
});

it("repeated rebuilds: each refused turn is passed by, the last end (no rebuild owed) settles", async () => {
  const { manager, startTurn } = build((turn) => turn !== "t3");
  const id = await start(manager, startTurn, "d5");
  for (const t of ["t1", "t2"]) { manager.handleRuntimeEvent(ev("turn.started", t)); manager.handleRuntimeEvent(refused(t)); expect(statusOf(manager, id)).toBe("running"); }
  manager.handleRuntimeEvent(ev("turn.started", "t3"));
  manager.handleRuntimeEvent(refused("t3"));
  expect(statusOf(manager, id)).toBe("failed");
});

it("a successful last resort: the final rebuilt turn completes the run", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1" || turn === "t2");
  const id = await start(manager, startTurn, "d5b");
  for (const t of ["t1", "t2"]) { manager.handleRuntimeEvent(ev("turn.started", t)); manager.handleRuntimeEvent(refused(t)); }
  settle(manager, id, "t3", "last resort");
});

it("settleDispatch fails exactly the run it names, never one that took the thread since, and is idempotent", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const id = await start(manager, startTurn, "d6");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  manager.settleDispatch({ runId: "not-this-run" }, "x");
  expect(statusOf(manager, id)).toBe("running");
  manager.settleDispatch({ runId: id }, "The run was stopped before it finished");
  expect(statusOf(manager, id)).toBe("failed");
  manager.settleDispatch({ runId: id }, "again");
  expect(manager.listRuns().find((r) => r.id === id)?.error).toBe("The run was stopped before it finished");
});

it("a replacement run on the same thread never binds or is settled by the passed-by turn's replays or a stale callback", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const a = await start(manager, startTurn, "d7");
  const dispatchA = dispatchOf(startTurn, 0);
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  manager.settleDispatch({ runId: a, seq: dispatchA.seq }, "The run was stopped before it finished");
  expect(statusOf(manager, a)).toBe("failed");
  const b = await start(manager, startTurn, "d7b");
  expect(manager.handleRuntimeEvent(ev("turn.started", "t1"))).toBeNull();
  expect(manager.handleRuntimeEvent(ev("turn.completed", "t1", { ok: false, stopReason: "crashed" }))).toBeNull();
  dispatchA.onError("late callback of the first run");
  expect(statusOf(manager, b)).toBe("running");
  settle(manager, b, "t9", "b's own answer");
});

it("H2a: a rolled-back save replaces every run object; a late dispatch error still fails the LIVE run", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const id = await start(manager, startTurn, "h2a");
  const dispatch = dispatchOf(startTurn, 0);
  const before = manager.listRuns().find((r) => r.id === id);
  expect(() => (manager as unknown as { commitMutation(m: () => void): void }).commitMutation(() => { throw new Error("disk full"); })).toThrow("disk full");
  // the manager's run object is a different object now (a clone), and the run is still live
  expect((manager as unknown as { runs: unknown[] }).runs.some((r) => r === before)).toBe(false);
  expect(statusOf(manager, id)).toBe("running");
  dispatch.onError("setup failed after the rollback");
  expect(statusOf(manager, id)).toBe("failed");
  expect(manager.listRuns().find((r) => r.id === id)?.error).toContain("setup failed after the rollback");
});

it("H2b: a late real error of dispatch #1 never ends run #2 (the run was requeued BUSY and dispatched again)", async () => {
  const { manager, startTurn } = build(() => false);
  const id = await start(manager, startTurn, "h2b");
  const first = dispatchOf(startTurn, 0);
  first.onError("database is locked");
  expect(statusOf(manager, id)).toBe("queued");
  await manager.tick();
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBe(2), { timeout: 5_000 });
  const second = dispatchOf(startTurn, 1);
  expect(second.seq).toBeGreaterThan(first.seq);
  expect(second.runId).toBe(id);
  first.onError("a late real error from dispatch one");
  expect(statusOf(manager, id)).toBe("running");
  // the live dispatch still settles it
  second.onError("dispatch two failed");
  expect(statusOf(manager, id)).toBe("failed");
});

it("H3 deletion: a run record gone (deleted) never lets a replacement bind the passed-by turn, in its pre-id window or after", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const r = await start(manager, startTurn, "h3");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  settle(manager, r, "t2", "rebuilt");
  expect(manager.deleteRun(r)?.id).toBe(r);
  expect(manager.hasRefusedTurn("t1")).toBe(true);
  const r2 = await start(manager, startTurn, "h3b");
  for (let round = 0; round < 2; round += 1) {
    expect(manager.handleRuntimeEvent(ev("turn.started", "t1"))).toBeNull();
    expect(manager.handleRuntimeEvent(refused("t1"))).toBeNull();
  }
  expect(statusOf(manager, r2)).toBe("running");
  expect(manager.listRuns().find((x) => x.id === r2)?.channelTurnId).toBeUndefined();
  settle(manager, r2, "t5", "own turn");
  for (let round = 0; round < 2; round += 1) {
    expect(manager.handleRuntimeEvent(ev("turn.started", "t1"))).toBeNull();
    expect(manager.handleRuntimeEvent(refused("t1"))).toBeNull();
  }
});

it("M: deleteRun drops the run's dispatch entry; the refused-turn registry is not pruned and holds 4096 turns", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const r = await start(manager, startTurn, "m1");
  expect(manager.liveDispatchRunIds()).toContain(r);
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  settle(manager, r, "t2", "rebuilt");
  expect(manager.liveDispatchRunIds()).toContain(r);
  manager.deleteRun(r);
  expect(manager.liveDispatchRunIds()).not.toContain(r);
  expect(manager.hasRefusedTurn("t1")).toBe(true);
  for (let i = 0; i < 4_096; i += 1) manager.passRefusedTurn({ runId: "none" }, `fill-${i}`);
  // t1 was the oldest of 4097 retirements: only it fell out
  expect(manager.hasRefusedTurn("t1")).toBe(false);
  expect(manager.hasRefusedTurn("fill-0")).toBe(true);
  expect(manager.hasRefusedTurn("fill-4095")).toBe(true);
});

it("M: retention eviction past the run cap drops the evicted run's dispatch entry; the registry keeps the turn", async () => {
  const { manager, startTurn } = build((turn) => turn === "t1");
  const r = await start(manager, startTurn, "m2");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  manager.handleRuntimeEvent(refused("t1"));
  settle(manager, r, "t2", "rebuilt");
  expect(manager.liveDispatchRunIds()).toContain(r);
  const m = manager as unknown as { runsRaw: Array<Record<string, unknown>>; saveNow(): void };
  // r is the oldest settled run; 2000 settled runs behind it push it past the cap of 2000 on the next save
  const template = m.runsRaw.find((x) => x.id === r)!;
  m.runsRaw.push(...Array.from({ length: 2_000 }, (_, i) => ({ ...template, id: `filler-${i}`, channelTurnId: undefined })));
  m.saveNow();
  expect(manager.listRuns().some((x) => x.id === r)).toBe(false);
  expect(manager.liveDispatchRunIds()).not.toContain(r);
  expect(manager.hasRefusedTurn("t1")).toBe(true);
});

it("a new dispatch starts unbound: a turn bound by an aborted dispatch never blocks the next dispatch's turn (High 4)", async () => {
  const { manager, startTurn } = build(() => false);
  const id = await start(manager, startTurn, "h4");
  manager.handleRuntimeEvent(ev("turn.started", "t1"));
  expect(manager.listRuns().find((r) => r.id === id)?.channelTurnId).toBe("t1");
  dispatchOf(startTurn, 0).onError("database is locked");
  expect(statusOf(manager, id)).toBe("queued");
  await manager.tick();
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBe(2), { timeout: 5_000 });
  expect(manager.listRuns().find((r) => r.id === id)?.channelTurnId).toBeUndefined();
  settle(manager, id, "t2", "second dispatch's turn");
});

type Entry = { seq: number; candidates: Map<string, unknown[]>; provenanceLost: boolean };
const entryOf = (manager: RoutineManager, id: string) => (manager as unknown as { liveDispatch: Map<string, Entry> }).liveDispatch.get(id)!;
const fill = (manager: RoutineManager, id: string) => { const e = entryOf(manager, id); e.candidates.set("stale", [{}]); e.provenanceLost = true; };

it("buffers live inside the dispatch entry and are emptied by a terminal, by failRun, and by the tick sweep after a cancel", async () => {
  const { manager, startTurn } = build(() => false);
  const a = await start(manager, startTurn, "c1");
  fill(manager, a);
  settle(manager, a, "ta", "done");
  expect(entryOf(manager, a).candidates.size).toBe(0);
  expect(entryOf(manager, a).provenanceLost).toBe(false);
  const b = await start(manager, startTurn, "c2");
  fill(manager, b);
  manager.settleDispatch({ runId: b }, "boom");
  expect(entryOf(manager, b).candidates.size).toBe(0);
  const c = await start(manager, startTurn, "c3");
  fill(manager, c);
  manager.cancelRun(c);
  expect(statusOf(manager, c)).toBe("cancelled");
  await manager.tick();
  expect(entryOf(manager, c).candidates.size).toBe(0);
  expect(entryOf(manager, c).provenanceLost).toBe(false);
  // a live run's buffers are not swept
  const d = await start(manager, startTurn, "c4");
  fill(manager, d);
  await manager.tick();
  expect(entryOf(manager, d).candidates.size).toBe(1);
});
