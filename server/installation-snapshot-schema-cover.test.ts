// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Schema coverage of the installation snapshot. Restore park J2 added restore_job_marks, a table no initializer makes (the first owner restore
// creates it), so the structural guard in backup-restore-speech-tables.test.ts, which only opens a fresh database, never saw it and a home that
// had finished an owner restore failed its encrypted backup and export. This test builds the live schema the way a home that finished an owner
// restore holds it: the real open path, then every feature that creates its tables lazily (phones, image library, email, the
// upgrade tables), then the real restore effects (stage, install, prepare). It enumerates sqlite_schema and fails when any table is in neither the
// snapshot registry nor the explicit exclusion list below. A second guard reads every non-test source file under server/ and fails when a
// CREATE TABLE there names a table the fixture never produced, unless the file keeps its tables in another database file (listed with the reason).
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { EmailStore } from "./email/email-store.ts";
import { sqliteRestoreEffects } from "./email/restore-job-effects.ts";
import { RestoreJobStore, type RestoreJob } from "./email/restore-job.ts";
import { ensureForgetTable } from "./harness/event-log.ts";
import { listPromptBlocksForOwner } from "./image-library.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { isInboxProjectionObject } from "./inbox.ts";
import { inspectInstallationDatabase, registeredSnapshotObjects, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { MESSAGE_SEARCH_DDL } from "./message-tables.ts";
import { ensureIntegrityPassTable } from "./memory/integrity-state.ts";
import { validateMemorySchema } from "./memory/schema.ts";
import { ensureScrubPassTable } from "./memory/scrub-state.ts";
import { LEGACY_UPGRADE_TABLES, ensureUpgradeAppTables } from "./memory/upgrade-app-tables.ts";
import { initializeAskRevocations } from "./phones/ask-revocations.ts";
import { initializePhoneReceipts } from "./phones/receipts.ts";
import { initializePhones } from "./phones/registry.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { stopSearchIndex } from "./message-search-index.ts";

/** Tables the snapshot registry does not list, each with the reason. A new table belongs in the registry (APP_TABLES in
 *  installation-database-snapshot.ts) unless it is added here with a reason. Names SQLite itself keeps (sqlite_*) are not ours and are filtered
 *  by prefix, not listed. */
const EXCLUDED_TABLES: Readonly<Record<string, string>> = {};

/** Tables the registry accepts but the staged copy of a backup must not carry, each with the reason. */
const ACCEPTED_BUT_NOT_BACKED_UP: Readonly<Record<string, string>> = {
  restore_boot_wait: "the owner line of THIS installation own boot wait; its identity and boot id mean nothing in another installation",
  restore_job_marks: "marks of THIS installation's own owner restore (swapped, prepared, blind); they mean nothing inside another installation's restore",
};

/** Source files under server/ whose CREATE TABLE statements are not for the desktop messages.db the fixture builds, each with the reason. Every other file's tables must be
 *  in the fixture below (so in the registry, the memory schema or the inbox projection, or this test fails on the schema check). A file listed
 *  here that no longer holds a CREATE TABLE is reported as stale. */
const OUTSIDE_THE_FIXTURE: Readonly<Record<string, string>> = {
  "cloud-sessions.ts": "cloud_* tables exist only on a Cloud home (MURAGE_CLOUD_ROLE=home, index.ts homeSessions) and the desktop snapshot registry has no entry for them; a Cloud home is not backed up through this snapshot path (the registry is not widened here)",
  "cloud-home/owner-events.ts": "home_owner_events is created on sessions.db, the Cloud session database passed by index.ts, rather than messages.db",
  "connected-app-journal.ts": "connected_app_ops and connected_app_receipts live in their own journal file (defaultJournalFile), opened by SqliteReceiptStore",
  "highlevel/users-create-identity.ts": "user_create_claims lives in highlevel/user-create-claims.sqlite, opened by the HighLevel runtime",
  "search-index-worker.ts": "search_state and docs live in search.db, the separate search index rebuilt from the read-only messages.db source",
  "web-document-budget.ts": "reservations lives in the per-user temporary reservations.sqlite byte-budget database, outside the installation",
  "skill-search.ts": "the skills full-text index is built in a temp file and published as its own database, and in :memory: for the schema check",
  "phone-calls/store.ts": "phone_calls and phone_call_settings live in phone-calls.db (PhoneCallsDatabase), snapshotted by snapshotPhoneCalls",
  "health/stats-publisher.ts": "the stats snapshot is a one-shot file written by a worker for publication, never the installation database",
  "sentinel/store.ts": "the sentinel store is its own database under the sentinel output root",
  "memory/index.ts": "the memory search index (entries, lexical, vectors) is its own index database, rebuilt from messages.db",
  "memory/index-wal.ts": "index_meta of the memory search index database",
  "memory/postings.ts": "posting tables of the memory search index database",
  "memory/age-index.ts": "lexical_age tables of the memory search index database",
  "memory/revocation-index.bench.mjs": "benchmark script, not product code",
};

function tablesOf(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
}
/** Every table of the live schema that is in neither the snapshot registry, the memory schema, the inbox projection nor the exclusion list. */
function uncovered(db: DatabaseSync): string[] {
  const memory = validateMemorySchema(db), known = registeredSnapshotObjects();
  return tablesOf(db).filter(name => !memory.has(name) && !isInboxProjectionObject({ type: "table", name, tbl_name: name }) && !known.has(name) && !(name in EXCLUDED_TABLES));
}

/** The table names a source text creates. A `${CONST}` name is read from `const CONST = "..."` in the same text; one that cannot be resolved is
 *  returned as an unresolved site so the guard reports it instead of skipping it. Comments are removed first. */
export function declaredTables(text: string): { names: string[]; unresolved: string[] } {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const names: string[] = [], unresolved: string[] = [];
  for (const m of code.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:\$\{(\w+)\}|["`']?([A-Za-z_]\w*))/gi)) {
    if (m[2] !== undefined) { names.push(m[2]); continue; }
    const value = new RegExp(`const\\s+${m[1]}\\s*=\\s*["']([A-Za-z_]\\w*)["']`).exec(code)?.[1];
    if (value) names.push(value); else unresolved.push("${" + m[1] + "}");
  }
  return { names, unresolved };
}
/** What the guard reports for a set of source files: a table the fixture never produced, a name it cannot resolve, a stale listing. */
export function lazyTablesNotProduced(files: ReadonlyMap<string, string>, produced: ReadonlySet<string>, otherDatabases: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [file, text] of files) {
    const { names, unresolved } = declaredTables(text);
    if (file in otherDatabases) { if (names.length + unresolved.length === 0) problems.push(`${file}: listed as another database but creates no table`); continue; }
    for (const name of new Set(names)) if (!produced.has(name)) problems.push(`${file}: creates ${name}, which the fixture never produced`);
    for (const site of unresolved) problems.push(`${file}: creates a table named ${site}, which cannot be resolved`);
  }
  for (const file of Object.keys(otherDatabases)) if (!files.has(file)) problems.push(`${file}: listed as another database but not found under server/`);
  return problems;
}
function serverSources(): Map<string, string> {
  const root = import.meta.dirname, out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "testing" || entry === "testdata") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|mjs)$/.test(entry) || /\.test\.ts$/.test(entry) || /-reference\.ts$/.test(entry) || /-fixtures?\.\w+$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      if (/CREATE\s+(?:VIRTUAL\s+)?TABLE/i.test(text)) out.set(relative(root, path), text);
    }
  };
  walk(root);
  return out;
}

