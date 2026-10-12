// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 integration fix: the connected-app ledger travels with a backup. An
// action that reached its app stays done whichever computer asks next, so its
// unknown-outcome record must keep blocking an equivalent request after a
// restore, and a restore over an existing installation keeps that
// installation's unresolved records as well.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConnectedAppOperations } from "./connected-app-operations.ts";
import { SqliteOperationJournal, readJournalFile, type JournalRecord } from "./connected-app-journal.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";

const roots: string[] = [];
const open: SqliteOperationJournal[] = [];
afterEach(() => {
  for (const journal of open.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const record = (handle: string, key: string, state: JournalRecord["state"], extra: Partial<JournalRecord> = {}): JournalRecord => ({
  handle, scope: "scope-a", key, label: "Gmail: send email", startedAt: Date.now() - 1000, state,
  ...(state === "unknown" ? { cause: "no-answer" as const } : {}), requirements: [], requirementsComplete: true, ...extra,
});

function installation(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "bots.json"), "[]");
  writeFileSync(join(dir, "groups.json"), "[]");
  return dir;
}
function ledger(dir: string, records: JournalRecord[]) {
  const journal = new SqliteOperationJournal(join(dir, "connected-app-ledger.db"));
  open.push(journal); // left open on purpose: the records sit in the WAL, as in a running installation
  for (const item of records) journal.put(item);
  return journal;
}
const operationsOver = (dir: string) => {
  const journal = new SqliteOperationJournal(join(dir, "connected-app-ledger.db"));
  open.push(journal);
  return new ConnectedAppOperations(Date.now, journal);
};

async function backup(source: string, root: string) {
  const archive = join(root, "backup.zip");
  const result = await writeInstallationArchive(source, archive);
  return { archive, sha: result.sha256 };
}

it("backup then restore keeps an unknown-outcome record and the duplicate stays blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-backup-")); roots.push(root);
  const source = installation(root, "source");
  ledger(source, [record("h-unknown", "key-unknown", "unknown"), record("h-pending", "key-pending", "pending")]);
  const { archive, sha } = await backup(source, root);

  const target = join(root, "restored");
  await restoreInstallation(target, archive, sha, { requireNew: true });

  const ops = operationsOver(target);
  expect(ops.blocking("scope-a", "key-unknown")?.outcome).toMatchObject({ kind: "unknown" });
  // What was on its way when the backup was taken reads as not known to have finished.
  expect(ops.blocking("scope-a", "key-pending")?.outcome).toMatchObject({ kind: "unknown", cause: "interrupted" });
  expect(ops.blocking("scope-a", "key-other")).toBeUndefined();
});

it("restoring over an existing installation keeps both sides' unresolved records", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-merge-")); roots.push(root);
  const source = installation(root, "source");
  ledger(source, [record("h-backup", "key-backup", "unknown")]);
  const { archive, sha } = await backup(source, root);

  const target = installation(root, "target");
  const mine = ledger(target, [record("h-mine", "key-mine", "unknown"), record("h-mine-pending", "key-mine-pending", "pending")]);
  mine.close();

  const result = await restoreInstallation(target, archive, sha);
  expect(result.previousDataDir).not.toBeNull();

  const ops = operationsOver(target);
  expect(ops.blocking("scope-a", "key-backup")?.outcome).toMatchObject({ kind: "unknown" });
  expect(ops.blocking("scope-a", "key-mine")?.outcome).toMatchObject({ kind: "unknown" });
  expect(ops.blocking("scope-a", "key-mine-pending")?.outcome).toMatchObject({ kind: "unknown", cause: "interrupted" });
  // The installation that was replaced is kept as it was.
  expect(readJournalFile(join(result.previousDataDir!, "connected-app-ledger.db")).map((item) => item.handle).sort()).toEqual(["h-mine", "h-mine-pending"]);
});

it("restoring a backup that holds no ledger over an installation that has one keeps its unresolved records", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-merge-none-")); roots.push(root);
  const source = installation(root, "source");
  const { archive, sha } = await backup(source, root);
  const target = installation(root, "target");
  ledger(target, [record("h-mine", "key-mine", "unknown")]).close();

  await restoreInstallation(target, archive, sha);
  expect(operationsOver(target).blocking("scope-a", "key-mine")?.outcome).toMatchObject({ kind: "unknown" });
});

it("after a restore and a reconnect with new credentials the same action stays blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-reconnect-")); roots.push(root);
  const source = installation(root, "source");
  // Scopes are bot|credential-hash; the restore makes new credentials, so the hash differs afterwards.
  ledger(source, [
    record("h-unknown", "key-unknown", "unknown", { scope: "bot-1|hash-old" }),
    record("h-pending", "key-pending", "pending", { scope: "bot-1|hash-old" }),
    // finished after the bot stopped waiting: not collected yet
    record("h-done", "key-done", "answered", { scope: "bot-1|hash-old" }),
    record("h-seen", "key-seen", "answered", { scope: "bot-1|hash-old", deliveredAt: Date.now() - 1000 }),
  ]);
  const { archive, sha } = await backup(source, root);
  const target = join(root, "restored");
  await restoreInstallation(target, archive, sha, { requireNew: true });

  const ops = operationsOver(target);
  const reconnected = "bot-1|hash-new";
  expect(ops.blocking(reconnected, "key-unknown")?.outcome).toMatchObject({ kind: "unknown" });
  expect(ops.blocking(reconnected, "key-pending")?.outcome).toMatchObject({ kind: "unknown", cause: "interrupted" });
  expect(ops.blocking(reconnected, "key-done")).toBeDefined();
  expect(ops.blocking(reconnected, "key-seen")).toBeDefined();
  // The handle the bot was told still answers after the reconnect.
  expect(ops.byHandle(reconnected, "h-unknown")).toBeDefined();
  // Only the same bot is held back, and only the same action.
  expect(ops.blocking("bot-2|hash-new", "key-unknown")).toBeUndefined();
  expect(ops.blocking(reconnected, "key-other")).toBeUndefined();
});

it("a destination ledger that cannot be read stops the restore and keeps the current installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-corrupt-")); roots.push(root);
  const source = installation(root, "source");
  const { archive, sha } = await backup(source, root);
  const target = installation(root, "target");
  writeFileSync(join(target, "connected-app-ledger.db"), "this is not a database file at all, it is just text".repeat(40));

  await expect(restoreInstallation(target, archive, sha)).rejects.toMatchObject({ code: "CONNECTED_APP_LEDGER_UNREADABLE", path: "connected-app-ledger.db" });
  // The installation being replaced is exactly where it was.
  expect(existsSync(join(target, "bots.json"))).toBe(true);
  expect(readFileSync(join(target, "connected-app-ledger.db"), "utf8")).toContain("this is not a database file");
});
