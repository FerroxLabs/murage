// Async peer handoff (`delegate_bot`) — pure logic. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { handoffCanStart, type HandoffAdmission } from "./handoff-admission.ts";
import { ownUnsharedWorkCheck } from "./handoff-binding.ts";
import { releaseStoredResult, type ResultEgressDeps } from "./result-egress.ts";
import { MAX_CONCURRENT_BOT_THREADS } from "./independent-thread-runs.ts";
import {
  findDelegationReceipt,
  formatDelegationElapsed,
  summarizeDelegatedActivity,
  MAX_BUSY_ATTEMPTS,
  pendingDelegationInfo,
  pendingDelegationSnapshot,
  queueDelegation,
  recordDelegationReceipt,
  releaseDelegationsWaitingOn,
  threadsWaitingOn,
  discardDelegations,
  dropUnreachableDelegations,
  pendingThreads,
  _loadPending,
  _pendingCount,
  _resetPending,
  _simulateRestart,
  BUSY_RETRY_FALLBACK_MS,
  hasActiveDelegationWork,
  releaseParkedDelegations,
  stopWaitingDelegation,
  dropQueuedDelegation,
  hasPendingBotDelegations,
  unknownTargetBackoffMs,
} from "./delegations.ts";
import { drainDelegations, heldNotices } from "./testing/handoff-turn.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
beforeEach(() => { heldNotices.length = 0; });
import { cancelPeerApprovalsForThread, peerAllowKey, resolvePeerComms } from "./peer-approval.ts";
import { Store, type BotRecord } from "./store.ts";
import { closeDatabase, database } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { queuedDelegationsByThread } from "./pending-delegations-schema.ts";
import { insertRoomRequest, roomRequest } from "./room-requests.ts";
import { botDeletionKey, recordOwnerDeletion } from "./owner-deletions.ts";
import { released } from "./testing/released.ts";
import type { ReleasedActivityRow } from "./delegations.ts";
import { status, outboundWords } from "./murage-status.ts";

/** The queue as the table holds it, in the shape delegations.json had. */
const queueFile = () => Object.fromEntries(Object.entries(queuedDelegationsByThread(database())).map(([thread, rows]) => [thread, rows.filter((row) => row.phase !== "started")]).filter(([, rows]) => (rows as unknown[]).length > 0));
const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

interface BusPair {
  commsBus: CommsBus;
  approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  broadcasts: unknown[];
}

function setupBuses(store: Store): BusPair {
  const broadcasts: unknown[] = [];
  const broadcast = (payload: unknown) => {
    broadcasts.push(payload);
  };
  // the store emits what it writes; the server turns those into frames.
  // Mirror that here so assertions see what a client would.
  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch") {
      broadcasts.push({ kind: change.type, threadId: change.threadId, message: change.message });
    }
  });
  const commsBus: CommsBus = { store, broadcast };
  const approvalBus = { store, broadcast };
  return { commsBus, approvalBus, broadcasts };
}

/** Poll until `predicate` returns a truthy value or `timeout` elapses.
 * drainDelegations is fire-and-forget (processOne runs as a Promise) so
 * tests need to wait for its async steps to land. */
async function waitFor<T>(predicate: () => T | undefined | false, timeout = 2_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("queueDelegation", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let broadcasts: unknown[];

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    broadcasts = buses.broadcasts;
  });

  // B5: in a room several bots share the thread, so the chip names who
  // delegated. A direct chat's chip needs no sender.
  it("a delegation chip queued from a room names the delegating bot", () => {
    const room = store.createGroup("Launch", [from.id, target.id]);
    const result = queueDelegation(commsBus, from, { toBotId: target.id, message: "build it", depth: 0 }, 1, room.threadId);
    expect(result.result).toBe("ok");
    const chip = store.messagesFor(room.threadId).find((m) => m.tool?.name.startsWith("Delegated to @Helper"));
    expect(chip?.from).toEqual({ botId: from.id, name: from.name, color: from.color });
  });

  it("a delegation chip in a direct chat stays without a sender", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "build it", depth: 0 }, 1);
    const chip = store.messagesFor(from.threadId).find((m) => m.tool?.name.startsWith("Delegated to @Helper"));
    expect(chip).toBeDefined();
    expect(chip?.from).toBeUndefined();
  });

  it("rejects a self-delegation without queueing", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: from.id,
      message: "self-talk",
      depth: 0,
    }, 1);
    expect(result.result).toBe("self");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the source turn is already at the depth cap", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "next task",
      depth: 1,
    }, 1);
    expect(result.result).toBe("too_deep");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the target bot does not exist", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: "ghost",
      message: "where?",
      depth: 0,
    }, 1);
    expect(result.result).toBe("no_target");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("queues, broadcasts, and drops a 'Delegated to @Target' chip on the source thread", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "do this",
      reason: "followup",
      depth: 0,
    }, 1);
    expect(result.result).toBe("ok");
    expect(_pendingCount(from.threadId)).toBe(1);

    const chip = store
      .messagesFor(from.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.tool?.name).toBe("Delegated to @Helper: followup");

    // The chip is also broadcast over SSE so chat clients see it without
    // polling /api/bots
    const broadcast = broadcasts.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { kind?: string }).kind === "message" &&
        (b as { threadId?: string }).threadId === from.threadId,
    );
    expect(broadcast).toBeTruthy();
  });

  it("projects routing metadata without exposing the delegated task prompt", () => {
    queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "private customer task details",
      reason: "followup",
      depth: 0,
    }, 1);
    const ownSnapshot = pendingDelegationSnapshot().filter((item) => item.sourceThreadId === from.threadId);
    expect(ownSnapshot).toEqual([
      { sourceThreadId: from.threadId, toBotId: target.id, reason: "followup" },
    ]);
    expect(JSON.stringify(ownSnapshot)).not.toContain("private customer task details");
  });

  it("keys detached routine delegations to their real source thread", async () => {
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    const result = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "routine follow-up", depth: 0 },
      1,
      routineTask.threadId,
    );

    expect(result.result).toBe("ok");
    expect(_pendingCount(routineTask.threadId)).toBe(1);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(from.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(false);
  });
});

