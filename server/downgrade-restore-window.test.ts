// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The step back to the earlier version refuses, and changes nothing, while an owner restore has not finished (restore-job.json armed, captured or swapped,
// or unreadable). Why: restore job X installs its marked database and stops before preparation; the earlier build then runs and writes the email cursors;
// the re-upgrade finishes X's preparation over those writes. So the downgrade must not let that window open. The check reads only the journal
// (restoreWindowOpen), runs under the offline lease, and comes before the first write, including the speech PREP write. Stale marks with no journal never block.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { RestoreJobStore } from "./email/restore-job.ts";
import { sqliteRestoreEffects } from "./email/restore-job-effects.ts";
import { RESTORE_JOB_MARKS_DDL } from "./email/restore-job-marks-ddl.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { stopSearchIndex } from "./message-search-index.ts";

const CODE = "DOWNGRADE_RESTORE_OPEN";
const LINE = "A restore has not finished. Open this version of Murage to finish recovery, then try going back to the earlier version.";
const journal = () => join(DATA_DIR, "restore-job.json");
const job = (phase: string) => JSON.stringify({ version: 1, id: "job-X", archiveId: "arc1", source: "local", phase, at: 1_800_000_000_000 }) + "\n";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(join(DATA_DIR, "config.json"), '{"profile":{"name":"Fixture"}}'); });
afterEach(() => { closeDatabase(); });

/** Every file under `dir` with its bytes (a folder by its name), so "changes nothing" is checked byte for byte. */
function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isDirectory()) { out[`${prefix}${name}/`] = "dir"; Object.assign(out, tree(path, `${prefix}${name}/`)); }
    else out[`${prefix}${name}`] = readFileSync(path).toString("hex");
  }
  return out;
}
/** Join the serving workers and fold the offline file before proving both sidecars stayed absent. */
async function quiesce() {
  expect(await stopSearchIndex()).toBe(true);
  expect(await stopWalMaintenance()).toBe(true);
  // The RC search worker owns a read-only connection; a last reader can leave sidecars after closing.
  const checkpoint = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    const folded = checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    expect(folded?.busy).toBe(0);
    expect(folded?.log).toBe(folded?.checkpointed);
  } finally { checkpoint.close(); }
  const names = ["messages.db-wal", "messages.db-shm"].map(name => join(DATA_DIR, name));
  let quiet = 0;
  for (let waited = 0; quiet < 8 && waited < 10_000; waited += 40) {
    quiet = names.some(path => existsSync(path)) ? 0 : quiet + 1;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  expect(quiet, "messages.db-wal and -shm stayed absent").toBeGreaterThanOrEqual(8);
}
/** A data folder as the current build leaves it. With `inFlightSpeech` an attempt a crash left streaming, which the speech PREP write would mark interrupted. */
async function home(opts: { inFlightSpeech?: boolean } = {}) {
  const db = database();
  if (opts.inFlightSpeech) {
    db.exec(`
      INSERT INTO speech_threads (thread_id, revision) VALUES ('thread', 3);
      INSERT INTO speech_prompts (thread_id, prompt_id) VALUES ('thread', 'send:s1');
      INSERT INTO speech_generations (generation_id, thread_id, bot_id, prompt_id, revision, boot_id, provider_turn_id, state) VALUES ('g1', 'thread', 'bot', 'send:s1', 3, 'boot-a', 'turn-1', 'completed');
      INSERT INTO speech_sessions (session_id, principal, connection_id, thread_id, boot_id, state, last_sequence, active_attempt) VALUES ('ss1', 'desktop', 'c1', 'thread', 'boot-a', 'closed', 1, NULL);
      INSERT INTO speech_accounts (binding_id, credential_version, account_scope_id, plan_version, hold_until) VALUES ('binding', 'v1', 'scope', 'plan', 0);
      INSERT INTO speech_plans (account_scope_id, fingerprint, plan_version) VALUES ('scope', 'fp', 'plan');
      INSERT INTO speech_attempts (attempt_id, session_id, command_sequence, thread_id, message_id, generation_id, mode, revision, boot_id, reserved_at, account_scope_id, plan_version, state, outcome)
        VALUES ('a1', 'ss1', 1, 'thread', 'message', 'g1', 'automatic', 3, 'boot-a', ${Date.now() - 3_600_000}, 'scope', 'plan', 'streaming', NULL);
    `);
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  await quiesce();
}
const speechState = () => { const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true }); try { return (db.prepare("SELECT state FROM speech_attempts").get() as { state: string } | undefined)?.state; } finally { db.close(); } };
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return error as Error & { code?: string }; } return undefined; };
const finishRecovery = () => new RestoreJobStore({ dir: DATA_DIR, now: () => 1_800_000_000_000, isLocalArchive: () => false, captureCarry: () => ({}), effects: sqliteRestoreEffects({ liveDb: join(DATA_DIR, "messages.db"), archivesDir: join(DATA_DIR, "restore-archives") }) });
const marksTable = (rows: Array<[string, string]>) => {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { db.exec(RESTORE_JOB_MARKS_DDL); for (const [kind, id] of rows) db.prepare("INSERT INTO restore_job_marks (kind, job_id) VALUES (?, ?)").run(kind, id); } finally { db.close(); }
};
const marks = () => { const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true }); try { return db.prepare("SELECT kind, job_id AS j FROM restore_job_marks ORDER BY kind").all(); } finally { db.close(); } };

