import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { RESTORE_JOB_MARKS_DDL, RESTORE_BOOT_WAIT_DDL } from "./email/restore-job-marks-ddl.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { insertRoomRequest } from "./room-requests.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { fenceRestoredSql, holdForRestore, releaseHeldItem, restoreHoldFor, type RestoreHoldKind } from "./restore-fence.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

const roots: string[] = [];
afterEach(async () => {
  closeDatabase();
  await stopWalMaintenance();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
async function fresh() {
  closeDatabase();
  await stopWalMaintenance();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  return database();
}
async function close() {
  database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  await stopWalMaintenance();
}
function request(db: DatabaseSync, key: string) {
  return insertRoomRequest(db, {
    groupId: "g", verb: "ask", fromKind: "bot", admissionKey: key,
    lineage: { rootThreadId: "room", origin: "server", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
    targetThreadId: "room", toBotId: "worker", priority: "work", now: 3,
  }).request.id;
}
function liveHolds(db: DatabaseSync) {
  db.exec(RESTORE_JOB_MARKS_DDL);
  db.exec(RESTORE_BOOT_WAIT_DDL);
  db.prepare("INSERT INTO restore_job_marks VALUES (?, ?)").run("installed", "prior-restore");
  db.prepare("INSERT INTO restore_boot_wait VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("prior-restore", "backup", 3000, "waiting", 1, "prior-boot", 1000, "1", "2");
  channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
  for (const key of ["pending", "delivered", "removed"]) {
    const id = request(db, key);
    db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES (?, 'none')").run(id);
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(id);
  }
  fenceRestoredSql(db, "restore-before-downgrade");
  const kinds: RestoreHoldKind[] = ["project_close", "goal_close", "room_request", "card_delivery", "push_relay_removal", "image_operation", "output_receipt", "shared_result"];
  for (const kind of kinds) holdForRestore(db, kind, "missing", "restore-before-downgrade");
  expect(db.prepare("SELECT COUNT(*) AS n FROM restore_holds").get()!.n).toBe(11);
}
// Include every column and value, including blobs and full 64-bit integers, with stable row ordering.
// sqlite_master includes rootpage and the exact SQL, not just an object-name inventory.
function dump(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  const encode = (value: unknown) => JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? { integer: String(v) } : v instanceof Uint8Array ? { blob: Buffer.from(v).toString("hex") } : v);
  const rows = (sql: string) => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all().map(encode).sort();
  };
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'restore_*' ORDER BY name").all();
    return encode({ sqlite_master: rows("SELECT * FROM sqlite_master"), tables: tables.map(({ name }) => ({
      name, rows: rows(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`),
    })) });
  } finally { db.close(); }
}

it("DG2 live holds refuse target 13 and preserve the full restore tables and head schema byte for byte", async () => {
  liveHolds(await fresh());
  await close();
  const file = join(DATA_DIR, "messages.db"), before = dump(file);
  let error: unknown;
  try { downgradeInstallationMemorySchema(DATA_DIR, 13); } catch (caught) { error = caught; }
  const after = dump(file);
  if (process.env.DG2_EVIDENCE_DIR) {
    writeFileSync(join(process.env.DG2_EVIDENCE_DIR, "dg2-before.json"), before);
    writeFileSync(join(process.env.DG2_EVIDENCE_DIR, "dg2-after.json"), after);
  }
  expect.soft(error).toMatchObject({ code: "DOWNGRADE_WORK_PENDING" });
  expect(after).toBe(before);
});

it("DG2 empty holds downgrade to 13, upgrade to head, and complete a restore with owner authorization", async () => {
  const db = await fresh();
  fenceRestoredSql(db, "empty");
  expect(db.prepare("SELECT * FROM restore_holds").all()).toEqual([]);
  await close();
  expect(downgradeInstallationMemorySchema(DATA_DIR, 13)).toMatchObject({ status: "downgraded", to: 13 });
  const upgraded = database();
  expect(() => inspectInstallationDatabase(upgraded)).not.toThrow();
  expect(upgraded.prepare("SELECT * FROM restore_holds").all()).toEqual([]);
  channelToProjectRows(upgraded, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
  const id = request(upgraded, "after-upgrade");
  upgraded.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES (?, 'none')").run(id);
  upgraded.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(id);
  await close();
  const root = mkdtempSync(join(tmpdir(), "j4d3-roundtrip-")); roots.push(root);
  const archive = join(root, "backup.zip"), target = join(root, "restored");
  writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([{ id: "worker", threadId: "worker-thread", name: "Worker" }, { id: "lead", threadId: "lead-thread", name: "Lead" }]));
  writeFileSync(join(DATA_DIR, "groups.json"), JSON.stringify([{ id: "g", threadId: "room", name: "Project", memberIds: ["worker", "lead"], channelProject: { goal: "Fixture", status: "active", startedAt: 1, updatedAt: 1 } }]));
  const backup = await writeInstallationArchive(DATA_DIR, archive);
  const restored = await restoreInstallation(target, archive, backup.sha256, { requireNew: true });
  expect(restored.activationAvailable).toBe(false);
  const copy = new DatabaseSync(join(target, "messages.db"));
  try {
    expect(() => inspectInstallationDatabase(copy)).not.toThrow();
    expect(copy.prepare("SELECT id FROM room_requests WHERE id=?").get(id)?.id).toBe(id);
    const hold = restoreHoldFor(copy, "shared_result", id);
    expect(hold).toMatchObject({ restoreHeld: true, restoreGen: expect.any(String) });
    expect(releaseHeldItem(copy, "shared_result", id, "old-token", hold!.restoreGen)).toEqual({ ok: false, reason: "stale_generation" });
    expect(releaseHeldItem(copy, "shared_result", id, hold!.restoreGen, hold!.restoreGen)).toEqual({ ok: true });
    expect(restoreHoldFor(copy, "shared_result", id)).toBeNull();
  } finally { copy.close(); }
});

it("DG2 the actual CLI names the pending restore and tells the owner to finish or cancel it first", async () => {
  liveHolds(await fresh());
  await close();
  const file = join(DATA_DIR, "messages.db"), before = dump(file);
  const result = await promisify(execFile)(process.execPath, ["scripts/installation-recovery.ts", "memory-downgrade", "--data-dir", DATA_DIR, "--to", "13"], { timeout: 20_000 }).catch(error => error);
  expect(result.code).toBe(1);
  const line = JSON.parse(result.stderr.trim().split("\n").at(-1));
  expect(line).toEqual({ ok: false, error: "DOWNGRADE_WORK_PENDING", message: "Murage can't go back to the earlier version while messages or a restore are pending. Finish or cancel the pending restore first, then send or cancel any waiting messages and try again." });
  const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8"));
  expect(line.message).toBe(en["recovery.downgradeWorkPending"]);
  expect(dump(file)).toBe(before);
});