describe("drainDelegations", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  let runTargetCalls: Array<{ toBotId: string; message: string; commsDepth: number; sourceThreadId?: string }>;

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
    runTargetCalls = [];
  });

  afterEach(() => {
    // Unresolved approval requests carry a 15-min timer that would otherwise
    // keep vitest's event loop alive long after the suite ends. None of the
    // tests above leave one — they all resolve via resolvePeerComms — but
    // double-check by counting the module's pending map: tests that didn't
    // resolve should be re-examined if this ever fires.
    void runTargetCalls;
  });

  // round 7 legacy rule: a queue a 1.0.1 process wrote, drained by 1.0.2, passes the source conversation to the turn it starts, so the answer is
  // bound to that hand-off and is released; the same answer with no recorded origin is refused to a bot
  it("a 1.0.1-shape queue drained now binds its answer to the hand-off and releases it", async () => {
    // a 1.0.1 queue is read once, when messages.db is opened (pending-delegations-schema.ts importLegacyDelegations, pm-sends): the file must be
    // there before the open, so this test starts from a closed database
    closeDatabase();
    await stopWalMaintenance();
    removeTempDirSync(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
    const legacy = { [from.threadId]: [{ id: "legacy-task-1", toBotId: target.id, message: "do this", depth: 0, attempts: 0, fromBotId: from.id }] };
    writeFileSync(join(DATA_DIR, "delegations.json"), JSON.stringify(legacy));
    _loadPending();
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth, sourceThreadId, _channel, taskId) => {
      runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
      // what the turn engine does with it: the dispatched user message records where the hand-off came from
      const prompt = store.appendMessage(target.threadId, { role: "user", kind: "text", text: message, handoffFrom: sourceThreadId });
      store.appendMessage(target.threadId, { role: "bot", kind: "text", text: "LEGACY ANSWER", parentId: prompt.id });
      void taskId;
    });
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.sourceThreadId).toBe(from.threadId);
    const answer = store.messagesFor(target.threadId).find(m => m.text === "LEGACY ANSWER")!;
    const rowOf = (id: string) => store.messagesFor(target.threadId).find(m => m.id === id);
    const deps: ResultEgressDeps = { message: (_thread, id) => { const m = rowOf(id); return m ? { id: m.id, text: m.text } : undefined; }, authorize: () => ({ ok: true }), copyOriginWithheld: () => false,
      capturedMessageWithheld: () => false, messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true,
      ownUnsharedWork: ownUnsharedWorkCheck({ bot: id => store.bot(id) ?? undefined, isOwnUnsharedThread: () => true, message: (_thread, id) => rowOf(id) as never }), withheldLine: "[withheld]" };
    const origin = { threadId: target.threadId, messageIds: [answer.id] };
    const bound = releaseStoredResult({ origin }, target.id, from.threadId, { fromBotId: from.id }, false, undefined, deps);
    expect(bound.kind).toBe("text");
    // the same kind of answer after a prompt that records no hand-off is refused
    const plainPrompt = store.appendMessage(target.threadId, { role: "user", kind: "text", text: "just chatting" });
    const plainAnswer = store.appendMessage(target.threadId, { role: "bot", kind: "text", text: "UNBOUND ANSWER", parentId: plainPrompt.id });
    const unbound = releaseStoredResult({ origin: { threadId: target.threadId, messageIds: [plainAnswer.id] } }, target.id, from.threadId, { fromBotId: from.id }, false, undefined, deps);
    expect(unbound).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });

  it("runs the target's turn via runTarget and mirrors the exchange", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    const call = runTargetCalls[0]!;
    expect(call.toBotId).toBe(target.id);
    expect(call.commsDepth).toBe(1);
    expect(call.message).toContain("Delegated by @");
    expect(call.message).toContain("do this");

    // Both 1:1 threads picked up their comm chips, attributed to the
    // source/target bot respectively, linking to the same channel.
    const fromChips = store
      .messagesFor(from.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
    expect(fromChips).toHaveLength(1);
    const targetChips = store
      .messagesFor(target.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === `Message from @${from.name}`);
    expect(targetChips).toHaveLength(1);
    expect(fromChips[0]?.comm?.groupId).toBe(targetChips[0]?.comm?.groupId);
  });

  it("includes the reason line in the prefixed message when one is given", async () => {
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", reason: "next step", depth: 0 },
      1,
    );
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.message).toContain("[Reason: next step]");
  });

  it("drains and mirrors a detached routine delegation on its source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "routine follow-up", depth: 0 },
      1,
      routineTask.threadId,
    );

    drainDelegations(
      commsBus,
      approvalBus,
      routineTask.threadId,
      (toBotId, message, commsDepth, sourceThreadId) => {
        runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
      },
    );

    await waitFor(() => runTargetCalls.length === 1 && _pendingCount(routineTask.threadId) === 0);
    expect(_pendingCount(routineTask.threadId)).toBe(0);
    expect(runTargetCalls[0]?.sourceThreadId).toBe(routineTask.threadId);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(false);
  });

  it("contains a rejected delegation worker and reports it on the source thread", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, () => {
      throw new Error("target runner exploded");
    });

    // a start that fails before anything began is a wait, never an end: the handoff stays queued, tries again on its own and says so
    const waiting = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.tool?.name.includes("waiting: it did not start (retry 1/")));
    expect(waiting.delegationWait).toBeDefined();
    expect(_pendingCount(from.threadId)).toBe(1);
    expect(store.messagesFor(from.threadId).some((m) => m.tool?.name.includes("delegation did not finish"))).toBe(false);
  });

  it("reports an asynchronous target-start rejection on a detached source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
      routineTask.threadId,
    );
    drainDelegations(commsBus, approvalBus, routineTask.threadId, () =>
      Promise.reject(new Error("provider disappeared")),
    );

    // the refusal is a wait on the thread the handoff was made in (never on another one), and the handoff is kept
    await waitFor(() => store.messagesFor(routineTask.threadId).find((m) => m.tool?.name.includes("waiting: it did not start")));
    expect(_pendingCount(routineTask.threadId)).toBe(1);
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name.includes("waiting: it did not start")),
    ).toBe(false);
  });

  it("skips runTarget and emits a 'no such bot' chip when the target was deleted", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    store.deleteBot(target.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("no such bot")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("r16: a target missing from the registry WITHOUT a recorded deletion keeps the delegation queued; the recorded deletion settles it", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    const registry = store as unknown as { bots: BotRecord[] };
    const kept = registry.bots;
    registry.bots = kept.filter((bot) => bot.id !== target.id);                   // a registry not loaded yet: no tombstone
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.messagesFor(from.threadId).some((m) => (m.tool?.name ?? "").includes("no such bot"))).toBe(false);
    expect(_pendingCount(from.threadId)).toBe(1);
    recordOwnerDeletion(database(), botDeletionKey(target.id));                    // the owner's deletion, durably recorded
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
    const chip = await waitFor(() => store.messagesFor(from.threadId).find((m) => (m.tool?.name ?? "").includes("no such bot")));
    expect(chip.tool?.ok).toBe(false);
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  describe("r17: a target the registry does not know is parked inactive, stoppable, and retried with backoff", () => {
    beforeEach(() => { _resetPending(); });   // the process-wide queue holds what earlier tests left
    const park = async () => {
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
      const registry = store as unknown as { bots: BotRecord[] };
      const kept = registry.bots;
      registry.bots = kept.filter((bot) => bot.id !== target.id);   // a pre-release deleted target: no tombstone
      drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
      const line = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.delegationWait));
      await waitFor(() => !hasActiveDelegationWork());
      return { queued, registry, kept, line };
    };
    it("is not active work (backups, engine changes), appears as waiting, and Stop works", async () => {
      const { queued, line } = await park();
      expect(hasActiveDelegationWork()).toBe(false);
      expect(hasPendingBotDelegations(from)).toBe(false);
      expect(pendingDelegationSnapshot({ activeOnly: true })).toEqual([]);
      expect(line.delegationWait).toEqual({ id: queued.id });
      expect(line.tool?.name).not.toMatch(/[\u2014]|safe|safety|composio/i);
      expect(_pendingCount(from.threadId)).toBe(1);
      expect(stopWaitingDelegation(commsBus, queued.id!)).toBe(true);
      expect(_pendingCount(from.threadId)).toBe(0);
      expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "cancelled" });
      expect(runTargetCalls).toEqual([]);
    });
    it("other drains inside the wait do not re-look or add lines; the timer retries it once the wait is over, then it runs", async () => {
      const { queued, registry, kept } = await park();
      drainDelegations(commsBus, approvalBus, from.threadId, () => { runTargetCalls.push({ toBotId: "x", message: "x", commsDepth: 0 }); });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.messagesFor(from.threadId).filter((m) => m.delegationWait)).toHaveLength(1);
      expect(releaseParkedDelegations(() => false, Date.now() + 30_000)).toEqual([]);          // inside the first minute: not due
      expect(releaseParkedDelegations(() => false, Date.now() + 61_000)).toEqual([from.threadId]);
      registry.bots = kept;                                                                       // the registry has it now
      drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
      await waitFor(() => runTargetCalls.length === 1);
      expect(runTargetCalls[0]!.toBotId).toBe(target.id);
      void queued;
      await waitFor(() => _pendingCount(from.threadId) === 0);
    });
    it("still unknown at the retry: parks again with a longer wait (1 min, doubling, at most 1 hour) and stays stoppable", async () => {
      const { queued } = await park();
      expect(unknownTargetBackoffMs(0)).toBe(60_000);
      expect(unknownTargetBackoffMs(1)).toBe(120_000);
      expect(unknownTargetBackoffMs(30)).toBe(3_600_000);
      const later = Date.now() + 61_000;
      expect(releaseParkedDelegations(() => false, later)).toEqual([from.threadId]);
      expect(hasActiveDelegationWork()).toBe(false);                                              // due, but still parked until a drain looks
      expect(stopWaitingDelegation(commsBus, "nope")).toBe(false);
      drainDelegations(commsBus, approvalBus, from.threadId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hasActiveDelegationWork()).toBe(false);
      expect(releaseParkedDelegations(() => false, Date.now() + 100_000)).toEqual([]);          // the second wait is 2 minutes
      expect(releaseParkedDelegations(() => false, Date.now() + 121_000)).toEqual([from.threadId]);
      expect(stopWaitingDelegation(commsBus, queued.id!)).toBe(true);
    });
    it("already queued as shared work whose task is not known yet: parked inactive too, and Stop also cancels its room request", async () => {
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
      const db = database();
      const row = insertRoomRequest(db, { id: queued.id!, groupId: "g", verb: "ask", fromKind: "bot", toBotId: target.id, targetThreadId: "task-not-listed", admissionKey: `ask:delegation:${queued.id}`, now: 1,
        lineage: { rootThreadId: from.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
      db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')").run(row.id);   // shared work is recorded as such when it is created
      drainDelegations(commsBus, approvalBus, from.threadId, () => { runTargetCalls.push({ toBotId: "x", message: "x", commsDepth: 0 }); });
      await waitFor(() => store.messagesFor(from.threadId).find((m) => m.delegationWait));
      await waitFor(() => !hasActiveDelegationWork());
      expect(stopWaitingDelegation(commsBus, queued.id!)).toBe(true);
      expect(roomRequest(db, row.id)!.state).toBe("cancelled");
      expect(_pendingCount(from.threadId)).toBe(0);
    });
    describe("r18: a SENDER the registry does not list is parked the same way", () => {
      const parkSender = () => {
        const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
        const registry = store as unknown as { bots: BotRecord[] };
        const kept = registry.bots;
        registry.bots = kept.filter((bot) => bot.id !== from.id);   // a registry not loaded yet: no tombstone for the sender
        drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
        return { queued, registry, kept };
      };
      it("is inactive (backups and engine changes), counts nowhere as running, and Stop works", () => {
        const { queued } = parkSender();
        expect(_pendingCount(from.threadId)).toBe(1);
        expect(hasActiveDelegationWork()).toBe(false);
        expect(hasPendingBotDelegations(from)).toBe(false);
        expect(pendingDelegationSnapshot({ activeOnly: true })).toEqual([]);
        expect(stopWaitingDelegation(commsBus, queued.id!)).toBe(true);
        expect(_pendingCount(from.threadId)).toBe(0);
        expect(runTargetCalls).toEqual([]);
      });
      it("the timer retries it at its persisted time, and it runs once the sender is listed", async () => {
        const { registry, kept } = parkSender();
        expect(releaseParkedDelegations(() => false, Date.now() + 30_000)).toEqual([]);          // inside the first minute: not due
        expect(releaseParkedDelegations(() => false, Date.now() + 61_000)).toEqual([from.threadId]);
        registry.bots = kept;
        drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
        await waitFor(() => runTargetCalls.length === 1);
        await waitFor(() => _pendingCount(from.threadId) === 0);
      });
      it("the sender's recorded deletion makes it due at once and settles it, running nothing", () => {
        parkSender();
        expect(releaseParkedDelegations(() => false, Date.now() + 1_000)).toEqual([]);
        recordOwnerDeletion(database(), botDeletionKey(from.id));
        expect(releaseParkedDelegations(() => false, Date.now() + 1_000)).toEqual([from.threadId]);
        drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => { runTargetCalls.push({ toBotId, message, commsDepth }); });
        expect(_pendingCount(from.threadId)).toBe(0);
        expect(runTargetCalls).toEqual([]);
      });
    });
    it("an interrupted turn on the same thread does not drop it, and it survives a restart still parked", async () => {
      const { queued } = await park();
      discardDelegations(commsBus, from.threadId, from.id);
      expect(_pendingCount(from.threadId)).toBe(1);
      _loadPending();
      expect(hasActiveDelegationWork()).toBe(false);
      expect(stopWaitingDelegation(commsBus, queued.id!)).toBe(true);
    });
  });

  it("drops a queued handoff when section assignment separates the bots before dispatch", async () => {
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
    );
    expect(store.setBotsSection([target.id], "Elsewhere").ok).toBe(true);

    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => findDelegationReceipt(queued.id!) && _pendingCount(from.threadId) === 0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({
      status: "dropped",
      result: expect.stringContaining("different sections"),
    });
    expect(runTargetCalls).toEqual([]);
    expect(
      store.messagesFor(from.threadId).some((message) =>
        message.tool?.name.includes("bots now belong to different sections")),
    ).toBe(true);
  });

  it("keeps the handoff queued with a 'waiting' chip when the target is currently busy", async () => {
    store.patchBot(target.id, { busy: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("waiting: they're busy")),
    );
    expect(chip.tool?.name).toBe("Delegation to @Helper waiting: they're busy (retry 1/3 when they finish)");
    expect(runTargetCalls).toEqual([]);
    // retained for the retry drain the target's settling turn triggers
    expect(_pendingCount(from.threadId)).toBe(1);
  });

  it("asks for approval when approvePeerComms is on, then runs only on allow", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    // the source bot's thread shows the options card BEFORE runTarget fires
    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    expect(card.card?.title).toContain("delegate to @Helper");
    expect(card.card?.tool).toBe("delegate_bot");
    expect(card.card?.allowKey).toBe(peerAllowKey("delegate_bot", target.id));
    expect(card.card?.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(runTargetCalls).toEqual([]);

    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.toBotId).toBe(target.id);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
  });

  it("rechecks sections after a pending human approval before dispatch", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
    );
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((message) => message.card?.requestId),
    );
    expect(store.setBotsSection([target.id], "Elsewhere").ok).toBe(true);
    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");

    await waitFor(() => findDelegationReceipt(queued.id!) && _pendingCount(from.threadId) === 0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  });

  it("does not ask twice when this exact fallback was already approved as ask_bot", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "do this",
      depth: 0,
      approvalAlreadyGranted: true,
    }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]).toMatchObject({ toBotId: target.id, commsDepth: 1 });
    expect(store.messagesFor(from.threadId).some((message) => message.card?.tool === "delegate_bot")).toBe(false);
  });

  it("emits a denial chip and skips runTarget when the user denies", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");

    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("denied by user")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("reports a cancelled approval as cancelled, not denied by the user", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));
    cancelPeerApprovalsForThread(from.threadId);

    await waitFor(() => findDelegationReceipt(queued.id!));
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "cancelled", result: "the approval was cancelled before a decision" });
    const chips = store.messagesFor(from.threadId).filter((m) => m.kind === "activity").map((m) => m.tool?.name ?? "");
    expect(chips.some((name) => name.includes("denied by user"))).toBe(false);
    expect(chips).toContain(`Delegation to @${target.name}: the approval was cancelled before a decision`);
    expect(runTargetCalls).toEqual([]);
  });

  it("auto-allows when alwaysAllow already covers the pair (no card pushed)", async () => {
    store.patchBot(from.id, {
      approvePeerComms: true,
      alwaysAllow: [peerAllowKey("delegate_bot", target.id)],
    });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
    const card = store
      .messagesFor(from.threadId)
      .find((m) => m.card?.requestId && m.card.tool === "delegate_bot");
    expect(card).toBeUndefined();
  });

  it("no-ops when nothing is queued for the source thread", () => {
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });

  it("no-ops when the source thread no longer resolves to a bot", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    store.deleteBot(from.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });
});

