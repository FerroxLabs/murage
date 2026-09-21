// Async peer handoff (`delegate_bot`) — pure logic. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { handoffCanStart, type HandoffAdmission } from "./handoff-admission.ts";
import { MAX_CONCURRENT_BOT_THREADS } from "./independent-thread-runs.ts";
import {
  drainDelegations,
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
  pendingThreads,
  _loadPending,
  _pendingCount,
  _resetPending,
} from "./delegations.ts";
import { peerAllowKey, resolvePeerComms } from "./peer-approval.ts";
import { Store, type BotRecord } from "./store.ts";

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
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    broadcasts = buses.broadcasts;
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
    rmSync(DATA_DIR, { recursive: true, force: true });
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

    const failure = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("target runner exploded")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
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

    const failure = await waitFor(() =>
      store
        .messagesFor(routineTask.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("provider disappeared")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name.includes("provider disappeared")),
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
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("waiting — they're busy")),
    );
    expect(chip.tool?.name).toBe("Delegation to @Helper waiting — they're busy (retry 1/3 when they finish)");
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
    expect(runTargetCalls).toEqual([]);
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

describe("delegations survive a restart", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let buses: BusPair;
  const file = () => join(DATA_DIR, "delegations.json");

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
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
    expect(existsSync(file())).toBe(true);
    const onDisk = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown[]>;
    expect(onDisk[from.threadId]).toHaveLength(1);
    expect(onDisk[from.threadId][0]).toMatchObject({
      toBotId: target.id,
      message: "do this",
      approvalAlreadyGranted: true,
    });

    discardDelegations(buses.commsBus, from.threadId);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "again", depth: 0 }, 1);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
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
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toHaveLength(1);

    release();
    await waitFor(() => pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
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
    // "restart": forget memory, reload from disk
    _resetPending();
    expect(pendingThreads()).toEqual([]);
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

  it("tolerates a missing or corrupt file", () => {
    _resetPending();
    _loadPending(); // no file
    expect(pendingThreads()).toEqual([]);
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), "{not json");
    _loadPending();
    expect(pendingThreads()).toEqual([]);
  });
});

describe("busy retries and receipts", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
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
    const saved = () => JSON.parse(readFileSync(join(DATA_DIR, "delegations.json"), "utf8"));
    expect(saved()[from.threadId][0].eventId).toBe(eventId);
    _resetPending();
    _loadPending();
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("retry 1/") === 1);
    expect(runTarget).not.toHaveBeenCalled();
    expect(saved()[from.threadId][0]).toMatchObject({ eventId, waitingOnBusy: true });
    // Reload the parked item too, then release this exact busy period.
    _resetPending();
    _loadPending();
    store.patchBot(target.id, { busy: false });
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(runTarget.mock.calls[0]![6]).toBe(from.id);
    expect(runTarget.mock.calls[0]![7]).toBe(eventId);
  });

  it("rejects malformed persisted event markers instead of dispatching them as ordinary turns", async () => {
    const invalid = [null, "", " ", 42, {}, ["event"], "event with spaces", "x".repeat(129), "event\ninjection"];
    const items = invalid.map((eventId, index) => ({ id: "invalid-" + index, fromBotId: from.id, toBotId: target.id, message: "must not run", depth: 0, attempts: 0, eventId }));
    const legacy = { id: "legacy", fromBotId: from.id, toBotId: target.id, message: "legacy allowed", depth: 0, attempts: 0 };
    writeFileSync(join(DATA_DIR, "delegations.json"), JSON.stringify({ [from.threadId]: [...items, legacy] }));
    _resetPending();
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
    await waitFor(() => chipCount("waiting — they're busy (retry 1/") === 1);
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
    expect(chipCount("canceled — still busy after")).toBe(1);
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
    expect(chipCount("canceled — still busy after")).toBe(0);

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
      result: "the reply text",
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

  it("writes a dropped receipt for every handoff a failed turn discards", async () => {
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "never runs", depth: 0 }, 1);
    const { discardDelegations } = await import("./delegations.ts");
    discardDelegations(commsBus, from.threadId);
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
    rmSync(DATA_DIR, { recursive: true, force: true });
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
    expect(JSON.parse(readFileSync(join(DATA_DIR, "delegations.json"), "utf8"))[room.threadId][0])
      .toMatchObject({ fromBotId: chief.id });

    _resetPending();
    _loadPending();
    expect(_pendingCount(room.threadId)).toBe(1);
    drainDelegations(buses.commsBus, buses.approvalBus, room.threadId, runTarget);
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.fromBotId).toBe(chief.id);
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
    expect(runTargetCalls).toEqual([]);
  });

  it("tells the room when a failed turn discards its queue", async () => {
    queueDelegation(buses.commsBus, chief, { toBotId: lead.id, message: "x", depth: 0 }, 1, room.threadId);
    const { discardDelegations } = await import("./delegations.ts");
    discardDelegations(buses.commsBus, room.threadId);
    expect(
      store.messagesFor(room.threadId).some((message) =>
        message.tool?.name?.includes("dropped — the turn did not finish")),
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
      store.messagesFor(room.threadId).find((m) => (m.tool?.name ?? "").includes("waiting — they're busy")));
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
    const lines = summarizeDelegatedActivity(messages, 1_000, 5);
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
    const lines = summarizeDelegatedActivity(messages, 1_000, 3);
    expect(lines).toEqual(["tool: step-6", "tool: step-7", "tool: step-8"]);
  });

  it("summarizeDelegatedActivity spells a host-stop notice as a stop, not a tool run (STOP2)", () => {
    // shared/host-stop.ts: the notice's tool name is "stopped: <reason>";
    // the caller reading the summary must see the stop as the harness
    // presents it everywhere else, never the raw prefix as a "tool:" line.
    const lines = summarizeDelegatedActivity([
      { at: 1_100, kind: "activity", tool: { name: "Bash" } },
      { at: 1_200, kind: "activity", tool: { name: "stopped: the model connection it was using was changed or turned off" } },
    ], 1_000, 5);
    expect(lines).toEqual([
      "tool: Bash",
      "Stopped — the model connection it was using was changed or turned off",
    ]);
  });

  it("reports nothing at all when the peer has produced nothing since dispatch", () => {
    // The empty list is the signal the proxy renders as "may be stuck", so
    // a pre-dispatch transcript must not leak into it and look like work.
    expect(summarizeDelegatedActivity(
      [{ at: 500, kind: "text", text: "the ask" }, { at: 900, kind: "activity", tool: { name: "Bash" } }],
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
    rmSync(DATA_DIR, { recursive: true, force: true });
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
    expect(chips("waiting — they're busy")).toBe(0);
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
      await waitFor(() => chips("waiting — they're busy") + chips("canceled — still busy after") === attempt);
    }
    expect(runTarget).not.toHaveBeenCalled();
    expect(chips("canceled — still busy after")).toBe(1);
    expect(_pendingCount(from.threadId)).toBe(0);
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
    expect(chips("waiting — they're busy")).toBe(0);
  });

  it("keeps the old bot-wide rule for a bus that cannot answer", async () => {
    // Stricter, never looser: an embedder with no thread bookkeeping — and
    // every older test above — sees exactly the behaviour it saw before.
    const bus: CommsBus = { store, broadcast: broadcastOnly };
    const runTarget = vi.fn();
    queueDelegation(bus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(bus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chips("waiting — they're busy") === 1);
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
