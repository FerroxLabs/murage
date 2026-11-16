import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { closeDatabase, database } from "./database.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { inspectInstallationDatabase, registeredSnapshotObjects, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch: string[] = [];
const tables = ["send_attempts", "send_attempt_bindings", "send_actions", "send_replay_exclusions", "send_replay_epochs", "turn_cleanup_owed", "send_retirement_keys", "retired_send_ids", "turn_index_dirty", "turn_index_state"];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); for (const root of scratch.splice(0)) removeTempDirSync(root); });
function fixture() {
  const db = database();
  // RED reaches a schema assertion on the base, never an absent module import.
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name)).toEqual(expect.arrayContaining(tables));
  return db;
}
function attempt(db: DatabaseSync, id: string, send = id, thread = "thread", message: string | null = null) {
  db.prepare(`INSERT INTO send_attempts(attempt_id,owner_id,bot_id,thread_id,send_id,fingerprint,isolated,queue_only,phase,delivery,replay_policy,revision,binding_epoch,message_id,cleanup_owed,created_at,updated_at)
    VALUES (?,'owner','bot',?,?,'fingerprint',0,0,'queued','not_submitted','exclude',0,0,?,0,1,1)`).run(id, thread, send, message);
}

it("I0/F7-RECEIPT schema: scoped send and linked-line identities cannot be duplicated", () => {
  const db = fixture();
  attempt(db, "a", "send", "thread", "line");
  expect(() => attempt(db, "b", "send")).toThrow(/UNIQUE/);
  expect(() => attempt(db, "c", "other", "thread", "line")).toThrow(/UNIQUE/);
  attempt(db, "d", "send", "another-thread", "line");
  attempt(db, "e"); attempt(db, "f"); // nullable unlinked lines do not conflict
  expect(() => db.exec("UPDATE send_attempts SET send_id=NULL WHERE attempt_id='e'")).toThrow(/NOT NULL/);
});

it("I0/F7-RECEIPT schema: invalid states, isolation and terminality are refused", () => {
  const db = fixture(); attempt(db, "a");
  for (const update of ["phase='idle'", "delivery='delivered'", "replay_policy='maybe'", "isolated=1", "phase='terminal'", "terminal_outcome='failed'", "isolated=2", "queue_only=2"]) {
    expect(() => db.exec(`UPDATE send_attempts SET ${update} WHERE attempt_id='a'`), update).toThrow(/CHECK/);
  }
  db.exec("UPDATE send_attempts SET isolated=1,queue_only=1,phase='terminal',terminal_outcome='abandoned_uncertain',delivery='uncertain' WHERE attempt_id='a'");
  expect(db.prepare("SELECT delivery FROM send_attempts WHERE attempt_id='a'").get()?.delivery).toBe("uncertain");
});

it("I0/F7-RECEIPT schema: one active binding per attempt permits shared ordinary provider correlation", () => {
  const db = fixture(); attempt(db, "a"); attempt(db, "b");
  const bind = db.prepare(`INSERT INTO send_attempt_bindings(attempt_id,binding_epoch,generation,provider_instance_id,provider_turn_id,thread_id,released_writes,invocation_released,sealed,active)
    VALUES (?,? ,?,'provider','turn','thread',0,0,0,1)`);
  bind.run("a", 1, 10); bind.run("b", 1, 10);
  expect(() => bind.run("a", 2, 11)).toThrow(/UNIQUE/);
  db.exec("UPDATE send_attempt_bindings SET active=0,sealed=1 WHERE attempt_id='a'");
  expect(() => bind.run("a", 2, 10)).toThrow(/UNIQUE/);
  bind.run("a", 2, 11);
});

it("I0/F7-RECEIPT schema: action identities and replacement identities remain unique", () => {
  const db = fixture(); attempt(db, "a");
  const action = db.prepare(`INSERT INTO send_actions(owner_id,action_id,bot_id,thread_id,kind,target_attempt_id,target_revision,target_binding_epoch,fingerprint,replacement_attempt_id,replacement_send_id,status,created_at)
    VALUES (? ,?,'bot','thread','resend','a',1,1,'fingerprint',?,?,'pending',1)`);
  action.run("owner", "action", "replacement", "send");
  expect(() => action.run("owner", "action", "other-attempt", "other-send")).toThrow(/UNIQUE/);
  expect(() => action.run("other", "action", "replacement", "new-send")).toThrow(/UNIQUE/);
  expect(() => action.run("other", "action", "new-attempt", "send")).toThrow(/UNIQUE/);
  expect(() => action.run("owner", "missing-replacement", null, null)).toThrow(/CHECK/);
  expect(() => action.run("owner", "missing-send", "next-attempt", null)).toThrow(/CHECK/);
  expect(() => action.run("owner", "missing-attempt", null, "next-send")).toThrow(/CHECK/);
  db.exec(`INSERT INTO send_actions(owner_id,action_id,bot_id,thread_id,kind,target_attempt_id,target_revision,target_binding_epoch,fingerprint,status,created_at)
    VALUES ('other','action','bot','thread','remove','a',1,1,'fingerprint','pending',1)`);
  expect(() => db.exec("UPDATE send_actions SET kind='retry'")).toThrow(/CHECK/);
  expect(() => db.exec("UPDATE send_actions SET status='lost'")).toThrow(/CHECK/);
});

