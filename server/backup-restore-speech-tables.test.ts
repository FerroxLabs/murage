// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 spoken replies (D24) keep ten speech_* tables and seven indexes in messages.db, made at every open (database.ts
// initializeReplySchema). Every backup runs the restore check (inspectInstallationDatabase) over its snapshot, so:
//   - the structural guard: a fresh database opened by the real path holds no object the snapshot registry does not know (the next new
//     table cannot repeat this);
//   - a 1.0.18 data dir with a row in every speech table backs up and restores, rows intact;
//   - a 1.0.17 archive (no speech tables) still restores;
//   - a tampered speech definition, or a trigger on a speech table, is refused;
//   - the downgrade leaves no speech object behind.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ensureForgetTable } from "./harness/event-log.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { isInboxProjectionObject } from "./inbox.ts";
import { assertNoSpeechHeld, downgradeSpeechTablesTo117, SPEECH_INDEXES_AFTER_117, SPEECH_TABLES_AFTER_117, markInFlightSpeechInterrupted, speechCooldownUntil } from "./installation-app-schema-downgrade.ts";
import { inspectInstallationDatabase, registeredSnapshotObjects } from "./installation-database-snapshot.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { validateMemorySchema } from "./memory/schema.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { initializeReplySchema } from "./tts/reply-schema.ts";
import { ReplyState, speechTransaction } from "./tts/reply-state.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { stopSearchIndex } from "./message-search-index.ts";

type Row = { type: string; name: string; tbl_name: string; sql: string | null };
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const readOnly = (file: string) => new DatabaseSync(file, { readOnly: true, timeout: 5000 });
const schemaOf = (db: DatabaseSync) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all() as Row[];
const UNSUPPORTED = /DATABASE_SCHEMA_UNSUPPORTED/;

