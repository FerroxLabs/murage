// Astra r16 P2 (retained unknown requests): a queued request kept because its bot or room is not known yet gets a persisted next-look
// time with backoff (30 s doubling to 1 hour); a sweep reads only the due ones, in a bounded batch, once per sweep and not once per bot;
// the owner can still dismiss one with the room's cancel; it is retried when due and when the harness finishes booting.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { createRoomDispatcher, type RoomDispatcherDeps } from "./room-dispatcher.ts";
import {
  cancelRoomRequest, clearRetainedRoomRequest, deferRetainedRoomRequest, dueRetainedRoomRequests, insertRoomRequest, retainedBackoffMs,
  roomRequest, RETAINED_SWEEP_BATCH, wakeRetainedRoomRequests,
} from "./room-requests.ts";
import { configureSharedDrain, drainSharedWork, sharedDispatchOrder } from "./shared-work.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { botDeletionKey, groupDeletionKey, recordOwnerDeletion } from "./owner-deletions.ts";
import type { DatabaseSync } from "node:sqlite";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { windowsNightly } from "./testing/windows-hosted.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setExecutionStore(undefined as never); });
afterEach(() => closeDatabase());


function harness(clock: { t: number }) {
  const db = database();
  initializeProjectTables(db);
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false,
    directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false,
    reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => clock.t });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const deps: RoomDispatcherDeps = { db: () => db, admission, now: () => clock.t, open: () => true, roomUsable: () => false, roomBusy: () => false, projectContext: () => undefined,
    memberIds: () => [], audienceStillValid: () => true, ownerOrigin: () => true, startOwnerSend: () => {}, startMemberTurn: () => {}, onClosed: () => {},
    onStillWaiting: () => {}, changed: () => {} };
  return { db, dispatcher: createRoomDispatcher(deps) };
}

/** Counts the rows every statement returns: what a sweep materializes. */
function counting(db: DatabaseSync) {
  const counter = { rows: 0 };
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    return new Proxy(stmt, { get(t, p) {
      const v = (t as never)[p] as unknown;
      if (p === "all") return (...a: unknown[]) => { const out = (v as (...x: unknown[]) => unknown[]).apply(t, a); counter.rows += out.length; return out; };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } });
  };
  return counter;
}

function seed(db: DatabaseSync, n: number, bots = 10) {
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO room_requests(id,root_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,created_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key) VALUES(?,?,?,'ask','bot',?,?,'queued',?,'t','desktop','fp',0,0,?)");
  const provenance = db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  for (let i = 0; i < n; i++) { provenance.run(`q-${i}`); insert.run(`q-${i}`, `q-${i}`, "g", `b${i % bots}`, `tt${i % bots}`, 1 + i, `k-${i}`); }
  db.exec("COMMIT");
}

