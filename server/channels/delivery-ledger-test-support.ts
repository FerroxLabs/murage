// Test-side helpers for delivery-ledger.db: read and fault the store through a SECOND connection,
// the way an outside observer (or a failing disk) would. Imported by tests only.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSchema, planV1, readLedger, type State } from "./delivery-ledger-v1.ts";
import { LEDGER_DB } from "./delivery-ledger-store.ts";

const dbOf = (file: string) => join(dirname(file), LEDGER_DB);
const loose = buildSchema(20_000, false);
/** A fresh read-only-in-practice connection; the caller closes it. */
function connect(file: string): DatabaseSync {
  const db = new DatabaseSync(dbOf(file));
  db.exec("PRAGMA busy_timeout=1000");
  return db;
}
export interface Row { legacy: string | null; legacy_sha256: string | null; migrated_by: string | null; migrated_boot: string | null; retire_attempts: number; retire_after: number | null }
export function rowOf(file: string): Row | undefined {
  if (!existsSync(dbOf(file))) return undefined;
  const db = connect(file);
  try { return db.prepare("SELECT legacy,legacy_sha256,migrated_by,migrated_boot,retire_attempts,retire_after FROM delivery_ledger WHERE ledger_key=?").get(basename(file)) as unknown as Row | undefined; }
  catch { return undefined; } finally { db.close(); }
}
/** The store's meta value (for example `name_proof`). */
export function metaOf(file: string, key: string): string | undefined {
  if (!existsSync(dbOf(file))) return undefined;
  const db = connect(file);
  try { return (db.prepare("SELECT value FROM store_meta WHERE key=?").get(key) as { value?: string } | undefined)?.value; }
  catch { return undefined; } finally { db.close(); }
}
/** Every committed entry body of the ledger as (kind, seq, JSON text), in insertion order. */
export function entriesOf(file: string): Array<{ kind: string; seq: number; body: string }> {
  if (!existsSync(dbOf(file))) return [];
  const db = connect(file);
  try { return db.prepare("SELECT kind,seq,body FROM delivery_entry WHERE ledger_key=? ORDER BY kind DESC, seq").all(basename(file)) as unknown as Array<{ kind: string; seq: number; body: string }>; }
  catch { return []; } finally { db.close(); }
}
/** The ledger's committed state; falls back to the v1 files when no row exists yet. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stored(file: string): any {
  if (!existsSync(dbOf(file))) return readLedger(file, loose).state;
  const db = connect(file);
  try {
    const row = db.prepare("SELECT binding_key,recipient FROM delivery_ledger WHERE ledger_key=?").get(basename(file)) as { binding_key: string; recipient: string } | undefined;
    if (!row) return readLedger(file, loose).state;
    const read = (kind: string) => (db.prepare("SELECT body FROM delivery_entry WHERE ledger_key=? AND kind=? ORDER BY seq").all(basename(file), kind) as unknown as Array<{ body: string }>).map(e => JSON.parse(e.body));
    return { version: 1, bindingKey: row.binding_key, recipient: row.recipient, records: read("record"), tombstones: read("tombstone") };
  } catch { return readLedger(file, loose).state; } finally { db.close(); }
}
/** Raw JSON text of the committed rows (for "does not contain" and "unchanged" checks). */
export const rawText = (file: string) => entriesOf(file).map(e => `${e.kind}:${e.seq}:${e.body}`).join("\n");
/** Replace the committed rows, as a crash-time or hand-edited state would be. A string is stored as one corrupt record body. */
export function putState(file: string, state: object | string, legacy: string | null = null) {
  const db = connect(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS delivery_ledger (
      ledger_key TEXT PRIMARY KEY, binding_key TEXT NOT NULL, recipient TEXT NOT NULL,
      legacy TEXT, legacy_sha256 TEXT, migrated_by TEXT, migrated_boot TEXT,
      retire_attempts INTEGER NOT NULL DEFAULT 0, retire_after INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_entry (
      ledger_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('record','tombstone')), seq INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (ledger_key, kind, seq)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
    const parsed = typeof state === "string" ? { bindingKey: "binding", recipient: "owner", records: [state], tombstones: [] as string[] } : state as State;
    const body = (row: unknown) => typeof row === "string" ? row : JSON.stringify(row);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO delivery_ledger (ledger_key,binding_key,recipient,legacy) VALUES (?,?,?,?) ON CONFLICT(ledger_key) DO UPDATE SET binding_key=excluded.binding_key, recipient=excluded.recipient, legacy=excluded.legacy")
      .run(basename(file), parsed.bindingKey, parsed.recipient, legacy);
    db.prepare("DELETE FROM delivery_entry WHERE ledger_key=?").run(basename(file));
    const insert = db.prepare("INSERT INTO delivery_entry (ledger_key,kind,seq,body) VALUES (?,?,?,?)");
    parsed.records.forEach((row, seq) => insert.run(basename(file), "record", seq, body(row)));
    parsed.tombstones.forEach((row, seq) => insert.run(basename(file), "tombstone", seq, body(row)));
    db.exec("COMMIT");
  } finally { db.close(); }
}
/** A probe that counts commits made by anyone else (PRAGMA data_version moves on every foreign commit). */
export function probe(file: string) {
  const db = connect(file);
  const version = () => (db.prepare("PRAGMA data_version").get() as unknown as { data_version: number }).data_version;
  return { version, commits: (since: number) => version() - since, close: () => db.close() };
}
/** Fail the next matching commit(s) with `message`: a trigger, exactly one connection's view of a bad disk. Returns the undo. */
export function fault(file: string, on: "INSERT" | "UPDATE" | "INSERT OR UPDATE" = "INSERT OR UPDATE", message = "crash"): () => void {
  const db = connect(file);
  const events = on === "INSERT OR UPDATE" ? ["INSERT", "UPDATE"] : [on];
  events.forEach((event, i) => db.exec(`CREATE TRIGGER IF NOT EXISTS fault${i} BEFORE ${event} ON delivery_ledger BEGIN SELECT RAISE(ABORT,'${message}'); END`));
  return () => { events.forEach((_, i) => db.exec(`DROP TRIGGER IF EXISTS fault${i}`)); db.close(); };
}
/** Write a v1 ledger (root and overflow pages) exactly as 1.0.18 did. Returns the file names written. */
export function writeV1(file: string, state: State): string[] {
  const plan = planV1(state, loose);
  const names = plan.pages.map(page => `${file}.${page.name}`);
  plan.pages.forEach(page => writeFileSync(`${file}.${page.name}`, page.bytes));
  writeFileSync(file, plan.rootBytes);
  return [file, ...names];
}
/** The ledger files (paths) a directory's store holds rows for. */
export function ledgerFilesIn(dir: string): string[] {
  const db = new DatabaseSync(join(dir, LEDGER_DB));
  try { return (db.prepare("SELECT ledger_key FROM delivery_ledger ORDER BY ledger_key").all() as unknown as Array<{ ledger_key: string }>).map(r => join(dir, r.ledger_key)); }
  finally { db.close(); }
}