/** One row in each speech table, written as the app writes them (every CHECK holds). */
function withSpeechRows(db: DatabaseSync): void {
  initializeReplySchema(db);
  db.exec(`
    UPDATE speech_clock SET value=7 WHERE id=1;
    INSERT INTO speech_threads (thread_id, revision) VALUES ('thread', 3);
    INSERT INTO speech_prompts (thread_id, prompt_id) VALUES ('thread', 'send:s1');
    INSERT INTO speech_generations (generation_id, thread_id, bot_id, prompt_id, revision, boot_id, provider_turn_id, state) VALUES ('g1', 'thread', 'bot', 'send:s1', 3, 'boot-a', 'turn-1', 'completed');
    INSERT INTO speech_settlements (settlement_id, generation_id, thread_id, message_id, revision, boot_id, settled_at, outcome) VALUES ('st1', 'g1', 'thread', 'message', 3, 'boot-a', 5, 'completed');
    INSERT INTO speech_sessions (session_id, principal, connection_id, thread_id, boot_id, state, last_sequence, active_attempt) VALUES ('ss1', 'desktop', 'c1', 'thread', 'boot-a', 'closed', 1, NULL);
    INSERT INTO speech_accounts (binding_id, credential_version, account_scope_id, plan_version, hold_until) VALUES ('binding', 'v1', 'scope', 'plan', 9);
    INSERT INTO speech_plans (account_scope_id, fingerprint, plan_version) VALUES ('scope', 'fp', 'plan');
    INSERT INTO speech_attempts (attempt_id, session_id, command_sequence, thread_id, message_id, generation_id, mode, revision, boot_id, reserved_at, account_scope_id, plan_version, state, outcome)
      VALUES ('a1', 'ss1', 1, 'thread', 'message', 'g1', 'automatic', 3, 'boot-a', 4, 'scope', 'plan', 'complete', 'done');
    INSERT INTO speech_commands (session_id, sequence, status, outcome, attempt_id) VALUES ('ss1', 1, 200, 'done', 'a1');
  `);
}
const counts = (db: DatabaseSync) => Object.fromEntries(SPEECH_TABLES_AFTER_117.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const rows = (db: DatabaseSync) => Object.fromEntries(SPEECH_TABLES_AFTER_117.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const ONE_EACH =Object.fromEntries(SPEECH_TABLES_AFTER_117.map(name => [name, 1]));
/** The config files a data dir carries, as the backup fixture writes them. */
function asInstallation(dir: string): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profile: { name: "Fixture" }, instances: {}, appearance: { skin: "light" } }) + "\n");
  writeFileSync(join(dir, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Fixture" }]) + "\n");
  writeFileSync(join(dir, "groups.json"), "[]\n");
}

describe("the real open path and the snapshot registry", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); });

  it("structural guard: every table, index and trigger a fresh database holds is one the snapshot registry or the memory schema knows", () => {
    const db = database();
    const memory = validateMemorySchema(db), known = registeredSnapshotObjects();
    const unknown = schemaOf(db).filter(row => !memory.has(row.name) && !isInboxProjectionObject(row) && !known.has(row.name)).map(row => `${row.type}:${row.name}`);
    expect(unknown).toEqual([]);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
  });

  it("the downgrade's speech list is exactly what initializeReplySchema makes, and the open path makes all of it", () => {
    const blank = new DatabaseSync(":memory:");
    try {
      initializeReplySchema(blank);
      const made = schemaOf(blank).filter(row => !row.name.startsWith("sqlite_autoindex_"));
      expect(made.filter(row => row.type === "table").map(row => row.name).sort()).toEqual([...SPEECH_TABLES_AFTER_117].sort());
      expect(made.filter(row => row.type === "index").map(row => row.name).sort()).toEqual([...SPEECH_INDEXES_AFTER_117].sort());
      expect(made.filter(row => row.type !== "table" && row.type !== "index")).toEqual([]);
    } finally { blank.close(); }
    const names = new Set(schemaOf(database()).map(row => row.name));
    for (const name of [...SPEECH_TABLES_AFTER_117, ...SPEECH_INDEXES_AFTER_117]) expect(names.has(name), name).toBe(true);
    for (const name of [...SPEECH_TABLES_AFTER_117, ...SPEECH_INDEXES_AFTER_117]) expect(registeredSnapshotObjects().has(name), name).toBe(true);
  });

  it("a 1.0.18 data dir with a row in every speech table passes the restore check, rows intact", () => {
    const db = database();
    withSpeechRows(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    expect(counts(db)).toEqual(ONE_EACH);
  });

  it.skipIf(!rawAgeHost)("backs up and restores a 1.0.18 data dir opened by the real path, every speech row intact", { timeout: 120_000 }, async () => {
    const keys = testAgeKeys();
    const source = database();
    withSpeechRows(source);
    const before = rows(source);
    closeDatabase();
    // Both workers can still touch the source after closeDatabase() starts their shutdown.
    // Production joins them before taking a snapshot; the fixture must join them too.
    await stopWalMaintenance();
    expect(await stopSearchIndex()).toBe(true);
    asInstallation(DATA_DIR);
    const parent = mkdtempSync(join(tmpdir(), "murage-speech-backup-test-"));
    try {
      const archive = join(parent, "backup.age");
      const written = await writeEncryptedInstallationBackup(DATA_DIR, archive, { ...keys, selection });
      const target = join(parent, "restored");
      const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
      expect(restored.status).toBe("restored-review-required");
      const db = readOnly(join(target, "messages.db"));
      try {
        expect(counts(db)).toEqual(ONE_EACH);
        // every column of every speech row, exactly as it was written
        expect(rows(db)).toEqual(before);
        expect(() => inspectInstallationDatabase(db)).not.toThrow();
      } finally { db.close(); }
    } finally { removeTempDirSync(parent); }
  });

  it("the downgrade (memory-downgrade --to 10) leaves no speech object behind", () => {
    const db = database();
    initializeImageOperations(db);
    ensureForgetTable(db);
    withSpeechRows(db);
    closeDatabase();
    expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
    const after = readOnly(join(DATA_DIR, "messages.db"));
    try {
      const left = schemaOf(after).filter(row => row.tbl_name.startsWith("speech_") || row.name.startsWith("speech_")).map(row => row.name);
      expect(left).toEqual([]);
    } finally { after.close(); }
  });
});

