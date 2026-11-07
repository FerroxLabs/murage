// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// CHARGE-UNKNOWN-1018 (ruling A-prime, no schema change). A turn whose steps did not all report a charge keeps the known
// sum as a real charge, marked as a lower bound: the driver sends chargePartial, the ledger keeps charge_kind 'charge'
// with ':partial' before the ':dispatch:<n>' tail, the rollup keeps the mark, and projectUsage reports
// chargeIsLowerBound from the same grouped SELECT. A retry of the same turn settles once whichever key form it carries.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldStepCharge, turnCharge } from "./drivers/openai-chat.ts";
import { initializeProjectTables, rollupUsageLedger } from "./project-tables.ts";
import { completeRequest, insertRoomRequest, roomRequest } from "./room-requests.ts";
import { projectUsage, settleProjectUsage, settleSharedWorkOwnerTurn } from "./usage-ledger.ts";
import { createSharedOwnerUsage, type SharedOwnerEvent } from "./shared-owner-usage.ts";

describe("driver: a turn charge with a step that reported none", () => {
  const step = (charge?: number) => ({ input: 10, output: 5, ...(charge === undefined ? {} : { charge }) });
  const fold = (steps: Array<ReturnType<typeof step> | null>) => steps.reduce((gap, usage) => foldStepCharge(gap, usage), false);

  it("is the exact charge when every step reported one", () => {
    expect(fold([step(0.1), step(0.2)])).toBe(false);
    expect(turnCharge({ input: 20, output: 10, charge: 0.3 }, false)).toEqual({ charge: 0.3 });
  });
  it("keeps the known sum and marks it partial when a later step has no charge", () => {
    expect(fold([step(0.1), step()])).toBe(true);
    expect(turnCharge({ input: 20, output: 10, charge: 0.1 }, true)).toEqual({ charge: 0.1, chargePartial: true });
  });
  it("marks it partial when the first step has no charge, or a step sent no usage at all", () => {
    expect(fold([step(), step(0.2)])).toBe(true);
    expect(fold([step(0.2), null])).toBe(true);
  });
  it("has no charge at all when no step reported one (nothing to call a lower bound)", () => {
    expect(turnCharge({ input: 20, output: 10 }, true)).toEqual({});
    expect(turnCharge(null, true)).toEqual({});
  });
  it("keeps a known zero exact", () => {
    expect(turnCharge({ input: 0, output: 0, charge: 0 }, false)).toEqual({ charge: 0 });
  });
});

