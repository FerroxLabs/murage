// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// murage#18 (a), REVOKE-NARROW-18-107 r2: the last flow of each memory_thread_flow edge (memory_thread_flow_last, v13). A revoke's flow phase
// skips an edge whose last flow was stamped strictly below the walked node's since, so a thread that read the revoked thread only before the
// revoked line is not held "checking" for the whole walk; every edge that could have carried the line stays followed, and a flow after the
// flow phase is held at its write. The stamp is the lsn counter at the flow, never the writer's own lsn.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup } from "./deny-read.ts";
import { resetLineageBackfillForTest } from "./lineage-backfill.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import type { LineageReader } from "./lineage-types.ts";
import { drainRevokeMarker, INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import { turnToolText } from "./prompt-parts.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { markerSlice, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { downgradeMemorySchema, MEMORY_SCHEMA, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { forgetKeptLineageForTest } from "./testing/legacy-lineage/replay-lineage.ts";
import { MESSAGES_SQL } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const CONTENT: LineageReader = { audience: null };
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const owner = (id: string, parentId?: string): Message => msg(id, { role: "user", ...(parentId ? { parentId } : {}) }); // a parent keeps the branch: no branch-switch revoke
const verdict = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)!.state;
const inTurn = (thread: string, turnId: string, write: () => void) => {
  const turn = openTurnLineage(database(), { threadId: thread, turnId });
  try { write(); } finally { closeTurnLineage(turn); }
};
/** B's turn quotes a line of A: a carry and an A -> B flow, stamped now. */
const quote = (b: string, turnId: string, reply: string, line: string) => inTurn("B", turnId, () => {
  turnToolText("B", "quoted words", [{ kind: "line", threadId: "A", messageId: line }]);
  appendMessage("B", msg(reply, { parentId: b }));
});
/** Runs the newest job's flow phase and nothing past it. */
function flowOnly(db: DatabaseSync) {
  for (let i = 0; i < 1000; i++) {
    if (db.prepare("SELECT phase FROM memory_revoke_jobs ORDER BY revoke_id DESC LIMIT 1").get()?.phase !== "flow") break;
    if (!markerSlice(db, 1)) break;
  }
  const phase = db.prepare("SELECT phase,state FROM memory_revoke_jobs ORDER BY revoke_id DESC LIMIT 1").get();
  expect(phase?.phase).not.toBe("flow");
  expect(phase?.state).toBe("active"); // the walk is still in flight: its pending windows are the ones a reader meets
}
const pendingOn = (db: DatabaseSync, thread: string) => Boolean(db.prepare("SELECT 1 FROM memory_deny_pending WHERE thread_id=?").get(thread));
const last = (db: DatabaseSync, from: string, to: string) => db.prepare("SELECT last_lsn FROM memory_thread_flow_last WHERE from_thread=? AND to_thread=?").get(from, to)?.last_lsn as number | undefined;

beforeEach(() => {
  closeMessageDb(); closeDatabase(); resetLineageBackfillForTest(); forgetKeptLineageForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setScopeFlowEdgesRecorded(true);
  // no bookkeeping step inside the commit and no runner: each phase runs only when a test drives it (flowOnly, drainRevokeMarker)
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation();
});
const inline = { ...INLINE_REVOCATION };
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); });

/** A: ao1, a1 | B quotes ao1 (the only A -> B flow) | A: ao2, a2. (No later turn of B: a later turn in the same thread re-reads its own
 * prefix, which carries ao1, and stamps A -> B again: followed, as it must be.) */
function twoThreads(db: DatabaseSync) {
  appendMessage("A", owner("ao1"));
  inTurn("A", "turn-a1", () => appendMessage("A", msg("a1", { parentId: "ao1" })));
  appendMessage("B", owner("bo1"));
  quote("bo1", "turn-b1", "b1", "ao1");
  appendMessage("A", owner("ao2", "a1"));
  inTurn("A", "turn-a2", () => appendMessage("A", msg("a2", { parentId: "ao2" })));
  db.prepare("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1").run(); // the certificate is ready: the flow phase may close '*'
}