describe("a 1.0.17 archive (no speech tables)", () => {
  it("passes the restore check", () => {
    const f = backupFixture();
    try {
      for (const name of SPEECH_TABLES_AFTER_117) expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name), name).toBeUndefined();
      expect(() => inspectInstallationDatabase(f.db)).not.toThrow();
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  });

  it.skipIf(!rawAgeHost)("restores from an encrypted archive, transcript intact and no speech table made by the restore", { timeout: 120_000 }, async () => {
    const f = backupFixture(), keys = testAgeKeys();
    try {
      f.db.close();
      const archive = join(f.parent, "backup.age");
      const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
      const target = join(f.parent, "restored");
      const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
      expect(restored.status).toBe("restored-review-required");
      const db = readOnly(join(target, "messages.db"));
      try {
        expect(db.prepare("SELECT text FROM messages WHERE id='message'").get()).toEqual({ text: "WAL-visible transcript" });
        expect(schemaOf(db).filter(row => row.name.startsWith("speech_") || row.tbl_name.startsWith("speech_")).map(row => row.name)).toEqual([]);
        expect(() => inspectInstallationDatabase(db)).not.toThrow();
      } finally { db.close(); }
    } finally { try { f.db.close(); } catch { /* closed above */ } removeTempDirSync(f.parent); }
  });
});

