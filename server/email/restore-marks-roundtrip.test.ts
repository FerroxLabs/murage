// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// restore_job_marks across an upgrade, a downgrade and an upgrade again. The downgrade does not list the table (installation-app-schema-downgrade.ts
// APP_SCHEMA_102_ADDITIONS), so a mark written by a restore under the newer build is still in the file when the newer build comes back. The ruling is that
// this is harmless because a mark steers recovery only when its job id equals the id of the journal now on disk (RestoreJobStore.phaseOf), and with no
// journal marks are never read. These tests pin that, and pin that the downgrade is refused while a restore journal is still open (DOWNGRADE_RESTORE_OPEN).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { downgradeApplicationSchemaTo101 } from "../installation-app-schema-downgrade.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RestoreJobStore, type RestoreJobOptions } from "./restore-job.ts";
import { archiveIsLocal, captureEmailCarry, sqliteRestoreEffects } from "./restore-job-effects.ts";
import { RESTORE_JOB_MARKS_DDL } from "./restore-job-marks-ddl.ts";

let dir: string, live: string, archives: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "restore-marks-rt-")); live = join(dir, "messages.db"); archives = join(dir, "archives"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mkdb = (path: string, bots: string[]) => {
  mkdirSync(join(path, ".."), { recursive: true }); rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE email_bindings (bot_id TEXT PRIMARY KEY, inbox_id TEXT, address TEXT, email_key_ref TEXT, op_id TEXT, state TEXT, step TEXT, revision INTEGER DEFAULT 0)");
  for (const bot of bots) db.prepare("INSERT INTO email_bindings (bot_id, inbox_id, address, email_key_ref, op_id, state) VALUES (?,?,?,?,?,'active')").run(bot, `ibx_${bot}`, `${bot}@x.test`, `key_${bot}`, `op_${bot}`);
  db.close();
};
const marks = (path = live) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT kind, job_id AS j FROM restore_job_marks ORDER BY kind").all() as Array<{ kind: string; j: string }>; } finally { db.close(); } };
const journalFile = () => join(dir, "restore-job.json");
const make = (uid: string, extra: Partial<RestoreJobOptions> = {}) => new RestoreJobStore({
  dir, now: () => 1_800_000_000_000, uid: p => `${p}-${uid}`, isLocalArchive: id => archiveIsLocal(archives, id), captureCarry: () => captureEmailCarry(live),
  effects: sqliteRestoreEffects({ liveDb: live, archivesDir: archives, now: () => 1_800_000_000_000 }), ...extra,
});
const ARM = { archiveId: "arc1", source: "local" } as const;
/** A home on which owner restore X ran to the end and was cleared: marks of X in the file, no journal on disk (what an upgraded home holds, then downgrades). */
function homeAfterFinishedRestoreX(): void {
  mkdb(live, ["b3"]); mkdb(join(archives, "arc1", "messages.db"), ["b1"]);
  const s = make("X");
  s.arm(ARM); s.capture(); s.swap(ARM); s.prepare();
  expect(s.clear().ok).toBe(true);
  expect(existsSync(journalFile())).toBe(false);
  expect(marks()).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]);
}

