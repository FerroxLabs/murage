import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeMessageTables } from "../message-tables.ts";
import { writeInstallationArchive } from "../installation-archive.ts";
import { restoreInstallation } from "../installation-restore.ts";
import { initializeHighLevelThreadMarks, markHighLevelThread, highLevelThreadMarked } from "./thread-marks.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { mergeDestinationHighLevelMarks } from "./thread-marks-restore.ts";
import { mergeOriginalMemoryDeletions } from "../memory/restore.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "highlevel-marks-restore-")); roots.push(root);
  const target = join(root, "installation"); mkdirSync(target);
  writeFileSync(join(target, "bots.json"), "[]");
  writeFileSync(join(target, "groups.json"), "[]");
  const db = new DatabaseSync(join(target, "messages.db"));
  initializeMessageTables(db); initializeHighLevelThreadMarks(db);
  db.exec("INSERT INTO thread_state VALUES ('t', NULL)");
  markHighLevelThread(db, "backup-only"); db.close();
  const archive = join(root, "before-mark.zip");
  const backup = await writeInstallationArchive(target, archive);
  return { target, archive, sha: backup.sha256 };
}

it("snapshot T, mark T, restore the older snapshot, reopen: marks are a permanent union", async () => {
  const f = await fixture();
  const current = new DatabaseSync(join(f.target, "messages.db"));
  expect(markHighLevelThread(current, "t")).toBe(true);
  current.exec("DELETE FROM highlevel_thread_marks WHERE thread_id='backup-only'");
  current.close();
  await restoreInstallation(f.target, f.archive, f.sha);
  const reopened = new DatabaseSync(join(f.target, "messages.db"));
  try {
    expect(reopened.prepare("SELECT thread_id FROM highlevel_thread_marks ORDER BY thread_id").all()).toEqual([
      { thread_id: "backup-only" }, { thread_id: "t" },
    ]);
    expect(highLevelThreadMarked(reopened, "t")).toBe("marked");
  } finally { reopened.close(); }
});

it("refuses restoration before replacing an unreadable destination mark ledger", async () => {
  const f = await fixture();
  const path = join(f.target, "messages.db");
  writeFileSync(path, "unreadable destination database");
  await expect(restoreInstallation(f.target, f.archive, f.sha)).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe("unreadable destination database");
});

it("refuses restoration before replacing a malformed destination mark table", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.target, "messages.db"));
  db.exec("DROP TABLE highlevel_thread_marks; CREATE TABLE highlevel_thread_marks(thread_id TEXT)");
  db.close();
  await expect(restoreInstallation(f.target, f.archive, f.sha)).rejects.toThrow();
  const reopened = new DatabaseSync(join(f.target, "messages.db"));
  try { expect(reopened.prepare("PRAGMA table_info(highlevel_thread_marks)").all()).toHaveLength(1); }
  finally { reopened.close(); }
});

it("retains marks added after the snapshot before selecting a separately restored installation", async () => {
  const f = await fixture();
  const candidate = join(f.target, "..", "candidate");
  await restoreInstallation(candidate, f.archive, f.sha);
  const current = new DatabaseSync(join(f.target, "messages.db"));
  markHighLevelThread(current, "t"); current.close();
  mergeOriginalMemoryDeletions(f.target, candidate);
  const reopened = new DatabaseSync(join(candidate, "messages.db"));
  try { expect(highLevelThreadMarked(reopened, "t")).toBe("marked"); }
  finally { reopened.close(); }
});

it("a failed candidate write throws and leaves the destination mark intact", async () => {
  const f = await fixture();
  const candidate = join(f.target, "..", "candidate"); mkdirSync(candidate);
  const broken = new DatabaseSync(join(candidate, "messages.db"));
  initializeHighLevelThreadMarks(broken);
  broken.exec("CREATE TRIGGER refuse_marks BEFORE INSERT ON highlevel_thread_marks BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  broken.close();
  expect(() => mergeDestinationHighLevelMarks(f.target, candidate)).toThrow("fixture write failure");
  const original = new DatabaseSync(join(f.target, "messages.db"));
  try { expect(highLevelThreadMarked(original, "backup-only")).toBe("marked"); }
  finally { original.close(); }
});