/** Raw rows as released rows (the result gate has let every field through). */
function rowsOf(messages: Array<{ at: number; kind: string; text?: string; tool?: { name?: string } }>): ReleasedActivityRow[] {
  const rows: ReleasedActivityRow[] = [];
  for (const message of messages) {
    if (message.kind === "text" && message.text?.trim()) rows.push({ at: message.at, kind: "text", text: released(message.text) });
    else if (message.kind === "activity" && message.tool?.name?.trim()) rows.push({ at: message.at, kind: "activity", tool: released(message.tool.name) });
  }
  return rows;
}

describe("delegations survive a restart", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let buses: BusPair;
  const file = () => join(DATA_DIR, "delegations.json");

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    buses = setupBuses(store);
  });
  afterEach(() => _resetPending());

  it("writes the queue to disk on queue, and clears it on drain and discard", async () => {
    expect(queueDelegation(buses.commsBus, from, {
      toBotId: target.id,
      message: "do this",
      depth: 0,
      approvalAlreadyGranted: true,
    }, 1)).toMatchObject({ result: "ok" });
    expect(_pendingCount(from.threadId)).toBe(1);
    expect(existsSync(file())).toBe(false);   // the queue is rows now, never delegations.json
    const onDisk = queueFile() as Record<string, unknown[]>;
    expect(onDisk[from.threadId]).toHaveLength(1);
    expect(onDisk[from.threadId][0]).toMatchObject({
      toBotId: target.id,
      message: "do this",
      approvalAlreadyGranted: true,
    });

    discardDelegations(buses.commsBus, from.threadId);
    expect(queueFile()[from.threadId]).toBeUndefined();

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "again", depth: 0 }, 1);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(queueFile()[from.threadId]).toBeUndefined();
  });

  it("keeps a handoff durable until its approval and dispatch path settles", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "wait for dispatch", depth: 0 }, 1);
    let release!: () => void;
    const dispatchSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async () => {
      started = true;
      await dispatchSettled;
    });

    await waitFor(() => started);
    expect(pendingThreads()).toEqual([from.threadId]);
    expect(queueFile()[from.threadId]).toHaveLength(1);

    release();
    await waitFor(() => pendingThreads().length === 0);
    expect(queueFile()[from.threadId]).toBeUndefined();
  });

  it("drains work queued by a later settled turn while an earlier handoff is waiting", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "first", depth: 0 }, 1);
    let release!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const runTarget = async (_to: string, message: string) => {
      ran.push(message);
      if (message.includes("first")) await firstSettled;
    };
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    await waitFor(() => ran.length === 1);

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "second", depth: 0 }, 1);
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    expect(ran).toHaveLength(1);

    release();
    await waitFor(() => ran.length === 2 && pendingThreads().length === 0);
    expect(ran[1]).toContain("second");
  });

  it("a fresh process loads what the last one queued, and can drain it", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "left over", depth: 0 }, 1);
    // "restart": forget memory, reload from the table
    _simulateRestart();
    _loadPending();
    expect(pendingThreads()).toEqual([from.threadId]);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(ran[0]).toContain("left over");
    expect(pendingThreads()).toEqual([]);
  });

  it("tolerates a missing or corrupt legacy file: the queue starts empty and the unreadable file is kept as evidence", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    _resetPending();
    _loadPending(); // no file
    expect(pendingThreads()).toEqual([]);
    _resetPending();
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), "{not json");
    _loadPending();
    expect(pendingThreads()).toEqual([]);
    expect(existsSync(file())).toBe(false);
    expect(require("node:fs").readdirSync(join(DATA_DIR, "recovery-quarantine")).some((name: string) => name.startsWith("delegations.unreadable-"))).toBe(true);
  });
});