it("I0/F7-ML6 schema: exclusions use primary-key point lookups and only one retirement key is active", () => {
  const db = fixture();
  db.exec("INSERT INTO send_replay_exclusions VALUES ('thread','line',NULL,'legacy',1)");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM send_replay_exclusions WHERE thread_id=? AND message_id=?").all("thread", "line");
  expect(plan.map(row => row.detail).join("\n")).toMatch(/SEARCH send_replay_exclusions USING PRIMARY KEY/);
  db.exec("INSERT INTO send_retirement_keys VALUES ('key',1,'installation','key-material',1)");
  expect(() => db.exec("INSERT INTO send_retirement_keys VALUES ('key2',1,'installation','key-material-2',1)")).toThrow(/UNIQUE/);
  db.exec("INSERT INTO send_retirement_keys VALUES ('key2',1,'installation','key-material-2',0)");
});

it("I0/T-SCHEMA registration: nullable turn column and exact M2 tables preserve legacy rows and never claim readiness", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY(thread_id,id));
      INSERT INTO messages VALUES ('thread','line',1,'user','text','hello','{"turnId":"old"}');`);
    initializeMessageTables(db, { defer: true });
    const columns = db.prepare("PRAGMA table_info(messages)").all();
    expect(columns.map(row => row.name)).toContain("turn_id");
    expect(columns.find(row => row.name === "turn_id")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(db.prepare("SELECT json,seq,turn_id FROM messages").get()).toEqual({ json: '{"turnId":"old"}', seq: null, turn_id: null });
    expect(db.prepare("PRAGMA table_info(turn_index_dirty)").all().map(row => row.name)).toEqual(["thread_id", "message_id", "ticket"]);
    expect(db.prepare("PRAGMA table_info(turn_index_state)").all().map(row => row.name)).toEqual(["id", "protocol", "build_id", "schema_digest", "phase", "cursor_thread", "cursor_message", "epoch", "backfill_done", "verified"]);
    expect(db.prepare("SELECT * FROM turn_index_state").all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_turn_v2'").get()).toBeUndefined(); // worker builds over history
    initializeMessageTables(db, { defer: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(1);
  } finally { db.close(); }
});

it("I0/T-BACKUP registration: snapshots retain receipts, retirement fences and incomplete M2 progress", async () => {
  const db = fixture(); attempt(db, "a");
  db.exec(`INSERT INTO turn_index_state VALUES (1,1,'build','digest','backfilling','thread','line',7,0,0);
    INSERT INTO turn_index_dirty VALUES ('thread','line',7);
    INSERT INTO send_retirement_keys VALUES ('key',1,'installation','key-material',1);
    INSERT INTO retired_send_ids VALUES ('key',1,'digest','send',1);`);
  for (const table of tables) expect(registeredSnapshotObjects().has(table), table).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "l8-i0-backup-"));
  scratch.push(root);
  const target = join(root, "snapshot.db");
  const expected = new Map(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  expect(await stopSearchIndex()).toBe(true);
  expect(await stopWalMaintenance()).toBe(true);
  closeDatabase();
  expect(await snapshotInstallationDatabase(DATA_DIR, target)).toMatchObject({ status: "copied" });
  const copy = new DatabaseSync(target);
  try {
    for (const table of tables) expect(copy.prepare(`SELECT * FROM ${table}`).all()).toEqual(expected.get(table));
    expect(() => inspectInstallationDatabase(copy)).not.toThrow();
  } finally { copy.close(); }
});

it("I0/T-BACKUP registration: the inspector refuses changed receipt definitions", () => {
  const db = fixture();
  db.exec("DROP INDEX send_attempts_message; CREATE INDEX send_attempts_message ON send_attempts(message_id)");
  expect(() => inspectInstallationDatabase(db)).toThrow();
});

// GUARDs of I0's staged contract, not RED claims about final A1/A2 behavior.
it("F1 implementation preserves missing-attempt guards; unimplemented F5 never executes a read", async () => {
  const { initializeSendAttempts, useSendAttemptDatabase, readAttempt, recordInvocation, releaseWrite, settleAttempt } = await import("./send-attempt-state.ts");
  const { withTurnReadSnapshot } = await import("./turn-index-state.ts");
  const key = { ownerId: "owner", botId: "bot", threadId: "thread", sendId: "send", attemptId: "attempt", bindingEpoch: 1, generation: "generation", providerInstanceId: "provider" };
  const db = new DatabaseSync(":memory:");
  initializeSendAttempts(db); useSendAttemptDatabase(() => db);
  expect(readAttempt(key, key.sendId)).toEqual({kind:"missing"});
  expect(() => recordInvocation(key, 1, true)).toThrow("stale_action");
  expect(() => releaseWrite(key, 1, 1)).toThrow("stale_action");
  expect(() => settleAttempt(key, 1, "failed", { binding: key, delivery: "not_submitted" })).toThrow("missing_attempt");
  let read = false;
  try { expect(() => withTurnReadSnapshot(db, () => { read = true; return []; })).toThrow("not implemented"); }
  finally { useSendAttemptDatabase(() => database()); db.close(); }
  expect(read).toBe(false);
});

it("I0 registration is idempotent inside an outer transaction and preserves pending work on reopen", () => {
  const db = fixture(); attempt(db, "a");
  db.exec("INSERT INTO turn_index_dirty VALUES ('thread','line',7)");
  db.exec("SAVEPOINT caller");
  initializeMessageTables(db, { defer: true });
  expect(db.isTransaction).toBe(true);
  db.exec("RELEASE caller");
  closeDatabase();
  const reopened = fixture();
  expect(reopened.prepare("SELECT attempt_id FROM send_attempts").all()).toEqual([{ attempt_id: "a" }]);
  expect(reopened.prepare("SELECT * FROM turn_index_dirty").all()).toEqual([{ thread_id: "thread", message_id: "line", ticket: 7 }]);
  expect(reopened.prepare("SELECT * FROM turn_index_state").all()).toEqual([]);
  expect(reopened.prepare("PRAGMA index_info(messages_turn_v2)").all().map(row => row.name)).toEqual(["thread_id", "turn_id"]);
});