describe("a voice reply still finishing holds the downgrade back (Astra r3/r4: a downgrade and quick return must not speak sooner than a restart)", () => {
  const MIN10 = 600_000;
  const at = 1_800_000_000_000;
  const refusal = (run: () => unknown): { code?: string; message: string } | undefined => {
    try { run(); } catch (error) { return error as { code?: string; message: string }; }
    return undefined;
  };
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); });

  it("the hold: an attempt in flight holds ten minutes from now; the newest attempt holds its rate window; an account hold holds; old ones hold nothing", () => {
    const db = new DatabaseSync(":memory:");
    try {
      withSpeechRows(db);
      db.exec(`UPDATE speech_attempts SET reserved_at=${at - 20 * MIN10}; UPDATE speech_accounts SET hold_until=0`);
      expect(speechCooldownUntil(db, at)).toBe(0);
      db.exec(`UPDATE speech_attempts SET reserved_at=${at - 60_000}`);
      expect(speechCooldownUntil(db, at)).toBe(at - 60_000 + MIN10);
      db.exec("UPDATE speech_attempts SET state='streaming'");
      expect(speechCooldownUntil(db, at)).toBe(at + MIN10);
      db.exec(`UPDATE speech_accounts SET hold_until=${at + 3 * MIN10}`);
      expect(speechCooldownUntil(db, at)).toBe(at + 3 * MIN10);
    } finally { db.close(); }
  });

  it("refuses while an attempt is in flight or an account is held, with the minutes left and nothing changed; goes ahead once it passes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      withSpeechRows(db);
      db.exec(`UPDATE speech_attempts SET reserved_at=${at - 60_000}, state='streaming'`);
      expect(refusal(() => downgradeSpeechTablesTo117(db, at))).toMatchObject({ code: "DOWNGRADE_VOICE_FINISHING_10", message: "Murage is finishing a voice reply. Try again in about 10 min." });
      expect(counts(db)).toEqual(ONE_EACH);
      db.exec(`UPDATE speech_attempts SET state='complete', reserved_at=${at - 20 * MIN10}; UPDATE speech_accounts SET hold_until=${at + 3 * MIN10 - 1}`);
      expect(refusal(() => assertNoSpeechHeld(db, at))).toMatchObject({ code: "DOWNGRADE_VOICE_FINISHING_30" });
      expect(refusal(() => assertNoSpeechHeld(db, at + 3 * MIN10 - 60_000))).toMatchObject({ code: "DOWNGRADE_VOICE_FINISHING_1" });
      expect(refusal(() => assertNoSpeechHeld(db, at + 3 * MIN10))).toBeUndefined();
      expect(downgradeSpeechTablesTo117(db, at + 3 * MIN10).dropped).toBeGreaterThan(0);
      expect(schemaOf(db).filter(row => row.name.startsWith("speech_"))).toEqual([]);
    } finally { db.close(); }
  });

  it("Astra r3's counterexample: a reply cut short, then Prepare to reinstall inside ten minutes, is refused before any change, and the next start holds the account as an ordinary restart does", () => {
    const db = database();
    initializeImageOperations(db);
    ensureForgetTable(db);
    withSpeechRows(db);
    db.exec(`UPDATE speech_attempts SET reserved_at=${Date.now() - 60_000}, state='streaming'`);
    closeDatabase();
    expect(refusal(() => downgradeInstallationMemorySchema(DATA_DIR, 10))?.code).toMatch(/^DOWNGRADE_VOICE_FINISHING_(9|10)$/);
    const after = database();
    expect(counts(after)).toEqual(ONE_EACH);
    // The return is this same build starting again: boot interrupts the attempt and holds its account, so no new reply, automatic or
    // owner-pressed, is admitted for ten minutes (reply-state.ts boot and reserve).
    const state = new ReplyState({ db: () => after, transaction: speechTransaction(after) });
    state.boot();
    expect(state.account("binding", "v1").holdUntil).toBeGreaterThan(Date.now() + 9 * 60_000);
  });
  // MurageMain ruling on Astra r5's Medium: a crash leaves an attempt reserved or streaming; 1.0.18 cannot start; the downgrade must still end.
  it("a crash left an attempt in flight: the downgrade marks it interrupted and holds ten minutes, durably, then refuses; the refusal ends ten minutes later (fake clock)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      withSpeechRows(db);
      db.exec(`UPDATE speech_attempts SET reserved_at=${at - 3 * 60 * MIN10}, state='streaming', outcome=NULL; UPDATE speech_accounts SET hold_until=0`);
      expect(markInFlightSpeechInterrupted(db, at)).toBe(1);
      expect((db.prepare("SELECT state FROM speech_attempts").get() as { state: string }).state).toBe("interrupted");
      expect((db.prepare("SELECT hold_until FROM speech_accounts").get() as { hold_until: number }).hold_until).toBe(at + MIN10);
      expect(refusal(() => assertNoSpeechHeld(db, at))).toMatchObject({ code: "DOWNGRADE_VOICE_FINISHING_10" });
      expect(refusal(() => assertNoSpeechHeld(db, at + MIN10 - 60_000))).toMatchObject({ code: "DOWNGRADE_VOICE_FINISHING_1" });
      // ten minutes on, with no start in between (the build cannot start), nothing holds and the downgrade goes ahead
      expect(refusal(() => assertNoSpeechHeld(db, at + MIN10))).toBeUndefined();
      expect(downgradeSpeechTablesTo117(db, at + MIN10).dropped).toBeGreaterThan(0);
    } finally { db.close(); }
  });

  it("a second downgrade inside the ten minutes does not extend the hold", () => {
    const db = new DatabaseSync(":memory:");
    try {
      withSpeechRows(db);
      db.exec(`UPDATE speech_attempts SET reserved_at=${at - 3 * 60 * MIN10}, state='reserved', outcome=NULL; UPDATE speech_accounts SET hold_until=0`);
      expect(markInFlightSpeechInterrupted(db, at)).toBe(1);
      expect(markInFlightSpeechInterrupted(db, at + 5 * 60_000)).toBe(0);
      expect((db.prepare("SELECT hold_until FROM speech_accounts").get() as { hold_until: number }).hold_until).toBe(at + MIN10);
      expect(refusal(() => assertNoSpeechHeld(db, at + 5 * 60_000))).toMatchObject({ code: "DOWNGRADE_VOICE_FINISHING_5" });
      expect(refusal(() => assertNoSpeechHeld(db, at + MIN10))).toBeUndefined();
    } finally { db.close(); }
  });

  it("the hold is not dropped: an attempt still in flight (no mark) keeps now + ten minutes, so a live reply is never cut off by the downgrade", () => {
    const db = new DatabaseSync(":memory:");
    try {
      withSpeechRows(db);
      db.exec(`UPDATE speech_attempts SET reserved_at=${at - 3 * 60 * MIN10}, state='streaming', outcome=NULL; UPDATE speech_accounts SET hold_until=0`);
      expect(speechCooldownUntil(db, at)).toBe(at + MIN10);
      expect(speechCooldownUntil(db, at + 7 * MIN10)).toBe(at + 8 * MIN10);
    } finally { db.close(); }
  });

  it("through the real memory downgrade: the first call refuses, the attempt is interrupted on disk, and once the hold has passed the next call goes ahead without any start in between", () => {
    const db = database();
    initializeImageOperations(db);
    ensureForgetTable(db);
    withSpeechRows(db);
    db.exec(`UPDATE speech_attempts SET reserved_at=${Date.now() - 3 * 60 * MIN10}, state='streaming', outcome=NULL; UPDATE speech_accounts SET hold_until=0`);
    closeDatabase();
    expect(refusal(() => downgradeInstallationMemorySchema(DATA_DIR, 10))?.code).toMatch(/^DOWNGRADE_VOICE_FINISHING_(9|10)$/);
    const mid = readOnly(join(DATA_DIR, "messages.db"));
    try {
      expect((mid.prepare("SELECT state FROM speech_attempts").get() as { state: string }).state).toBe("interrupted");
      expect(counts(mid)).toEqual(ONE_EACH);
    } finally { mid.close(); }
    // a second call inside the ten minutes still refuses and does not move the hold
    const before = (() => { const d = readOnly(join(DATA_DIR, "messages.db")); try { return (d.prepare("SELECT hold_until FROM speech_accounts").get() as { hold_until: number }).hold_until; } finally { d.close(); } })();
    expect(refusal(() => downgradeInstallationMemorySchema(DATA_DIR, 10))?.code).toMatch(/^DOWNGRADE_VOICE_FINISHING_/);
    const again = (() => { const d = readOnly(join(DATA_DIR, "messages.db")); try { return (d.prepare("SELECT hold_until FROM speech_accounts").get() as { hold_until: number }).hold_until; } finally { d.close(); } })();
    expect(again).toBe(before);
    // time passes (the hold and the rate window are now in the past); the build still has not started
    const w = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { w.exec(`UPDATE speech_accounts SET hold_until=${Date.now() - 1000}`); } finally { w.close(); }
    expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
  });

});

