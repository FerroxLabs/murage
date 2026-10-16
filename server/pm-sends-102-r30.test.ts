// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
import { released } from "./testing/released.ts";
// Round 30: each test reproduces an item the r29 fixer left open and fails on 7f28cf52b:
//  1  Fable r28 P3   the process dies between the receipt reaching disk and the final commit: after the restart the reply is in the source conversation,
//                    exactly once (and a second restart does not write it again)
//  3  Fable r28 P3   a freed slot of the bot (a shared run ends while the total cap is full) wakes the teams waiting on the bot directly: at 5,000 waiting
//                    teams the next team starts in the very next pass, with no wake page and no sweep
//  4  Fable r28 P3   the ready row follows its team's CURRENT head: after the head changes it names the new head's conversation, and freeing that
//                    conversation brings the team back
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as delegations from "./delegations.ts";
import { _resetPending, FINALIZER_WRITES, onDelegationReceipt, onOwedHandoffReply, queueDelegation, reconcileStartedDelegations, type DelegationReceipt } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { appendHandoffReply, owedReplyOf, replayOwedReply } from "./handoff-reply.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { completeRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { _resetDrainDiagnostics, drainSharedWork, sharedThreadFreed } from "./shared-work.ts";
import { Store } from "./store.ts";
import { ownerWorld, sharedWorld, type SharedWorld } from "./testing/handoff-worlds.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };
const fresh = () => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); };
const quietly = async <T>(run: () => T | Promise<T>): Promise<T> => { const error = console.error; console.error = () => {}; try { return await run(); } finally { console.error = error; } };