describe("busy retries and receipts", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
  });

  const chipCount = (needle: string) =>
    store.messagesFor(from.threadId).filter((m) => m.kind === "activity" && m.tool?.name?.includes(needle)).length;

  it("persists the originating event through reload and a busy retry before dispatch", async () => {
    const eventId = "event:trusted-generation_42";
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "event follow-up", depth: 0, eventId }, 1);
    expect(queued.result).toBe("ok");
    const saved = () => queueFile();
    expect(saved()[from.threadId][0].eventId).toBe(eventId);
    _simulateRestart();
    _loadPending();
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("retry 1/") === 1);
    expect(runTarget).not.toHaveBeenCalled();
    expect(saved()[from.threadId][0]).toMatchObject({ eventId, waitingOnBusy: true });
    // Reload the parked item too, then release this exact busy period.
    _simulateRestart();
    _loadPending();
    store.patchBot(target.id, { busy: false });
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(runTarget.mock.calls[0]![6]).toBe(from.id);
    expect(runTarget.mock.calls[0]![7]).toBe(eventId);
  });

  it("keeps the routine ceiling and trigger after the parent ends and the queue reloads", async () => {
    const routineAuthority = { permissionMode: "full" as const, triggerSource: "schedule" as const };
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message: "routine follow-up", depth: 0, routineAuthority }, 1).result).toBe("ok");
    expect(queueFile()[from.threadId][0].routineAuthority).toEqual(routineAuthority);
    _simulateRestart();
    _loadPending();
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(runTarget.mock.calls[0]![12]).toEqual(routineAuthority);
  });

  // Audit final round (Astra H2): a handoff queued by a turn that was not
  // owner audience keeps that mark through a restart.
  // Audit round 5 (Kimi M1): and its unattended mark, so Full access keeps the owner's cards.
  it("keeps a not-owner-audience mark through reload and hands it to the peer's turn", async () => {
    store.patchBot(target.id, { busy: true });
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message: "unproven follow-up", depth: 0, notOwnerAudience: true, unattended: true }, 1).result).toBe("ok");
    expect(queueFile()[from.threadId][0]).toMatchObject({ notOwnerAudience: true, unattended: true });
    _simulateRestart();
    _loadPending();
    store.patchBot(target.id, { busy: false });
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(runTarget.mock.calls[0]![9]).toBe(true);
    expect(runTarget.mock.calls[0]![10]).toBe(true);
  });

  it("rejects malformed persisted event markers instead of dispatching them as ordinary turns", async () => {
    const invalid = [null, "", " ", 42, {}, ["event"], "event with spaces", "x".repeat(129), "event\ninjection"];
    const items = invalid.map((eventId, index) => ({ id: "invalid-" + index, fromBotId: from.id, toBotId: target.id, message: "must not run", depth: 0, attempts: 0, eventId }));
    const legacy = { id: "legacy", fromBotId: from.id, toBotId: target.id, message: "legacy allowed", depth: 0, attempts: 0 };
    writeFileSync(join(DATA_DIR, "delegations.json"), JSON.stringify({ [from.threadId]: [...items, legacy] }));
    _resetPending();   // a clean slate, so the file is imported
    _loadPending();
    expect(_pendingCount(from.threadId)).toBe(1);
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(runTarget.mock.calls[0]![1]).toContain("legacy allowed");
    expect(runTarget.mock.calls[0]![7]).toBeUndefined();
  });

  it("rejects an invalid supplied event identity before queueing", () => {
    expect(() => queueDelegation(commsBus, from, { toBotId: target.id, message: "no", depth: 0, eventId: " " }, 1)).toThrow("Invalid delegation event identity");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("keeps a handoff queued while the target is busy and dispatches on the retry drain", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    expect(queued.result).toBe("ok");
    const taskId = queued.id!;

    const dispatched: unknown[][] = [];
    const runTarget = (...args: unknown[]) => void dispatched.push(args);

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("waiting: they're busy (retry 1/") === 1);
    expect(dispatched).toHaveLength(0);
    expect(_pendingCount(from.threadId)).toBe(1);
    // this is the set a settling target turn re-drains
    expect(threadsWaitingOn(target.id)).toEqual([from.threadId]);
    expect(pendingDelegationInfo(taskId)).toMatchObject({ toBotId: target.id, attempts: 1 });

    store.patchBot(target.id, { busy: false });
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => dispatched.length === 1);
    expect(_pendingCount(from.threadId)).toBe(0);
    // the task id rides into the dispatched turn so the receipt can be keyed
    expect(dispatched[0][5]).toBe(taskId);
    expect(pendingDelegationInfo(taskId)).toBeNull();
  });

  it("gives up after the bounded retries, with a receipt the delegator can read", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const taskId = queued.id!;
    const runTarget = () => undefined;
    for (let round = 1; round < MAX_BUSY_ATTEMPTS; round++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => chipCount(`retry ${round}/`) === 1);
      // One retry is charged per distinct busy period. Releasing the wait
      // models that turn settling before another turn claims the target.
      expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    }
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    // it is held for the owner, never dropped: the line says it was not sent and offers Send again / Dismiss
    expect(heldNotices.map((held) => held.text)).toEqual(["@Helper stayed busy, so this wasn't sent. Send again or dismiss it."]);
    expect(findDelegationReceipt(taskId)).toMatchObject({
      status: "busy_gave_up",
      toBotName: "Helper",
      sourceThreadId: from.threadId,
    });
  });

  it("does not burn busy retries when an unrelated drain is requested", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const taskId = queued.id!;
    const runTarget = vi.fn();

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("retry 1/") === 1);

    // A source-thread redrain can happen while an approval for another
    // item settles. It must not count the same continuously busy turn again.
    for (let index = 0; index < MAX_BUSY_ATTEMPTS + 1; index++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pendingDelegationInfo(taskId)?.attempts).toBe(1);
    expect(chipCount("canceled: still busy after")).toBe(0);

    store.patchBot(target.id, { busy: false });
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
  });

  it("persists receipts across a restart and prunes the drawer by count", () => {
    recordDelegationReceipt({
      id: "task-one",
      sourceThreadId: from.threadId,
      toBotId: target.id,
      toBotName: "Helper",
      status: "done",
      result: released("the reply text"),
    });
    // a fresh process loads what the last one recorded
    _loadPending();
    expect(findDelegationReceipt("task-one")).toMatchObject({ status: "done", result: "the reply text" });

    for (let index = 0; index < 105; index++) {
      recordDelegationReceipt({
        id: `bulk-${index}`,
        sourceThreadId: from.threadId,
        toBotId: target.id,
        toBotName: "Helper",
        status: "done",
      });
    }
    expect(findDelegationReceipt("bulk-104")).toBeTruthy();
    expect(findDelegationReceipt("bulk-3")).toBeNull(); // oldest pruned
  });

  it("keeps the request a receipt answers across a restart, so a replay can re-ask its delivery authorization", () => {
    recordDelegationReceipt({ id: "bound-one", sourceThreadId: from.threadId, toBotId: target.id, toBotName: "Helper", status: "done", result: released("text"), lineage: true, requestId: "req-1" });
    _loadPending();
    expect(findDelegationReceipt("bound-one")?.requestId).toBe("req-1");
    recordDelegationReceipt({ id: "legacy-one", sourceThreadId: from.threadId, toBotId: target.id, toBotName: "Helper", status: "done", result: released("text"), lineage: true });
    _loadPending();
    expect(findDelegationReceipt("legacy-one")?.requestId).toBeUndefined();
  });

  it("writes a dropped receipt for every handoff a failed turn discards", async () => {
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "never runs", depth: 0 }, 1);
    const { discardDelegations } = await import("./delegations.ts");
    discardDelegations(commsBus, from.threadId);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  });

  it("drops, never drains, what a turn queued when Murage halted it at the Ask boundary (ok:true, stopReason ask_stop)", async () => {
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "never runs", depth: 0 }, 1);
    const { settleQueuedDelegations } = await import("./delegations.ts");
    expect(settleQueuedDelegations(commsBus, approvalBus as never, from.threadId, { ok: true, stopReason: "ask_stop" }, from.id)).toBe("discarded");
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  });
});

