// One dispatch, one verdict. The five ways a hand-off can begin (the owner drain after the sender's turn, the shared drain, the boot redispatch, the idle release,
// Send again) are asked the same questions of the same hand-off under the same condition, and every one of them must give the same answer:
//   a migration hold | each of the three tombstones | a pinned conversation busy while another is idle | a capacity refusal | a submitted turn that was never accepted
// The owner and the shared origin each have the entry points that can reach them (the shared drain cannot reach an owner hand-off, Send again queues an owner one).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import {
  DELETED_NOTE, _drainingCount, _loadPending, _resetPending, _simulateRestart, drainDelegations, findDelegationReceipt, pendingDelegationInfo, pendingThreads, queueDelegation,
  reconcileStartedDelegations, releaseDelegationsWaitingOn, resendHeldDelegation, settleStartedDelegations,
} from "./delegations.ts";
import { admit } from "./handoff-dispatch.ts";
import { _resetOwnerMigration, runOwnerHandoffMigration } from "./pending-delegations-schema.ts";
import { insertRoomRequest, roomRequest } from "./room-requests.ts";
import { drainSharedWork, enqueueSharedWork } from "./shared-work.ts";
import { LINEAGE, ownerWorld, sharedWorld, type OwnerWorld, type SharedWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

type Kind = "owner" | "shared";
type Entry = "owner drain" | "shared drain" | "boot redispatch" | "idle release" | "Send again";
const ENTRIES: Record<Kind, Entry[]> = {
  owner: ["owner drain", "boot redispatch", "idle release", "Send again"],
  shared: ["owner drain", "shared drain", "boot redispatch", "idle release"],
};
type World = OwnerWorld | SharedWorld;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const settle = async (): Promise<void> => { await until(() => _drainingCount() === 0); await tick(); await tick(); };
const rowOf = (id: string) => database().prepare("SELECT phase, started_at FROM pending_delegations WHERE id=?").get(id) as { phase: string; started_at: number | null } | undefined;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

const isShared = (w: World): w is SharedWorld => "iris" in w;
const sourceThread = (w: World): string => isShared(w) ? w.sales.threadId : w.from.threadId;
const targetBot = (w: World): string => isShared(w) ? w.iris.id : w.target.id;
const senderBot = (w: World): string => isShared(w) ? w.sales.id : w.from.id;
const idleSettings = (w: World) => ({ botName: () => "Helper", store: w.store });

/** Where the hand-off will run, as the world's rows say once it is queued. */
function destinationOf(w: World, id: string): string {
  if (isShared(w)) return roomRequest(database(), id)!.targetThreadId!;
  return w.target.threadId;
}

/** What each way of beginning does with the hand-off `id`. */
async function go(w: World, entry: Entry, id: string): Promise<void> {
  const env = { bus: w.bus, approvalBus: w.approvalBus };
  const drain = async () => { for (const thread of pendingThreads()) drainDelegations(w.bus, w.approvalBus, thread); await settle(); };
  switch (entry) {
    case "owner drain": case "Send again":
      drainDelegations(w.bus, w.approvalBus, sourceThread(w));
      await settle();
      return;
    case "shared drain":
      drainSharedWork(targetBot(w));
      await settle();
      return;
    case "boot redispatch":
      if (isShared(w)) w.crash();
      _simulateRestart(); _loadPending(); w.attach();
      await settleStartedDelegations(idleSettings(w));
      await drain();
      return;
    case "idle release": {
      // it waited on a busy teammate; the teammate went idle: the dispatch's own question decides who is woken
      database().prepare("UPDATE pending_delegations SET phase='busy', retry_at=? WHERE id=? AND phase<>'started'").run(Date.now() + 5 * 60_000, id);
      const woke = releaseDelegationsWaitingOn(targetBot(w), (_thread, handoff) => admit(handoff, env, { probe: true }).kind !== "wait");
      for (const thread of woke) drainDelegations(w.bus, w.approvalBus, thread);
      await settle();
      return;
    }
  }
}

/** Queues the hand-off `entry` will be asked about. Send again queues it from a held original, as the owner's click does. */
async function queued(w: World, entry: Entry, options: { pin?: boolean } = {}): Promise<{ id: string; original?: string }> {
  if (isShared(w)) { w.handoff("sh-1"); return { id: "sh-1" }; }
  const original = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it exactly once", depth: 0 }, 2).id!;
  if (options.pin && entry !== "Send again") {
    // attempt 1 wrote its prompt in the target's conversation and was cut short before the provider took it; the restart left it fresh with that prompt
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    _simulateRestart(); _loadPending(); w.attach();
    reconcileStartedDelegations();
    w.turns.splice(0);
    return { id: original };
  }
  if (entry !== "Send again") return { id: original };
  w.knobs.submit.add(original);
  drainDelegations(w.bus, w.approvalBus, w.from.threadId);
  await settle();
  _simulateRestart(); _loadPending(); w.attach();
  reconcileStartedDelegations(idleSettings(w));
  expect(rowOf(original)).toMatchObject({ phase: "started", started_at: null });      // held, waiting for the owner's choice
  const sent = resendHeldDelegation(w.bus, original);
  expect(sent.result).toBe("ok");
  w.turns.splice(0);
  return { id: sent.id!, original };
}

interface Observed { turns: number; row: "queued" | "gone" | "started" | "held"; request: string | undefined; receipt: string | undefined; attemptsSpent: number }
function observe(w: World, id: string): Observed {
  const row = rowOf(id);
  return {
    turns: w.turns.filter((turn) => turn.id === id).length,
    row: !row ? "gone" : row.phase === "started" ? (row.started_at === null ? "held" : "started") : "queued",
    request: isShared(w) || w.bus.prepareDelegation ? roomRequest(database(), id)?.state : undefined,
    receipt: findDelegationReceipt(id)?.status,
    attemptsSpent: pendingDelegationInfo(id)?.attempts ?? 0,
  };
}

describe.each(["owner", "shared"] as Kind[])("%s hand-offs: the same verdict whichever way the dispatch is reached", (kind) => {
  const make = (): World => kind === "owner" ? ownerWorld("owner") : sharedWorld();

  it.each(ENTRIES[kind])("migration hold, reached by %s: nothing is admitted, the row and the request are untouched; after the gate opens it starts exactly once", async (entry) => {
    const w = make();
    const { id } = await queued(w, entry);
    // the clean-up of an earlier build's stand-in record fails: the gate is closed
    insertRoomRequest(database(), { id: "stand-in", groupId: "owner-handoff", verb: "ask", fromKind: "bot", admissionKey: "ask:delegation:stand-in", state: "queued", now: 1, lineage: LINEAGE(sourceThread(w)) });
    database().exec("CREATE TRIGGER rr_nodelete BEFORE DELETE ON room_requests BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(runOwnerHandoffMigration(database())).toBe(false);
    await go(w, entry, id);
    expect(observe(w, id)).toMatchObject({ turns: 0, row: "queued", receipt: undefined, attemptsSpent: 0, ...(isShared(w) ? { request: "queued" } : {}) });
    database().exec("DROP TRIGGER rr_nodelete");
    expect(runOwnerHandoffMigration(database())).toBe(true);                       // the gate opens (in the server the retry timer does this)
    await go(w, entry, id);
    expect(observe(w, id)).toMatchObject({ turns: 1, row: "started" });
  });

  describe.each(["source", "sender", "target"] as const)("the %s tombstone", (which) => {
    it.each(ENTRIES[kind])("reached by %s: cancelled with the deletion wording, never started, its request ended", async (entry) => {
      const w = make();
      const { id } = await queued(w, entry);
      const key = which === "source" ? sourceThread(w) : which === "sender" ? `bot:${senderBot(w)}` : `bot:${targetBot(w)}`;
      database().prepare("INSERT OR IGNORE INTO owner_deleted_threads(thread_id, deleted_at) VALUES(?, 1)").run(key);
      await go(w, entry, id);
      expect(observe(w, id)).toMatchObject({ turns: 0, row: "gone", receipt: "cancelled", ...(isShared(w) ? { request: "cancelled" } : {}) });
      expect(findDelegationReceipt(id)).toMatchObject({ status: "cancelled", result: DELETED_NOTE });
    });
  });

  it.each(ENTRIES[kind])("a conversation that is busy while the others are idle, reached by %s: it waits, kept, and starts in the conversation it is stored for once that is free", async (entry) => {
    const w = make();
    const { id } = await queued(w, entry, { pin: true });
    // owner: its prompt is in the target's own conversation (A) and the selected one is now B (a new Send again resolves B). shared: the work thread.
    const A = destinationOf(w, id);
    const B = "selected-b";
    if (!isShared(w)) w.knobs.destination = B;
    const blocked = !isShared(w) && entry === "Send again" ? B : A;
    w.knobs.busyThreads.add(blocked);
    await go(w, entry, id);
    expect(observe(w, id)).toMatchObject({ turns: 0, row: "queued", receipt: undefined, ...(isShared(w) ? { request: "queued" } : {}) });
    w.knobs.busyThreads.delete(blocked);
    await go(w, entry === "Send again" ? "owner drain" : entry, id);
    expect(observe(w, id)).toMatchObject({ turns: 1, row: "started" });
    expect(w.turns.map((turn) => turn.thread)).toEqual([blocked]);                    // exactly where it was stored (or resolved), never the other one
  });

  it.each(ENTRIES[kind])("a capacity refusal, reached by %s: it waits without spending a busy retry, kept, and starts when there is room", async (entry) => {
    const w = make();
    const { id } = await queued(w, entry);
    let cure: () => void;
    if (isShared(w)) {
      // the team already has a request running for this teammate: its share is taken
      const holder = enqueueSharedWork(w.store, { fromBotId: w.sales.id, sourceThreadId: w.sales.threadId, toBotId: w.iris.id, message: "holds the team's share", admissionKey: "cap-holder", ownerAudience: true, now: 1, id: "cap" });
      if (!holder.ok) throw new Error(holder.code);
      database().prepare("UPDATE room_requests SET state='running', dispatched_at=5 WHERE id='cap'").run();
      cure = () => { database().prepare("UPDATE room_requests SET state='done', finished_at=6 WHERE id='cap'").run(); };
    } else {
      w.knobs.capacity = false;
      cure = () => { w.knobs.capacity = true; };
    }
    await go(w, entry, id);
    expect(observe(w, id)).toMatchObject({ turns: 0, row: "queued", receipt: undefined, attemptsSpent: 0, ...(isShared(w) ? { request: "queued" } : {}) });
    cure();
    await go(w, entry === "Send again" ? "owner drain" : entry, id);
    expect(observe(w, id)).toMatchObject({ turns: 1, row: "started" });
  });

  it.each(ENTRIES[kind])("a turn handed to the provider and never accepted, reached by %s: it is not started a second time", async (entry) => {
    const w = make();
    const id = isShared(w) ? (w.handoff("sh-1"), "sh-1") : queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "once", depth: 0 }, 2).id!;
    w.knobs.submit.add(id);
    // its first start: the prompt is written and the turn is handed to the provider
    if (isShared(w)) drainSharedWork(targetBot(w)); else drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(observe(w, id)).toMatchObject({ turns: 1, row: "started" });
    if (entry === "Send again") {
      _simulateRestart(); _loadPending(); w.attach();
      reconcileStartedDelegations(idleSettings(w));
      if (!isShared(w)) expect(resendHeldDelegation(w.bus, id).result).toBe("ok");      // the owner's choice is a NEW hand-off; the original is gone, not re-run
    } else {
      await go(w, entry, id);
    }
    const after = observe(w, id);
    expect(after.turns).toBe(1);                                                        // no entry point ran it again by itself
    expect(after.row).not.toBe("queued");
    expect(["started", "held", "gone"]).toContain(after.row);
    if (entry === "boot redispatch") expect(after.row).toBe("held");                    // the restart holds it for the owner
  });
});