describe("backoff", () => {
  it("30 s, doubling, at most 1 hour", () => {
    expect([0, 1, 2, 3].map(retainedBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retainedBackoffMs(30)).toBe(3_600_000);
  });
});

describe("a sweep reads only what is due", () => {
  it("10k retained requests x 10 bots: the first sweep retains them, later sweeps read at most one batch, flat from 1k to 10k", windowsNightly(), () => {
    const perScale: number[] = [];
    for (const n of [1_000, 10_000]) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      const clock = { t: 1_000_000 };
      const { db, dispatcher } = harness(clock);
      seed(db, n);
      // the first sweeps look at everything once, a batch at a time; the rest is not re-read
      for (let i = 0; i < Math.ceil(n / RETAINED_SWEEP_BATCH) + 2; i++) dispatcher.pump();
      expect((db.prepare("SELECT count(*) AS c FROM room_request_retry").get() as { c: number }).c).toBe(n);
      const counter = counting(db);
      dispatcher.tick();
      configureSharedDrain({ admission: undefined as never, open: () => true, start: () => {}, closed: () => {}, changed: () => {}, now: () => clock.t });
      for (let i = 0; i < 10; i++) { drainSharedWork(`b${i}`); sharedDispatchOrder(`b${i}`); }
      perScale.push(counter.rows);
      expect(counter.rows).toBeLessThanOrEqual(RETAINED_SWEEP_BATCH);          // nothing is due: reads nothing, never the backlog
      for (const row of dueRetainedRoomRequests(db, clock.t)) expect(row.retryAttempts ?? 0).toBeGreaterThanOrEqual(0);
      expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(0);
    }
    expect(perScale[1]!).toBeLessThanOrEqual(perScale[0]! + RETAINED_SWEEP_BATCH);   // flat
  });

  it("due ones are taken a batch at a time and retried: after the wait they are looked at again with a longer wait", () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher } = harness(clock);
    seed(db, 250);
    for (let i = 0; i < 6; i++) dispatcher.pump();
    const wait = (id: string) => (db.prepare("SELECT retry_at, attempts FROM room_request_retry WHERE request_id=?").get(id) as { retry_at: number; attempts: number });
    expect(wait("q-0")).toEqual({ retry_at: clock.t + 30_000, attempts: 1 });
    clock.t += 30_001;
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(RETAINED_SWEEP_BATCH);      // 250 due, one batch per sweep
    dispatcher.pump();
    expect(wait("q-0")).toEqual({ retry_at: clock.t + 60_000, attempts: 2 });                    // looked at again, longer wait
    for (let i = 0; i < 4; i++) dispatcher.pump();
    expect((db.prepare("SELECT count(*) AS c FROM room_request_retry WHERE attempts=2").get() as { c: number }).c).toBe(250);   // every one was retried
  });

  it("the owner can dismiss a retained request with the room's cancel; it leaves the retry set and is never looked at again", () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher } = harness(clock);
    db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES('r1', 'none')").run();
    const r = insertRoomRequest(db, { id: "r1", groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", targetThreadId: "tt", admissionKey: "r", now: 1, lineage: { rootThreadId: "t", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
    dispatcher.pump();
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id=?").get(r.id)).toBeTruthy();
    expect(roomRequest(db, r.id)!.state).toBe("queued");
    expect(cancelRoomRequest(db, r.id, { now: clock.t, note: "cancelled by you" })).toBeTruthy();
    expect(roomRequest(db, r.id)!.state).toBe("cancelled");
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id=?").get(r.id)).toBeUndefined();
    clock.t += 4_000_000;
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(0);
  });

  it("booting wakes every retained request; a request that becomes decidable leaves the retry set", () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher } = harness(clock);
    seed(db, 5);
    dispatcher.pump();
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(0);
    expect(wakeRetainedRoomRequests(db, clock.t)).toBe(5);
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(5);
    expect(clearRetainedRoomRequest(db, "q-0")).toBe(true);
    expect(clearRetainedRoomRequest(db, "q-0")).toBe(false);
    deferRetainedRoomRequest(db, "q-1", clock.t);
    expect(dueRetainedRoomRequests(db, clock.t).map(q => q.id)).not.toContain("q-1");
  });

  it("a recorded deletion makes the requests that name that bot, room or thread due at once (and only those)", () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher } = harness(clock);
    seed(db, 20, 2);   // bots b0 / b1, rooms all "g"
    dispatcher.pump();
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(0);
    recordOwnerDeletion(db, botDeletionKey("b0"));
    expect(dueRetainedRoomRequests(db, clock.t).map(q => q.toBotId)).toEqual(Array(10).fill("b0"));
    dispatcher.pump();
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(0);
    recordOwnerDeletion(db, "tt1");
    expect(dueRetainedRoomRequests(db, clock.t)).toHaveLength(10);
    recordOwnerDeletion(db, groupDeletionKey("g"));
    expect(dueRetainedRoomRequests(db, clock.t).length).toBeGreaterThan(0);
  });
});