it("N2 a thread that read the revoked thread only before the revoked line gets no pending window: the walk never holds it", () => {
  const db = database();
  twoThreads(db);
  const stamped = last(db, "A", "B");
  expect(stamped).toBeDefined();
  commitRevoke(db, { kind: "line", threadId: "A", messageIds: ["a2"], cause: "branch-switch" });
  expect(stamped!).toBeLessThan(Number(db.prepare("SELECT min(since_lsn) AS s FROM memory_deny_pending WHERE thread_id='A'").get()!.s));
  flowOnly(db);
  expect(pendingOn(db, "B")).toBe(false);
  expect(verdict("B", "b1")).toBe("shown");
  expect(drainRevokeMarker(db).pending).toBe(false);
  expect(verdict("B", "b1")).toBe("shown");
  expect(verdict("A", "a2")).toBe("withheld");
});

it("N1 a flow over the edge at or after since keeps the reader held until the mark, then withheld", () => {
  const db = database();
  twoThreads(db);
  appendMessage("B", owner("bo3", "b1"));
  quote("bo3", "turn-b3", "b3", "a2"); // B read a2: the edge's last flow is above a2's lsn
  commitRevoke(db, { kind: "line", threadId: "A", messageIds: ["a2"], cause: "forget" });
  flowOnly(db);
  expect(pendingOn(db, "B")).toBe(true);
  expect(verdict("B", "b3")).not.toBe("shown");
  expect(drainRevokeMarker(db).pending).toBe(false);
  expect(verdict("B", "b3")).toBe("withheld");
});

it("N3 a flow over a skipped edge after the flow phase is held at its write and withheld once marked", () => {
  const db = database();
  twoThreads(db);
  commitRevoke(db, { kind: "line", threadId: "A", messageIds: ["a2"], cause: "forget" });
  flowOnly(db);
  expect(pendingOn(db, "B")).toBe(false);
  appendMessage("B", owner("bo4", "b1"));
  quote("bo4", "turn-b4", "b4", "a2");
  expect(verdict("B", "b4")).not.toBe("shown");
  expect(drainRevokeMarker(db).pending).toBe(false);
  expect(verdict("B", "b4")).toBe("withheld");
  // (what the late child's own walk marks around it is the walker's business, unchanged here: withholds more, never less)
});

function bare() { const db = new DatabaseSync(":memory:"); db.exec(MESSAGES_SQL); migrateMemorySchema(db, "active"); return db; }
const at = (db: DatabaseSync, n: number) => db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(n);

it("N4 N10 every attempted flow stamps the counter now, also a duplicate OR IGNORE, the backfill's upsert, an old lsn and a sentinel", () => {
  const db = bare();
  try {
    at(db, 10);
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('A','B',3)").run();
    expect(last(db, "A", "B")).toBe(10);
    at(db, 20);
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('A','B',3)").run(); // ignored as a duplicate: its BEFORE trigger still runs
    expect(last(db, "A", "B")).toBe(20);
    at(db, 30);
    db.prepare("INSERT INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES('A','B',1) ON CONFLICT(from_thread,to_thread) DO UPDATE SET first_lsn=min(first_lsn,excluded.first_lsn)").run();
    expect(last(db, "A", "B")).toBe(30);
    expect(db.prepare("SELECT first_lsn FROM memory_thread_flow WHERE from_thread='A' AND to_thread='B'").get()!.first_lsn).toBe(1);
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('scope:s','C',?)").run(-(2 ** 52)); // a U1 sentinel
    expect(last(db, "scope:s", "C")).toBe(30);
    at(db, 25); // the stamp never moves down
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('A','B',3)").run();
    expect(last(db, "A", "B")).toBe(30);
    // no counter row: no stamp (unknown, followed), and the writer's own statement still succeeds
    db.exec("DELETE FROM memory_lsn");
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('D','E',5)").run();
    expect(last(db, "D", "E")).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM memory_thread_flow WHERE from_thread='D'").get()).toBeTruthy();
  } finally { db.close(); }
});