describe("stale restore marks after an upgrade, downgrade, upgrade round trip", () => {
  it("(1) with no journal on disk the stale marks of job X change nothing: not the window, not the home line, not boot recovery, not the pending check", () => {
    homeAfterFinishedRestoreX();
    const back = make("later");
    expect(back.windowOpen()).toBe(false);
    expect(back.homeLine()).toBeNull();
    expect(back.recover()).toEqual({ action: "none" });
    expect(back.checkPending()).toBe(false);
    expect(existsSync(journalFile())).toBe(false);
    expect(marks()).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]); // read, never rewritten or cleared
  });

  it("(2) a new restore job Y after the round trip takes its phase from its own journal; the marks of X are ignored at every step", () => {
    homeAfterFinishedRestoreX();
    const y = make("Y");
    expect(y.arm(ARM)).toMatchObject({ ok: true, job: { id: "job-Y", phase: "armed" } });
    // X's prepared mark must not turn Y into a finished job: the window is open and the home says so
    expect(y.windowOpen()).toBe(true);
    expect(y.homeLine()).toBe(RESTORE_FINISHING_LINE);
    expect(y.capture()).toMatchObject({ ok: true, job: { phase: "captured" } });
    expect(y.windowOpen()).toBe(true);
    // swap needs Y captured; X's marks (prepared, swapped) must not make it "not_swappable"
    expect(y.swap(ARM)).toMatchObject({ ok: true, job: { id: "job-Y", phase: "swapped" } });
    expect(marks()).toEqual([{ kind: "swapped", j: "job-Y" }]); // the archive's staged copy replaced the file, X's marks went with the old one
    expect(y.prepare()).toMatchObject({ ok: true, job: { phase: "prepared" } });
    expect(y.clear().ok).toBe(true);
    expect(marks()).toEqual([{ kind: "prepared", j: "job-Y" }, { kind: "swapped", j: "job-Y" }]);
  });

  it("(2b) a job Y that never reached the swap is aborted by boot recovery, not read as prepared from X's marks", () => {
    homeAfterFinishedRestoreX();
    const y = make("Y");
    y.arm(ARM); y.capture();
    const boot = make("boot");
    expect(boot.recover()).toEqual({ action: "aborted" });
    expect(boot.homeLine()).toBe(RESTORE_FAILED_LINE);
    expect(marks()).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]);
  });

  it("(3a) X's journal survives together with X's marks: the downgrade is REFUSED and changes nothing, the upgraded build finishes job X from the marks, and only then does a downgrade go ahead and keep them", async () => {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const db = database();
    db.exec(RESTORE_JOB_MARKS_DDL);
    db.prepare("INSERT INTO restore_job_marks (kind, job_id) VALUES ('swapped', 'job-X')").run();
    // the journal the swap left: phase captured on disk, the swapped mark in the file (the journal is not rewritten by the swap)
    const journal = join(DATA_DIR, "restore-job.json");
    writeFileSync(journal, JSON.stringify({ version: 1, id: "job-X", archiveId: "arc1", source: "local", phase: "captured", at: 1_800_000_000_000 }) + "\n");
    const open = () => new RestoreJobStore({ dir: DATA_DIR, now: () => 1_800_000_000_000, isLocalArchive: () => false, captureCarry: () => ({}), effects: sqliteRestoreEffects({ liveDb: join(DATA_DIR, "messages.db"), archivesDir: archives }) });
    // PIN: the downgrade is refused while a restore is open (DOWNGRADE_RESTORE_OPEN, before any write), so an older build cannot write into the database job X still
    // owes preparation. The marks and the journal are exactly as they were.
    expect(() => downgradeApplicationSchemaTo101(db, DATA_DIR)).toThrow(expect.objectContaining({ code: "DOWNGRADE_RESTORE_OPEN", message: "A restore has not finished. Open this version of Murage to finish recovery, then try going back to the earlier version." }));
    expect(db.prepare("SELECT kind, job_id AS j FROM restore_job_marks").all()).toEqual([{ kind: "swapped", j: "job-X" }]);
    expect(existsSync(journal)).toBe(true);
    closeDatabase(); await stopWalMaintenance();
    // upgrade again: the window is open (swapped from the mark), and boot recovery finishes the job
    const back = open();
    expect(back.windowOpen()).toBe(true);
    expect(back.homeLine()).toBe(RESTORE_FINISHING_LINE);
    expect(back.recover()).toEqual({ action: "prepared" });
    expect(existsSync(journal)).toBe(false);
    expect(marks(join(DATA_DIR, "messages.db"))).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]);
    // with the journal gone the window is closed: the downgrade is allowed, and the marks (the table is not in APP_SCHEMA_102_ADDITIONS) survive it
    const again = database();
    expect(() => downgradeApplicationSchemaTo101(again, DATA_DIR)).not.toThrow();
    expect(again.prepare("SELECT kind, job_id AS j FROM restore_job_marks ORDER BY kind").all()).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]);
    closeDatabase(); await stopWalMaintenance();
  });

  it("(3b) X's journal survives while the file carries only the marks of an older job Z: the journal governs, the marks of Z are ignored", () => {
    mkdb(live, ["b3"]); mkdb(join(archives, "arc1", "messages.db"), ["b1"]);
    const seed = new DatabaseSync(live);
    try { seed.exec(RESTORE_JOB_MARKS_DDL); seed.exec("INSERT INTO restore_job_marks (kind, job_id) VALUES ('swapped','job-Z'),('prepared','job-Z')"); } finally { seed.close(); }
    writeFileSync(journalFile(), JSON.stringify({ version: 1, id: "job-X", archiveId: "arc1", source: "local", phase: "captured", at: 1_800_000_000_000 }) + "\n");
    const back = make("later");
    expect(back.windowOpen()).toBe(true);
    expect(back.swap(ARM)).toMatchObject({ ok: true, job: { id: "job-X", phase: "swapped" } });
    expect(marks()).toEqual([{ kind: "swapped", j: "job-X" }]);
  });
});