describe("a tampered speech object is refused", () => {
  const cases: Array<[string, string]> = [
    ["a trigger on a speech table", "CREATE TRIGGER speech_tamper AFTER INSERT ON speech_attempts BEGIN DELETE FROM messages; END"],
    ["a trigger on messages named like a speech object", "CREATE TRIGGER speech_clock_tick AFTER INSERT ON messages BEGIN UPDATE speech_clock SET value=value+1; END"],
    ["the automatic claim index made total (its WHERE dropped)", "DROP INDEX speech_automatic_claim; CREATE UNIQUE INDEX speech_automatic_claim ON speech_attempts(message_id)"],
    ["an index re-targeted to another column", "DROP INDEX speech_attempt_rate; CREATE INDEX speech_attempt_rate ON speech_attempts(account_scope_id)"],
    ["a speech table with its CHECK dropped", "DROP TABLE speech_sessions; CREATE TABLE speech_sessions (session_id TEXT PRIMARY KEY, principal TEXT NOT NULL, connection_id TEXT NOT NULL, thread_id TEXT NOT NULL, boot_id TEXT NOT NULL, state TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0, active_attempt TEXT); CREATE INDEX speech_session_connection ON speech_sessions(connection_id,state)"],
    ["a speech table with an extra column", "ALTER TABLE speech_accounts ADD COLUMN secret TEXT"],
    ["an unknown speech_ table", "CREATE TABLE speech_extra (id TEXT)"],
  ];
  for (const [label, sql] of cases) {
    it(label, () => {
      const f = backupFixture();
      try {
        withSpeechRows(f.db);
        expect(() => inspectInstallationDatabase(f.db)).not.toThrow();
        f.db.exec(sql);
        expect(() => inspectInstallationDatabase(f.db)).toThrow(UNSUPPORTED);
      } finally { f.db.close(); removeTempDirSync(f.parent); }
    });
  }
});
