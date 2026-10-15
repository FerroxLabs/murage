// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 30, item 5 (Fable r28 P3 "every pump re-admits 8 heads per bot"): the server's pump works only on the teams an event made ready, a bounded number of
// bots per pump, never a page of waiting heads per bot. Statements per pump are the same with 10 and with 500 bots that each have waiting teams. Fails on
// 7f28cf52b (there the pump drained every bot, each waking 8 waiting heads).
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _resetPending, onDelegationReceipt } from "./delegations.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { botsWithReadyTeams } from "./shared-ready.ts";
import { _resetDrainDiagnostics, _resetSharedPump, _sharedSweepDueAt, pumpSharedWork } from "./shared-work.ts";
import { sharedWorld } from "./testing/handoff-worlds.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const fresh = () => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); _resetSharedPump(); };
beforeEach(fresh);
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

function counted(db: DatabaseSync, run: () => void): number {
  let statements = 0;
  const original = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = original(sql);
    for (const key of ["all", "get", "run", "iterate"] as const) {
      const fn = (statement[key] as (...a: unknown[]) => unknown).bind(statement);
      (statement as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => { statements++; return fn(...args); };
    }
    return statement;
  };
  try { run(); } finally { (db as { prepare: unknown }).prepare = original; }
  return statements;
}
const COLUMNS = "id,root_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,created_at,deadline_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key,execution_audience";

/** `bots` other bots, each with three teams whose heads wait (their teammate is not listed); then one hand-off for Iris arrives and the server pumps. */
async function measure(bots: number): Promise<{ quiet: number; event: number; started: string[] }> {
  fresh();
  const w = sharedWorld();
  const db = database();
  const insert = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?,?)`);
  const provenance = db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  db.exec("BEGIN");
  for (let b = 0; b < bots; b++) for (let t = 0; t < 3; t++) {
    const id = `r-${b}-${t}`;
    insert.run(id, id, "g", "ask", "bot", `bot-${String(b).padStart(4, "0")}`, `x-${b}-${t}`, "queued", 1_000 + t, Date.now() + 86_400_000, "t", `key-${id}`, JSON.stringify({ kind: "team", team: `T${t}` }));
    provenance.run(id);
  }
  db.exec("COMMIT");
  const now = Date.now();
  // the start: every team is looked at once (it entered ready, and the first sweep of the process), then everything waits
  for (let pump = 0; pump < 5_000; pump++) {
    pumpSharedWork(now);
    await tick();
    const due = _sharedSweepDueAt();
    if (due !== undefined && due > now && botsWithReadyTeams(db, "", 1).length === 0) break;
  }
  expect(botsWithReadyTeams(db, "", 1)).toEqual([]);
  expect((db.prepare("SELECT count(*) AS n FROM shared_ready_teams WHERE waiting=1").get() as { n: number }).n).toBe(bots * 3);
  // a pump with no event: nothing is ready, nothing waiting is looked at
  const quiet = counted(db, () => pumpSharedWork(now));
  // an event: one hand-off for Iris; the pump drains Iris alone
  w.handoff("E1");
  const event = counted(db, () => pumpSharedWork(now));
  await tick(); await tick();
  return { quiet, event, started: w.turns.map((turn) => turn.id) };
}

describe("5. a pump's work does not grow with the number of bots", () => {
  it("10 vs 500 bots with waiting teams: the same statements for a quiet pump and for a pump after one event, and the event's hand-off starts", async () => {
    const small = await measure(10), large = await measure(500);
    expect(small.started).toEqual(["E1"]);
    expect(large.started).toEqual(["E1"]);
    expect(large.quiet).toBe(small.quiet);
    expect(large.event).toBe(small.event);
    expect(small.quiet).toBeLessThanOrEqual(2);
  }, 300_000);
});