// ── room-sourced handoffs ─────────────────────────────────────────────
// A room turn is the one place a bot runs at comms depth 0 and therefore
// holds the agents tools, so it is where a Chief actually delegates. The
// queue is keyed by SOURCE THREAD, and a room thread has no owning bot:
// the drain used to resolve its sender with botByThread alone, get null,
// and delete the whole queue — no turn, no receipt, no chip.
describe("delegations queued from a room", () => {
  let store: Store;
  let chief: BotRecord;
  let lead: BotRecord;
  let room: ReturnType<Store["createGroup"]>;
  let buses: BusPair;
  let runTargetCalls: Array<{ toBotId: string; sourceThreadId: string; fromBotId: string }>;

  const runTarget = (
    toBotId: string,
    _message: string,
    _commsDepth: number,
    sourceThreadId: string,
    _channel: unknown,
    _taskId: string,
    fromBotId: string,
  ) => {
    runTargetCalls.push({ toBotId, sourceThreadId, fromBotId });
  };

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    _resetPending();
    store = new Store(selection);
    chief = store.patchBot(store.createBot({ name: "Ember" }).id, { chiefOfStaff: true })!;
    lead = store.patchBot(store.createBot({ name: "Rex" }).id, { name: "Rex" })!;
    room = store.createGroup("Exec", [chief.id, lead.id]);
    buses = setupBuses(store);
    runTargetCalls = [];
  });
  afterEach(() => _resetPending());

  it("delivers a handoff queued on a room thread instead of deleting it", async () => {
    const queued = queueDelegation(
      buses.commsBus,
      chief,
      { toBotId: lead.id, message: "own the launch", depth: 0 },
      1,
      room.threadId,
    );
    expect(queued.result).toBe("ok");
    expect(_pendingCount(room.threadId)).toBe(1);

    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]).toMatchObject({
      toBotId: lead.id,
      sourceThreadId: room.threadId,
      fromBotId: chief.id,
    });
    await waitFor(() => _pendingCount(room.threadId) === 0);
    // the visibility chip lands in the room, not nowhere
    expect(
      store.messagesFor(room.threadId).some((message) => message.tool?.name === `Messaged @Rex`),
    ).toBe(true);
  });

  // 0.1.60 low: in a room several bots hand off, and a failure row with no
  // `from` rendered unattributed, so nobody could tell whose handoff failed.
  it("names the delegating bot on every row it leaves in the room, failures included", async () => {
    expect(queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "own the launch", depth: 0 }, 1, room.threadId).result).toBe("ok");
    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, () => { throw new Error("engine went away"); });
    const failed = await waitFor(() => store.messagesFor(room.threadId).find((m) => m.tool?.name.startsWith("Delegation to @Rex waiting: it did not start")));
    expect(failed.from).toMatchObject({ botId: chief.id, name: "Ember" });
    const queuedRow = store.messagesFor(room.threadId).find((m) => m.tool?.name.startsWith("Delegated to @Rex"));
    expect(queuedRow?.from).toMatchObject({ botId: chief.id });

    expect(queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "again", depth: 0 }, 1, room.threadId).result).toBe("ok");
    discardDelegations(buses.commsBus, room.threadId, chief.id);
    const dropped = store.messagesFor(room.threadId).find((m) => m.tool?.name.includes("queued delegation dropped"));
    expect(dropped?.from).toMatchObject({ botId: chief.id });
  });

  it("leaves a 1:1 thread's rows as they were: the thread is the sender's own", () => {
    expect(queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "x", depth: 0 }, 1, chief.threadId).result).toBe("ok");
    expect(store.messagesFor(chief.threadId).find((m) => m.tool?.name.startsWith("Delegated to @Rex"))?.from).toBeUndefined();
  });

  it("names the sender per item, so two speakers in one room do not cross wires", async () => {
    const other = store.patchBot(store.createBot({ name: "Nia" }).id, { name: "Nia" })!;
    store.patchGroup(room.id, { memberIds: [chief.id, lead.id, other.id] });
    queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "a", depth: 0 }, 4, room.threadId);
    queueDelegation(buses.commsBus, other, { toBotId: lead.id, message: "b", depth: 0 }, 4, room.threadId);

    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);

    await waitFor(() => runTargetCalls.length === 2);
    expect(runTargetCalls.map((call) => call.fromBotId)).toEqual([chief.id, other.id]);
  });

  it("keeps the sender across a restart, because it is persisted with the item", async () => {
    queueDelegation(
      buses.commsBus,
      chief,
      { toBotId: lead.id, message: "own the launch", depth: 0 },
      1,
      room.threadId,
    );
    expect(queueFile()[room.threadId][0])
      .toMatchObject({ fromBotId: chief.id });

    _simulateRestart();
    _loadPending();
    expect(_pendingCount(room.threadId)).toBe(1);
    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.fromBotId).toBe(chief.id);
  });

  // The room copy of a queued message names the turn that queued it, read from the server's turn state when it was queued: the hand-off starts
  // after that turn ended (and here after a restart), when the turn running in the room is another or none.
  it("records the queuing turn from the server's own state, never from the item, and the room copy names it after the turn ended and a restart", async () => {
    let running: string | undefined = "prov-queue";
    const bus = { ...buses.commsBus, turnOf: () => running } as CommsBus;
    expect(queueDelegation(bus, chief, { toBotId: lead.id, message: "own the launch", depth: 0, senderTurnId: "prov-forged" } as never, 1, room.threadId).result).toBe("ok");
    expect(queueFile()[room.threadId][0]).toMatchObject({ senderTurnId: "prov-queue" });
    running = "prov-later";
    _simulateRestart();
    _loadPending();
    expect(queueFile()[room.threadId][0]).toMatchObject({ senderTurnId: "prov-queue" });
    drainDelegations(bus, buses.approvalBus, room.threadId, runTarget);
    await waitFor(() => runTargetCalls.length === 1);
    // the room copy names its source row by copyOf (LINEAGE-DESIGN-S6 rule 6): the Messaged row written when it was queued, as that turn's row
    const copies = store.groups.flatMap((group) => store.messagesFor(group.threadId)).filter((message) => message.text === "own the launch");
    expect(copies).toHaveLength(1);
    const source = store.messagesFor(room.threadId).find((message) => message.id === copies[0]!.copyOf?.messageIds[0]);
    expect(source).toMatchObject({ kind: "activity", turnId: "prov-queue", from: { botId: chief.id } });
  });

  it("a queue row written before its source row was kept loads without one: its room copy is withheld, the hand-off still runs", async () => {
    queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "own the launch", depth: 0 }, 1, room.threadId);
    database().prepare("UPDATE pending_delegations SET item=json_remove(item,'$.senderTurnId','$.sourceMessageId') WHERE source_thread_id=?").run(room.threadId);
    _simulateRestart();
    _loadPending();
    expect(queueFile()[room.threadId][0]).not.toHaveProperty("sourceMessageId");
    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);
    await waitFor(() => runTargetCalls.length === 1);
    expect(store.groups.flatMap((group) => store.messagesFor(group.threadId)).filter((message) => message.text === "own the launch")).toEqual([]);
  });

  it("writes a dropped receipt when the room-sourced sender left the room", async () => {
    // the post-approval re-check used to `return "settled"` with no receipt
    // at all — a silent drop that check_delegation answers forever with
    // "unknown task id".
    // a standing "always allow" for this pair so the approval resolves
    // without a card, but still through the post-approval re-check
    const gated = store.patchBot(chief.id, {
      approvePeerComms: true,
      alwaysAllow: [peerAllowKey("delegate_bot", lead.id)],
    })!;
    const queued = queueDelegation(
      buses.commsBus,
      gated,
      { toBotId: lead.id, message: "own the launch", depth: 0 },
      1,
      room.threadId,
    );
    store.patchGroup(room.id, { memberIds: [lead.id] }); // chief removed from the room

    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);

    await waitFor(() => findDelegationReceipt(queued.id!));
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  });

  it("tells the room when a failed turn discards its queue", async () => {
    queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "x", depth: 0 }, 1, room.threadId);
    const { discardDelegations } = await import("./delegations.ts");
    discardDelegations(buses.commsBus, room.threadId);
    expect(
      store.messagesFor(room.threadId).some((message) =>
        message.tool?.name?.includes("dropped: the turn did not finish")),
    ).toBe(true);
  });

  // A room queue has many senders, and an interruption belongs to one turn.
  // Thread-granular discard made one member hitting Stop cancel another
  // member's handoff, with a receipt blaming "the delegating turn did not
  // finish" about a turn that had finished perfectly well.
  it("does not let one member's interruption cancel another member's parked handoff", async () => {
    const { discardDelegations } = await import("./delegations.ts");
    // Park it the way production parks it: the target is mid-turn, so the
    // drain retries later. It has now outlived the turn that queued it.
    store.patchBot(lead.id, { busy: true });
    const parked = queueDelegation(
      buses.commsBus, chief, { toBotId: lead.id, message: "ember's", depth: 0 }, 1, room.threadId,
    );
    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);
    await waitFor(() =>
      store.messagesFor(room.threadId).find((m) => (m.tool?.name ?? "").includes("waiting: they're busy")));
    expect(_pendingCount(room.threadId)).toBe(1);

    // A different member's turn in the same room is interrupted.
    discardDelegations(buses.commsBus, room.threadId);

    expect(findDelegationReceipt(parked.id!)).toBeNull();
    expect(_pendingCount(room.threadId)).toBe(1);
  });

  it("drops only the interrupted bot's own handoff, not a peer's", async () => {
    const { discardDelegations } = await import("./delegations.ts");
    const chiefs = queueDelegation(
      buses.commsBus, chief, { toBotId: lead.id, message: "chief's", depth: 0 }, 1, room.threadId,
    );
    const leads = queueDelegation(
      buses.commsBus, lead, { toBotId: chief.id, message: "lead's", depth: 0 }, 1, room.threadId,
    );
    expect(_pendingCount(room.threadId)).toBe(2);

    discardDelegations(buses.commsBus, room.threadId, chief.id);

    expect(findDelegationReceipt(chiefs.id!)).toMatchObject({ status: "dropped" });
    expect(findDelegationReceipt(leads.id!)).toBeNull();
    expect(_pendingCount(room.threadId)).toBe(1);
  });

  it("still lets a workspace chief hand off across sections, and still stops a grunt", async () => {
    store.patchBot(chief.id, { chiefScope: "workspace" });
    store.setBotsSection([lead.id], "Sales");
    store.setChiefOfStaff(lead.id);
    const grunt = store.createBot({ name: "Pixel", section: "Sales" });

    const ok = queueDelegation(
      buses.commsBus,
      store.bot(chief.id)!,
      { toBotId: lead.id, message: "own the launch", depth: 0 },
      4,
      room.threadId,
    );
    const blocked = queueDelegation(
      buses.commsBus,
      store.bot(chief.id)!,
      { toBotId: grunt.id, message: "do the pixels", depth: 0 },
      4,
      room.threadId,
    );
    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);

    await waitFor(() => findDelegationReceipt(blocked.id!));
    expect(runTargetCalls.map((call) => call.toBotId)).toEqual([lead.id]);
    expect(findDelegationReceipt(blocked.id!)).toMatchObject({ status: "dropped" });
    expect(findDelegationReceipt(ok.id!)).toBeNull(); // dispatched, not dropped
  });
});


