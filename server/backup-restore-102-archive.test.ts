// A backup made by Murage 1.0.2 restores in 1.0.3 (release finding 07-1). 1.0.3 appends output_publications.turn_id by ALTER
// (artifacts.ts initializeArtifacts); the restore's database check holds every table to a definition the app writes, so until the
// column was registered as appended later, every 1.0.2 archive was refused with DATABASE_SCHEMA_UNSUPPORTED.
//
// Three proofs, from the narrowest to the most real:
//  1. every object the real 1.0.2 server writes into messages.db (testing/messages-db-1.0.2-schema.json, read back from a first
//     start of git afbf549ba) passes 1.0.3's check, and 1.0.3's migration then adds turn_id to the kept receipt;
//  2. a backup whose output_publications is the 1.0.2 table restores through 1.0.3's own encrypted backup and restore;
//  3. the REAL 1.0.2 server writes a data folder, the REAL 1.0.2 backup code encrypts it, 1.0.3 restores it and the real 1.0.3
//     server starts on it (git archive afbf549ba extracted into the gitignored .v102-ref; skipped without it, like .v101-ref).
// Test data only (fake engine, throwaway folders). Run in the build host container (hz-test.sh), never on a Mac.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { downgradeOutputPublicationTurnTo102, initializeArtifacts } from "./artifacts.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const SCHEMA_102 = JSON.parse(readFileSync(join(import.meta.dirname, "testing", "messages-db-1.0.2-schema.json"), "utf8")) as { version: string; rows: Array<{ type: string; name: string; sql: string }> };
const OUTPUT_PUBLICATIONS_102 = SCHEMA_102.rows.find(row => row.name === "output_publications")!.sql;
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
const tableSql = (db: DatabaseSync, table: string) => (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
/** One registered shell-output receipt, as output-publication.ts writes it, in the 1.0.2 columns (no turn_id). */
const insertReceipt = (db: DatabaseSync, id: string, threadId: string) =>
  db.prepare("INSERT INTO output_publications(id,producer,bot_id,thread_id,run_id,path_token,sha256,mime,bytes,stage,artifact_id,attachment_id,message_id,error_category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "shell-output", "bot", threadId, "run-102", "token-102", "a".repeat(64), "text/plain", 12, "registered", null, null, null, null, 1, 1);

describe("a 1.0.2 backup restores in 1.0.3", () => {
  it("accepts every object the real 1.0.2 server writes, and the 1.0.3 migration adds turn_id to the kept receipt", () => {
    expect(SCHEMA_102.version).toBe("1.0.2");
    const db = new DatabaseSync(":memory:");
    try {
      // a virtual table's shadow tables are listed after it, and SQLite makes them itself
      const virtual = SCHEMA_102.rows.filter(row => /^CREATE VIRTUAL TABLE/i.test(row.sql)).map(row => `${row.name}_`);
      for (const row of SCHEMA_102.rows) if (!virtual.some(prefix => row.type === "table" && row.name.startsWith(prefix))) db.exec(row.sql);
      expect(columns(db, "output_publications")).not.toContain("turn_id");
      const message = { id: "m1", at: 1, role: "user", kind: "text", text: "kept from 1.0.2" };
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("thread", "m1", 1, "user", "text", message.text, JSON.stringify(message));
      db.exec("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES('thread','m1')");
      insertReceipt(db, "receipt-102", "thread");
      // the restore's check (installation-restore-preparation.ts): 1.0.3 refused this file before turn_id was registered
      expect(inspectInstallationDatabase(db)).toMatchObject({ messages: 1, threads: 1 });
      initializeArtifacts(db);
      expect(columns(db, "output_publications")).toContain("turn_id");
      expect(db.prepare("SELECT id, stage, turn_id FROM output_publications").all()).toEqual([{ id: "receipt-102", stage: "registered", turn_id: null }]);
      // and the migrated file is still one the check accepts (a 1.0.3 backup of it)
      expect(() => inspectInstallationDatabase(db)).not.toThrow();
    } finally { db.close(); }
  });

  it.skipIf(!rawAgeHost)("restores an encrypted backup whose output_publications is the 1.0.2 table, receipt included", { timeout: 120_000 }, async () => {
    const f = backupFixture(), keys = testAgeKeys();
    try {
      initializeArtifacts(f.db);
      insertReceipt(f.db, "receipt-102", "thread");
      expect(downgradeOutputPublicationTurnTo102(f.db)).toEqual({ dropped: true });
      expect(tableSql(f.db, "output_publications").replace(/\s+/g, " ")).toBe(OUTPUT_PUBLICATIONS_102.replace(/\s+/g, " "));
      f.db.close();
      const archive = join(f.parent, "backup.age");
      const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
      const target = join(f.parent, "restored");
      const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
      expect(restored.status).toBe("restored-review-required");
      const db = new DatabaseSync(join(target, "messages.db"));
      try {
        expect(columns(db, "output_publications")).not.toContain("turn_id");
        expect(String(db.prepare("SELECT json FROM messages").get()?.json)).toContain("WAL-visible transcript");
        initializeArtifacts(db);
        expect(db.prepare("SELECT id, turn_id FROM output_publications").all()).toEqual([{ id: "receipt-102", turn_id: null }]);
      } finally { db.close(); }
    } finally { try { f.db.close(); } catch { /* closed above */ } removeTempDirSync(f.parent); }
  });
});

const V102 = join(process.cwd(), ".v102-ref");
const have102 = existsSync(join(V102, "scripts", "control-murage.ts")) && existsSync(join(V102, "server", "installation-encrypted-backup.ts"));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!have102 || !rawAgeHost || process.platform === "win32")("the real 1.0.2 server and backup, restored by 1.0.3", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const close of closers) await close().catch(() => {}); });

  it("1.0.2 writes and encrypts the folder; 1.0.3 restores it, then starts on it and adds turn_id with every row kept", async () => {
    expect((JSON.parse(readFileSync(join(V102, "package.json"), "utf8")) as { version: string }).version).toBe("1.0.2");
    // a variable: the type check never reads the 1.0.2 tree
    const load = async <T>(path: string) => await import(/* @vite-ignore */ join(V102, path)) as T;
    const control = await load<{ launchVerificationServer: typeof launchVerificationServer }>("scripts/control-murage.ts");
    const backup102 = await load<{ writeEncryptedInstallationBackup: typeof writeEncryptedInstallationBackup }>("server/installation-encrypted-backup.ts");
    const inventory102 = await load<{ classifyDataDirEntry: (name: string) => { backup: string } | undefined }>("server/data-dir-inventory.ts");
    const keys = testAgeKeys();

    // ── 1.0.2: a bot, a conversation the fake engine answered, then a shell-output receipt ──
    const a = await control.launchVerificationServer(process.env);
    closers.push(() => a.close());
    const secret = (await (await fetch(`${a.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${a.info.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const bot = (await post("/api/bots", { name: "Keeper" })).body.bot as { id: string; threadId: string };
    expect(bot?.threadId).toBeTruthy();
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Remember this. RESTORE102_TAG" })).status).toBeLessThan(300);
    const live = new DatabaseSync(join(a.info.dataDir, "messages.db"), { readOnly: true });
    try {
      for (const started = Date.now(); Date.now() - started < 60_000; await sleep(200)) {
        if (live.prepare("SELECT 1 AS x FROM messages WHERE thread_id=? AND role='assistant'").get(bot.threadId)) break;
      }
    } finally { live.close(); }
    await a.stop();
    const written102 = new DatabaseSync(join(a.info.dataDir, "messages.db"));
    try {
      expect(columns(written102, "output_publications")).not.toContain("turn_id");
      insertReceipt(written102, "receipt-102", bot.threadId);
      written102.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { written102.close(); }

    // the installation folder as 1.0.2 itself classifies it (the fixture's fake-engine files are not an installation's)
    const installation = join(a.info.dataDir, "..", `installation-102-${process.pid}`);
    mkdirSync(installation);
    closers.push(async () => removeTempDirSync(installation));
    for (const name of readdirSync(a.info.dataDir)) {
      const kind = inventory102.classifyDataDirEntry(name)?.backup;
      if (!kind || kind === "excluded" || kind === "refused" || kind === "sidecar") continue;
      cpSync(join(a.info.dataDir, name), join(installation, name), { recursive: true });
    }
    const archive = join(a.info.dataDir, "..", `backup-102-${process.pid}.age`);
    closers.push(async () => rmSync(archive, { force: true }));
    const written = await backup102.writeEncryptedInstallationBackup(installation, archive, { ...keys, selection });

    // ── 1.0.3: restore the 1.0.2 archive ──
    const target = join(a.info.dataDir, "..", `restored-102-${process.pid}`);
    closers.push(async () => removeTempDirSync(target));
    const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(restored.status).toBe("restored-review-required");
    const restoredDb = new DatabaseSync(join(target, "messages.db"), { readOnly: true });
    try {
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%RESTORE102_TAG%'").get()).toEqual({ n: 1 });
      expect(restoredDb.prepare("SELECT id FROM output_publications").all()).toEqual([{ id: "receipt-102" }]);
    } finally { restoredDb.close(); }

    // ── the real 1.0.3 server starts on the restored database: the migration runs and nothing is lost ──
    const b = await launchVerificationServer(process.env);
    closers.push(() => b.close());
    await b.stop();
    for (const name of readdirSync(b.info.dataDir)) if (/^messages\.db/.test(name)) rmSync(join(b.info.dataDir, name), { force: true });
    copyFileSync(join(target, "messages.db"), join(b.info.dataDir, "messages.db"));
    await b.restart();
    await b.stop();
    const migrated = new DatabaseSync(join(b.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect(columns(migrated, "output_publications")).toContain("turn_id");
      expect(migrated.prepare("SELECT id, stage, turn_id FROM output_publications").all()).toEqual([{ id: "receipt-102", stage: "registered", turn_id: null }]);
      expect(migrated.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%RESTORE102_TAG%'").get()).toEqual({ n: 1 });
    } finally { migrated.close(); }
    expect(readFileSync(b.info.logPath, "utf8")).not.toMatch(/DATABASE_SCHEMA_UNSUPPORTED|SqliteError/);
  }, 600_000);
});
