// SPDX-License-Identifier: AGPL-3.0-or-later
// Restore contract for the message search index (messages_fts + its four
// shadow tables). The offline archive inspector accepts only objects it knows
// by name AND definition, so a backup/restore that has not learned the index
// refuses every installation that has one. These tests pin: a snapshot of a
// live, indexed installation is accepted and carries the index; the restored
// copy answers search identically; an archive from before the index restores
// and gets one; and a tampered index definition is still refused.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { closeMessageDb, deleteThread, insertMessage, searchMessages, updateMessage } from "./message-db.ts";
import { backfillMessageSearchIndex, messageSearchIndexReady, trigramQuery } from "./message-search-index.ts";
import type { Message } from "./store.ts";

let clock = 0;
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });
const roots: string[] = [];
const queries = ["railway", "RAILWAY up", "日本語", "日本", "café", "needle", "alembic", "removed", "edited", "zzz-nothing", "50%"];
const answers = () => queries.map((query) => searchMessages(query).map((hit) => `${hit.threadId}/${hit.messageId}`));
const indexedRows = () => Number(database().prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get()!.n);

/** A used installation: every write path has run (insert, replace, edit, delete). */
function populate() {
  insertMessage("a", msg("m1", "Deploy to Railway, then railway up again"));
  insertMessage("a", msg("m2", "日本語のテキスト、café ☕ needle"));
  insertMessage("a", { id: "c1", role: "bot", kind: "activity", at: ++clock, tool: { name: "Bash: alembic upgrade head", ok: true } } as Message);
  insertMessage("b", msg("m3", "50% of this will be removed"));
  insertMessage("b", msg("m4", "to be edited"));
  updateMessage("b", msg("m4", "has been edited needle"));
  insertMessage("a", msg("m1", "Deploy to Railway, then railway up again")); // replace: new rowid
  deleteThread("b");
  insertMessage("b", msg("m5", "50% survivor, edited"));
}
function stage(): string { const root = mkdtempSync(join(tmpdir(), "murage-search-restore-")); roots.push(root); return root; }
/** What the restore flow does with the snapshot: it becomes the new installation's messages.db. */
function restoreInto(snapshot: string) {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  copyFileSync(snapshot, join(DATA_DIR, "messages.db"));
}

beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMessageDb(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("snapshots an indexed installation, carries the index, and restored search answers identically", async () => {
  populate();
  const before = answers();
  expect(before.flat().length).toBeGreaterThan(0);
  const indexed = indexedRows();
  expect(indexed).toBeGreaterThan(0);
  closeMessageDb(); // the offline snapshot takes the installation lease; the app is not running
  const target = join(stage(), "snapshot.db");
  expect(await snapshotInstallationDatabase(DATA_DIR, target)).toMatchObject({ status: "copied" });

  // The index travelled inside the file: ask it directly, before the app ever opens it.
  const file = new DatabaseSync(target, { readOnly: true });
  try {
    expect(file.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get()!.n).toBe(indexed);
    expect(file.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get(trigramQuery("railway"))!.n).toBeGreaterThan(0);
    expect(file.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(inspectInstallationDatabase(file).messages).toBeGreaterThan(0);
  } finally { file.close(); }

  restoreInto(target);
  expect(answers()).toEqual(before);
  expect(messageSearchIndexReady(database())).toBe(true);
  expect(backfillMessageSearchIndex(database())).toBe(0); // nothing missing: it did not need rebuilding
  expect(indexedRows()).toBe(indexed);
});

it("restores a snapshot taken while the index was ahead of the checkpoint (WAL-resident writes)", async () => {
  populate();
  const before = answers();
  database().exec("PRAGMA wal_autocheckpoint=0"); // keep this run's writes in the -wal file
  insertMessage("a", msg("m9", "written after the last checkpoint needle"));
  const expected = searchMessages("after the last checkpoint").length;
  expect(expected).toBe(1);
  closeMessageDb();
  const target = join(stage(), "snapshot.db");
  await snapshotInstallationDatabase(DATA_DIR, target);
  restoreInto(target);
  expect(searchMessages("after the last checkpoint")).toHaveLength(1);
  expect(answers().slice(0, 3)).toEqual(before.slice(0, 3));
});

it("an archive from before the index restores, and the first open builds the index", async () => {
  populate();
  const before = answers();
  // Make the snapshot source look like a database an older release wrote.
  database().exec("DROP TABLE messages_fts");
  expect(database().prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts%'").all()).toEqual([]);
  closeMessageDb();
  const target = join(stage(), "snapshot.db");
  expect(await snapshotInstallationDatabase(DATA_DIR, target)).toMatchObject({ status: "copied" });
  restoreInto(target);
  expect(answers()).toEqual(before);
  expect(messageSearchIndexReady(database())).toBe(true);
  expect(indexedRows()).toBeGreaterThan(0);
});

it("a restored index that is behind its messages is topped up, never trusted blind", async () => {
  populate();
  const before = answers();
  database().exec("DELETE FROM messages_fts WHERE rowid > 2"); // a partially built index
  closeMessageDb();
  const target = join(stage(), "snapshot.db");
  await snapshotInstallationDatabase(DATA_DIR, target);
  restoreInto(target);
  expect(answers()).toEqual(before);
});

it.each([
  ["full position detail", "DROP TABLE messages_fts; CREATE VIRTUAL TABLE messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1)"],
  ["a different tokenizer", "DROP TABLE messages_fts; CREATE VIRTUAL TABLE messages_fts USING fts5(t, tokenize='porter', content='', contentless_delete=1, detail=none)"],
  ["an extra column", "DROP TABLE messages_fts; CREATE VIRTUAL TABLE messages_fts USING fts5(t, u, tokenize='trigram', content='', contentless_delete=1, detail=none)"],
  ["stored content", "DROP TABLE messages_fts; CREATE VIRTUAL TABLE messages_fts USING fts5(t, tokenize='trigram')"],
  ["an extra shadow-looking table", "CREATE TABLE messages_fts_extra(x)"],
  ["a trigger on the index", "CREATE TRIGGER hostile AFTER INSERT ON messages BEGIN DELETE FROM thread_state; END"],
])("still refuses an archive whose search index has %s", async (_name, sql) => {
  populate();
  database().exec(sql);
  closeMessageDb();
  const target = join(stage(), "snapshot.db");
  await expect(snapshotInstallationDatabase(DATA_DIR, target)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
  expect(existsSync(target)).toBe(false);
});