describe("delegated turn status helpers", () => {
  it("formats elapsed time compactly", () => {
    expect(formatDelegationElapsed(5_000)).toBe("5s");
    expect(formatDelegationElapsed(65_000)).toBe("65s");
    expect(formatDelegationElapsed(95_000)).toBe("1m 35s");
    expect(formatDelegationElapsed(180_000)).toBe("3m");
    // a clock that went backwards must not print a negative age
    expect(formatDelegationElapsed(-5_000)).toBe("0s");
  });

  it("summarizeDelegatedActivity keeps only post-dispatch activity, newest last, bounded", () => {
    const messages = [
      { at: 900, kind: "text", text: "before dispatch (the user's ask)" },
      { at: 1_100, kind: "activity", tool: { name: "Delegated to @Helper: followup" } },
      { at: 1_200, kind: "text", text: "peer inbound message" },
      { at: 1_300, kind: "activity", tool: { name: "tool: Bash" } },
      { at: 1_400, kind: "text", text: "  multi  space   reply " },
      { at: 1_500, kind: "activity" },
      { at: 1_600, kind: "unknown-kind" },
    ];
    const lines = summarizeDelegatedActivity(rowsOf(messages), 1_000, 5).map(line => outboundWords(line));
    expect(lines).toEqual([
      "tool: Delegated to @Helper: followup",
      "text: peer inbound message",
      "tool: tool: Bash",
      "text: multi space reply",
    ]);
  });

  it("summarizeDelegatedActivity bounds the list to the newest lines", () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      at: 1_000 + index,
      kind: "activity",
      tool: { name: `step-${index}` },
    }));
    const lines = summarizeDelegatedActivity(rowsOf(messages), 1_000, 3).map(line => outboundWords(line));
    expect(lines).toEqual(["tool: step-6", "tool: step-7", "tool: step-8"]);
  });

  it("summarizeDelegatedActivity spells a host-stop notice as a stop, not a tool run (STOP2)", () => {
    // shared/host-stop.ts: the notice's tool name is "stopped: <reason>";
    // the caller reading the summary must see the stop as the harness
    // presents it everywhere else, never the raw prefix as a "tool:" line.
    const lines = summarizeDelegatedActivity(rowsOf([
      { at: 1_100, kind: "activity", tool: { name: "Bash" } },
      { at: 1_200, kind: "activity", tool: { name: "stopped: the model connection it was using was changed or turned off" } },
    ]), 1_000, 5).map(line => outboundWords(line));
    expect(lines).toEqual([
      "tool: Bash",
      "Stopped: the model connection it was using was changed or turned off",
    ]);
  });

  it("reports nothing at all when the peer has produced nothing since dispatch", () => {
    // The empty list is the signal the proxy renders as "may be stuck", so
    // a pre-dispatch transcript must not leak into it and look like work.
    expect(summarizeDelegatedActivity(
      rowsOf([{ at: 500, kind: "text", text: "the ask" }, { at: 900, kind: "activity", tool: { name: "Bash" } }]),
      1_000,
    )).toEqual([]);
  });
});

// ── spare-thread admission ─────────────────────────────────────────────────
//
// A handoff runs on ONE of the target's threads and the harness admits it on
// three conditions (that thread idle, no room turn on the bot, under the
// three-thread limit). Admission here used to test `bot.busy` instead, which
// is the union over ALL of a bot's threads. So a teammate running a scheduled
// routine in a detached task thread refused handoffs its two free threads
// could have taken — and after MAX_BUSY_ATTEMPTS the handoff was not parked,
// it was CANCELLED, over capacity the teammate had the whole time.

