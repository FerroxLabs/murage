// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.3 revoke storm's fixture (revoke-storm.test.ts, revoke-budget.test.ts): receipts over a few threads, flipped at once as
// revokeAllDisclosures flips them.
import { noteReceiptOutput } from "../receipt-outputs.ts";
import { CARRY_CHILD_CODE, recordChildRef, type MemoryRef } from "../lineage-types.ts";
import { testThreadNo, WritetimeFixture } from "./writetime-fixture.ts";

export const SHARED: MemoryRef = { kind: "record", id: "rec-shared", version: 1 };
export const THREADS = ["storm-a", "storm-b", "storm-c", "storm-d"];
export const num = (fx: WritetimeFixture, sql: string, ...args: Array<string | number>) => Number((fx.db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);

/** `receipts` delivered receipts over four threads, each with its own first output line and session; every output line carries the same
 * record (a shared memory object the walk reaches from each of them). */
export function storm(receipts: number): WritetimeFixture {
  const fx = new WritetimeFixture();
  fx.cert(true);
  fx.db.prepare("UPDATE memory_lsn SET next=1000 WHERE id=1").run(); // commits take slots after every fixture line
  fx.record(SHARED.id, 1, "s-room");
  for (let i = 0; i < receipts; i++) {
    const T = THREADS[i % THREADS.length]!, lsn = 10 + i * 2;
    fx.owner(T, `u${i}`, lsn - 1).reply(T, `r${i}`, lsn, { turnLsn: lsn - 1 });
    fx.receipt(`b${i}`, T, "fuigo", `s${i}`);
    fx.sessionLineage(T, "fuigo", `s${i}`, lsn - 1, lsn);
    noteReceiptOutput(fx.db, `b${i}`, T, lsn, { driverInstance: "fuigo", nativeSession: `s${i}` });
    fx.db.prepare("INSERT INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,0)")
      .run(testThreadNo(fx.db, T), lsn, lsn, CARRY_CHILD_CODE.record, recordChildRef(SHARED));
  }
  return fx;
}
/** The install-wide flip (revokeAllDisclosures' UPDATE): every live receipt turns 'revoked' at once and the trigger queues each. */
export const flipAll = (fx: WritetimeFixture) => fx.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state IN ('prepared','delivered')").run();
/** Rows the connection changed so far (SQLite total_changes(): trigger writes included). */
export const changes = (fx: WritetimeFixture | { db: WritetimeFixture["db"] }): number => Number((fx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