const JOB: RestoreJob = { version: 1, id: "job-1", archiveId: "arc1", source: "local", phase: "captured", at: 1_800_000_000_000 };

/** The lazy creation paths of messages.db, each through the function the product calls (listed in the comment beside it). */
function runFeatureCreationPaths(db: DatabaseSync, withEmail: boolean): void {
  initializePhones(db);                // phones/registry.ts: phone_registrations, phone_revocations, only when phones are offered
  initializeAskRevocations(db);        // phones/ask-revocations.ts, only while share and ask is offered
  initializePhoneReceipts(db);         // phones/receipts.ts, only while share and ask is offered
  listPromptBlocksForOwner(db);        // image-library.ts prepared(): the lazy initializeImageLibrary (image-operations-schema.ts) on first use
  initializeImageOperations(db);       // image-operations-schema.ts, image startup recovery
  ensureForgetTable(db);               // harness/event-log.ts, upgrade path: tables 1.0.2 added to an older file
  ensureUpgradeAppTables(db);          // memory/upgrade-app-tables.ts, upgrade path
  for (const { schema } of LEGACY_UPGRADE_TABLES.values()) db.exec(schema); // upgrade path: a file an early 1.0.2 preview wrote (card_branch, branch_walk, upgrade_root_set_proofs)
  ensureIntegrityPassTable(db);        // memory/integrity-state.ts, upgrade path
  ensureScrubPassTable(db);            // memory/scrub-state.ts, upgrade path
  if (withEmail) new EmailStore(db);   // email/email-store.ts: initializeEmailTables, email_bindings and the rest (email_parks is dropped below so restore makes it)
}