describe("a busy teammate with a free thread", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  let broadcastOnly: CommsBus["broadcast"];

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    approvalBus = buses.approvalBus;
    broadcastOnly = buses.commsBus.broadcast;
    // busy on SOMETHING, which is all `bot.busy` has ever meant
    store.patchBot(target.id, { busy: true });
  });

  /** A bus whose harness answers the admission question directly, the way
   *  server/index.ts's handoffCanStartNow does. */
  const busWith = (canStartHandoff: (botId: string, sourceThreadId: string) => boolean): CommsBus =>
    ({ store, broadcast: broadcastOnly, canStartHandoff });

  const chips = (needle: string) =>
    store.messagesFor(from.threadId).filter((m) => m.kind === "activity" && m.tool?.name?.includes(needle)).length;

  it("takes the handoff now instead of parking it", async () => {
    const bus = busWith(() => true);
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(runTarget.mock.calls[0]![0]).toBe(target.id);
    expect(chips("waiting: they're busy")).toBe(0);
  });

  it("is asked about the thread the handoff would actually run on", async () => {
    const asked: Array<[string, string]> = [];
    const bus = busWith((botId, sourceThreadId) => {
      asked.push([botId, sourceThreadId]);
      return true;
    });
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, vi.fn());
    await waitFor(() => asked.length > 0);
    expect(asked[0]).toEqual([target.id, from.threadId]);
  });

  it("still parks, and still gives up, when that thread really is taken", async () => {
    const bus = busWith(() => false);
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    for (let attempt = 1; attempt <= MAX_BUSY_ATTEMPTS; attempt += 1) {
      releaseDelegationsWaitingOn(target.id);
      drainDelegations(bus, approvalBus, from.threadId, runTarget);
      await waitFor(() => chips("waiting: they're busy") + heldNotices.length === attempt);
    }
    expect(runTarget).not.toHaveBeenCalled();
    expect(heldNotices).toHaveLength(1);
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  // Upstream #1678: a thread settling on a still-busy teammate re-tests the
  // waiting handoffs instead of holding them for whole-bot idle. Only the
  // ones admission would now take are released, so a handoff whose own
  // thread is still taken does not spend a busy retry on someone else's turn.
  it("releases a waiting handoff when a slot frees on a still-busy teammate, and only one admission would take", async () => {
    const bus = busWith(() => false);
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chips("waiting: they're busy") === 1);

    // Its own thread is still taken: nothing is released, no retry is spent.
    expect(releaseDelegationsWaitingOn(target.id, () => false)).toEqual([]);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chips("waiting: they're busy")).toBe(1);
    expect(chips("canceled: still busy after")).toBe(0);

    // The thread it needs frees while the bot stays busy elsewhere.
    const asked: string[] = [];
    const released = releaseDelegationsWaitingOn(target.id, (sourceThreadId) => { asked.push(sourceThreadId); return true; });
    expect(released).toEqual([from.threadId]);
    expect(asked).toEqual([from.threadId]);
    drainDelegations(busWith(() => true), approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(store.bot(target.id)?.busy).toBe(true);
  });

  it("re-checks the same way after a human approval that sat there", async () => {
    // The card can sit for fifteen minutes, so everything checked before it
    // is a stale snapshot. That re-check must use the new rule too, or an
    // approved handoff is refused by the rule the first gate stopped using.
    // The target stays bot-wide busy for the whole test, so a second gate
    // still reading `current.busy` would park the handoff after the allow.
    store.patchBot(from.id, { approvePeerComms: true });
    const bus = busWith(() => true);
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    const card = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));
    expect(runTarget).not.toHaveBeenCalled();
    expect(store.bot(target.id)?.busy).toBe(true);
    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => runTarget.mock.calls.length === 1);
    expect(chips("waiting: they're busy")).toBe(0);
  });

  it("keeps the old bot-wide rule for a bus that cannot answer", async () => {
    // Stricter, never looser: an embedder with no thread bookkeeping — and
    // every older test above — sees exactly the behaviour it saw before.
    const bus: CommsBus = { store, broadcast: broadcastOnly };
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chips("waiting: they're busy") === 1);
    expect(runTarget).not.toHaveBeenCalled();
  });
});

describe("the harness answers that question the way it dispatches", () => {
  // This used to read server/index.ts as TEXT and check that three
  // identifiers appeared inside `handoffCanStartNow`. Three identifiers being
  // present cannot tell a mirrored condition from an inverted one, and cannot
  // see WHICH thread the predicate asks about — which is the half that was
  // wrong before (`bot.busy`, the union over every thread). The predicate now
  // lives in server/handoff-admission.ts and is RUN here, over recorded
  // collaborators. Only the wiring is still read from the source.

  /** The target: one bot, one main thread, one task thread for the human
   *  principal the handoff arrives under. */
  const admission = (over: Partial<HandoffAdmission> = {}): HandoffAdmission & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      bot: () => ({ threadId: "t-main" }),
      handoffThread: () => "t-handoff",
      threadBusy: (_botId, threadId) => {
        asked.push(threadId);
        return false;
      },
      groupTurnActive: () => false,
      runningThreads: () => 0,
      maxThreads: MAX_CONCURRENT_BOT_THREADS,
      ...over,
    };
  };

  // THE DEFECT, run. `bot.busy` was true whenever ANY of the bot's threads was
  // running, so a teammate mid-routine in a detached task thread refused a
  // handoff its handoff thread could have taken.
  it("admits a target that is busy on a DIFFERENT thread", () => {
    const deps = admission({ threadBusy: (_botId, threadId) => threadId === "t-other" });
    expect(handoffCanStart(deps, "target", "t-source")).toBe(true);
  });

  it("refuses a target already running on the thread this handoff would use", () => {
    const deps = admission({ threadBusy: (_botId, threadId) => threadId === "t-handoff" });
    expect(handoffCanStart(deps, "target", "t-source")).toBe(false);
  });

  it("asks about the handoff's own thread, not the bot's main one", () => {
    const deps = admission();
    handoffCanStart(deps, "target", "t-source");
    expect(deps.asked).toEqual(["t-handoff"]);
  });

  it("falls back to the bot's main thread when the principal has no task of its own yet", () => {
    const deps = admission({ handoffThread: () => undefined });
    handoffCanStart(deps, "target", "t-source");
    expect(deps.asked).toEqual(["t-main"]);
  });

  it("refuses a target mid-turn in a room", () => {
    expect(handoffCanStart(admission({ groupTurnActive: () => true }), "target", "t-source")).toBe(false);
  });

  it("refuses at startTurn's concurrent-thread ceiling, and admits one below it", () => {
    expect(handoffCanStart(admission({ runningThreads: () => MAX_CONCURRENT_BOT_THREADS }), "target", "t-source")).toBe(false);
    expect(handoffCanStart(admission({ runningThreads: () => MAX_CONCURRENT_BOT_THREADS - 1 }), "target", "t-source")).toBe(true);
  });

  it("answers 'not now' rather than throwing when the source thread's principal is unreadable", () => {
    const deps = admission({ handoffThread: () => { throw new Error("unreadable principal"); } });
    expect(() => handoffCanStart(deps, "target", "t-source")).not.toThrow();
    expect(handoffCanStart(deps, "target", "t-source")).toBe(false);
  });

  it("refuses a bot the roster no longer has", () => {
    expect(handoffCanStart(admission({ bot: () => null }), "gone", "t-source")).toBe(false);
  });

  // WHAT IS NO LONGER PROVEN, AND WHY IT IS BETTER SAID THAN FAKED.
  //
  // A test used to sit here reading server/index.ts as text and checking that
  // `handoffAdmission` was built from `directThreadBusy`,
  // `activeGroupTurnForBot`, `MAX_CONCURRENT_BOT_THREADS` and the thread
  // `runDelegatedTurn` picks, and that `handoffCanStart` was called with it
  // and put on the comms bus.
  //
  // It ran nothing. It matched text, so it went green on a call that had been
  // commented out, moved into dead code or written differently, and red on a
  // rename that changed nothing. Executing it means importing server/index.ts,
  // which boots a listening server on import, so it cannot be driven from a
  // unit suite without extracting the wiring first.
  //
  // `handoffCanStart` itself is tested thoroughly above, against every
  // collaborator answering every way. That the harness hands it the REAL
  // collaborators, and that the predicate is on the bus at all, is UNPROVEN.
});

