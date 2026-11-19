// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: trainred-store-rollback (create persistence). Consumer owner: trainred-createbot (staged HTTP creates).
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { cancelCoalesced, syncParentDirectory, writeFileAtomic } from "./atomic.ts";
import { database, transaction } from "./database.ts";
import { RoutineRunsJournal } from "./routine-runs-journal.ts";
import { afterCommit, onRollback } from "./tx-scope.ts";

const files = ["bots.json", "groups.json"] as const;
const journalName = /^\.bot-create-([a-f0-9-]{36})\.json$/;
const temporaryName = /^(?:bots\.json|groups\.json|\.bot-create-[a-f0-9-]{36}\.json)\.[0-9]+\.[a-f0-9-]{36}\.tmp$/;
const bytes = z.string().refine(s => Buffer.from(s, "base64").toString("base64") === s);
const schema = z.object({ version: z.literal(1), id: z.uuid(), order: z.number().int().nonnegative(),
  run: z.object({ id: z.string().min(1), routineId: z.string().min(1) }).catchall(z.unknown())
    .refine(run => !Object.keys(run).some(key => key.startsWith("$"))).optional(),
  files: z.object({ "bots.json": bytes.nullable(), "groups.json": bytes.nullable() }).strict(),
}).strict();
type Journal = z.infer<typeof schema>;
let order = 0;
const failedRestorations = new Set<string>();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function read(path: string): string | null {
  try { return readFileSync(path).toString("base64"); }
  catch (error) { if (absent(error)) return null; throw error; }
}
function remove(path: string): void {
  try { unlinkSync(path); } catch (error) { if (!absent(error)) throw error; }
  syncParentDirectory(path);
}
function restore(root: string, journal: Journal, receiptRestore?: () => void): void {
  for (const file of files) {
    const path = join(root, file), before = journal.files[file];
    cancelCoalesced(path);
    if (read(path) === before) continue;
    if (before === null) remove(path);
    else writeFileAtomic(path, Buffer.from(before, "base64"), { mode: 0o600, syncDir: true });
  }
  if (journal.run) {
    if (receiptRestore) receiptRestore();
    else new RoutineRunsJournal(root).append({ runs: [journal.run], routines: [], removed: [] });
  }
}

/** Called under the create's SQLite writer lock, before its first file change.
 * The marker commits with the messages/bindings; its journal survives a process
 * death and restores original bytes if that transaction never committed. */
export function prepareBotCreateRollback(root: string, receipt?: { run: { id: string; routineId: string }; restore: () => void }): void {
  assertBotCreateRecovered(root);
  const db = database();
  if (!db.isTransaction) throw new Error("BOT_CREATE_REQUIRES_TRANSACTION");
  const id = randomUUID(), path = join(root, `.bot-create-${id}.json`);
  const journal: Journal = { version: 1, id, ...(receipt ? { run: receipt.run } : {}), order: order = Math.max(Date.now(), order + 1),
    files: { "bots.json": read(join(root, "bots.json")), "groups.json": read(join(root, "groups.json")) } };
  onRollback(() => {
    if (failedRestorations.has(root)) return;
    if (!existsSync(path)) return;
    // Keep the journal on an I/O failure: restart must retry, never accept the failed roster.
    try { restore(root, journal, receipt?.restore); remove(path); }
    catch (error) {
      failedRestorations.add(root);
      console.error("store: bot create rollback needs recovery", error);
      throw error;
    }
  });
  afterCommit(() => {
    remove(path);
    db.prepare("DELETE FROM bot_create_commits WHERE id=?").run(id);
  });
  writeFileAtomic(path, JSON.stringify(journal), { mode: 0o600, syncDir: true });
  db.exec("CREATE TABLE IF NOT EXISTS bot_create_commits(id TEXT PRIMARY KEY NOT NULL)");
  db.prepare("INSERT INTO bot_create_commits(id) VALUES(?)").run(id);
}

export function assertBotCreateRecovered(root: string): void {
  if (failedRestorations.has(root)) throw new Error("BOT_CREATE_RECOVERY_REQUIRED");
}

/** Recover before Store reads either roster or flushes any coalesced save. */
export function recoverBotCreates(root: string): void {
  if (!existsSync(root)) return;
  const names = readdirSync(root);
  const journals = names.filter(name => journalName.test(name)).map(name => {
    const path = join(root, name);
    if (!lstatSync(path).isFile()) throw new Error("INVALID_BOT_CREATE_JOURNAL");
    const journal = schema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (name !== `.bot-create-${journal.id}.json`) throw new Error("INVALID_BOT_CREATE_JOURNAL");
    return { path, journal };
  }).sort((a, b) => b.journal.order - a.journal.order);
  if (journals.length) transaction(db => {
    const table = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_create_commits'").get();
    for (const { path, journal } of journals) {
      if (!table || !db.prepare("SELECT 1 FROM bot_create_commits WHERE id=?").get(journal.id)) restore(root, journal);
      remove(path);
      if (table) db.prepare("DELETE FROM bot_create_commits WHERE id=?").run(journal.id);
    }
  }, { op: "recoverBotCreates" });
  for (const name of names) if (temporaryName.test(name)) remove(join(root, name));
  failedRestorations.delete(root);
}