/** DATA_DIR/messages.db as a home holds it after an owner restore finished: the real open path made it, the feature paths added their tables, and
 *  the real restore effects staged and installed an archive over it and prepared it. With email, the archive lacks email_parks so prepare (restore.ts)
 *  creates it from email_bindings, the path the review named. */
async function homeThatFinishedARestore(withEmail = true): Promise<string> {
  const db = database();
  runFeatureCreationPaths(db, withEmail);
  closeDatabase();
  await stopWalMaintenance();
  expect(await stopSearchIndex()).toBe(true);
  const live = join(DATA_DIR, "messages.db");
  // A read-only search connection can close last and leave the newest schema in WAL.
  // Fold those frames into the main file before this fixture copies only messages.db.
  const checkpointer = new DatabaseSync(live);
  try { expect(checkpointer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0, log: 0, checkpointed: 0 }); }
  finally { checkpointer.close(); }
  const archives = mkdtempSync(join(tmpdir(), "snapshot-cover-archives-"));
  mkdirSync(join(archives, JOB.archiveId), { recursive: true });
  const archive = join(archives, JOB.archiveId, "messages.db");
  copyFileSync(live, archive);
  if (withEmail) { const a = new DatabaseSync(archive); try { a.exec("DROP TABLE email_parks"); } finally { a.close(); } }
  const fx = sqliteRestoreEffects({ liveDb: live, archivesDir: archives, now: () => 1_800_000_000_000 });
  fx.stage(JOB); fx.install(JOB); fx.prepare(JOB);
  const job2: RestoreJob = {...JOB,id:"job-2",phase:"swapped"};
  expect(job2.id).not.toBe(JOB.id);
  fx.stage(job2); fx.install(job2);
  expect(fx.marks().swapped).toBe(job2.id); expect(fx.marks().prepared).not.toBe(job2.id);
  writeFileSync(join(DATA_DIR,"restore-job.json"),JSON.stringify(job2));
  expect(JSON.parse(readFileSync(join(DATA_DIR,"restore-job.json"),"utf8"))).toMatchObject({id:job2.id,phase:"swapped"});
  let tries=0,m=0;
  const store=new RestoreJobStore({dir:DATA_DIR,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>++tries>1,release:()=>{}},mono:()=>m,sleepSync:ms=>{m+=ms;},log:()=>{}});
  expect(store.recover()).toEqual({action:"prepared"});await store.publishSettled();
  const check=new DatabaseSync(live);
  try {expect(check.prepare("SELECT job_id FROM restore_boot_wait").all()).toEqual([{job_id:job2.id}]);}finally{check.close();}
  return archives;
}

