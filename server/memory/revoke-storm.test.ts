// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 revoke storm (REVOKE-STORM-DESIGN-M, agreed). On 1.0.2 a notebook re-import flipped 122 receipts; the flip drain made 122 audience
// jobs (one per receipt), each walking and marking every shared object again, at 0.6-1.8 GB a minute, and room turns were refused while
// they were pending. M5: one drain is one audience bulk. M3: the walk stays inside a write budget and yields to foreground turns. M1: an
// owner-audience room reads its own transcript by content.
import { describe, expect, it } from "vitest";
import { commitRevoke, undoRevoke } from "./revoke-commit.ts";
import { markerSlice, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { REVOKE_FOLD } from "./revoke-fold.ts";
import { refsLookup } from "./deny-read.ts";
import type { LineageRef } from "./lineage-types.ts";
import { CONTENT, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { changes as totalChanges, flipAll, num, SHARED, storm, THREADS } from "./testing/revoke-storm-fixture.ts";

const slice = (fx: WritetimeFixture, run: () => unknown) => { fx.db.exec("BEGIN IMMEDIATE"); try { return run(); } finally { fx.db.exec("COMMIT"); } };
const drainAll = (fx: WritetimeFixture) => { for (let n = 0; n < 100_000; n++) if (!slice(fx, () => markerSlice(fx.db, 256, 8))) return; throw new Error("unbounded"); };
const bulks = (fx: WritetimeFixture) => fx.db.prepare("SELECT revoke_id AS r,kind,state FROM memory_revoke_jobs WHERE state!='done' ORDER BY revoke_id").all() as Array<{ r: number; kind: string; state: string }>;

describe("M5: one drain of the receipt flips is one audience bulk", () => {
  it("122 flips: one drain makes one active bulk with 122 receipt roots, every root with its own window; inside the write budget", () => {
    const fx = storm(122);
    try {
      flipAll(fx);
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(122);
      const before = totalChanges(fx);
      expect(slice(fx, () => markerSlice(fx.db, 256, Number.POSITIVE_INFINITY))).toBe(true);
      const drainWrites = totalChanges(fx) - before;
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(0);
      const jobs = bulks(fx);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: "bulk", state: "active" });
      const R = jobs[0]!.r;
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_audience WHERE revoke_id=?", R)).toBe(1);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0 AND node LIKE '%receipt%'", R)).toBe(122);
      // each root keeps its own bound: every thread's window starts at its own earliest receipt output, not at the bulk's minimum
      for (const [i, T] of THREADS.entries()) expect(num(fx, "SELECT min(since_lsn) AS n FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?", T, R)).toBe(10 + i * 2);
      // one drain fits one slice of the marker's write budget (revoke-budget.ts: 20 MB a minute, a page per changed row)
      expect(drainWrites * Number((fx.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size)).toBeLessThanOrEqual(20 * 1024 * 1024 - 512 * 4096);
      // the walk: every shared object, session and thread range is written once for the one revoke
      const walkBefore = totalChanges(fx);
      drainAll(fx);
      const walkWrites = totalChanges(fx) - walkBefore;
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND id=?", SHARED.id)).toBe(1);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_session")).toBe(122);
      for (const T of THREADS) expect(num(fx, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id=?", T)).toBe(1);
      // O(receipts + lines + sessions): a fixed handful of rows per receipt, not a walk per receipt
      expect(drainWrites + walkWrites).toBeLessThanOrEqual(122 * 24 + 256);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding')")).toBe(0);
    } finally { fx.close(); }
  });

  it("a content forget after an audience mark still withholds, and the audience bulk is never undone (DRAIN-104 2.5)", () => {
    const fx = storm(12);
    try {
      flipAll(fx);
      slice(fx, () => markerSlice(fx.db, 256, Number.POSITIVE_INFINITY));
      const jobs = bulks(fx);
      expect(jobs).toHaveLength(1);
      drainAll(fx);
      const shared: LineageRef = { kind: "memory", ref: SHARED };
      // the audience bulk marked the record once; an audience-only mark never withholds the object itself
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND id=? AND revoke_id=?", SHARED.id, jobs[0]!.r)).toBe(1);
      expect(refsLookup(fx.db, [shared], CONTENT).state).toBe("shown");
      expect(refsLookup(fx.db, [shared], OWNER).state).toBe("shown");
      // the owner forgets the record: its own mark, never deduped against the audience one
      const F = slice(fx, () => commitRevoke(fx.db, { kind: "memory", ref: SHARED, cause: "forget" }, { inline: false })) as number;
      expect(F).toBeGreaterThan(jobs[0]!.r);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND id=? AND revoke_id=?", SHARED.id, F)).toBe(1);
      drainAll(fx);
      expect(refsLookup(fx.db, [shared], CONTENT).state).toBe("withheld");
      // an audience-only revoke is never undone (DRAIN-104 2.5): its marks may be what another audience job skipped under
      expect(() => slice(fx, () => undoRevoke(fx.db, jobs[0]!.r))).toThrow("MEMORY_REVOKE_UNDO_BULK");
      drainAll(fx);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_memory WHERE revoke_id=?", jobs[0]!.r)).toBe(1);
      expect(refsLookup(fx.db, [shared], CONTENT).state).toBe("withheld");
      expect(refsLookup(fx.db, [shared], OWNER).state).toBe("withheld");
    } finally { fx.close(); }
  });
});

