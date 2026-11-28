import type { DatabaseSync as Database, SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { neutralizeRestoredSends } from "./send-store.ts";
import { initializeSendAttempts, SendAttemptStore } from "./send-attempt-state.ts";

const fields = ["resumeCursors", "resumePolicies", "replayPending", "effortTouch", "resumeSeals", "resumeIncarnations"];
/** R3: installation-wide and durable-only, independent of startup recovery. */
export function clearRetainedContextForAmbiguousAttempts(root: string, db: Database): { ambiguous: number; cleared: number } {
  if (!exists(db, "send_attempts")) return { ambiguous: 0, cleared: 0 };
  const ambiguous = Number(db.prepare(`SELECT count(*) AS n FROM send_attempts a WHERE delivery='uncertain' OR phase<>'terminal'
    OR terminal_outcome='abandoned_uncertain' OR (delivery<>'not_submitted' AND EXISTS (SELECT 1 FROM send_replay_exclusions x WHERE x.attempt_id=a.attempt_id))`).get()!.n);
  if (!ambiguous) return { ambiguous, cleared: 0 };
  let cleared = 0;
  const writes: Array<{ path: string; text: string }> = [];
  for (const name of ["bots.json", "groups.json"]) {
    const path = join(root, name);
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const records: unknown = JSON.parse(text);
    if (!Array.isArray(records)) throw new Error(`${name} must be an array`);
    let changed = false;
    const clear = (holder: unknown) => {
      if (!holder || typeof holder !== "object" || Array.isArray(holder)) return;
      const record = holder as Record<string, unknown>;
      let held = false;
      for (const field of fields) if (Object.hasOwn(record, field)) { delete record[field]; changed = held = true; }
      if (held) cleared++;
    };
    for (const record of records) {
      clear(record);
      if (record && typeof record === "object" && Array.isArray(record.tasks)) for (const task of record.tasks) clear(task);
    }
    if (changed) writes.push({ path, text: JSON.stringify(records) });
  }
  // Parse every file first. Atomic replacement failure propagates; the schema
  // stamp/archive publication remains I's final step after this succeeds.
  for (const write of writes) writeFileAtomic(write.path, write.text, { mode: 0o600, syncDir: true });
  return { ambiguous, cleared };
}
function exists(db: Database, name: string): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
const tables = ["send_attempts", "send_attempt_bindings", "send_actions", "send_replay_exclusions", "send_replay_epochs", "turn_cleanup_owed", "send_retirement_keys", "retired_send_ids"] as const;
export const SEND_ATTEMPT_COMPAT_MEMBER = "send-attempt-compat.v1";
type TableRows = Record<string, Record<string, SQLInputValue>[]>;
function checksum(body: string): string { return createHash("sha256").update(body).digest("hex"); }

/** PROVISIONAL INTERFACE: I passes a staged archive directory and its database,
 * after confirmed provider closure. No source installation is modified here.
 * The same projection is usable in-place before I lowers the schema stamp. */
export function exportSendAttemptCompat(root: string, db: Database): void {
  if (!exists(db, "send_attempts")) return;
  if (db.prepare("SELECT 1 FROM send_attempt_bindings WHERE active=1").get()) throw new Error("active send binding requires confirmed closure before export");
  clearRetainedContextForAmbiguousAttempts(root, db);
  const store = new SendAttemptStore(db);
  store.transaction(() => {
    const rows: TableRows = {};
    for (const table of tables) rows[table] = db.prepare(`SELECT * FROM ${table}`).all() as TableRows[string];
    const body = JSON.stringify({ version: 1, tables: rows });
    // Publish the recovery metadata before the reversible projection. A failed
    // projection leaves usable metadata and I must not expose the old runtime.
    writeFileAtomic(join(root, SEND_ATTEMPT_COMPAT_MEMBER), JSON.stringify({ version: 1, checksum: checksum(body), body }), { mode: 0o600, syncDir: true });
    const affectedThreads = new Set<string>();
    if (exists(db, "messages")) {
      const rows = db.prepare("SELECT m.thread_id,m.id,m.json FROM messages m JOIN send_replay_exclusions x ON x.thread_id=m.thread_id AND x.message_id=m.id").all();
      for (const row of rows) {
        const message = JSON.parse(String(row.json));
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("excluded message cannot be projected");
        if (message.sendAttemptCompat) continue;
        if (message.kind !== "text") continue;
        message.sendAttemptCompat = { version: 1, role: message.role, kind: message.kind };
        message.role = "bot"; message.kind = "activity";
        db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify(message), row.thread_id, row.id);
        affectedThreads.add(String(row.thread_id));
      }
    }
    bumpCompatReplayEpochs(db, affectedThreads);
    if (exists(db, "owner_sends")) {
      // The same restore generation used by existing chips is the retry fence.
      db.prepare("UPDATE owner_sends SET status='refused',dispatched=0 WHERE status IN ('dispatched','unconfirmed')").run();
      neutralizeRestoredSends(db);
    }
  });
}

/** Preserve destination retirement keys/fences before swapping restored DBs.
 * Imported keys are verification-only; an existing destination active key wins. */
