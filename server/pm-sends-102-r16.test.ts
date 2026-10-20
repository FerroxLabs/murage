// Astra r15 P2 x3: (1) the owed backfill is kept alive by the blocking heartbeat while this thread sits inside slow SQL;
// (2) a queued shared continuation whose task metadata is missing is not cancelled as "the room is gone" without a recorded deletion;
// (3) work addressed to a bot or room the registry cannot show is settled only with the owner's recorded deletion (the delegation case is
// in delegations.test.ts; the authorization seam is here).
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { startBlockingHeartbeat } from "./memory/blocking-heartbeat.ts";
import { botDeletionKey, groupDeletionKey, recordOwnerDeletion } from "./owner-deletions.ts";
import { BACKFILL_NAME, upgradeRoomRequestOwed } from "./room-request-owed.ts";
import { createRoomDispatcher, type RoomDispatcherDeps } from "./room-dispatcher.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { insertRoomRequest, roomRequest } from "./room-requests.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { authorizeWork, setExecutionStore } from "./execution-audience.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

const blockFor = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };

describe("(1) the owed backfill runs under the blocking heartbeat", () => {
  it("slow SQL on this thread: the note keeps refreshing, the heartbeat starts before the first batch and is acknowledged after the last", () => {
    const db = database();
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO room_requests(id,root_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,created_at,finished_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)");
    for (let i = 0; i < 60; i++) insert.run(`h-${i}`, `h-${i}`, "g", "ask", "bot", "b", "tt", "done", 1, 1, "t", `key-${i}`);
    db.exec("COMMIT");
    for (const t of ["shared_ins", "shared_upd", "shared_clear", "fanout_ins", "fanout_upd", "fanout_child", "gone"]) db.exec(`DROP TRIGGER IF EXISTS room_request_owed_${t}`);
    db.exec("DELETE FROM room_request_owed; DELETE FROM room_request_backfills");
    const dir = mkdtempSync(join(tmpdir(), "owed-heartbeat-")), file = join(dir, "memory-upgrade-status.json");
    try {
      // every statement of the backfill takes 250 ms with this thread blocked: no progress callback can run in between
      const slow = new Proxy(db, { get(target, prop) {
        const value = (target as never)[prop];
        if (prop === "prepare") return (sql: string) => { const stmt = target.prepare(sql); return new Proxy(stmt, { get(t, p) { const v = (t as never)[p]; return typeof v === "function" ? (...a: unknown[]) => { if (p === "run" || p === "get") blockFor(250); return (v as (...x: unknown[]) => unknown).apply(t, a); } : v; } }); };
        return typeof value === "function" ? (...a: unknown[]) => (value as (...x: unknown[]) => unknown).apply(target, a) : value;
      } }) as unknown as DatabaseSync;
      const events: string[] = [], stamps: number[] = [];
      let beat: ReturnType<typeof startBlockingHeartbeat> | undefined;
      upgradeRoomRequestOwed(slow, () => { events.push("note"); }, {
        sliceMs: 10_000,
        heartbeat: () => { events.push("start"); beat = startBlockingHeartbeat(file, { v: 1, state: "upgrading", phase: "indexing", pid: process.pid, startedAt: Date.now() }, "backfill", 40); const end = beat.end; return { step: beat.step, end: () => { events.push("end"); end(); } }; },
      });
      expect(events[0]).toBe("start");
      expect(events.at(-1)).toBe("end");
      expect(events.filter(e => e === "end")).toHaveLength(1);
      expect(db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(BACKFILL_NAME)).toEqual({ completed: 1 });
      // while the thread was blocked the heartbeat thread rewrote the note: the last write is recent, with the backfill step recorded
      const note = JSON.parse(readFileSync(file, "utf8")) as { updatedAt: number; step: string; phase: string };
      expect(note.step).toBe("backfill"); expect(note.phase).toBe("indexing");
      stamps.push(note.updatedAt);
      expect(Date.now() - note.updatedAt).toBeLessThan(600);
    } finally { removeTempDirSync(dir); }
  });
  it("a heartbeat that cannot start leaves the backfill exactly as it was", () => {
    const db = database();
    expect(() => upgradeRoomRequestOwed(db, () => {}, { heartbeat: () => { throw new Error("no thread"); } })).not.toThrow();
  });
});

describe("(2) a queued shared continuation is not cancelled for missing metadata", () => {
  function harness(over: Partial<RoomDispatcherDeps> = {}) {
    const db = database(), closed: string[] = [];
    initializeProjectTables(db);
    const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false,
      directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false,
      reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 1_000 });
    admission.setBudgetGate({ check: () => ({ ok: true }) });
    const deps: RoomDispatcherDeps = { db: () => db, admission, now: () => 1_000, open: () => true, roomUsable: () => false, roomBusy: () => false, projectContext: () => undefined,
      memberIds: () => [], audienceStillValid: () => true, ownerOrigin: () => true, startOwnerSend: () => {}, startMemberTurn: () => {}, onClosed: (r, l) => { closed.push(`${r.id}:${l}`); },
      onStillWaiting: () => {}, changed: () => {}, ...over };
    return { db, closed, dispatcher: createRoomDispatcher(deps) };
  }
  it("unknown task metadata: kept queued; a recorded room deletion cancels it", () => {
    setExecutionStore(undefined as never);
    const { db, closed, dispatcher } = harness();
    const root = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", targetThreadId: "tt", admissionKey: "r", lineage, now: 1 }).request;
    db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')").run(root.id);   // recorded when the shared ask was created
    const wake = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "b", targetThreadId: "tt", parentId: root.id, admissionKey: "wake:r", now: 2 }).request;
    dispatcher.pump();
    expect(roomRequest(db, wake.id)!.state).toBe("queued");
    expect(closed).toEqual([]);
    recordOwnerDeletion(db, groupDeletionKey("g"));
    dispatcher.pump();
    expect(roomRequest(db, wake.id)!.state).toBe("cancelled");
  });
  it("durable provenance on the parent keeps the wake queued whatever the registry lists", () => {
    const { db, dispatcher } = harness();
    const root = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", targetThreadId: "tt", admissionKey: "r2", lineage, now: 1 }).request;
    db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')").run(root.id);
    const wake = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "b", targetThreadId: "tt", parentId: root.id, admissionKey: "wake:r2", now: 2 }).request;
    dispatcher.pump();
    expect(roomRequest(db, wake.id)!.state).toBe("queued");
  });
});

describe("(3) work for a bot the registry cannot show is settled only with a recorded deletion", () => {
  it("authorizeWork: an unknown target is kept (queue) and a tombstoned one is refused for good", () => {
    setExecutionStore(undefined as never);
    const edge = { edge: "dispatch", requestId: "r", targetBotId: "ghost", targetThreadId: "tt", tag: null, kind: "wake" } as never;
    expect(authorizeWork(edge)).toMatchObject({ ok: false, code: "not_reachable", retry: "queue" });
    recordOwnerDeletion(database(), botDeletionKey("ghost"));
    expect(authorizeWork(edge)).toMatchObject({ ok: false, code: "not_reachable", retry: "never" });
  });
});
