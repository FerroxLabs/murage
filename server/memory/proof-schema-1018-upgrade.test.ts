// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: fprod4-sqlite-build4-par owns boot validation; trainred-proofschema owns proof installation/readers and these witnesses.
// The memory lane owns the reclaim transaction in memory/root-set-reclaim.ts.
// The two files in testdata were written by 1.0.18's own server (f452ac5c97, memory v13, no session-proof objects yet): v13-1018-fresh.db.gz after a
// first start and a bot, v13-1018-reclaimed.db.gz after 1.0.18's own root-set reclaim handed memory_session_roots back (and 1.0.18 opened it again).
// Both must keep opening, start after start, with every proof trigger whose table is there; the reclaimed state is accepted only without the
// table the two root triggers guard, never for a file that still has it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { stopRecallViewMaintenance } from "./recall-view.ts";
import { ROOT_SET_RECLAIM_TABLES, runReclaimStep } from "./root-set-reclaim.ts";
import { validateMemorySchema } from "./schema.ts";
import { proofModule, setupProofFixture } from "./session-proof-fixture.ts";
const SESSION_PROOF_ROOT_TRIGGERS = ["memory_session_proof_root_insert", "memory_session_proof_root_update"] as const;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

const RECEIPT_LINE_TRIGGERS = ["memory_session_proof_receipt_line_insert", "memory_session_proof_receipt_line_update"] as const;
const present = (db: DatabaseSync, names: readonly string[]) => names.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version);
/** The 1.0.18 file as this build's start opens it (database(): message tables, then migrateMemorySchema, which validates first). */
function open1018(name: "fresh" | "reclaimed"): DatabaseSync {
  writeFileSync(join(DATA_DIR, "messages.db"), gunzipSync(readFileSync(new URL(`./testdata/v13-1018-${name}.db.gz`, import.meta.url))));
  return database();
}
const restart = () => { closeDatabase(); return database(); };
function reclaim(db: DatabaseSync) {
  for (let guard = 0; ; guard++) {
    if (guard > 10_000) throw new Error("the reclaim never ended");
    const { step } = runReclaimStep(db, { freeDiskBytes: () => null });
    if (step.kind === "done" || step.kind === "vacuum") return;
  }
}

it("1.0.18's file goes through the 1.0.19 start, this build's reclaim, and three more starts", () => {
  let db = open1018("fresh");
  expect(version(db)).toBe(13);
  expect(present(db, ["memory_session_roots", ...SESSION_PROOF_ROOT_TRIGGERS, ...RECEIPT_LINE_TRIGGERS])).toHaveLength(5);
  db = restart();
  reclaim(db);
  expect(present(db, ROOT_SET_RECLAIM_TABLES)).toEqual([]);
  expect(present(db, SESSION_PROOF_ROOT_TRIGGERS)).toEqual([]);
  for (let start = 0; start < 3; start++) {
    db = restart();
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(present(db, RECEIPT_LINE_TRIGGERS)).toEqual([...RECEIPT_LINE_TRIGGERS]);
  }
});

it("a file 1.0.18's own reclaim handed back opens, start after start, with the receipt-line proof triggers made", () => {
  let db = open1018("reclaimed");
  expect(version(db)).toBe(13);
  expect(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()?.value).toBe(1);
  expect(present(db, ["memory_session_roots"])).toEqual([]);
  // the empty-checkpoint invalidation on receipt lines does not depend on the handed-back table
  expect(present(db, RECEIPT_LINE_TRIGGERS)).toEqual([...RECEIPT_LINE_TRIGGERS]);
  for (let start = 0; start < 3; start++) {
    db = restart();
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(present(db, RECEIPT_LINE_TRIGGERS)).toEqual([...RECEIPT_LINE_TRIGGERS]);
  }
});

for (const trigger of SESSION_PROOF_ROOT_TRIGGERS) it(`never weakened: a file that still has memory_session_roots (with a root row) and lacks ${trigger} is refused`, () => {
  const db = open1018("fresh");
  db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES('fixture-thread','fixture-engine','fixture-session','')").run();
  expect(() => validateMemorySchema(db)).not.toThrow();
  db.exec(`DROP TRIGGER ${trigger}`);
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

for (const trigger of RECEIPT_LINE_TRIGGERS) for (const name of ["fresh", "reclaimed"] as const) it(`never weakened: the ${name} 1.0.18 file without ${trigger} is refused`, () => {
  const db = open1018(name);
  expect(() => validateMemorySchema(db)).not.toThrow();
  db.exec(`DROP TRIGGER ${trigger}`);
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

it("never weakened: a proof trigger set that lost one root trigger while the table stays is refused even with every other object", () => {
  const db = open1018("fresh");
  db.exec(`DROP TRIGGER ${SESSION_PROOF_ROOT_TRIGGERS[0]}; DROP TRIGGER ${SESSION_PROOF_ROOT_TRIGGERS[1]}`);
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

it("a retained session is proved, not crashed, once the reclaim has handed memory_session_roots back", async () => {
  const f = setupProofFixture(), db = database(), p = await proofModule();
  db.prepare("INSERT OR REPLACE INTO memory_session_state VALUES(?,?,?,0)").run(f.key.threadId, f.key.driverInstance, f.key.nativeSession);
  // control: while the table is there a non-empty root still carries recall
  db.prepare("INSERT INTO memory_session_roots VALUES(?,?,?,'fixture-root')").run(f.key.threadId, f.key.driverInstance, f.key.nativeSession);
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: false })).toMatchObject({ kind: "fresh", reason: "no-receipts" });
  db.exec("DROP TABLE memory_session_roots");
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: false })).toEqual({ kind: "resume" });
});

for (const mark of [0, 1]) it(`a present root table still requires its triggers even with hand-back mark=${mark}`, () => {
  const db = open1018("fresh");
  db.prepare("UPDATE memory_lineage_lsn_meta SET value=? WHERE key='root_sets_dropped'").run(mark);
  db.exec("DROP TRIGGER memory_session_proof_root_insert");
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

it("an unmarked missing root table remains refused", () => {
  const db = open1018("fresh");
  db.exec("DROP TABLE memory_session_roots");
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

it("fresh proof initialization still works after the reclaim", async () => {
  const f = setupProofFixture(), db = database(), p = await proofModule();
  db.prepare("INSERT OR REPLACE INTO memory_session_state VALUES(?,?,?,0)").run(f.key.threadId, f.key.driverInstance, f.key.nativeSession);
  reclaim(db);
  expect(() => p.initializeFreshSessionProof(f.key, f.access)).not.toThrow();
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: false })).toEqual({ kind: "resume" });
});