export function mergeSendRetirementFences(destination: Database, source: Database): void {
  if (!exists(source, "send_retirement_keys")) return;
  initializeSendAttempts(destination);
  const store = new SendAttemptStore(destination);
  store.transaction(() => {
    for (const row of source.prepare("SELECT * FROM send_retirement_keys").all()) {
      const prior = destination.prepare("SELECT * FROM send_retirement_keys WHERE key_id=?").get(row.key_id);
      if (prior && (prior.key_bytes !== row.key_bytes || prior.installation_scope !== row.installation_scope || prior.digest_version !== row.digest_version)) throw new Error("retirement key collision");
      destination.prepare("INSERT OR IGNORE INTO send_retirement_keys VALUES (?,?,?,?,0)").run(row.key_id, row.digest_version, row.installation_scope, row.key_bytes);
    }
    for (const row of source.prepare("SELECT * FROM retired_send_ids").all()) destination.prepare("INSERT OR IGNORE INTO retired_send_ids VALUES (?,?,?,?,?)").run(row.key_id, row.digest_version, row.digest, row.kind, row.retired_at);
  });
}

/** Import validated metadata before restoring original roles. Existing
 * destination retirement fences survive and suppress deleted source identities. */
export function importSendAttemptCompat(root: string, db: Database): boolean {
  const file = join(root, SEND_ATTEMPT_COMPAT_MEMBER);
  if (!existsSync(file)) return false;
  const envelope = JSON.parse(readFileSync(file, "utf8"));
  if (envelope.version !== 1 || typeof envelope.body !== "string" || envelope.checksum !== checksum(envelope.body)) throw new Error("invalid send attempt compatibility checksum");
  const body = JSON.parse(envelope.body);
  if (body.version !== 1 || !body.tables || Object.keys(body.tables).some(name => !tables.includes(name as typeof tables[number]))) throw new Error("unsupported send attempt compatibility archive");
  initializeSendAttempts(db);
  const store = new SendAttemptStore(db);
  store.transaction(() => {
    const affectedThreads = new Set<string>();
    // Keys/fences precede receipts. SQL identifiers come exclusively from the
    // initialized local schema, never from archive member names.
    const ordered = ["send_retirement_keys", "retired_send_ids", ...tables.filter(name => name !== "send_retirement_keys" && name !== "retired_send_ids")];
    for (const table of ordered) {
      if (!Array.isArray(body.tables[table])) throw new Error("incomplete send attempt compatibility archive");
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
      for (const source of body.tables[table]) {
        if (!source || typeof source !== "object" || Object.keys(source).some(name => !columns.includes(name)) || columns.some(name => !Object.hasOwn(source, name))) throw new Error("invalid compatibility row");
        const row = { ...source };
        if (table === "send_retirement_keys") row.active = 0;
        if (table === "send_attempts" && store.isRetired({ ownerId: row.owner_id, botId: row.bot_id, threadId: row.thread_id }, "send", row.send_id)) continue;
        if (["send_attempt_bindings", "send_replay_exclusions", "turn_cleanup_owed"].includes(table) && row.attempt_id && !store.byId(row.attempt_id)) continue;
        if (table === "send_actions" && !store.byId(row.target_attempt_id)) continue;
        const inserted = db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(name => row[name] as SQLInputValue));
        if (table === "send_replay_exclusions" && Number(inserted.changes)) affectedThreads.add(String(row.thread_id));
      }
    }
    // Reversal is safe only after receipts and exclusions are present. I runs
    // M2 reconciliation before advertising a ready reader on this installation.
    if (exists(db, "messages")) for (const row of db.prepare("SELECT thread_id,id,json FROM messages").all()) {
      let message: Record<string, any>;
      try { message = JSON.parse(String(row.json)); } catch { continue; }
      const marker = message?.sendAttemptCompat;
      if (!marker) continue;
      if (marker.version !== 1 || marker.kind !== "text" || !["user", "bot"].includes(marker.role)) throw new Error("unsupported compatibility projection");
      if (!db.prepare("SELECT 1 FROM send_replay_exclusions WHERE thread_id=? AND message_id=?").get(row.thread_id, row.id)) continue;
      message.role = marker.role; message.kind = marker.kind; delete message.sendAttemptCompat;
      db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify(message), row.thread_id, row.id);
      affectedThreads.add(String(row.thread_id));
    }
    bumpCompatReplayEpochs(db, affectedThreads);
  });
  return true;
}

/** I invokes this only after compatibility export and provider closure, inside
 * its existing owned downgrade transaction and before lowering schema stamps. */
export function dropSendAttemptSchema(db: Database): void {
  for (const table of [...tables].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
  if (exists(db, "owner_sends") && db.prepare("PRAGMA table_info(owner_sends)").all().some(row => row.name === "isolated")) db.exec("ALTER TABLE owner_sends DROP COLUMN isolated");
}

/** Both projection passes may run with a connection-owned proof alive. */
function bumpCompatReplayEpochs(db: Database, threads: ReadonlySet<string>): void {
  for (const thread of threads) db.prepare("INSERT INTO send_replay_epochs(thread_id,revision) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(thread);
}