beforeEach(fresh);
afterEach(() => { onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

function senders(w: SharedWorld, n: number) {
  return Array.from({ length: n }, (_, i) => { const bot = w.store.createBot(); w.store.patchBot(bot.id, { name: `S${i}`, section: `Section${i}`, chiefOfStaff: true }); return bot; });
}
const at = (id: string, createdAt: number) => database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(createdAt, id);
const readyRow = (bot: string, team?: string) => database().prepare(`SELECT team, waiting, thread_id AS thread FROM shared_ready_teams WHERE bot_id=?${team ? " AND team=?" : ""} ORDER BY seq`).all(...(team ? [bot, team] : [bot])) as Array<{ team: string; waiting: number; thread: string | null }>;

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. a crash between the receipt and the final commit loses no reply", () => {
  it("the receipt reached disk, the commit never did: the restart's settle writes the reply into the source conversation exactly once", async () => {
    const w = ownerWorld("room");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(roomRequest(database(), id)!.state).toBe("running");
    const owed = owedReplyOf({ ok: true, reply: "The number is 42.", targetName: "Helper", failureName: "", stopped: false });
    // the server's receipt listener (index.ts onDelegationReceipt): the finalizer's own receipt is skipped while it finalizes; any other settle ends the request,
    // writing the reply it still owes in the same transaction
    const finalizing = new Set([id]);
    // (round 31: the line is written by the owed-reply writer before the row goes, whatever the origin; the listener ends the request pointing at it)
    const listen = (store: Parameters<typeof replayOwedReply>[0]) => {
      onOwedHandoffReply((receipt) => finalizing.has(receipt.id) ? FINALIZER_WRITES : replayOwedReply(store, receipt));
      onDelegationReceipt((receipt: DelegationReceipt, delivered) => {
        if (finalizing.has(receipt.id)) return;
        const row = roomRequest(database(), receipt.id);
        if (!row) return;
        const replayed = isTerminalRoomRequestState(row.state) ? null : delivered;
        completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now(), resultMessageId: replayed?.id ?? null });
      });
    };
    listen(w.store);
    const receipt = { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" as const, result: released("The number is 42."), lineage: true, requestId: id, reply: owed };
    // the finalizer (index.ts finalizeDelegationWatch): receipt, row removal, the reply line, the request's end, ONE transaction; the process dies before its commit
    await quietly(() => {
      expect(() => delegations.finishHandoff(receipt, () => {
        appendHandoffReply(w.store, { handoffId: id, sourceThreadId: w.from.threadId, owed, targetBotId: w.target.id, targetName: "Helper", askRequestId: id });
        throw new Error("the process died");
      })).toThrow(/the process died/);
    });
    // restart: a new process (its memory gone), the same disk
    const restart = () => {
      delegations._simulateRestart(); closeDatabase(); delegations._loadPending(); finalizing.clear();
      const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
      const view = { appendMessage: store.appendMessage.bind(store), bot: (botId: string) => w.store.bot(botId), botByThread: (threadId: string) => w.store.botByThread(threadId), groupByThread: () => undefined };
      listen(view as never);
      reconcileStartedDelegations();
      return store;
    };
    const lines = (store: Store) => store.messagesFor(w.from.threadId).filter((message) => (message.text ?? "").includes("The number is 42."));
    const after = restart();
    expect(lines(after)).toHaveLength(1);
    expect(lines(after)[0]!.text).toBe("@Helper replied to the delegated task:\n\nThe number is 42.");
    expect(roomRequest(database(), id)).toMatchObject({ state: "done", resultMessageId: lines(after)[0]!.id });
    expect(database().prepare("SELECT 1 AS x FROM pending_delegations WHERE id=?").get(id)).toBeUndefined();
    const again = restart();
    expect(lines(again)).toHaveLength(1);
  });
  it("the finalizer's commit landed: the receipt no longer owes the line, and a later settle of it writes nothing", async () => {
    const w = ownerWorld("room");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const owed = owedReplyOf({ ok: true, reply: "Done.", targetName: "Helper", failureName: "", stopped: false });
    const finalizing = new Set([id]);
    onDelegationReceipt((receipt) => { if (finalizing.has(receipt.id)) return; });
    onOwedHandoffReply((receipt) => finalizing.has(receipt.id) ? FINALIZER_WRITES : null);
    delegations.finishHandoff({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("Done."), requestId: id, reply: owed }, () => {
      const line = appendHandoffReply(w.store, { handoffId: id, sourceThreadId: w.from.threadId, owed, targetBotId: w.target.id, targetName: "Helper", askRequestId: id });
      completeRequest(database(), id, { state: "done", now: Date.now(), resultMessageId: line.id });
    });
    expect(delegations.findDelegationReceipt(id)?.reply).toBeUndefined();
    expect(w.store.messagesFor(w.from.threadId).filter((message) => message.text?.includes("Done."))).toHaveLength(1);
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────
describe("3. a freed slot wakes the teams waiting on the bot directly", () => {
  it("total cap full, 5,000 teams waiting: one shared run ends, and the very next pass (no wake page, no sweep) starts the oldest waiting team", async () => {
    const w = sharedWorld();
    const [a, b, c] = senders(w, 3);
    const first = w.handoff("A1", a!); at(first.id, 10);
    const second = w.handoff("B1", b!); at(second.id, 20);
    const third = w.handoff("C1", c!); at(third.id, 30);
    drainSharedWork(w.iris.id);
    await ticks(5);
    expect(w.turns.map((turn) => turn.id).sort()).toEqual(["A1", "B1"]);              // two conversations: the bot's total cap is full
    expect(roomRequest(database(), "C1")!.refusal).toBe("shared_total_cap");
    // 4,999 more teams wait behind C (newer places), on the bot as well
    const db = database();
    const hasWaitOn = (db.prepare("PRAGMA table_info(shared_ready_teams)").all() as Array<{ name: string }>).some((column) => column.name === "wait_on");
    const pad = db.prepare(`INSERT INTO shared_ready_teams(bot_id, team, thread_id, seq, waiting${hasWaitOn ? ", wait_on" : ""}) VALUES(?,?,?,?,1${hasWaitOn ? ",'bot'" : ""})`);
    db.exec("BEGIN");
    for (let i = 0; i < 4_999; i++) pad.run(w.iris.id, `Z${String(i).padStart(4, "0")}`, null, 1_000_000 + i);
    db.exec("COMMIT");
    expect((db.prepare("SELECT count(*) AS n FROM shared_ready_teams WHERE bot_id=? AND waiting=1").get(w.iris.id) as { n: number }).n).toBe(5_000);
    completeRequest(db, "A1", { state: "done", now: 11 });                             // A's run ends: one slot of the bot is free
    drainSharedWork(w.iris.id, { continuation: true });                                // the next pass, with no waking of its own
    await ticks(5);
    expect(w.turns.map((turn) => turn.id)).toContain("C1");
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────
describe("4. the ready row follows the team's current head", () => {
  it("the head changes to a request in another conversation: the row names that conversation, and freeing it brings the team back", () => {
    const w = sharedWorld();
    const head = w.handoff("H1"); at(head.id, 10);
    w.handoff("H2"); at("H2", 20);
    const team = readyRow(w.iris.id)[0]!.team;
    // the second request is for another conversation of the bot (its task for the team was replaced)
    database().prepare("UPDATE room_requests SET target_thread_id='thread-Y' WHERE id='H2'").run();
    database().prepare("UPDATE pending_delegations SET target_thread_id='thread-Y' WHERE id='H2'").run();
    expect(readyRow(w.iris.id, team)[0]!.thread).toBe(head.targetThreadId);
    completeRequest(database(), "H1", { state: "cancelled", now: 11 });                 // the head leaves: H2 heads the team now
    expect(readyRow(w.iris.id, team)[0]!.thread).toBe("thread-Y");
    // a pass found it waiting on that conversation (as the drain records it), and the conversation frees
    database().prepare("UPDATE shared_ready_teams SET waiting=1 WHERE bot_id=? AND team=?").run(w.iris.id, team);
    sharedThreadFreed(head.targetThreadId!);                                             // the OLD head's conversation freeing is not this team's event any more
    expect(readyRow(w.iris.id, team)[0]!.waiting).toBe(1);
    sharedThreadFreed("thread-Y");                                                      // the new head's conversation frees: the team is ready again
    expect(readyRow(w.iris.id, team)[0]!.waiting).toBe(0);
  });
});
