// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W, the base witness: it imports nothing of the wake bus, so the same file runs on the base build (f6ae52c670), where
// every test below is RED (no wake is recorded for a committed memory write, and a lease journals a row for every view to read), and on
// this build, where the installer of every open makes them GREEN.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });
const topics = () => { try { return (database().prepare("SELECT topic FROM temp.mem_wake ORDER BY topic").all() as { topic: string }[]).map(row => row.topic); } catch (error) { return `no wake table: ${error instanceof Error ? error.message : String(error)}`; } };

it("a committed memory write records its wake on the writing connection, in the same transaction (read before the drain's turn)", () => {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  db.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-a',1,1)");
  db.exec("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(1,'line','{}',1,1,'mark','','active')");
  db.exec("COMMIT");
  expect(topics()).toEqual(["revoke", "window"]);
});

it("a rolled-back memory write leaves no wake", () => {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  db.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-a',1,1)");
  expect(topics()).toEqual(["window"]); // recorded inside the transaction...
  db.exec("ROLLBACK");
  expect(topics()).toEqual([]);         // ...and gone with it
});

it("a lease, a heartbeat and a settle of a job write no journal row (G-JOB)", () => {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES('job-a','src-a',1,'capture','1','pending',0,0)");
  const rows = () => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_changes WHERE kind='job'").get()!.n);
  const before = rows();
  db.exec("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_until=10 WHERE id='job-a'");
  db.exec("UPDATE memory_jobs SET lease_until=20 WHERE id='job-a'");
  db.exec("UPDATE memory_jobs SET status='complete' WHERE id='job-a'");
  expect(rows() - before).toBe(0);
});
