// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CANCEL-TREE-104 D4 (CANCEL-TREE-DESIGN-OPUS.md section 10): the two start sites that had no ended-ancestor guard, the hand-off dispatch's
// decide() and the card executor's pump(), with the rows 1.0.3 left open (its cancel closed only ask children, its failure closed nothing)
// that the 1.0.4 boot does not sweep. Each queued row here exists only to serve a request that already ended: it must never start.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _resetPending, findDelegationReceipt, onDelegationReceipt, queueDelegation } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { projectCardById } from "./project-records.ts";
import { applyCardRunEffect, cardGenerationCurrent } from "./project-turn-engine.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { createProjectCardExecutor } from "./project-card-executor.ts";
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { ownerWorld, sharedWorld, type SharedWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

describe("D4 decide(): a queued plain hand-off whose room request's asker ended", () => {
  const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); };
  // the server's receipt listener (index.ts onDelegationReceipt): a hand-off's receipt ends its room request
  beforeEach(() => {
    fresh();
    onDelegationReceipt((receipt) => {
      const row = roomRequest(database(), receipt.id);
      if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : "cancelled", now: Date.now() });
    });
  });
  afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

  for (const ended of ["cancelled", "failed"] as const) {
    it(`asker ${ended} (1.0.3 left the ask queued): never started, request cancelled, one cancelled receipt, row gone`, async () => {
      const w = ownerWorld("room");
      const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
      expect(roomRequest(database(), id)).toMatchObject({ verb: "ask", parentId: "root", state: "queued" });
      database().prepare("UPDATE room_requests SET state=?, finished_at=5 WHERE id='root'").run(ended);
      await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
      expect(w.turns.map((turn) => turn.id)).not.toContain(id);
      expect(roomRequest(database(), id)!.state).toBe("cancelled");
      expect(findDelegationReceipt(id)?.status).toBe("cancelled");
      expect(database().prepare("SELECT 1 FROM pending_delegations WHERE id=?").get(id)).toBeUndefined();
    });
  }

  it("guard: the same hand-off under an open asker starts", async () => {
    const w = ownerWorld("room");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(w.turns.map((turn) => turn.id)).toContain(id);
  });
});

describe("D4 pump(): a queued card continuation wake whose card run ended", () => {
  const databases: DatabaseSync[] = [];
  const executors: Array<{ stop(): void }> = [];
  afterEach(() => { for (const executor of executors.splice(0)) executor.stop(); for (const db of databases.splice(0)) db.close(); });
  function setup() {
    const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
    db.exec("INSERT INTO project_settings(group_id,mode,lead_bot_id,updated_at) VALUES('g','ongoing','lead',1)");
    let now = 10000;
    const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false,
      speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }),
      askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => now });
    admission.setBudgetGate({ check: () => ({ ok: true }) });
    const hooks = { restartCards: vi.fn(), cardGenerationCurrent, cardEffect: (database: DatabaseSync, request: any) => applyCardRunEffect(database, request, { memberIds: ["lead", "jax"], now }), returnThread: () => "room" };
    const start = vi.fn();
    const executor = createProjectCardExecutor({ db: () => db, admission, now: () => now, open: () => true,
      context: () => ({ groupId: "g", isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: "lead", boardOn: true, parallelCards: 1 }),
      usable: () => true, desk: (request) => `desk-${request.toBotId}`, writerRoot: () => undefined, start, hooks, changed: vi.fn() });
    executors.push(executor);
    const made = createProjectCard(db, { groupId: "g", title: "Reconcile payments", assigneeBotId: "jax", actor: { kind: "owner" }, memberIds: ["lead", "jax"], now });
    if (!made.ok) throw new Error(made.reason);
    const queued = enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now });
    if (!queued.ok) throw new Error(queued.reason);
    db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
    return { db, executor, start, hooks, card: { id: made.card.id, requestId: queued.requestId }, advance: () => { now += 3000; } };
  }
  /** The card run asked a teammate, the teammate answered: the run's continuation `wake:<run>` is queued. */
  function continuationQueued(f: ReturnType<typeof setup>) {
    f.executor.pump();
    expect(f.start).toHaveBeenCalledTimes(1);
    const child = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "lead", parentId: f.card.requestId, admissionKey: "ask-card", now: 11000 }).request;
    f.executor.finish(f.card.requestId, { ok: true, resultMessageId: "intermediate" });
    expect(roomRequest(f.db, f.card.requestId)?.state).toBe("waiting_bot");
    completeRequest(f.db, child.id, { state: "done", now: 12000, resultMessageId: "answer" }, f.hooks);
    const wake = f.db.prepare("SELECT id FROM room_requests WHERE admission_key=?").get(`wake:${f.card.requestId}`) as { id: string };
    expect(roomRequest(f.db, wake.id)?.state).toBe("queued");
    return wake.id;
  }

  for (const ended of ["cancelled", "failed"] as const) {
    it(`card run ${ended} (1.0.3 left its continuation queued): the continuation is cancelled, never started`, () => {
      const f = setup();
      const wake = continuationQueued(f);
      f.db.prepare("UPDATE room_requests SET state=?, finished_at=12500 WHERE id=?").run(ended, f.card.requestId);
      f.advance(); f.executor.pump();
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(roomRequest(f.db, wake)?.state).toBe("cancelled");
    });
  }

  it("guard: the continuation of an open (waiting) card run starts", () => {
    const f = setup();
    const wake = continuationQueued(f);
    f.advance(); f.executor.pump();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(roomRequest(f.db, wake)?.state).toBe("running");
    expect(projectCardById(f.db, f.card.id)?.state).toBe("doing");
  });
});

describe("D4 decide(): a queued SHARED hand-off whose room request's asker ended (U31)", () => {
  const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); };
  beforeEach(() => {
    fresh();
    onDelegationReceipt((receipt) => {
      const row = roomRequest(database(), receipt.id);
      if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : "cancelled", now: Date.now() });
    });
  });
  afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

  // the asker is another shared ask (the lead's own request); the hand-off's ask hangs under it
  const askUnder = (w: SharedWorld) => {
    const asker = w.handoff("asker");
    const ask = w.handoff("ask");
    database().prepare("UPDATE room_requests SET parent_id=? WHERE id=?").run(asker.id, ask.id);
    expect(roomRequest(database(), ask.id)).toMatchObject({ verb: "ask", parentId: asker.id, state: "queued" });
    return { asker, ask };
  };

  for (const ended of ["cancelled", "failed"] as const) {
    it(`asker ${ended}: never started, request cancelled, one cancelled receipt, row gone`, async () => {
      const w = sharedWorld();
      const { asker, ask } = askUnder(w);
      database().prepare("UPDATE room_requests SET state=?, finished_at=5 WHERE id=?").run(ended, asker.id);
      await dispatchHandoff(ask.id, { bus: w.bus, approvalBus: w.approvalBus });
      expect(w.turns.map((turn) => turn.id)).not.toContain(ask.id);
      expect(w.finished).toEqual([]);
      expect(roomRequest(database(), ask.id)!.state).toBe("cancelled");
      expect(findDelegationReceipt(ask.id)?.status).toBe("cancelled");
      expect(database().prepare("SELECT 1 FROM pending_delegations WHERE id=?").get(ask.id)).toBeUndefined();
    });
  }

  it("guard: the same shared hand-off under an open asker starts", async () => {
    const w = sharedWorld();
    const { ask } = askUnder(w);
    await dispatchHandoff(ask.id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(w.turns.map((turn) => turn.id)).toContain(ask.id);
  });
});