it("N5 N11 an edge with no stamp is followed, a scope -> scope edge is followed whatever its stamp, any other stale edge is skipped", () => {
  const db = database();
  appendMessage("A", owner("ao1"));
  inTurn("A", "turn-a1", () => appendMessage("A", msg("a1", { parentId: "ao1" })));
  appendMessage("A", owner("ao2", "a1"));
  inTurn("A", "turn-a2", () => appendMessage("A", msg("a2", { parentId: "ao2" })));
  for (const [f, t] of [["A", "scope:s1"], ["scope:s1", "scope:s2"], ["scope:s2", "C"], ["A", "D"], ["A", "E"]]) db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES(?,?,1)").run(f, t);
  db.prepare("UPDATE memory_thread_flow_last SET last_lsn=1").run(); // every stamp stale (below a2's lsn)
  db.prepare("DELETE FROM memory_thread_flow_last WHERE (from_thread='A' AND to_thread='scope:s1') OR (from_thread='A' AND to_thread='E')").run(); // two unknown
  db.prepare("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1").run();
  commitRevoke(db, { kind: "line", threadId: "A", messageIds: ["a2"], cause: "forget" });
  flowOnly(db);
  const scoped = (id: string) => Boolean(db.prepare("SELECT 1 FROM memory_deny_pending_scope WHERE scope_id=?").get(id));
  expect(pendingOn(db, "E")).toBe(true); // no stamp: followed
  expect(scoped("s1")).toBe(true); // no stamp: followed
  expect(scoped("s2")).toBe(true); // scope -> scope: followed despite the stale stamp
  expect(pendingOn(db, "C")).toBe(false); // scope -> thread, stamped below since: skipped
  expect(pendingOn(db, "D")).toBe(false); // thread -> thread, stamped below since: skipped
});

it("N4b a flow written by a trigger body (memory_flow_capture on a captured source) is stamped too", () => {
  const db = bare();
  try {
    db.exec("INSERT OR IGNORE INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES('s-room','room','s-room','[]',0)");
    const source = (id: string, msgId: string) => db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,'s-room','T',?,NULL,1,?,'message','user','ok',NULL,'active')").run(id, msgId, `h-${id}`);
    at(db, 40);
    source("src-1", "m1");
    expect(last(db, "T", "scope:s-room")).toBe(40);
    at(db, 90);
    source("src-2", "m2"); // the capture trigger's INSERT OR IGNORE hits the existing edge: still stamped now
    expect(last(db, "T", "scope:s-room")).toBe(90);
  } finally { db.close(); }
});

it("N6 N7 13 -> 12 drops the stamps, a flow written on 12 has no stamp after the re-upgrade, and the validator wants both objects on 13", () => {
  const db = bare();
  try {
    at(db, 10);
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('A','B',3)").run();
    downgradeMemorySchema(db, 12);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('memory_thread_flow_last','memory_thread_flow_last_insert')").get()).toBeUndefined();
    at(db, 50);
    db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('A','B',3)").run(); // a flow on 12: nothing stamps it
    migrateMemorySchema(db, "active");
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_thread_flow_last").get()!.n)).toBe(0); // empty: every edge unknown, followed
    expect(() => validateMemorySchema(db)).not.toThrow();
    db.exec("DROP TRIGGER memory_thread_flow_last_insert");
    expect(() => validateMemorySchema(db)).toThrow();
    db.exec(MEMORY_SCHEMA.slice(MEMORY_SCHEMA.indexOf("CREATE TRIGGER IF NOT EXISTS memory_thread_flow_last_insert")));
    expect(() => validateMemorySchema(db)).not.toThrow();
    db.exec("DROP TRIGGER memory_thread_flow_last_insert; DROP TABLE memory_thread_flow_last");
    expect(() => validateMemorySchema(db)).toThrow();
  } finally { db.close(); }
});