let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); });
afterEach(() => db.close());
function request(thread = "room", now = 1000) {
  return insertRoomRequest(db, { groupId: "g", projectGoalId: "goal", workItemId: "card", attempt: 1,
    verb: "room_turn", fromKind: "owner", toBotId: "bot", targetThreadId: thread,
    admissionKey: thread + now, now, state: "running",
    lineage: { rootThreadId: thread, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
}
const terminal = { threadId: "room", botId: "bot", engine: "openai-compat", turnGeneration: "gen", providerTurnId: "one", at: 6000, ok: true, usage: { input: 100, output: 20 } };
const rows = () => db.prepare("SELECT settle_key, charge, charge_kind FROM usage_ledger ORDER BY settle_key").all() as Array<{ settle_key: string; charge: number | null; charge_kind: string }>;

describe("ledger: a lower-bound charge", () => {
  it("keeps charge_kind 'charge' with the known sum, the mark before the dispatch tail, and reports chargeIsLowerBound", () => {
    const r = request();
    expect(settleProjectUsage(db, r, { ...terminal, charge: 0.25, chargePartial: true })).toBe(true);
    expect(rows()).toEqual([{ settle_key: `turn:${JSON.stringify(["room", "one"])}:partial:dispatch:${r.dispatchedAt}`, charge: 0.25, charge_kind: "charge" }]);
    const usage = projectUsage(db, { groupId: "g" });
    expect(usage.totals).toMatchObject({ charge: 0.25, chargeIsLowerBound: true });
    expect(usage.byBot[0]).toMatchObject({ botId: "bot", chargeIsLowerBound: true });
  });
  it("leaves an exact charge exact, and an exact plus a partial turn is a lower bound", () => {
    settleProjectUsage(db, request("room", 1000), { ...terminal, charge: 0.1 });
    expect(projectUsage(db, { groupId: "g" }).totals).toMatchObject({ charge: 0.1, chargeIsLowerBound: false });
    settleProjectUsage(db, request("desk", 2000), { ...terminal, threadId: "desk", providerTurnId: "two", charge: 0.2, chargePartial: true });
    const totals = projectUsage(db, { groupId: "g" }).totals;
    expect(totals.charge).toBeCloseTo(0.3, 10);
    expect(totals.chargeIsLowerBound).toBe(true);
  });
  it("marks nothing when the turn had no charge to qualify", () => {
    const r = request();
    settleProjectUsage(db, r, { ...terminal, chargePartial: true });
    expect(rows()).toEqual([{ settle_key: `turn:${JSON.stringify(["room", "one"])}:dispatch:${r.dispatchedAt}`, charge: null, charge_kind: "none" }]);
    expect(projectUsage(db, { groupId: "g" }).totals).toMatchObject({ charge: null, chargeIsLowerBound: false });
  });
  it("settles a retried turn once, whichever key form the first and the repeat carry", () => {
    const r = request();
    expect(settleProjectUsage(db, r, { ...terminal, charge: 0.25, chargePartial: true })).toBe(true);
    expect(settleProjectUsage(db, r, { ...terminal, charge: 0.25, chargePartial: true })).toBe(false);
    expect(settleProjectUsage(db, r, { ...terminal, charge: 0.4 })).toBe(false);
    const r2 = request("desk", 2000);
    const desk = { ...terminal, threadId: "desk", providerTurnId: "two" };
    expect(settleProjectUsage(db, r2, { ...desk, charge: 0.4 })).toBe(true);
    expect(settleProjectUsage(db, r2, { ...desk, charge: 0.25, chargePartial: true })).toBe(false);
    expect(rows()).toHaveLength(2);
    expect(projectUsage(db, { groupId: "g" }).totals.charge).toBeCloseTo(0.65, 10);
  });
  it("replaces an unknown row once and is itself seen by a later unknown settle", () => {
    const r = request();
    completeRequest(db, r.id, { state: "unknown", now: 9000 });
    settleProjectUsage(db, roomRequest(db, r.id)!, { ...terminal, unknown: true, at: 9000, lastActivityAt: 8000 });
    expect(settleProjectUsage(db, r, { ...terminal, charge: 0.25, chargePartial: true })).toBe(true);
    expect(settleProjectUsage(db, roomRequest(db, r.id)!, { ...terminal, unknown: true, at: 9500, lastActivityAt: 9000 })).toBe(false);
    expect(rows()).toEqual([{ settle_key: `turn:${JSON.stringify(["room", "one"])}:partial:dispatch:${r.dispatchedAt}`, charge: 0.25, charge_kind: "charge" }]);
  });
  it("keeps the mark through the rollup, in its own bucket, with the older key form unchanged", () => {
    const r = request("room", 0);
    settleProjectUsage(db, r, { ...terminal, providerTurnId: "a", at: 1000, charge: 0.1 });
    settleProjectUsage(db, r, { ...terminal, providerTurnId: "b", at: 1001, charge: 0.2, chargePartial: true });
    rollupUsageLedger(db, 200 * 86400000);
    const rolled = rows();
    expect(rolled).toHaveLength(2);
    expect(rolled.every(row => row.settle_key.startsWith("rollup:g:1970-01-01:") && row.charge_kind === "charge")).toBe(true);
    expect(rolled.filter(row => row.settle_key.endsWith(":partial")).map(row => row.charge)).toEqual([0.2]);
    expect(rolled.filter(row => !row.settle_key.endsWith(":partial"))[0]!.settle_key).toMatch(/^rollup:g:1970-01-01:[0-9a-f]{16}$/);
    expect(projectUsage(db, { groupId: "g" }).totals).toMatchObject({ chargeIsLowerBound: true });
    rollupUsageLedger(db, 200 * 86400000);
    expect(rows()).toEqual(rolled);
  });
  it("does not read a provider turn id that merely contains the marker text as a lower bound", () => {
    settleProjectUsage(db, request(), { ...terminal, providerTurnId: "x:partial:dispatch:7", charge: 0.1 });
    expect(projectUsage(db, { groupId: "g" }).totals).toMatchObject({ charge: 0.1, chargeIsLowerBound: false });
  });
});

describe("shared-owner turns (Astra CH14 #1)", () => {
  const ownerRows = () => db.prepare("SELECT settle_key, charge, charge_kind FROM usage_ledger WHERE settle_key GLOB 'shared-owner:*' OR settle_key GLOB 'rollup:*' ORDER BY settle_key").all() as Array<{ settle_key: string; charge: number | null; charge_kind: string }>;
  const owner = { threadId: "work", botId: "bot", teamId: "team", ownerMessageId: "m", engine: "openai-compat", startedAt: 0, at: 1000, ok: true, usage: { input: 1, output: 2 } };
  function complete(generation: string, event: Partial<SharedOwnerEvent>) {
    const usage = createSharedOwnerUsage<SharedOwnerEvent>((threadId, run, outcome) => {
      settleSharedWorkOwnerTurn(db, { ...owner, threadId, turnGeneration: run.generation, providerTurnId: outcome.turnId, ...outcome, usage: outcome.usage as { input: number; output: number } });
    });
    usage.begin("work", { generation, botId: "bot", teamId: "team", messageId: "m", engine: "openai-compat", startedAt: 0, ownerWaitMs: 0, asks: new Set() });
    if (event.turnId) usage.accepted("work", generation, event.turnId);
    usage.observe({ type: "turn.completed", threadId: "work", ok: true, usage: { input: 1, output: 2 }, ...event }, generation);
  }
  it("a partly costed owner turn keeps its mark from the completion to the row", () => {
    complete("g1", { turnId: "p1", charge: 0.25, chargePartial: true });
    complete("g2", { turnId: "p2", charge: 0.5 });
    expect(ownerRows()).toEqual([
      { settle_key: "shared-owner:g1:partial", charge: 0.25, charge_kind: "charge" },
      { settle_key: "shared-owner:g2", charge: 0.5, charge_kind: "charge" },
    ]);
  });
  it("settles once whichever key form the first and the repeat carry, and marks nothing without a charge", () => {
    const at = { ...owner, turnGeneration: "g3" };
    expect(settleSharedWorkOwnerTurn(db, { ...at, charge: 0.25, chargePartial: true })).toBe(true);
    expect(settleSharedWorkOwnerTurn(db, { ...at, charge: 0.25 })).toBe(false);
    expect(settleSharedWorkOwnerTurn(db, { ...at, charge: 0.25, chargePartial: true })).toBe(false);
    const exact = { ...owner, turnGeneration: "g4" };
    expect(settleSharedWorkOwnerTurn(db, { ...exact, charge: 0.1 })).toBe(true);
    expect(settleSharedWorkOwnerTurn(db, { ...exact, charge: 0.1, chargePartial: true })).toBe(false);
    expect(settleSharedWorkOwnerTurn(db, { ...owner, turnGeneration: "g5", chargePartial: true })).toBe(true);
    expect(ownerRows().map(row => row.settle_key)).toEqual(["shared-owner:g3:partial", "shared-owner:g4", "shared-owner:g5"]);
  });
  it("keeps the mark through the rollup, in its own bucket", () => {
    settleSharedWorkOwnerTurn(db, { ...owner, turnGeneration: "a", charge: 0.1 });
    settleSharedWorkOwnerTurn(db, { ...owner, turnGeneration: "b", at: 1001, charge: 0.2, chargePartial: true });
    rollupUsageLedger(db, 200 * 86400000);
    const rolled = ownerRows();
    expect(rolled).toHaveLength(2);
    expect(rolled.every(row => row.settle_key.startsWith("rollup:") && row.charge_kind === "charge")).toBe(true);
    expect(rolled.filter(row => row.settle_key.endsWith(":partial")).map(row => row.charge)).toEqual([0.2]);
    rollupUsageLedger(db, 200 * 86400000);
    expect(ownerRows()).toEqual(rolled);
  });
});
