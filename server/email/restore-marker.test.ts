// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RESTORE-PARK r3.1 section 5 (Cloud reset and undo): the marker murage-commands writes into the staged messages.db is consumed once at
// boot, inside one transaction, before anything reads email rows. T20 server half; crash variants C3b, C3c.
import { removeTempDirSync } from "../testing/cleanup.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeRestoreMarker } from "./restore-marker.ts";
import * as restore from "./restore.ts";
import { sqliteRestoreEffects } from "./restore-job-effects.ts";
import { ensureWriteRevision } from "../app-write-revision.ts";

let dir: string;
const dbPath = () => join(dir, "messages.db");
const open = () => new DatabaseSync(dbPath());
const seed = (opts: { marker?: boolean } = { marker: true }) => {
  const db = open();
  db.exec("CREATE TABLE email_bindings (bot_id TEXT PRIMARY KEY, state TEXT NOT NULL, step TEXT, revision INTEGER NOT NULL DEFAULT 0)");
  db.exec("INSERT INTO email_bindings (bot_id, state) VALUES ('b1','removing'), ('b2','active')");
  if (opts.marker !== false) {
    db.exec("CREATE TABLE restore_pending (reset_id TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("INSERT INTO restore_pending VALUES ('r1','reset',1)");
  }
  db.close();
};
const states = () => { const db = open(); try { return db.prepare("SELECT bot_id, state FROM email_bindings ORDER BY bot_id").all(); } finally { db.close(); } };
const hasMarker = () => { const db = open(); try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='restore_pending'").get()); } finally { db.close(); } };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "restore-marker-")); });
afterEach(() => { removeTempDirSync(dir); });

describe("consumeRestoreMarker", () => {
  it("T20: a marked database is prepared (removal parked, live binding unverified) and the marker is gone", () => {
    seed();
    expect(consumeRestoreMarker(dir)).toBe(true);
    expect(states()).toEqual([{ bot_id: "b1", state: "removal_parked" }, { bot_id: "b2", state: "restored_unverified" }]);
    expect(hasMarker()).toBe(false);
  });
  it("T20: consumed once: a second boot does nothing, so a Keep or Reconnect after the first boot is never re-parked", () => {
    seed();
    consumeRestoreMarker(dir);
    const db = open();
    db.exec("UPDATE email_bindings SET state='active' WHERE bot_id='b1'");
    db.close();
    expect(consumeRestoreMarker(dir)).toBe(false);
    expect(states()).toEqual([{ bot_id: "b1", state: "active" }, { bot_id: "b2", state: "restored_unverified" }]);
  });
  it("an unmarked database is left exactly as it is; a missing database is not created", () => {
    seed({ marker: false });
    const was = seedRevision();
    expect(consumeRestoreMarker(dir)).toBe(false);
    expect(revision()).toEqual(was);
    expect(states()).toEqual([{ bot_id: "b1", state: "removing" }, { bot_id: "b2", state: "active" }]);
    const empty = mkdtempSync(join(tmpdir(), "restore-marker-empty-"));
    try { expect(consumeRestoreMarker(empty)).toBe(false); expect(() => readFileSync(join(empty, "messages.db"))).toThrow(); }
    finally { removeTempDirSync(empty); }
  });
  it("C3c: a crash inside the consumer transaction leaves the marker and the old rows; the next boot redoes it", () => {
    seed();
    const real = restore.prepareRestoredEmail;
    expect(() => consumeRestoreMarker(dir, { prepare: db => { real(db); throw new Error("power cut"); } })).toThrow("power cut");
    expect(states()).toEqual([{ bot_id: "b1", state: "removing" }, { bot_id: "b2", state: "active" }]);
    expect(hasMarker()).toBe(true);
    expect(consumeRestoreMarker(dir)).toBe(true);
    expect(states()).toEqual([{ bot_id: "b1", state: "removal_parked" }, { bot_id: "b2", state: "restored_unverified" }]);
    expect(hasMarker()).toBe(false);
  });
  // M6 (J4): a restore job's swapped database that still carries a Cloud marker is prepared by the marker consumer at boot, BEFORE boot recovery runs the job's own prepare.
  // The consumer writes the job's prepared mark in the same transaction, so recovery sees the preparation done and never re-keys the parks a second time.
  const JOB = { version: 1 as const, id: "job-m6", archiveId: "arc1", source: "owner", phase: "swapped" as const, at: 1 };
  const marks = () => { const db = open(); try { return db.prepare("SELECT kind, job_id FROM restore_job_marks ORDER BY kind").all(); } catch { return "no table"; } finally { db.close(); } };
  const swapMark = (jobId: string) => { const db = open(); db.exec("CREATE TABLE restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL)"); db.prepare("INSERT INTO restore_job_marks VALUES ('swapped', ?)").run(jobId); db.close(); };
  it("M6: the consumer writes the swapped job's prepared mark, so the job's own prepare afterwards is a no-op (no second re-key)", () => {
    seed(); swapMark(JOB.id);
    expect(consumeRestoreMarker(dir)).toBe(true);
    expect(marks()).toEqual([{ kind: "prepared", job_id: JOB.id }, { kind: "swapped", job_id: JOB.id }]);
    const db = open(); db.exec("UPDATE email_bindings SET state='active' WHERE bot_id='b1'"); db.close(); // the owner kept the first one after the first preparation
    sqliteRestoreEffects({ liveDb: dbPath(), archivesDir: join(dir, "archives") }).prepare(JOB);
    expect(states()).toEqual([{ bot_id: "b1", state: "active" }, { bot_id: "b2", state: "restored_unverified" }]);
  });
  const revision = () => {
    const db = open();
    try { return db.prepare("SELECT epoch, n FROM app_write_revision WHERE id=1").get() as { epoch: string; n: number }; }
    finally { db.close(); }
  };
  const seedRevision = () => {
    const db = open();
    try { ensureWriteRevision(db); db.exec("UPDATE app_write_revision SET n=17 WHERE id=1"); }
    finally { db.close(); }
    return revision();
  };
  it("R2-06: consuming the marker replaces the restored revision once, including after a rolled-back attempt", () => {
    seed();
    const was = seedRevision();
    // Abort the epoch write after email preparation, so the whole preparation must roll back.
    const db = open();
    db.exec("CREATE TRIGGER reject_epoch BEFORE UPDATE ON app_write_revision BEGIN SELECT RAISE(ABORT, 'epoch interrupted'); END");
    db.close();
    expect(() => consumeRestoreMarker(dir)).toThrow("epoch interrupted");
    expect(revision()).toEqual(was);
    expect(hasMarker()).toBe(true);
    expect(states()).toEqual([{ bot_id: "b1", state: "removing" }, { bot_id: "b2", state: "active" }]);
    const retry = open(); retry.exec("DROP TRIGGER reject_epoch"); retry.close();
    expect(consumeRestoreMarker(dir)).toBe(true);
    const prepared = revision();
    expect(prepared.epoch).not.toBe(was.epoch);
    expect(prepared.n).toBe(0);
    expect(consumeRestoreMarker(dir)).toBe(false);
    expect(revision()).toEqual(prepared);
  });
  it("R2-06: the restore job replaces the revision in its preparation transaction, once per job", () => {
    seed({ marker: false });
    const was = seedRevision();
    const effects = sqliteRestoreEffects({ liveDb: dbPath(), archivesDir: join(dir, "archives") });
    // A failure after the epoch update must roll back both the revision and the email rows.
    const db = open();
    db.exec("CREATE TABLE restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL)");
    db.exec("CREATE TRIGGER reject_prepared BEFORE INSERT ON restore_job_marks WHEN NEW.kind='prepared' BEGIN SELECT RAISE(ABORT, 'mark interrupted'); END");
    db.close();
    expect(() => effects.prepare(JOB)).toThrow("mark interrupted");
    expect(revision()).toEqual(was);
    expect(marks()).toEqual([]);
    expect(states()).toEqual([{ bot_id: "b1", state: "removing" }, { bot_id: "b2", state: "active" }]);
    const retry = open(); retry.exec("DROP TRIGGER reject_prepared"); retry.close();
    effects.prepare(JOB);
    const prepared = revision();
    expect(prepared.epoch).not.toBe(was.epoch);
    expect(prepared.n).toBe(0);
    expect(marks()).toEqual([{ kind: "prepared", job_id: JOB.id }]);
    effects.prepare(JOB);
    expect(revision()).toEqual(prepared);
  });
  it("M6: a pure Cloud reset (no job swapped it in) writes no job mark and creates no marks table", () => {
    seed();
    expect(consumeRestoreMarker(dir)).toBe(true);
    expect(marks()).toBe("no table");
  });
  it("M6: a failed consumer leaves no prepared mark either (one transaction)", () => {
    seed(); swapMark(JOB.id);
    expect(() => consumeRestoreMarker(dir, { prepare: () => { throw new Error("power cut"); } })).toThrow("power cut");
    expect(marks()).toEqual([{ kind: "swapped", job_id: JOB.id }]);
  });
  it("C3b: swapped in but not yet booted: the database still carries its marker and the boot consumes it", () => {
    seed();
    expect(hasMarker()).toBe(true);
    expect(consumeRestoreMarker(dir)).toBe(true);
  });
  it("T20: the boot calls it after the second assertRestoreReviewed and before any email runtime, store or transcript reader", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const call = index.indexOf("consumeRestoreMarker(DATA_DIR)");
    expect(call).toBeGreaterThan(0);
    expect(index.indexOf("consumeRestoreMarker(DATA_DIR)", call + 1)).toBe(-1);
    const second = index.indexOf("assertRestoreReviewed(DATA_DIR)", index.indexOf("assertRestoreReviewed(DATA_DIR)") + 1);
    expect(call).toBeGreaterThan(second);
    expect(call).toBeLessThan(index.indexOf("new TranscriptReader(join(DATA_DIR"));
    expect(call).toBeLessThan(index.indexOf("new EmailRuntime"));
  });
});
