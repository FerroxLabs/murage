// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: cl-psclouda owns these Cloud witnesses; fprod4-sqlite-build4-par owns boot validation;
// trainred-proofschema owns proof installation; the memory lane owns the reclaim transaction.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopRecallViewMaintenance } from "./recall-view.ts";
import { reclaimRootSetsWhenIdle, ROOT_SET_RECLAIM_TABLES, setReadTimeJudgeRetired } from "./root-set-reclaim.ts";

const file = join(DATA_DIR, "messages.db");
const idle = { ownerIdleMs: () => 60 * 60_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
const present = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const mark = (db: DatabaseSync) => db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()?.value;
const restart = () => { closeDatabase(); return database(); };

beforeEach(() => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  setReadTimeJudgeRetired(true);
});
afterEach(() => {
  stopRecallViewMaintenance();
  closeDatabase();
  setReadTimeJudgeRetired(false);
  vi.unstubAllEnvs();
});

it("W1: a Cloud home boots after each of two real idle reclaim cycles", async () => {
  let db = database();
  expect(process.env.MURAGE_CLOUD_ROLE).toBe("home");
  expect(present(db, "memory_session_roots")).toBe(true);
  expect(mark(db)).toBe(0);
  for (let cycle = 0; cycle < 2; cycle++) {
    expect(await reclaimRootSetsWhenIdle(db, idle)).toBe("done");
    expect(ROOT_SET_RECLAIM_TABLES.filter(name => present(db, name))).toEqual([]);
    db = restart(); // database() performs the production open, migration and schema validation.
    expect(mark(db)).toBe(1);
    expect(present(db, "memory_session_roots")).toBe(false);
  }
});

it("W2: a Cloud home boots twice from the real pre-reclaimed 1.0.18 file", () => {
  writeFileSync(file, gunzipSync(readFileSync(new URL("./testdata/v13-1018-reclaimed.db.gz", import.meta.url))));
  for (let boot = 0; boot < 2; boot++) {
    const db = restart();
    expect(mark(db)).toBe(1);
    expect(present(db, "memory_session_roots")).toBe(false);
  }
});

for (const receipt of ["zero", "absent"] as const) it(`W3: a Cloud home refuses a missing root table with ${receipt} reclaim mark`, () => {
  const db = database();
  db.exec("DROP TABLE memory_session_roots");
  db.exec(receipt === "zero"
    ? "UPDATE memory_lineage_lsn_meta SET value=0 WHERE key='root_sets_dropped'"
    : "DELETE FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'");
  closeDatabase();
  expect(() => database()).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

for (const cut of ["before-commit", "after-commit"] as const) it(`a Cloud reclaim crash keeps the DROP and mark atomic (${cut})`, () => {
  const db = database();
  for (const table of ROOT_SET_RECLAIM_TABLES) if (table !== "memory_session_roots") db.exec(`DROP TABLE IF EXISTS ${table}`);
  // An earlier clear batch must not conceal a DROP whose mark was committed separately.
  db.exec("UPDATE memory_lineage_lsn_meta SET value=0 WHERE key='root_sets_dropped'; PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  const source = `
    import { DatabaseSync } from "node:sqlite";
    import { nextReclaimStep, runReclaimStep } from ${JSON.stringify(new URL("./root-set-reclaim.ts", import.meta.url).href)};
    const db = new DatabaseSync(process.argv[1]), cut = process.argv[2];
    db.exec("PRAGMA synchronous=FULL");
    const step = nextReclaimStep(db);
    if (step.kind !== "drop-table" || step.name !== "memory_session_roots") throw new Error("wrong crash boundary");
    const exec = db.exec.bind(db); let dropped = false;
    db.exec = sql => {
      exec(sql);
      if (sql === "DROP TABLE IF EXISTS memory_session_roots") {
        dropped = true;
        if (cut === "before-commit") process.kill(process.pid, "SIGKILL");
      }
      if (sql === "COMMIT" && dropped && cut === "after-commit") process.kill(process.pid, "SIGKILL");
    };
    runReclaimStep(db);
    throw new Error("crash boundary was not reached");
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", source, file, cut], { encoding: "utf8", windowsHide: true });
  expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
  const recovered = new DatabaseSync(file);
  try {
    expect(present(recovered, "memory_session_roots")).toBe(cut === "before-commit");
    expect(mark(recovered)).toBe(cut === "before-commit" ? 0 : 1);
  } finally { recovered.close(); }
  expect(() => database()).not.toThrow();
});