const OPEN_JOURNALS: Array<[string, () => void]> = [
  ["armed", () => writeFileSync(journal(), job("armed"))],
  ["captured", () => writeFileSync(journal(), job("captured"))],
  ["swapped", () => writeFileSync(journal(), job("swapped"))],
  ["unreadable (not JSON)", () => writeFileSync(journal(), "{ torn")],
  ["unreadable (a phase nobody knows)", () => writeFileSync(journal(), job("half-done"))],
  ["unreadable (a link, not a file)", () => { writeFileSync(join(DATA_DIR, "elsewhere.json"), job("prepared")); symlinkSync(join(DATA_DIR, "elsewhere.json"), journal()); }],
];

describe("the step back refuses while a restore has not finished", () => {
  it.each(OPEN_JOURNALS)("(a) journal %s: memory-downgrade --to 13 is refused before the speech PREP write, and the folder is byte for byte as it was", async (_name, put) => {
    await home({ inFlightSpeech: true });
    put();
    const before = tree(DATA_DIR);
    const error = refusal(() => downgradeInstallationMemorySchema(DATA_DIR, 13));
    expect(error?.code).toBe(CODE);
    expect(error?.message).toBe(LINE);
    expect(tree(DATA_DIR)).toEqual(before);        // the PREP write did not run: no byte, no file, no private copy beside it
    expect(speechState()).toBe("streaming");       // read last: a read-only open of a WAL file leaves -wal and -shm behind
  });

  it.each(OPEN_JOURNALS)("(a) journal %s: downgradeApplicationSchemaTo101 is refused at entry and the database bytes and listing are unchanged", async (_name, put) => {
    await home();
    put();
    const before = tree(DATA_DIR);
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    let error: (Error & { code?: string }) | undefined;
    try { error = refusal(() => downgradeApplicationSchemaTo101(db, DATA_DIR)); } finally { db.close(); }
    await quiesce();
    expect(error?.code).toBe(CODE);
    expect(error?.message).toBe(LINE);
    expect(tree(DATA_DIR)).toEqual(before);
  });

  it("the owner message is plain: no code word, no path, no dash", () => {
    expect(LINE).not.toMatch(/[A-Z]{2,}_[A-Z_]+|restore-job|\.json|\u2014|\u2013/);
  });

  it("(b) stale marks with NO journal do not block: the downgrade goes ahead and the marks stay", async () => {
    await home();
    marksTable([["swapped", "job-X"], ["prepared", "job-X"]]);
    expect(existsSync(journal())).toBe(false);
    await quiesce();
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, 13)).not.toThrow();
    expect(marks()).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]);
  });

  it("(b) a finished job (journal prepared) or an aborted one does not block", async () => {
    await home();
    writeFileSync(journal(), job("prepared"));
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, 13)).not.toThrow();
    rmSync(journal());
    writeFileSync(journal(), job("aborted"));
    expect(() => downgradeApplicationSchemaTo101(new DatabaseSync(join(DATA_DIR, "messages.db")), DATA_DIR)).not.toThrow();
  });

  it("(c) captured journal: after the refusal, opening the current version (boot recovery) aborts the job and the downgrade then succeeds", async () => {
    await home();
    writeFileSync(journal(), job("captured"));
    expect(refusal(() => downgradeInstallationMemorySchema(DATA_DIR, 13))?.code).toBe(CODE);
    expect(finishRecovery().recover()).toEqual({ action: "aborted" });
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, 13)).not.toThrow();
  });

  it("(c) swapped by its mark: after the refusal, boot recovery prepares the job, and the downgrade then succeeds with the marks kept", async () => {
    await home();
    marksTable([["swapped", "job-X"]]);
    writeFileSync(journal(), job("captured"));
    await quiesce();
    expect(refusal(() => downgradeInstallationMemorySchema(DATA_DIR, 13))?.code).toBe(CODE);
    expect(marks()).toEqual([{ kind: "swapped", j: "job-X" }]);
    expect(finishRecovery().recover()).toEqual({ action: "prepared" });
    expect(existsSync(journal())).toBe(false);
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, 13)).not.toThrow();
    expect(marks()).toEqual([{ kind: "prepared", j: "job-X" }, { kind: "swapped", j: "job-X" }]);
  });
});
