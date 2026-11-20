// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.19 bot creation (bot-create-rollback.ts) makes the bot_create_commits marker table in messages.db the first time a bot is
// created; its rows leave after commit but the table stays. Every backup runs the restore check (inspectInstallationDatabase) over its
// snapshot, which refused that table as unknown: from the first created bot on, every snapshot failed with DATABASE_SCHEMA_UNSUPPORTED
// (red-audit B2). Everything here runs the real open path, the real Store and the real snapshot, backup, restore and downgrade.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { Store } from "./store.ts";
import { rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const marker = (db: DatabaseSync) => db.prepare("SELECT type, sql FROM sqlite_schema WHERE name='bot_create_commits'").all();
const botIds = (db: DatabaseSync) => db.prepare("SELECT DISTINCT thread_id FROM messages ORDER BY thread_id").all();
async function quiesce() { closeDatabase(); await stopWalMaintenance(); await stopSearchIndex(); }
function asInstallation(dir: string): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profile: { name: "Fixture" }, instances: {}, appearance: { skin: "light" } }) + "\n");
  writeFileSync(join(dir, "groups.json"), "[]\n");
}
/** A data dir the real path made, with one bot created through the real Store. */
function withCreatedBot(): DatabaseSync {
  const db = database();
  expect(marker(db), "a fresh open makes no marker table").toEqual([]);
  new Store().createBot();
  expect(marker(db), "the real create leaves the marker table behind").toEqual([{ type: "table", sql: "CREATE TABLE bot_create_commits(id TEXT PRIMARY KEY NOT NULL)" }]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM bot_create_commits").get()).toEqual({ n: 0 });
  return db;
}

describe("a data dir where a bot was created still backs up", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(async () => { await quiesce(); });

  it("B2 the restore check accepts the marker table the real bot create leaves, and the snapshot is taken", { timeout: 120_000 }, async () => {
    const db = withCreatedBot();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    await quiesce();
    const parent = mkdtempSync(join(tmpdir(), "murage-bot-create-snapshot-"));
    try {
      await snapshotInstallationDatabase(DATA_DIR, join(parent, "snapshot.db"));
      const snapshot = new DatabaseSync(join(parent, "snapshot.db"), { readOnly: true });
      try { expect(marker(snapshot)).toHaveLength(1); } finally { snapshot.close(); }
    } finally { removeTempDirSync(parent); }
  });

  it.skipIf(!rawAgeHost)("B2 an encrypted backup of that data dir restores, the transcript intact and the restored file passing the check", { timeout: 120_000 }, async () => {
    const before = botIds(withCreatedBot());
    expect(before.length).toBeGreaterThan(0);
    await quiesce();
    asInstallation(DATA_DIR);
    const parent = mkdtempSync(join(tmpdir(), "murage-bot-create-backup-"));
    try {
      const keys = testAgeKeys(), archive = join(parent, "backup.age");
      const written = await writeEncryptedInstallationBackup(DATA_DIR, archive, { ...keys, selection });
      const target = join(parent, "restored");
      const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
      expect(restored.status).toBe("restored-review-required");
      const db = new DatabaseSync(join(target, "messages.db"), { readOnly: true });
      try {
        expect(botIds(db)).toEqual(before);
        expect(() => inspectInstallationDatabase(db)).not.toThrow();
      } finally { db.close(); }
    } finally { removeTempDirSync(parent); }
  });

  for (const to of [10, 9] as const) it(`B2 the downgrade to v${to} takes the empty marker table out (no older inspector knows it), and the snapshot is taken`, { timeout: 120_000 }, async () => {
    withCreatedBot();
    await quiesce();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, to)).toMatchObject({ status: "downgraded", to });
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(marker(db)).toEqual([]); } finally { db.close(); }
    const parent = mkdtempSync(join(tmpdir(), "murage-bot-create-downgrade-"));
    try { await snapshotInstallationDatabase(DATA_DIR, join(parent, "snapshot.db")); } finally { removeTempDirSync(parent); }
  });

  it("B2 the check still refuses the marker table in any other shape", async () => {
    const db = database();
    db.exec("CREATE TABLE bot_create_commits(id TEXT PRIMARY KEY NOT NULL, extra TEXT)");
    expect(() => inspectInstallationDatabase(db)).toThrow(/DATABASE_SCHEMA_UNSUPPORTED/);
  });
});
