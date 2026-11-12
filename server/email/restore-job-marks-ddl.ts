// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one definition of the restore job's marks table. It has no imports so the restore job effects (which create it) and the installation
// snapshot (which must accept it exactly, and keep it out of every backup) can both read it without a cycle.
export const RESTORE_JOB_MARKS_DDL = "CREATE TABLE IF NOT EXISTS restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL)";

export const RESTORE_BOOT_WAIT_DDL = "CREATE TABLE IF NOT EXISTS restore_boot_wait (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, cause TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, boot_id TEXT NOT NULL, up_ms INTEGER NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL)";
