// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server writes the memory upgrade's start-up note and the desktop shell
// reads it (electron/memory-upgrade-status.mjs). This proves the two agree on
// the file, for progress and for each reason an upgrade can be blocked, and
// that a normal finish leaves no note behind.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { memoryUpgradeBlockedSentence, readMemoryUpgradeStatus, MEMORY_UPGRADE_STATUS_FILE as READER_FILE } from "../../electron/memory-upgrade-status.mjs";
import { MEMORY_SCHEMA, MEMORY_SCHEMA_V2, migrateMemorySchema } from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./learning-policy.ts";
import { MEMORY_UPGRADE_STATUS_FILE, memoryUpgradeReporter } from "./upgrade-status.ts";

const roots: string[] = []; const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function v2() {
  const root = mkdtempSync(join(tmpdir(), "murage-upgrade-status-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(MEMORY_SCHEMA_V2);
  db.prepare("INSERT INTO memory_meta VALUES(1,2,?,0,0,0,'active')").run(randomUUID());
  db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify(DEFAULT_MEMORY_LEARNING_V1));
  return { root, db };
}

it("writer and reader agree on the file name", () => { expect(READER_FILE).toBe(MEMORY_UPGRADE_STATUS_FILE); });

it("progress notes are readable by the shell, and a finished upgrade leaves no note", () => {
  const f = v2(); const report = memoryUpgradeReporter(f.root, basename);
  const seen: Array<string | undefined> = [];
  migrateMemorySchema(f.db, "off", {
    snapshotV2Path: join(f.root, "messages.pre-memory-v3.db"), freeBytes: () => 1e12,
    onPhase: event => { report.phase(event); const note = readMemoryUpgradeStatus(f.root, { pid: process.pid }); seen.push(note?.phase); if (event.phase === "copying") expect(note?.partialName).toBe("messages.pre-memory-v3.db.partial"); },
  });
  report.done();
  expect(seen).toEqual(["checking", "copying", "migrating"]);
  expect(existsSync(join(f.root, MEMORY_UPGRADE_STATUS_FILE))).toBe(false);
});

it("a disk that is too small leaves a blocked note whose sentence names the shortfall", () => {
  const f = v2(); const report = memoryUpgradeReporter(f.root, basename);
  try { migrateMemorySchema(f.db, "off", { snapshotV2Path: join(f.root, "messages.pre-memory-v3.db"), freeBytes: () => 10, onPhase: e => report.phase(e) }); } catch (error) { report.blocked(error); }
  const note = readMemoryUpgradeStatus(f.root, { pid: process.pid });
  expect(note).toMatchObject({ state: "blocked", code: "MEMORY_MIGRATION_DISK_SPACE" });
  expect(memoryUpgradeBlockedSentence(note, "en")).toMatch(/Free up at least \d+ MB, then open Murage again\. Nothing has been changed\./);
});

it("a newer data format leaves a blocked note that says to install the latest version", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-upgrade-status-")); roots.push(root);
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec(MEMORY_SCHEMA.replace("CHECK(schema_version=6)", "CHECK(schema_version=7)"));
  db.prepare("INSERT INTO memory_meta VALUES(1,7,?,0,0,0,'off')").run(randomUUID());
  const report = memoryUpgradeReporter(root, basename);
  try { migrateMemorySchema(db, "off"); } catch (error) { report.blocked(error); }
  const note = readMemoryUpgradeStatus(root, { pid: process.pid });
  expect(note).toMatchObject({ state: "blocked", code: "MEMORY_SCHEMA_NEWER", newerVersion: 7 });
  expect(memoryUpgradeBlockedSentence(note, "en")).toMatch(/Install the latest version of Murage/);
});
