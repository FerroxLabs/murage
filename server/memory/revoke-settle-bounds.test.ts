// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitRevoke } from "./revoke-commit.ts";
import { admitMarkerSlice, beginRevokeMeasure, endRevokeMeasure, resetRevokeWriteBudget, revokePaceTestHooks, type SliceTarget } from "./revoke-budget.ts";
import { markerSlice, markerSliceDetailed, setFoldHooks } from "./revoke-marker.ts";
import { SETTLE_ACTIVE_FLOW, SETTLE_SEEDING_FOLD } from "./schema.ts";
import { storm } from "./testing/revoke-storm-fixture.ts";

describe("targeted settlement work bounds", () => {
  let fx: ReturnType<typeof storm>;
  beforeEach(() => {
    fx = storm(0);
    fx.db.exec(SETTLE_ACTIVE_FLOW.sql);
    fx.db.exec(SETTLE_SEEDING_FOLD.sql);
    resetRevokeWriteBudget();
    revokePaceTestHooks.osUnknown = true;
    setFoldHooks({ need: () => 0, pending: () => false, slice: () => null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fx.close();
    resetRevokeWriteBudget();
    revokePaceTestHooks.osUnknown = false;
  });
  function content(thread: string, lsn: number): number {
    fx.owner(thread, "u", lsn).reply(thread, "r", lsn + 1);
    return commitRevoke(fx.db, { kind: "line", threadId: thread, messageIds: ["u"], cause: "forget" }, { inline: false });
  }
  function settle(target: SliceTarget) {
    fx.db.exec("BEGIN IMMEDIATE");
    const measurement = beginRevokeMeasure(fx.db);
    try {
      const result = admitMarkerSlice(fx.db, 4096, 1000, null, target, "drain");
      fx.db.exec("COMMIT");
      endRevokeMeasure(fx.db, measurement);
      return result;
    } catch (error) {
      if (fx.db.isTransaction) {
        fx.db.exec("ROLLBACK");
        endRevokeMeasure(fx.db, measurement, false, false);
      }
      throw error;
    }
  }
  const job = (id: number) => fx.db.prepare("SELECT * FROM memory_revoke_jobs WHERE revoke_id=?").get(id);
  const pending = (id: number) => fx.db.prepare("SELECT * FROM memory_deny_pending WHERE revoke_id=? ORDER BY thread_id,since_lsn").all(id);
  const frontier = (id: number) => fx.db.prepare("SELECT * FROM memory_revoke_frontier WHERE revoke_id=? ORDER BY seq").all(id);

  it.each(["line", "bulk", "deletion"])("a flow tick stops before the next %s job, which has not been validated", kind => {
    const selected = content("selected", 2000);
    const next = content("next", 3000);
    if (kind === "bulk") fx.db.prepare("UPDATE memory_revoke_jobs SET kind='bulk',root=? WHERE revoke_id=?").run('{"kind":"bulk","cause":"fold"}', next);
    if (kind === "deletion") fx.db.prepare("UPDATE memory_revoke_jobs SET kind='thread',root=? WHERE revoke_id=?").run('{"kind":"thread","threadId":"next","cause":"delete-conversation"}', next);
    const before = { job: job(next), pending: pending(next), frontier: frontier(next) };

    expect(settle({ kind: "flows" })).toMatchObject({ admitted: true, outcome: "progress" });
    expect(job(selected)?.phase).toBe("mark");
    expect({ job: job(next), pending: pending(next), frontier: frontier(next) }).toEqual(before);
    // The selected flow's marks and own pending work belong to a later, reclassified tick.
    expect(frontier(selected).some(row => Number(row.seq) > 0)).toBe(true);
    expect(pending(selected).some(row => row.thread_id === "selected")).toBe(true);
  });

  it("flow settlement uses indexed job selection without the legacy fold probe", () => {
    fx.db.exec("BEGIN");
    for (let id = 1; id <= 10000; id++) fx.job(id, 1, "done");
    fx.db.exec("COMMIT");
    const selected = content("selected", 2000);
    const legacy = vi.fn(() => { throw new Error("legacy fold scan"); });
    setFoldHooks({ need: () => 0, pending: legacy, slice: () => null });
    const prepare = vi.spyOn(fx.db, "prepare");
    expect(settle({ kind: "flows" })).toMatchObject({ admitted: true, outcome: "progress" });
    expect(job(selected)?.phase).toBe("mark");
    expect(legacy).not.toHaveBeenCalled();
    const queries = prepare.mock.calls.map(([sql]) => sql).filter(sql =>
      sql.includes("FROM memory_revoke_jobs") && sql.includes("LIMIT 1") && !sql.includes("revoke_id=?"));
    prepare.mockRestore();
    expect(queries).toHaveLength(2);
    const plans = queries.map(sql => fx.db.prepare("EXPLAIN QUERY PLAN " + sql).all().map(row => row.detail).join("\n"));
    expect(plans.some(plan => plan.includes("USING INDEX memory_revoke_jobs_seeding_fold"))).toBe(true);
    expect(plans.join("\n")).toMatch(/USING (?:COVERING )?INDEX memory_revoke_jobs_active_flow/);
    console.info("settlement job query plans", plans);
    for (const plan of plans) expect(plan).not.toContain("USE TEMP B-TREE");
  });

  it.each(["memory_revoke_jobs_seeding_fold", "memory_revoke_jobs_active_flow"])("refuses flow settlement when %s is absent", index => {
    const selected = content("selected", 2000);
    fx.db.exec(`DROP INDEX ${index}`);
    const before = job(selected);
    expect(() => settle({ kind: "flows" })).toThrow(/no such index/);
    expect(job(selected)).toEqual(before);
    expect(fx.db.isTransaction).toBe(false);
  });

  it("a seeding fold blocks flow settlement even without a registered legacy hook", () => {
    const selected = content("selected", 2000);
    fx.job(selected + 1, 3000, "seeding");
    fx.db.prepare("UPDATE memory_revoke_jobs SET kind='bulk',root=? WHERE revoke_id=?")
      .run('{"kind":"bulk","cause":"fold"}', selected + 1);
    const before = job(selected);
    expect(settle({ kind: "flows" })).toMatchObject({ admitted: true, outcome: "blocked", cause: "fold-seeding", changed: 0 });
    expect(job(selected)).toEqual(before);
  });

  function readyToFinish() {
    for (let id = 1; id <= 100; id++) fx.job(id, 1, "done");
    const selected = content("selected", 2000);
    fx.job(selected + 1, 3000, "done"); // the selected job is not the maximum id
    return selected;
  }
  it.each([
    ["admission", "tidy"], ["detailed", "tidy"], ["admission", "undo"], ["detailed", "undo"],
  ])("%s only completes %s without pruning finished jobs", (entry, phase) => {
    const selected = readyToFinish();
    if (phase === "undo") fx.db.prepare("UPDATE memory_revoke_jobs SET phase='undo',state='undoing' WHERE revoke_id=?").run(selected);
    const unrelated = () => fx.db.prepare("SELECT * FROM memory_revoke_jobs WHERE revoke_id<>? ORDER BY revoke_id").all(selected);
    const before = unrelated();
    if (entry === "admission") expect(settle({ kind: "only", revokeId: selected })).toMatchObject({ admitted: true, outcome: "progress" });
    else {
      fx.db.exec("BEGIN IMMEDIATE");
      expect(markerSliceDetailed(fx.db, 4096, 1000, null, 10000, { only: selected })).toEqual({ outcome: "progress" });
      fx.db.exec("COMMIT");
    }
    expect(unrelated()).toEqual(before);
    expect(job(selected)?.state).toBe(phase === "undo" ? "undone" : "done");
    expect(pending(selected)).toEqual([]);
    expect(frontier(selected)).toEqual([]);
  });

  it("the legacy only wrapper retains finished-job pruning", () => {
    const selected = readyToFinish();
    fx.db.exec("BEGIN IMMEDIATE");
    expect(markerSlice(fx.db, 4096, 1000, null, 10000, { only: selected })).toBe(true);
    fx.db.exec("COMMIT");
    expect(fx.db.prepare("SELECT revoke_id FROM memory_revoke_jobs ORDER BY revoke_id").all()).toEqual([{ revoke_id: selected + 1 }]);
    expect(pending(selected)).toEqual([]);
  });
});