describe("installation snapshot schema coverage", () => {
  let archives = "";
  beforeEach(async () => { closeDatabase(); await stopWalMaintenance(); expect(await stopSearchIndex()).toBe(true); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); if (archives) removeTempDirSync(archives); archives = ""; });

  it("every table of a home that finished an owner restore is in the snapshot registry or the commented exclusion list", async () => {
    archives = await homeThatFinishedARestore();
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try {
      const tables = tablesOf(db);
      expect(tables).toContain("restore_job_marks");
      // the lazy feature tables are really there, so the enumeration below is not the bare fresh schema
      for (const name of ["phone_registrations", "phone_revocations", "phone_ask_revocations", "phone_receipts", "image_prompt_blocks", "image_render_prompts", "image_reference_packs", "image_model_probes", "image_operations", "card_branch", "branch_walk", "upgrade_root_set_proofs", "email_bindings", "email_sends", "email_parks"]) expect(tables, name).toContain(name);
      expect(uncovered(db)).toEqual([]);
      // the restore check the backup runs over the live source accepts it
      expect(() => inspectInstallationDatabase(db)).not.toThrow();
    } finally { db.close(); }
  });

  it("restore preparation creates email_parks from email_bindings when the archive lacks it", async () => {
    archives = await homeThatFinishedARestore();
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(tablesOf(db)).toContain("email_parks"); } finally { db.close(); }
  });

  it("a table the registry does not know is reported", async () => {
    archives = await homeThatFinishedARestore();
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      db.exec("CREATE TABLE zz_new_unlisted_table (id INTEGER PRIMARY KEY)");
      expect(uncovered(db)).toEqual(["zz_new_unlisted_table"]);
    } finally { db.close(); }
  });

  it("an unknown table is reported whatever its name starts with, email_ and the other registered prefixes included", async () => {
    archives = await homeThatFinishedARestore();
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      const strays = ["email_zz_unlisted", "phone_zz_unlisted", "image_zz_unlisted", "cloud_zz_unlisted", "restore_zz_unlisted", "inbox_zz_unlisted", "push_zz_unlisted"];
      for (const name of strays) db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`);
      expect(uncovered(db)).toEqual([...strays].sort());
    } finally { db.close(); }
  });

  it("every exclusion names a table that exists nowhere in the registry, and every reason is written", () => {
    const known = registeredSnapshotObjects();
    for (const [name, reason] of [...Object.entries(EXCLUDED_TABLES), ...Object.entries(ACCEPTED_BUT_NOT_BACKED_UP), ...Object.entries(OUTSIDE_THE_FIXTURE)]) {
      expect(reason.length, name).toBeGreaterThan(20);
    }
    for (const name of Object.keys(EXCLUDED_TABLES)) expect(known.has(name), `${name} is excluded and registered`).toBe(false);
    for (const name of Object.keys(ACCEPTED_BUT_NOT_BACKED_UP)) expect(known.has(name), `${name} must be registered`).toBe(true);
  });

  it("every CREATE TABLE under server/ makes a table the fixture produced, or sits in a file listed as another database", async () => {
    archives = await homeThatFinishedARestore();
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    // RC keeps legacy FTS in the archive reference schema, while serving search writes its own search.db.
    // Build that supported archive schema too, including SQLite's shadow tables, and check its registry coverage.
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(MESSAGE_SEARCH_DDL);
      const legacyTables = tablesOf(legacy), known = registeredSnapshotObjects();
      expect(legacyTables).toContain("messages_fts");
      for (const name of legacyTables) expect(known.has(name), `${name} must be registered`).toBe(true);
      expect(lazyTablesNotProduced(serverSources(), new Set([...tablesOf(db), ...legacyTables]), OUTSIDE_THE_FIXTURE)).toEqual([]);
    } finally { legacy.close(); db.close(); }
  });

  it("the source guard reports a new lazy table the fixture never produced, an unresolvable name and a stale listing", () => {
    const produced = new Set(["messages"]);
    const files = new Map([
      ["zz-lazy.ts", "export const init = (db) => db.exec(`CREATE TABLE IF NOT EXISTS zz_lazy_table (id INTEGER)`);"],
      ["zz-dynamic.ts", "export const init = (db, t) => db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER)`);"],
      ["zz-const.ts", 'const T = "zz_const_table"; export const init = (db) => db.exec(`CREATE TABLE IF NOT EXISTS ${T} (id INTEGER)`);'],
      ["zz-commented.ts", "// CREATE TABLE statement in prose\nexport const x = 1;\n/* CREATE TABLE zz_in_a_block_comment */\nexport const y = db.exec('CREATE TABLE messages (id INTEGER)');"],
      ["zz-other.ts", "export const y = 1;"],
    ]);
    expect(lazyTablesNotProduced(files, produced, { "zz-other.ts": "reason written here for a stale entry", "zz-gone.ts": "reason written here for a missing file" })).toEqual([
      "zz-lazy.ts: creates zz_lazy_table, which the fixture never produced",
      "zz-dynamic.ts: creates a table named ${t}, which cannot be resolved",
      "zz-const.ts: creates zz_const_table, which the fixture never produced",
      "zz-other.ts: listed as another database but creates no table",
      "zz-gone.ts: listed as another database but not found under server/",
    ]);
  });

  it.each([{ withEmail: true }, { withEmail: false }])("a home that finished an owner restore backs up, and the copy carries no restore marks (email tables: $withEmail)", async ({ withEmail }) => {
    archives = await homeThatFinishedARestore(withEmail);
    const destination = join(mkdtempSync(join(tmpdir(), "snapshot-cover-copy-")), "messages.db");
    try {
      await snapshotInstallationDatabase(DATA_DIR, destination);
      const copy = new DatabaseSync(destination, { readOnly: true });
      try {
        expect(tablesOf(copy).includes("email_payloads"), "the fixture has the email tables only when asked").toBe(withEmail);
        for (const name of Object.keys(ACCEPTED_BUT_NOT_BACKED_UP)) expect(tablesOf(copy), name).not.toContain(name);
        expect(() => inspectInstallationDatabase(copy)).not.toThrow();
      } finally { copy.close(); }
      // the live file keeps its marks: only the staged copy drops them
      const live = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
      try { expect((live.prepare("SELECT kind FROM restore_job_marks").all() as unknown[]).length).toBeGreaterThan(0); } finally { live.close(); }
    } finally { removeTempDirSync(join(destination, "..")); }
  });
});
