// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOOT-SETTLE-108 (docs/designs/BOOT-SETTLE-HELD-SENDS-108.md section 6, the frozen timing protocol): 100,000 expired owner holds under FULL and WAL, the
// real Store and real registered controls across 100 conversations. Setup is outside the timing; no fake timers; one run each, no reruns.
//  - exactly 1,000 write-bearing outer cleanup commits, at most 100 rows between two turns of the event loop, no provider start, all cleaned after reopening
//  - every unit (its BEGIN through its COMMIT and the synchronous effects after it): p95 under 250 ms, max under 1,000 ms
//  - activeMs(100k) <= max(60 s, 15 x the slower of a 10k run before and after)
//  - receipt-bearing units measured on their own; a reader pinned across pages, then released, and the checkpoint catches up; a failed COMMIT retried
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { SETTLE_PAGE, _resetPending, appendHeldLine, heldLineId, onDelegationReceipt, settleStartedDelegations } from "./delegations.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { Store } from "./store.ts";
import { afterCommit } from "./tx-scope.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { dispatchHandoffRequest } from "./testing/handoff-turn.ts";
import { LINEAGE } from "./testing/handoff-worlds.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const count = (sql: string) => Number((database().prepare(sql).get() as { n: number }).n);
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); };
beforeEach(fresh);
afterEach(() => { vi.restoreAllMocks(); onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
/** `n` expired owner holds across 100 conversations, each with its real line and registration, written in one setup commit (outside the timing). */
function seed(n: number): { store: Store; threads: string[] } {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bots = Array.from({ length: 100 }, () => store.createBot());
  const target = store.createBot();
  const insert = database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES(?,?,?,?,'started',NULL,'{\"message\":\"m\",\"depth\":0,\"attempts\":0}','owner',?,1,NULL)");
  transaction(() => {
    for (let i = 0; i < n; i++) {
      const bot = bots[i % 100]!, id = `h${String(i).padStart(6, "0")}`;
      insert.run(id, bot.threadId, target.id, bot.id, `dlg-${id}`);
      appendHeldLine(store, { id, sourceThreadId: bot.threadId, toBotId: target.id, fromBotId: bot.id, toBotName: "Helper", text: "held" });
    }
  }, { op: "boot-settle-108-seed" });
  return { store, threads: bots.map((bot) => bot.threadId) };
}
/** Runs the boot settling once and measures it: every unit's synchronous time (the gap between two turns of the event loop), the commits, the rows per turn. */
async function measured(store: Store): Promise<{ activeMs: number; wallMs: number; units: number[]; commits: number; worstRows: number }> {
  let commits = 0, marked = false, inTurn = 0, worstRows = 0;
  const counting = {
    patchMessage: (thread: string, id: string, patch: Parameters<Store["patchMessage"]>[2], within?: () => void) => store.patchMessage(thread, id, patch, () => {
      if (!marked) { marked = true; afterCommit(() => { commits++; marked = false; }); }
      inTurn++;
      within?.();
    }),
  };
  const units: number[] = [];
  let over = false;
  const started = performance.now();
  let last = started;
  const ticker = (async () => {
    while (!over) {
      await tick();
      const now = performance.now();
      units.push(now - last);
      last = now;
      worstRows = Math.max(worstRows, inTurn);
      inTurn = 0;
    }
  })();
  await settleStartedDelegations({ store: counting });
  over = true;
  await ticker;
  const wallMs = performance.now() - started;
  return { activeMs: units.reduce((sum, gap) => sum + gap, 0), wallMs, units, commits, worstRows };
}

describe("100,000 eligible expired holds under FULL", () => {
  it("1,000 outer commits, a page per turn, units within budget, activeMs within the calibrated bound, everything cleaned after reopening", { tags: ["perf-budget"], timeout: 600_000 }, async () => {
    const calibrate = async (): Promise<number> => {
      fresh();
      const { store } = seed(10_000);
      const run = await measured(store);
      expect(run.commits).toBe(100);
      return run.activeMs;
    };
    const before = await calibrate();
    fresh();
    const { store, threads } = seed(100_000);
    expect(database().prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
    expect(database().prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    let starts = 0;
    onDelegationReceipt(() => { starts++; });
    const run = await measured(store);
    const after = await calibrate();
    const p95 = percentile(run.units, 95), max = Math.max(...run.units);
    console.log(`boot-settle-108 perf: 100k activeMs=${run.activeMs.toFixed(0)} wallMs=${run.wallMs.toFixed(0)} units=${run.units.length} p95=${p95.toFixed(1)} max=${max.toFixed(1)} commits=${run.commits} 10k before=${before.toFixed(0)} after=${after.toFixed(0)}`);
    expect(run.commits).toBe(1_000);
    expect(run.worstRows).toBeLessThanOrEqual(SETTLE_PAGE);
    expect(starts).toBe(0);
    expect(p95).toBeLessThan(250);
    expect(max).toBeLessThan(1_000);
    expect(run.activeMs).toBeLessThanOrEqual(Math.max(60_000, 15 * Math.max(before, after)));
    void threads;
  });
  it("after reopening, no row, no registration and no control is left (the 100k run's own end state, at 10k scale)", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
    const { store, threads } = seed(10_000);
    await settleStartedDelegations({ store });
    closeDatabase();
    const reopened = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE json_extract(json,'$.delegationHeld') IS NOT NULL")).toBe(0);
    threads.slice(0, 5).forEach((thread, k) => {
      const line = reopened.messageById(thread, heldLineId(`h${String(k).padStart(6, "0")}`));
      expect(line).toBeDefined();
      expect(line?.delegationHeld).toBeUndefined();
    });
  });
});

describe("receipt-bearing units, a pinned reader and a failed COMMIT", () => {
  it("150 held room hand-offs with live requests: one receipt per unit, each unit within the same budget", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const from = store.createBot(), target = store.createBot();
    for (let i = 0; i < 150; i++) {
      const id = `r${String(i).padStart(4, "0")}`;
      insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId: from.id, toBotId: target.id, returnThreadId: from.threadId, returnBotId: from.id, admissionKey: `ask:delegation:${id}`, now: 2, lineage: LINEAGE(from.threadId) });
      dispatchHandoffRequest(database(), id, { now: 2 });
      database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES(?,?,?,?,'started',NULL,'{\"message\":\"m\",\"depth\":0,\"attempts\":0}','room',?,?,NULL)")
        .run(id, from.threadId, target.id, from.id, `dlg-${id}`, Date.now());
    }
    let receipts = 0, inTurn = 0, worst = 0;
    onDelegationReceipt((receipt) => {
      receipts++; inTurn++;
      const row = roomRequest(database(), receipt.id);
      if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: "failed", now: Date.now() });
    });
    const units: number[] = [];
    let over = false, last = performance.now();
    const ticker = (async () => { while (!over) { await tick(); const now = performance.now(); units.push(now - last); last = now; worst = Math.max(worst, inTurn); inTurn = 0; } })();
    await settleStartedDelegations({ store, botName: () => "Helper" });
    over = true; await ticker;
    console.log(`boot-settle-108 perf: receipt units=${units.length} p95=${percentile(units, 95).toFixed(1)} max=${Math.max(...units).toFixed(1)}`);
    expect(receipts).toBe(150);
    expect(worst).toBeLessThanOrEqual(1);
    expect(percentile(units, 95)).toBeLessThan(250);
    expect(Math.max(...units)).toBeLessThan(1_000);
  });
  it("a reader pinned across the SQL pages holds the WAL; once released a checkpoint catches up, and nothing committed is lost", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
    const { store } = seed(2_000);
    const file = join(DATA_DIR, "messages.db");
    const reader = new DatabaseSync(file, { readOnly: true });
    reader.exec("BEGIN");
    expect(Number((reader.prepare("SELECT COUNT(*) AS n FROM pending_delegations").get() as { n: number }).n)).toBe(2_000);   // the snapshot is pinned
    await settleStartedDelegations({ store });
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(Number((reader.prepare("SELECT COUNT(*) AS n FROM pending_delegations").get() as { n: number }).n)).toBe(2_000);   // still its old snapshot
    const pinned = database().prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
    reader.exec("COMMIT");
    reader.close();
    const caught = database().prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
    expect(pinned.log).toBeGreaterThan(0);
    expect(pinned.checkpointed).toBeLessThan(pinned.log);                                          // the pinned reader held the WAL back
    expect(caught.checkpointed).toBe(caught.log);                                                  // released, the checkpoint catches up
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
  });
  it("a batch that fails before its COMMIT rolls back whole and is retried by itself: the committed batches stay, the rest finishes, FULL throughout", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
    const { store } = seed(300);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let patches = 0, failed = false;
    const faulty = {
      patchMessage: (thread: string, id: string, patch: Parameters<Store["patchMessage"]>[2], within?: () => void) => store.patchMessage(thread, id, patch, () => {
        patches++;
        // the second batch's last row: the disk refuses it, so the batch's COMMIT never comes
        if (!failed && patches === 200) { failed = true; throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 778 }); }
        within?.();
      }),
    };
    const settling = settleStartedDelegations({ store: faulty });
    // the first batch committed before the failure; after the 1 s retry the rest goes
    await settling;
    expect(failed).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    expect(database().prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
  });
});
