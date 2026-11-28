// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H W19 (designs/HOOKS-LINEAGE-1023.md r2 section 5, Opus r2 H2): going back while a connected-app result is still owed refuses in
// the downgrade's read-only preflight, on the step back to 1.0.17 (--to 13) and on older targets, and removes nothing (schema, rows, files).
// With nothing owed, every L5H object leaves on every target, and on 13 app_event_runs keeps exactly the columns 1.0.17 knows.
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppTriggerStore, L5H_OBJECTS } from "./app-trigger-store.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** app_event_runs as 1.0.17 made it (app-trigger-store.ts before L5H). */
const RUNS_COLUMNS_117 = ["run_id", "batch_id", "trigger_id", "routine_id", "bot_id", "owner_account_id", "subscription_id", "policy_digest", "billing_ref", "state",
  "wait_reason", "retry_at", "flux_revision", "reserve_receipt", "start_receipt", "submitted", "thread_id", "generation", "renew_due_at", "child_refusal", "child_card",
  "child_card_written", "child_creates", "child_handoffs", "created_at", "updated_at"];

/** Every L5H object by name, written out here and not read from L5H_OBJECTS, so a name missing from that list is a leftover this test sees. */
const L5H_NAMES = ["app_origin_threads", "app_event_turns", "event_result_routes", "app_origin_threads_card_owed", "app_event_turns_run", "app_event_runs_result_owed"];

const objects = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
/** What the owner keeps: every schema object with its SQL and every app run row (files: none removed, checked beside it). The PREP write that runs
 * before every preflight (markInFlightSpeechInterrupted) may touch file bytes, so bytes are not the measure; nothing may be removed. */
const ownerState = () => {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try {
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
    const runs = db.prepare("SELECT * FROM app_event_runs ORDER BY run_id").all();
    return JSON.stringify({ schema, runs });
  } finally { db.close(); }
};

const files = () => readdirSync(DATA_DIR).filter(name => !/-(wal|shm)$/.test(name));

function seedRun(resultState: "owed" | "done") {
  const db = database();
  new AppTriggerStore(db);
  db.prepare(`INSERT INTO app_event_runs (run_id, batch_id, trigger_id, routine_id, bot_id, owner_account_id, subscription_id, policy_digest, state, created_at, updated_at, result_state)
    VALUES ('00000000-0000-4000-8000-00000000000a','b1','trg-1','r-1','bot-a','acct_owner_a','754ff2fc-423d-5573-bded-ccf9fb7cde23','d','completed',1,1,?)`).run(resultState);
  closeDatabase();
}

describe("W19 downgrade with a connected-app result owed", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); });

  it.each([13, 12, 6] as const)("--to %i refuses in the preflight, names what clears it, and removes nothing", async (to) => {
    seedRun("owed");
    const before = ownerState(), filesBefore = files();
    await expect(downgradeInstallationMemorySchema(DATA_DIR, to, { testOnlyBefore102: true })).rejects.toThrow("1 result is waiting. Open the automation to see why, or delete it.");
    expect(ownerState()).toBe(before);
    expect(filesBefore.filter(name => !files().includes(name))).toEqual([]);
  });

  // 6 is the step back to 1.0.1 (downgradeApplicationSchemaTo101): the results chat route table leaves on it too (pm-sends-102-r22 census)
  it.each([13, 12, 6] as const)("--to %i with nothing owed leaves no L5H object; on 13 app_event_runs has exactly the 1.0.17 columns", async (to) => {
    seedRun("done");
    const before = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(objects(before)).toContain("event_result_routes"); } finally { before.close(); }
    await downgradeInstallationMemorySchema(DATA_DIR, to, { testOnlyBefore102: true });
    const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try {
      expect(objects(after).filter(name => L5H_NAMES.includes(name) || (L5H_OBJECTS as readonly string[]).includes(name))).toEqual([]);
      if (to === 13) expect((after.prepare("SELECT name FROM pragma_table_info('app_event_runs')").all() as Array<{ name: string }>).map(row => row.name)).toEqual(RUNS_COLUMNS_117);
    } finally { after.close(); }
  });
});