describe("M1: an owner-audience room reads its own transcript by content", () => {
  it("an audience-only window holds the room prefix only for a room whose audience is not the owner's; a content window holds both", () => {
    const fx = new WritetimeFixture();
    try {
      fx.cert(true);
      const T = "room-own";
      fx.owner(T, "u1", 1).reply(T, "r1", 2, { turnLsn: 1 });
      fx.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(77)").run();
      fx.pending("*", 1, 77);
      const owned: LineageRef = { kind: "prefix", threadId: T, headLsn: 2, shown: ["r1"], content: true };
      const other: LineageRef = { kind: "prefix", threadId: T, headLsn: 2, shown: ["r1"] };
      expect(refsLookup(fx.db, [owned], OWNER).state).toBe("shown");
      expect(refsLookup(fx.db, [other], OWNER).state).toBe("checking");
      // a cross-thread line in the same prompt keeps the member's audience reader
      fx.owner("side", "s1", 3).reply("side", "s2", 4, { turnLsn: 3 });
      expect(refsLookup(fx.db, [owned, { kind: "line", threadId: "side", messageId: "s2" }], OWNER).state).toBe("checking");
      // a content revoke still holds the owner's room
      fx.pending(T, 1, 78);
      expect(refsLookup(fx.db, [owned], OWNER).state).toBe("checking");
    } finally { fx.close(); }
  });
});

// 1.0.3 revoke drain, F3: the runner used to carry the oldest job to its end while every younger job sat in its flow phase, holding its '*'
// window over every thread and scope for the whole drain. Each job's cheap flow phase now runs first; marking starts once none is left.
describe("F3: every pending job narrows its windows before any job marks", () => {
  const marks = (fx: WritetimeFixture) => ["memory_deny_session", "memory_deny_line", "memory_deny_memory", "memory_deny_range"]
    .reduce((sum, table) => sum + num(fx, `SELECT count(*) AS n FROM ${table}`), 0);
  const inFlow = (fx: WritetimeFixture) => num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active' AND phase='flow'");
  it("six per-receipt jobs: no mark is written and no mark node is taken while any job is still in its flow phase; then all finish", () => {
    const fx = storm(6);
    setScopeFlowEdgesRecorded(true);
    REVOKE_FOLD.enabled = false; // jobs the fold leaves alone (a turn position between them): each still narrows before any marks
    try {
      // each storm thread flows into 200 others, so every flow phase spans several slices
      const edge = fx.db.prepare("INSERT OR IGNORE INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES(?,?,5)");
      for (const T of THREADS) for (let k = 0; k < 200; k++) edge.run(T, `fan-${T}-${k}`);
      const ids = slice(fx, () => [0, 1, 2, 3, 4, 5].map(i => commitRevoke(fx.db, { kind: "receipt", bundleId: `b${i}`, cause: "receipt-revoked" }, { inline: false }))) as number[];
      expect(new Set(ids).size).toBe(6);
      expect(inFlow(fx)).toBe(6);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'")).toBe(6);
      const marksBefore = marks(fx), nodesBefore = num(fx, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE seq>0");
      expect(nodesBefore).toBeGreaterThan(0);
      let slices = 0;
      while (inFlow(fx) > 0) {
        expect(marks(fx)).toBe(marksBefore);
        expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE seq>0")).toBe(nodesBefore);
        // the '*' windows end one by one, each at its own flow's end
        expect(num(fx, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'")).toBe(inFlow(fx));
        slice(fx, () => markerSlice(fx.db, 64, Number.POSITIVE_INFINITY));
        expect(++slices).toBeLessThan(10_000);
      }
      expect(slices).toBeGreaterThan(6);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'")).toBe(0);
      // every per-thread window is still there until its job's last mark
      for (const id of ids) expect(num(fx, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", id)).toBeGreaterThan(0);
      drainAll(fx);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_pending")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM (SELECT DISTINCT thread_id,driver_instance,native_session FROM memory_deny_session)")).toBe(6);
    } finally { REVOKE_FOLD.enabled = true; setScopeFlowEdgesRecorded(false); fx.close(); }
  });
});