describe("dropUnreachableDelegations", () => {
  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    _resetPending();
  });

  it("drops only the handoffs a team change made unreachable, straight away, and says so", async () => {
    const store = new Store(selection);
    const { commsBus } = setupBuses(store);
    const from = store.createBot({ name: "Sender", section: "Ops" });
    const moved = store.createBot({ name: "Moved", section: "Ops" });
    const stays = store.createBot({ name: "Stays", section: "Ops" });
    const gone = queueDelegation(commsBus, from, { toBotId: moved.id, message: "one", depth: 0 }, 2);
    const kept = queueDelegation(commsBus, from, { toBotId: stays.id, message: "two", depth: 0 }, 2);
    expect(store.setBotsSection([moved.id], "Sales").ok).toBe(true);

    expect(await dropUnreachableDelegations(commsBus)).toBe(1);

    expect(findDelegationReceipt(gone.id!)).toMatchObject({ status: "dropped", result: expect.stringContaining("different sections") });
    expect(pendingDelegationInfo(gone.id!)).toBeNull();
    expect(pendingDelegationInfo(kept.id!)).not.toBeNull();
    expect(findDelegationReceipt(kept.id!)).toBeNull();
    expect(store.messagesFor(from.threadId).some((m) => m.tool?.name.includes("Delegation to @Moved canceled"))).toBe(true);
    // Persisted: a restart does not bring the dropped handoff back.
    _loadPending();
    expect(pendingDelegationInfo(gone.id!)).toBeNull();
    expect(pendingDelegationInfo(kept.id!)).not.toBeNull();
    // Nothing else to drop the second time.
    expect(await dropUnreachableDelegations(commsBus)).toBe(0);
  });

  it("keeps sweeping after a pass that found an empty queue (upstream fa0402dbc)", async () => {
    const store = new Store(selection);
    const { commsBus } = setupBuses(store);
    // an empty queue: the sweep reaches no await and settles at once
    expect(await dropUnreachableDelegations(commsBus)).toBe(0);
    const from = store.createBot({ name: "Sender", section: "Ops" });
    const moved = store.createBot({ name: "Moved", section: "Ops" });
    const gone = queueDelegation(commsBus, from, { toBotId: moved.id, message: "one", depth: 0 }, 2);
    expect(store.setBotsSection([moved.id], "Sales").ok).toBe(true);
    // the next roster change sweeps again instead of getting the old settled promise back
    expect(await dropUnreachableDelegations(commsBus)).toBe(1);
    expect(pendingDelegationInfo(gone.id!)).toBeNull();
  });
});

// 0.1.60 Linux re-test 4, L4-1: a handoff parked on a teammate whose room
// turn outlasted its own settle. The teammate's settle released the wait
// while the room still held them, so the retry parked again ("retry 2/3"),
// and no later event ever woke it: the teammate stayed idle, the handoff
// stayed parked, and it counted as running work that held every backup.
describe("a parked handoff whose wake-up already passed", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  let broadcastOnly: CommsBus["broadcast"];
  let canStart: boolean;
  let bus: CommsBus;

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(from.id, { name: "Ember" });
    store.patchBot(target.id, { name: "Maple" });
    const buses = setupBuses(store);
    approvalBus = buses.approvalBus;
    broadcastOnly = buses.commsBus.broadcast;
    canStart = false;
    bus = { store, broadcast: broadcastOnly, canStartHandoff: () => canStart };
  });

  const chips = (needle: string) =>
    store.messagesFor(from.threadId).filter((m) => m.kind === "activity" && m.tool?.name?.includes(needle));

  /** Park the handoff twice, the way the room did: once when Ember's turn
   * settled, once when Maple's room reply settled while the room still
   * held Maple. */
  async function parkTwice(runTarget: Parameters<typeof drainDelegations>[3]): Promise<string> {
    const queued = queueDelegation(bus, from, { toBotId: target.id, message: "run pwd", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chips("retry 1/").length === 1);
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chips("retry 2/").length === 1);
    return queued.id!;
  }

  it("runs once the teammate can take it, with no further settle to wake it", async () => {
    const runTarget = vi.fn();
    await parkTwice(runTarget);
    // The room lets Maple go. No turn of Maple's settles after this.
    canStart = true;
    expect(releaseParkedDelegations((botId, sourceThreadId) => bus.canStartHandoff!(botId, sourceThreadId))).toEqual([from.threadId]);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(chips("canceled").length).toBe(0);
  });

  it("leaves a handoff parked while the teammate still cannot take it and the fallback has not come round", async () => {
    const runTarget = vi.fn();
    const id = await parkTwice(runTarget);
    expect(releaseParkedDelegations(() => false, Date.now() + BUSY_RETRY_FALLBACK_MS - 1_000)).toEqual([]);
    expect(pendingDelegationInfo(id)).toMatchObject({ attempts: 2 });
  });

  it("gives up with a plain line after its attempts when the teammate stays busy, on the timer alone", async () => {
    const runTarget = vi.fn();
    const id = await parkTwice(runTarget);
    // No settle ever comes. The fallback timer spends the last attempt.
    expect(releaseParkedDelegations(() => false, Date.now() + BUSY_RETRY_FALLBACK_MS)).toEqual([from.threadId]);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(runTarget).not.toHaveBeenCalled();
    expect(heldNotices.map((held) => held.text)).toEqual(["@Maple stayed busy, so this wasn't sent. Send again or dismiss it."]);
    expect(findDelegationReceipt(id)).toMatchObject({ status: "busy_gave_up" });
  });

  it("keeps the time it started waiting across a restart, so the fallback still comes round", async () => {
    const runTarget = vi.fn();
    await parkTwice(runTarget);
    _simulateRestart();
    _loadPending();
    expect(releaseParkedDelegations(() => false, Date.now() + BUSY_RETRY_FALLBACK_MS)).toEqual([from.threadId]);
  });

  it("does not count as running work while it only waits, and does again once it is released to run", async () => {
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "run pwd", depth: 0 }, 1);
    // Queued behind its own source turn: that is work in progress.
    expect(hasActiveDelegationWork()).toBe(true);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chips("retry 1/").length === 1);
    // Once the drain that parked it has let go of the thread.
    await waitFor(() => !hasActiveDelegationWork());
    expect(pendingDelegationSnapshot({ activeOnly: true })).toEqual([]);
    expect(pendingDelegationSnapshot()).toHaveLength(1);
    releaseDelegationsWaitingOn(target.id);
    expect(hasActiveDelegationWork()).toBe(true);
  });

  it("offers Stop on the waiting line, and Stop drops the handoff with a receipt and a plain line", async () => {
    const runTarget = vi.fn();
    const id = await parkTwice(runTarget);
    const waiting = chips("waiting: they're busy");
    // Only the newest waiting line offers Stop.
    expect(waiting.map((m) => m.delegationWait?.id)).toEqual([undefined, id]);
    expect(stopWaitingDelegation(bus, id)).toBe(true);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(chips("Delegation to @Maple stopped by you").length).toBe(1);
    expect(findDelegationReceipt(id)).toMatchObject({ status: "cancelled" });
    expect(chips("waiting: they're busy").every((m) => !m.delegationWait)).toBe(true);
    // A later wake-up finds nothing to run.
    canStart = true;
    expect(releaseParkedDelegations(() => true)).toEqual([]);
    expect(stopWaitingDelegation(bus, id)).toBe(false);
  });

  it("clears Stop from the waiting line once the handoff runs", async () => {
    const runTarget = vi.fn();
    await parkTwice(runTarget);
    canStart = true;
    releaseParkedDelegations(() => true);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(chips("waiting: they're busy").every((m) => !m.delegationWait)).toBe(true);
  });

  it("does not stop a handoff that is not waiting", () => {
    const queued = queueDelegation(bus, from, { toBotId: target.id, message: "run pwd", depth: 0 }, 1);
    expect(stopWaitingDelegation(bus, queued.id!)).toBe(false);
    expect(_pendingCount(from.threadId)).toBe(1);
  });

  // lane E1: a handoff whose room request was cancelled is taken out of the
  // queue whatever it waits on, with a cancelled receipt, and never runs
  it("drops a queued handoff that has not started, with a cancelled receipt", () => {
    const queued = queueDelegation(bus, from, { toBotId: target.id, message: "run pwd", depth: 0 }, 1);
    expect(dropQueuedDelegation(bus, queued.id!, status("receipt_cancelled"))).toBe(true);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "cancelled", result: "cancelled" });
    expect(dropQueuedDelegation(bus, queued.id!, status("receipt_cancelled"))).toBe(false);
  });
});
