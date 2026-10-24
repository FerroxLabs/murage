// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READER-PRIVACY-104 (U07, the inherit hold): fresh memory written while a content revoke is walked is held only as long as the revoke can
// reach it. A forget seeds the flow of its supporting sources' scopes and capture threads at commit (R1, R2), so the flow gate's closure is
// whole; a late memory child then inherits its parent's own scope window, and a `*` window only from a job this build did not certify (R3 a,
// b); an uncertified single forget past its gate holds every late child to its tidy (R3 c). Before: every record written by import,
// pin-copy, correction, consolidation or extraction during any content walk read "checking" until that walk's tidy (up to hours).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import { commitRevoke, inheritEdge } from "./revoke-commit.ts";
import { denyLookup, refsLookup } from "./deny-read.ts";
import { FIRST_LSN, PENDING_ALL_SCOPES, PENDING_ALL_THREADS, type MemoryRef } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db) => { for (let k = 0; k < 100_000; k++) if (!slice(db)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const pathOf = (db: Db) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
const phase = (db: Db, id: number) => (db.prepare("SELECT phase,state FROM memory_revoke_jobs WHERE revoke_id=?").get(id) as { phase: string; state: string } | undefined);
const verdict = (db: Db, ref: MemoryRef) => refsLookup(db, [{ kind: "memory", ref }], CONTENT).state;
const lineVerdict = (db: Db, thread: string, messageId: string) => denyLookup(db, { threadId: thread, lines: [{ messageId, author: "generated" }] }, CONTENT).get(messageId)?.state;
const holds = (db: Db, revoke: number, scope: string) => n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id=? AND revoke_id=?", scope, revoke); // markPending stores the bare scope id
const seeded = (db: Db, revoke: number) => db.prepare("SELECT json_extract(root,'$.seeded') AS s FROM memory_revoke_jobs WHERE revoke_id=?").get(revoke)?.s;

/** Astra's interleaving (codex-jobs/astra-103-inherit-scope): X in A and P in B both cite S, captured in B from thread TS at line 20 (a
 * generated line at 15 precedes it, one at 30 follows); an unrelated import scope IMP and a copy scope D. Flow edges run B -> A only. */
function store(): WritetimeFixture {
  const fx = new WritetimeFixture();
  fx.cert(true).scope("A").scope("B").scope("D").scope("IMP");
  fx.reply("TS", "TS-15", 15).owner("TS", "TS-20", 20).reply("TS", "TS-30", 30);
  fx.source("S", "B", { thread: "TS", message: "TS-20" });
  fx.record("X", 1, "A", ["S"]).record("P", 1, "B", ["S"]);
  fx.db.prepare("UPDATE memory_lsn SET next=max(next,5000) WHERE id=1").run();
  return fx;
}
/** The owner forgets X: a real commit (seeds, `*` windows, the flag), the marker not run inline. */
function forget(db: Db, id = "X"): number {
  return tx(db, () => commitRevoke(db, { kind: "memory", ref: { kind: "record", id, version: 1 }, cause: "forget" }, { inline: false }));
}
/** An import (import.ts): a pinned record of an unrelated scope with evidence from its imported source, in one transaction. */
function importPinned(fx: WritetimeFixture, id = "IR", scope = "IMP"): MemoryRef {
  const db = fx.db;
  tx(db, () => {
    fx.scope(scope).source(`${id}-src`, scope, { kind: "legacy-import" });
    fx.record(id, 1, scope, [`${id}-src`]);
    inheritEdge(db, { kind: "record", id, version: 1 }, { kind: "source", id: `${id}-src` });
  });
  return { kind: "record", id, version: 1, scopeId: scope };
}
/** A pin-copy (authority.ts promote): P (cites S, outside X's own forward closure) copied into D. */
function copyOfP(fx: WritetimeFixture, id = "C", parent = "P", scope = "D"): MemoryRef {
  const db = fx.db;
  tx(db, () => {
    fx.scope(scope).record(id, 1, scope).derive(parent, 1, id, 1);
    inheritEdge(db, { kind: "record", id, version: 1 }, { kind: "record", id: parent, version: 1 });
  });
  return { kind: "record", id, version: 1, scopeId: scope };
}
/** A capture of a stored line of TS (a line parent) into D. */
function captureOfLine(fx: WritetimeFixture, id: string, messageId: string, scope = "D"): MemoryRef {
  const db = fx.db;
  tx(db, () => {
    fx.scope(scope).record(id, 1, scope);
    inheritEdge(db, { kind: "record", id, version: 1 }, { threadId: "TS", messageId });
  });
  return { kind: "record", id, version: 1, scopeId: scope };
}
/** R's flow gate: one-row slices run its flow phase to its end; the walk is still to come. */
function gate(db: Db, R: number): void {
  for (let k = 0; k < 10_000 && phase(db, R)?.phase === "flow"; k++) slice(db, 1);
  expect(phase(db, R)?.phase, "R is past its flow gate").toBe("mark");
  expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id=? AND revoke_id=?", PENDING_ALL_SCOPES, R), "R's `*` scope window is gone").toBe(0);
  expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?", PENDING_ALL_THREADS, R), "R's `*` thread window is gone").toBe(0);
  expect(n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0", R), "R's walk is still running").toBeGreaterThan(0);
}

describe("READER-PRIVACY-104 U07: fresh memory while a forget is walked", () => {
  let fx: WritetimeFixture | null = null;
  beforeEach(() => { marker.setScopeFlowEdgesRecorded(true); });
  afterEach(() => { fx?.close(); fx = null; });

  it("T1: an imported pinned record of an unrelated scope is shown after the flow gate while the walk still runs", () => {
    fx = store();
    const R = forget(fx.db);
    expect(seeded(fx.db, R), "a certified single job").toBe(1);
    const ir = importPinned(fx);
    expect(verdict(fx.db, ir), "before R's gate the reader holds it under `*`").toBe("checking");
    expect(holds(fx.db, R, "IMP"), "no hold inherited from `*`").toBe(0);
    gate(fx.db, R);
    expect(verdict(fx.db, ir), "after the gate, mid-walk").toBe("shown");
    drainAll(fx.db);
    expect(verdict(fx.db, ir)).toBe("shown");
    expect(verdict(fx.db, { kind: "record", id: "X", version: 1, scopeId: "A" })).toBe("withheld");
  });

  it("T2: a copy of a record that only shares a supporting source with X is held from its write until the walk marks it, then withheld", () => {
    fx = store();
    const R = forget(fx.db);
    expect(holds(fx.db, R, "B"), "the supporting source's scope is seeded at commit").toBeGreaterThan(0);
    expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='TS' AND since_lsn=20 AND revoke_id=?", R), "its capture thread from the capture line").toBe(1);
    const c = copyOfP(fx);
    expect(verdict(fx.db, c)).toBe("checking");
    expect(holds(fx.db, R, "D"), "held under R from B's own window").toBe(1);
    gate(fx.db, R);
    expect(verdict(fx.db, c), "after the gate, mid-walk").toBe("checking");
    const c2 = copyOfP(fx, "C2"); // a copy written after the gate inherits the same way
    expect(verdict(fx.db, c2)).not.toBe("shown");
    const db = fx.db;
    for (let k = 0; k < 100_000 && phase(db, R)?.phase !== "tidy" && phase(db, R)?.state !== "done"; k++) {
      expect(verdict(db, c), `slice ${k}`).not.toBe("shown");
      expect(verdict(db, c2), `slice ${k}`).not.toBe("shown");
      if (!slice(db)) break;
    }
    drainAll(db);
    for (const ref of [c, c2, { kind: "record", id: "P", version: 1, scopeId: "B" } as MemoryRef]) expect(verdict(db, ref)).toBe("withheld");
  });

  it("T2b: a copy of a record whose scope row is stamped after the record (evidence added at activation) is held from its write until the walk marks it", () => {
    fx = store();
    const db = fx.db;
    // Q in C created at one slot; its evidence for S (an owner invitation accepted at activation, authority.ts) arrives 1_000 slots later, so
    // the flow edge B -> C, and C's pending row, carry a since above Q's created lsn: the reader shows Q itself until the walk marks it
    fx.scope("C").record("Q", 1, "C");
    db.prepare("UPDATE memory_lsn SET next=next+1000 WHERE id=1").run();
    db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('Q',1,'S',1,0,3)").run();
    const qCreated = Number((db.prepare("SELECT created_lsn AS c FROM memory_record_lsn WHERE id='Q' AND version=1").get() as { c: number }).c);
    expect(Number((db.prepare("SELECT first_lsn AS l FROM memory_thread_flow WHERE from_thread='scope:B' AND to_thread='scope:C'").get() as { l: number }).l), "the edge is stamped after Q").toBeGreaterThan(qCreated);
    const R = forget(db);
    const cq = copyOfP(fx, "CQ", "Q"); // pre-gate pin-copy of Q into D
    expect(verdict(db, cq)).toBe("checking");
    gate(db, R);
    expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id='C' AND revoke_id=?", R), "the flow pended C").toBe(1);
    expect(holds(db, R, "D"), "the copy is held under R from C's row, whatever its since").toBe(1);
    expect(verdict(db, cq), "after the gate, before the walk reaches Q").toBe("checking");
    // a copy made after the gate into a scope the flow never reached (no row of its own, its edge C -> D2 is written after the flow is
    // done): only inheritance from C's row can hold it, and C's since is above Q's created lsn
    const cq2 = copyOfP(fx, "CQ2", "Q", "D2");
    expect(holds(db, R, "D2"), "held under R from C's row, whatever its since").toBe(1);
    expect(verdict(db, cq2), "a post-gate copy of a record the walk is still to mark").toBe("checking");
    for (let k = 0; k < 100_000 && phase(db, R)?.phase !== "tidy" && phase(db, R)?.state !== "done"; k++) {
      for (const ref of [cq, cq2]) expect(verdict(db, ref), `slice ${k}`).not.toBe("shown");
      if (!slice(db)) break;
    }
    drainAll(db);
    for (const ref of [cq, cq2, { kind: "record", id: "Q", version: 1, scopeId: "C" } as MemoryRef]) expect(verdict(db, ref)).toBe("withheld");
  });

  it("T3c: the capture thread is held from the capture line, not from its first line", () => {
    fx = store();
    const R = forget(fx.db);
    gate(fx.db, R);
    expect(lineVerdict(fx.db, "TS", "TS-15"), "a generated line before the capture is not held").toBe("shown");
    expect(lineVerdict(fx.db, "TS", "TS-30"), "one after it reads checking until marked").toBe("checking");
    // a source with no message id, or whose line has no lineage row, seeds no thread: the walk never enters it for that source
    fx.scope("E").source("S2", "E", { thread: "TR" }).source("S3", "E", { thread: "TQ", message: "no-row" }).record("Y", 1, "E", ["S2", "S3"]);
    const R2 = forget(fx.db, "Y");
    expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id IN ('TR','TQ') AND revoke_id=?", R2)).toBe(0);
    expect(holds(fx.db, R2, "E")).toBeGreaterThan(0);
  });

  it("T3a: a job this build did not certify keeps today's `*` inheritance (legacy root, null flag, bulk)", () => {
    fx = store();
    const db = fx.db;
    let k = 0;
    for (const [R, kind, root] of [[11, "memory", JSON.stringify({ kind: "memory", cause: "forget", ref: { kind: "record", id: "X", version: 1 } })], [12, "memory", JSON.stringify({ kind: "memory", cause: "forget", ref: { kind: "record", id: "X", version: 1 }, seeded: null })], [13, "bulk", JSON.stringify({ kind: "bulk", cause: "fold", seeded: true })]] as const) {
      // the `*` window as 1.0.3's commitRevoke writes it for a forget (scopeSince = FIRST_LSN); a source parent's edge bound is 0, so a
      // positive since would never match, on the base or here
      db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,4000,'flow','','active')").run(R, kind, root, FIRST_LSN);
      fx.pendingScope(PENDING_ALL_SCOPES, FIRST_LSN, R);
      const ir = importPinned(fx, `IR${k++}`);
      expect(verdict(db, ir)).toBe("checking");
      expect(holds(db, R, "IMP"), `held under ${R} from its \`*\``).toBe(1);
    }
    // a certified single job hands its `*` on no more
    db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(14,'memory',?,?,4000,'flow','','active')").run(JSON.stringify({ kind: "memory", cause: "forget", ref: { kind: "record", id: "X", version: 1 }, seeded: 1 }), FIRST_LSN);
    fx.pendingScope(PENDING_ALL_SCOPES, FIRST_LSN, 14);
    importPinned(fx, "IR9");
    expect(holds(db, 14, "IMP")).toBe(0);
  });

  it("T3a/T3d: an uncertified forget past its gate holds every late child, memory or line parent, until its tidy; across a reopen and a re-upgrade", () => {
    fx = store();
    const db = fx.db;
    // a 1.0.3 forget of X in flight at the upgrade, already past its gate: no `*` rows, root without the flag, P not yet marked
    db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(21,'memory',?,1,4000,'mark','','active')").run(JSON.stringify({ kind: "memory", cause: "forget", ref: { kind: "record", id: "X", version: 1 } }));
    fx.pendingScope("A", 1, 21);
    marker.enqueueNode(db, 21, { kind: "record", id: "X", version: 1 });
    const c = copyOfP(fx);
    expect(holds(db, 21, "D"), "held under the uncertified job though its `*` is gone").toBe(1);
    expect(verdict(db, c)).toBe("checking");
    // a capture of a stored line into a scope nothing else holds (L): the hold can only come from the stored-line path of R3(c)
    const cap = captureOfLine(fx, "CL", "TS-15", "L");
    expect(holds(db, 21, "L"), "the capture is held under the uncertified job through its line parent").toBe(1);
    expect(verdict(db, cap), "a capture of a stored line is held the same way").toBe("checking");
    const file = pathOf(db);
    db.close();
    const again = new DatabaseSync(file); // a restart
    try {
      expect(verdict(again, c)).toBe("checking");
      expect(verdict(again, cap)).toBe("checking");
      const child = (id: string, scope: string, parent: MemoryRef): MemoryRef => tx(again, () => { again.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact','text','observed','active',0,0,NULL,NULL,0)").run(id, scope); again.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,1,?,1)").run(parent.id, id); inheritEdge(again, { kind: "record", id, version: 1 }, parent); return { kind: "record", id, version: 1, scopeId: scope }; });
      const c3 = child("C3", "D", { kind: "record", id: "P", version: 1 });
      expect(verdict(again, c3), "after the reopen the same rule holds").toBe("checking");
      again.prepare("INSERT INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES('L2','room','L2','{}',0)").run();
      const c4 = child("C4", "L2", cap); // the capture's own descendant, after the reopen
      expect(holds(again, 21, "L2"), "the capture's descendant inherits the hold").toBe(1);
      expect(verdict(again, c4)).toBe("checking");
      drainAll(again);
      for (const ref of [c, c3]) expect(verdict(again, ref)).toBe("withheld");
      expect(n(again, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE revoke_id=21"), "its tidy cleared the holds").toBe(0);
      for (const ref of [cap, c4]) expect(verdict(again, ref), "the capture and its descendant are decided, not left checking").not.toBe("checking");
    } finally { again.close(); }
  });

  it("T3b: a forget over the read cap stays uncertified and holds its late children before and after its gate", () => {
    fx = store();
    const db = fx.db;
    fx.scope("W").source("WS", "W").record("W", 1, "W", ["WS"]);
    const insert = db.prepare("INSERT OR IGNORE INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('W',1,'WS',1,?,?)");
    tx(db, () => { for (let b = 1; b <= 65_536; b++) insert.run(b * 4, b * 4 + 3); });
    expect(n(db, "SELECT count(*) AS n FROM memory_evidence WHERE record_id='W'")).toBe(65_537);
    const R = forget(db, "W");
    expect(seeded(db, R), "over the cap: not certified").not.toBe(1);
    const c = importPinned(fx);
    expect(holds(db, R, "IMP"), "held pre-gate from its `*`").toBe(1);
    gate(db, R);
    const c2 = importPinned(fx, "IR2", "IMP2"); // a fresh scope: the hold can only come from R3(c), its `*` is gone
    expect(holds(db, R, "IMP2"), "held post-gate under the uncertified job").toBe(1);
    expect(verdict(db, c)).toBe("checking");
    expect(verdict(db, c2)).toBe("checking");
  });

  it("T4: a restart mid-walk keeps the holds", () => {
    fx = store();
    const R = forget(fx.db);
    const c = copyOfP(fx);
    const ir = importPinned(fx);
    gate(fx.db, R);
    const file = pathOf(fx.db);
    const before = n(fx.db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE revoke_id=?", R);
    fx.db.close();
    const db = new DatabaseSync(file);
    try {
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE revoke_id=?", R)).toBe(before);
      expect(verdict(db, c)).toBe("checking");
      expect(verdict(db, ir)).toBe("shown");
      drainAll(db);
      expect(verdict(db, c)).toBe("withheld");
      expect(verdict(db, ir)).toBe("shown");
    } finally { db.close(); }
  });

  it("T3b: a forget with more distinct sources than FORGET_SEED_SEEKS seeds every capture thread from its first line, with no seek", () => {
    fx = store();
    const db = fx.db;
    // 4097 = FORGET_SEED_SEEKS + 1 sources, each captured mid-thread (lsn 10_001 and up) so a seek would seed the thread at its line
    const MANY = 4097, ids: string[] = [], f = fx;
    f.scope("V");
    tx(db, () => { for (let i = 1; i <= MANY; i++) { f.owner(`TV${i}`, `TV${i}-m`, 10_000 + i).source(`VS${i}`, "V", { thread: `TV${i}`, message: `TV${i}-m` }); ids.push(`VS${i}`); } f.record("V", 1, "V", ids); });
    const R = forget(db, "V");
    expect(seeded(db, R), "under the read cap: certified").toBe(1);
    // node:sqlite has no statement trace, so the outcome is asserted: a seek would have put the seed at the capture line (T2, 10_001+);
    // every thread sits at FIRST_LSN instead, and none at its line
    expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=? AND thread_id LIKE 'TV%' AND since_lsn=?", R, FIRST_LSN)).toBe(MANY);
    expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=? AND thread_id LIKE 'TV%' AND since_lsn>?", R, FIRST_LSN)).toBe(0);
    expect(holds(db, R, "V")).toBeGreaterThan(0);
  });
});
