// The channel receipt ledger's durable store: one small SQLite file per ledger directory,
// delivery-ledger.db. A ledger is one `delivery_ledger` row (binding, recipient, migration facts) plus one
// `delivery_entry` row per record and per tombstone; one transaction per commit.
// Same driver, journal mode and flush level as messages.db, and the same shape as
// connected-app-journal.ts: a record of what is about to be sent, flushed before it is sent.
// Nothing here renames or deletes a file to commit, so durability does not depend on a
// directory flush. Version 1 files (delivery-ledger-v1.ts) are only read to migrate, and are
// removed one bounded step at a time, only after the store's own copy has been re-read and the
// store's NAME is proven durable (a directory sync that really ran, or a later machine boot).
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "../sqlite-open.ts";
import { CHECKPOINT_BUSY_MS } from "../sqlite-checkpoint.ts";
import { checkpointFile, fileCheckpointAdmissionOpen, trackFileClose } from "../sqlite-file-checkpoint.ts";
import { syncDirectory, writeFileAtomic } from "../atomic.ts";
import { assertFileWriteAdmission } from "../read-only-start.ts";
import * as boot from "./boot-id.ts";
import { windowsDirectoryInheritCheck } from "../win-acl.ts";
import { buildElementSchemas, buildSchema, readLedger, planV1, sha256, type State } from "./delivery-ledger-v1.ts";

export const LEDGER_DB = "delivery-ledger.db";
export const LEDGER_INVALID = "Channel receipt data is invalid; original data preserved.";
export const RETIRE_STEP = 8;
const BUSY_TIMEOUT_MS = 1000;
const RETIRE_BACKOFF_MS = 60_000, RETIRE_BACKOFF_CAP_MS = 24 * 3600_000;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);
export type Legacy = null | "kept" | "removed" | "diverged" | "exported";
export interface LedgerRow {
  ledger_key: string; binding_key: string; recipient: string; legacy: Legacy; legacy_sha256: string | null;
  migrated_by: string | null; migrated_boot: string | null; retire_attempts: number; retire_after: number | null;
}
type WriteFile = (file: string, data: string) => void;
// Shared slots: current writer (1 main, negative worker), commit revision, next worker token.
interface Coordination { gate: Int32Array; refs: number; closing?: Promise<void> }
interface Handle { db: DatabaseSync; refs: number; coordination: Coordination; folded: number; checkpoint?: Promise<boolean>; checkpointRevision?: number; closed?: boolean; closing?: Promise<void>; timer?: ReturnType<typeof setInterval> }
const handles = new Map<string, Handle>();
const coordinations = new Map<string, Coordination>();
function writer<T>(coordination: Coordination, work: () => T): T {
  const { gate } = coordination;
  const held = Atomics.compareExchange(gate, 0, 0, 1);
  if (held !== 0) {
    // A reset has no copy debt. A failed worker must never leave intake waiting indefinitely.
    if (held === 1 || Atomics.wait(gate, 0, held, CHECKPOINT_BUSY_MS) === "timed-out" || Atomics.compareExchange(gate, 0, 0, 1) !== 0) throw new Error(LEDGER_INVALID);
  }
  try { const result = work(); Atomics.add(gate, 1, 1); return result; }
  finally { Atomics.store(gate, 0, 0); Atomics.notify(gate, 0); }
}
function releaseCoordination(file: string, coordination: Coordination): void {
  if (--coordination.refs === 0) coordinations.delete(file);
}
function closeIdleHandle(file: string, handle: Handle): Promise<void> | undefined {
  if (handle.refs || handle.closing) return handle.closing;
  if (handle.coordination.closing) {
    handle.closing = handle.coordination.closing.then(() => { handle.closing = undefined; return closeIdleHandle(file, handle); });
    return handle.closing;
  }
  let closed = false, ready = false;
  handle.closing = trackFileClose(checkpointFile(file, { gate: handle.coordination.gate, beforeFold: () => {
    ready = true;
    if (handle.refs) return false; // another lease reused the connection while the worker was starting
    handle.db.close(); closed = true; handle.closed = true; handles.delete(file);
  } }).then(async () => {
    handle.coordination.closing = undefined;
    if (closed) {
      handle.closing = undefined; clearInterval(handle.timer); releaseCoordination(file, handle.coordination); return;
    }
    // A failed pin leaves the main connection open; custody must still wait for a real last close.
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
    handle.closing = undefined;
    if (!handle.refs) await closeIdleHandle(file, handle);
  }));
  handle.coordination.closing = handle.closing;
  return handle.closing;
}
function releaseHandle(file: string, handle: Handle): Promise<void> {
  if (--handle.refs === 0) {
    if (handle.closed) { clearInterval(handle.timer); releaseCoordination(file, handle.coordination); }
    else closeIdleHandle(file, handle);
  }
  return (handle.checkpoint?.then(() => handle.closing) ?? handle.closing ?? Promise.resolve()).then(() => {});
}
async function checkpointHandle(file: string, handle: Handle): Promise<boolean> {
  if (handle.closed) return false;
  if (handle.coordination.closing) {
    handle.refs++;
    await handle.coordination.closing;
    handle.refs--;
  }
  const requested = Atomics.load(handle.coordination.gate, 1);
  // Nothing committed since the last fold: the file is already folded, so no worker starts.
  if (!handle.checkpoint && handle.folded === requested) return true;
  if (!handle.checkpoint) {
    handle.refs++; handle.checkpointRevision = requested;
    handle.checkpoint = checkpointFile(file, { gate: handle.coordination.gate }).then(folded => {
      if (folded) handle.folded = requested;
      return folded;
    }).finally(() => {
      handle.checkpoint = undefined;
      return releaseHandle(file, handle);
    });
  }
  const started = handle.checkpointRevision;
  const folded = await handle.checkpoint;
  if (handle.closed) return false;
  if (Atomics.load(handle.coordination.gate, 1) !== started || (folded && handle.folded !== requested)) return checkpointHandle(file, handle);
  return folded;
}
const strayName = (base: string) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\\d+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp)$`, "i");

function openHandle(dbFile: string, writeFile?: WriteFile): Handle {
  // A read-only start changes no data bytes (boot-tolerance A2): opening makes the folder, the file, its -wal/-shm and runs schema statements, so it is refused first.
  assertFileWriteAdmission(dbFile);
  mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
  // SQLite makes the -wal/-shm files itself, so they take the folder's inheritable entries: an existing folder must carry owner-only ones (nothing is trusted when the check cannot answer).
  if (process.platform === "win32" && windowsDirectoryInheritCheck(dirname(dbFile)) !== "owner-only") throw new Error("Channel receipt folder is not private");
  let created = false;
  try { lstatSync(dbFile); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; created = true; }
  let dirSynced = false;
  if (created) {
    // The adapter-owned creation boundary (Signal's private writer) makes the empty file; otherwise create it 0600 here.
    if (writeFile) writeFile(dbFile, "");
    else { closeSync(openSync(dbFile, "a", 0o600)); try { chmodSync(dbFile, 0o600); } catch { /* platform without modes */ } }
    // The strict sync: only a sync that really ran proves the new name durable. An unsupported one is tolerated (nothing is recorded); an I/O error is not.
    try { syncDirectory(dirname(dbFile), process.platform, false); dirSynced = process.platform !== "win32"; }
    catch (error) { if (!DIRECTORY_SYNC_UNSUPPORTED.has(String((error as { code?: unknown } | null)?.code))) throw error; }
  }
  const stat = lstatSync(dbFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid channel receipt file");
  const coordination = coordinations.get(dbFile) ?? { gate: new Int32Array(new SharedArrayBuffer(12)), refs: 0 };
  coordinations.set(dbFile, coordination); coordination.refs++;
  let db: DatabaseSync | undefined;
  try { return writer(coordination, () => {
    db = new DatabaseSync(dbFile);
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=0;`);
    db.exec(`CREATE TABLE IF NOT EXISTS delivery_ledger (
      ledger_key TEXT PRIMARY KEY, binding_key TEXT NOT NULL, recipient TEXT NOT NULL,
      legacy TEXT, legacy_sha256 TEXT, migrated_by TEXT, migrated_boot TEXT,
      retire_attempts INTEGER NOT NULL DEFAULT 0, retire_after INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_entry (
      ledger_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('record','tombstone')), seq INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (ledger_key, kind, seq)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
    if (dirSynced) db.prepare("INSERT OR IGNORE INTO store_meta (key,value) VALUES ('name_proof','dirsync')").run();
    return { db, refs: 0, coordination, folded: -1 };
  }); } catch (error) { try { db?.close(); } catch { /* already closed */ } releaseCoordination(dbFile, coordination); throw error; }
}

/** One ledger's view of its directory's store. The first open of a directory opens the file; the last release closes it. */
export class LedgerStore {
  readonly key: string;
  private readonly dbFile: string;
  private handle: Handle;
  private released = false;
  /** `nonce` names the owner of a migration; one per ledger instance, kept across its re-opens. */
  readonly file: string;
  readonly nonce: string;
  constructor(file: string, writeFile?: WriteFile, nonce: string = randomUUID()) {
    if (!fileCheckpointAdmissionOpen()) throw new Error(LEDGER_INVALID);
    this.file = file; this.nonce = nonce;
    this.key = basename(file);
    this.dbFile = join(dirname(file), LEDGER_DB);
    let handle = handles.get(this.dbFile);
    if (!handle) {
      handle = openHandle(this.dbFile, writeFile); handles.set(this.dbFile, handle);
      const owned = handle, file = this.dbFile;
      handle.timer = setInterval(() => {
        if (!owned.refs) { void closeIdleHandle(file, owned); return; }
        if (!owned.checkpoint && owned.folded !== Atomics.load(owned.coordination.gate, 1)) void checkpointHandle(file, owned);
      }, 250).unref();
    }
    handle.refs++; this.handle = handle;
  }
  get isReleased() { return this.released; }
  get maintenancePending() { return Boolean(this.handle.checkpoint || this.handle.coordination.closing); }
  private get db() { return this.handle.db; }
  /** Idempotent: the handle's count drops once per lease, and the last lease closes the file. */
  release(): Promise<void> {
    if (!this.released) {
      this.released = true;
      return releaseHandle(this.dbFile, this.handle);
    }
    return (this.handle.checkpoint?.then(() => this.handle.closing) ?? this.handle.closing ?? Promise.resolve()).then(() => {});
  }
  row(): LedgerRow | undefined {
    return this.db.prepare("SELECT * FROM delivery_ledger WHERE ledger_key = ?").get(this.key) as unknown as LedgerRow | undefined;
  }
  private nameProof(): boolean {
    return (this.db.prepare("SELECT value FROM store_meta WHERE key='name_proof'").get() as { value?: string } | undefined)?.value === "dirsync";
  }
  private tx<T>(work: () => T): T {
    return writer(this.handle.coordination, () => {
      this.db.exec("BEGIN IMMEDIATE");
      let result: T;
      try { result = work(); this.db.exec("COMMIT"); }
      catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* best effort */ } throw error; }
      return result;
    });
  }
  /** One transaction: the ledger row, and only the record and tombstone rows that differ from the committed ones.
   * A row keeps its seq while its order allows; a row whose place moved, a new row and a changed body are the only writes, and a row that left
   * the state is deleted. ORDER BY seq always reads back the state's own order. */
  commit(state: State, legacy?: { legacy: Legacy; sha: string | null; by: string | null }): void {
    this.tx(() => {
      if (legacy) this.db.prepare(`INSERT INTO delivery_ledger (ledger_key,binding_key,recipient,legacy,legacy_sha256,migrated_by,migrated_boot,retire_attempts,retire_after) VALUES (?,?,?,?,?,?,?,0,NULL)
        ON CONFLICT(ledger_key) DO UPDATE SET binding_key=excluded.binding_key, recipient=excluded.recipient, legacy=excluded.legacy, legacy_sha256=excluded.legacy_sha256,
          migrated_by=excluded.migrated_by, migrated_boot=excluded.migrated_boot, retire_attempts=0, retire_after=NULL`)
        .run(this.key, state.bindingKey, state.recipient, legacy.legacy, legacy.sha, legacy.by, boot.bootId());
      else this.db.prepare(`INSERT INTO delivery_ledger (ledger_key,binding_key,recipient) VALUES (?,?,?)
        ON CONFLICT(ledger_key) DO UPDATE SET binding_key=excluded.binding_key, recipient=excluded.recipient`)
        .run(this.key, state.bindingKey, state.recipient);
      const remove = this.db.prepare("DELETE FROM delivery_entry WHERE ledger_key=? AND kind=? AND seq=?");
      const insert = this.db.prepare("INSERT INTO delivery_entry (ledger_key,kind,seq,body) VALUES (?,?,?,?)");
      const update = this.db.prepare("UPDATE delivery_entry SET body=? WHERE ledger_key=? AND kind=? AND seq=?");
      for (const kind of ["record", "tombstone"] as const) {
        const held = this.db.prepare("SELECT seq, body FROM delivery_entry WHERE ledger_key=? AND kind=? ORDER BY seq").all(this.key, kind) as unknown as Array<{ seq: number; body: string }>;
        const rows = kind === "record" ? state.records : state.tombstones;
        const byId = new Map<string, { seq: number; value: { deliveryId: string } }>();
        let readable = true;
        for (const entry of held) {
          try { const value = JSON.parse(entry.body) as { deliveryId: string }; byId.set(value.deliveryId, { seq: entry.seq, value }); } catch { readable = false; }
        }
        // An unreadable body or duplicate ids on either side leave no row identity to diff by: that kind is written whole, as before.
        if (!readable || byId.size !== held.length || new Set(rows.map(row => row.deliveryId)).size !== rows.length) {
          for (const entry of held) remove.run(this.key, kind, entry.seq);
          rows.forEach((row, seq) => insert.run(this.key, kind, seq, JSON.stringify(row)));
          continue;
        }
        const kept = new Set<number>(), writes: Array<() => void> = [];
        let last = -1, top = held.length ? held[held.length - 1].seq : -1;
        for (const row of rows) {
          const body = JSON.stringify(row), entry = byId.get(row.deliveryId);
          if (entry && entry.seq > last) {
            kept.add(entry.seq); last = entry.seq;
            // Compared by value: a body read back through the schema has its keys in schema order, which is no change.
            if (!isDeepStrictEqual(entry.value, JSON.parse(body))) writes.push(() => update.run(body, this.key, kind, entry.seq));
          } else { const seq = last = ++top; writes.push(() => insert.run(this.key, kind, seq, body)); }
        }
        for (const entry of held) if (!kept.has(entry.seq)) remove.run(this.key, kind, entry.seq);
        for (const write of writes) write();
      }
    });
  }
  setLegacy(legacy: Legacy, sha?: string | null): void {
    this.tx(() => this.db.prepare("UPDATE delivery_ledger SET legacy=?, legacy_sha256=COALESCE(?, legacy_sha256), retire_attempts=0, retire_after=NULL WHERE ledger_key=?").run(legacy, sha ?? null, this.key));
  }
  /** Joined requests verify their committed revision, including writes crossing a worker's exit. */
  checkpoint(): Promise<boolean> { return checkpointHandle(this.dbFile, this.handle); }
  /** The ledger's rows as a state, each body parsed with the element schema; the aggregate is unbounded, as the in-memory ledger is. */
  state(row: LedgerRow, maxResponse: number): State {
    const element = buildElementSchemas(maxResponse);
    const read = <T>(kind: "record" | "tombstone", schema: { parse(value: unknown): T }): T[] =>
      (this.db.prepare("SELECT body FROM delivery_entry WHERE ledger_key=? AND kind=? ORDER BY seq").all(this.key, kind) as unknown as Array<{ body: string }>)
        .map(entry => schema.parse(JSON.parse(entry.body)));
    return { version: 1, bindingKey: row.binding_key, recipient: row.recipient, records: read("record", element.record), tombstones: read("tombstone", element.tombstone) };
  }
  /** True once a v1 file exists beside a row that no longer owns v1 files (an older build wrote it after a reinstall): the store stays authoritative. */
  private markDivergence(row: LedgerRow): void {
    if (row.legacy !== null && row.legacy !== "removed" && row.legacy !== "diverged") return;
    let bytes: Buffer;
    try { if (!lstatSync(this.file).isFile()) return; bytes = readFileSync(this.file); } catch { return; }
    const sha = sha256(bytes);
    if (row.legacy === "diverged" && row.legacy_sha256 === sha) return;
    this.setLegacy("diverged", sha);
  }

  /** The ledger's state: the rows, else a migrated v1 file, else undefined for a new ledger. Throws LEDGER_INVALID, never returns an empty stand-in. */
  load(maxResponse: number, options: { migrate: boolean }): { state: State; row: LedgerRow } | undefined {
    let row: LedgerRow | undefined;
    try { row = this.row(); } catch { throw new Error(LEDGER_INVALID); }
    if (row && row.legacy !== "exported") {
      try {
        const state = this.state(row, maxResponse);
        if (options.migrate) { this.markDivergence(row); row = this.row() ?? row; }
        return { state, row };
      } catch { throw new Error(LEDGER_INVALID); }
    }
    const schema = buildSchema(maxResponse);
    try {
      const v1 = readLedger(this.file, schema);
      // A first migration, or the re-import of a v1 file an older build wrote after a prepared downgrade.
      if (options.migrate) { this.commit(v1.state, { legacy: "kept", sha: v1.rootSha, by: this.nonce }); row = this.row(); }
      return { state: v1.state, row: row ?? { ledger_key: this.key, binding_key: v1.state.bindingKey, recipient: v1.state.recipient, legacy: "kept", legacy_sha256: v1.rootSha, migrated_by: this.nonce, migrated_boot: null, retire_attempts: 0, retire_after: null } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(LEDGER_INVALID);
      // A root missing while a page of it remains is the replace-crash shape of the old writer: not a new ledger, and (for an exported
      // ledger) not a removed one either. Checked before the row changes, so the older snapshot never answers for a half-written v1 ledger.
      let orphan: boolean;
      try { orphan = readdirSync(dirname(this.file)).some(name => name.startsWith(this.key + ".") && strayName(this.key).test(name)); }
      catch { throw new Error(LEDGER_INVALID); }
      if (orphan) throw new Error(LEDGER_INVALID);
      if (row) { if (options.migrate) { this.setLegacy(null); row = this.row() ?? row; } try { return { state: this.state(row, maxResponse), row }; } catch { throw new Error(LEDGER_INVALID); } }
      return undefined;
    }
  }

  private failRetire(attempts: number, now: number): { removed: number; failed: number; more: boolean } {
    const next = attempts + 1, wait = Math.min(RETIRE_BACKOFF_MS * 2 ** (next - 1), RETIRE_BACKOFF_CAP_MS);
    try { this.tx(() => this.db.prepare("UPDATE delivery_ledger SET retire_attempts=?, retire_after=? WHERE ledger_key=?").run(next, now + wait, this.key)); }
    catch { /* the failure is still counted below */ }
    return { removed: 0, failed: 1, more: false };
  }
  /** One bounded legacy-retirement step. Failures back off; `more` only after a step that removed something and has work left. */
  async retire(maxResponse: number, current: State, own: string, now: number): Promise<{ removed: number; failed: number; more: boolean }> {
    const none = { removed: 0, failed: 0, more: false };
    const row = this.row();
    if (!row || row.legacy !== "kept") return none;
    if (row.retire_after !== null && now < row.retire_after) return none;
    // (a) written by an earlier open, read back here, and the store's NAME is proven durable: a directory sync that really ran, or a later machine boot
    if (row.migrated_by === own) return none;
    const bootNow = boot.bootId();
    const laterBoot = row.migrated_boot !== null && bootNow !== null && row.migrated_boot !== bootNow;
    // Windows has no directory sync and no boot id, so neither proof can ever exist there; it relies on (c) instead: on NTFS the fold's
    // FlushFileBuffers commits the volume's metadata log, which holds the store's name, before any delete below. Without this the v1 plaintext of a
    // redacted or expired receipt stayed on disk for good (privacy; Fable H5 on thrust-boot).
    if (!this.nameProof() && !laterBoot && process.platform !== "win32") return none;
    // (b) equal to what this instance holds
    const schema = buildSchema(maxResponse, false);
    try { if (JSON.stringify(schema.parse(this.state(row, maxResponse))) !== JSON.stringify(schema.parse(current))) return none; } catch { return none; }
    // (c) folded into the main file
    const folded = await this.checkpoint();
    // A stop, mutation or another retirement during the fold invalidates this deletion plan.
    if (this.released || JSON.stringify(this.row()) !== JSON.stringify(row)) return none;
    try { if (JSON.stringify(schema.parse(this.state(row, maxResponse))) !== JSON.stringify(schema.parse(current))) return none; } catch { return none; }
    if (!folded) return this.failRetire(row.retire_attempts, now);
    // (d) only bytes identical to the migration snapshot are ever deleted
    let rootBytes: Buffer | undefined;
    try { rootBytes = readFileSync(this.file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return this.failRetire(row.retire_attempts, now); }
    if (rootBytes !== undefined && sha256(rootBytes) !== row.legacy_sha256) { this.setLegacy("diverged"); return none; }
    const dir = dirname(this.file);
    const queue: string[] = [];
    if (rootBytes !== undefined) {
      try { for (const part of (JSON.parse(rootBytes.toString("utf8")).overflow ?? []) as string[]) if (/^[0-9a-f-]{36}$/i.test(part)) queue.push(`${this.key}.${part}`); } catch { /* strays below */ }
    }
    const stray = strayName(this.key);
    for (const name of readdirSync(dir)) if (stray.test(name) && !queue.includes(name)) queue.push(name);
    if (rootBytes !== undefined) queue.push(this.key);
    let removed = 0, failed = 0;
    const batch = queue.slice(0, RETIRE_STEP);
    for (const name of batch) {
      if (name === this.key && failed) continue; // the root goes last, and only when everything before it went
      try { rmSync(join(dir, name)); removed++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++; }
    }
    if (failed) return { ...this.failRetire(row.retire_attempts, now), removed };
    if (queue.length <= RETIRE_STEP) { this.setLegacy("removed"); return { removed, failed: 0, more: false }; }
    this.tx(() => this.db.prepare("UPDATE delivery_ledger SET retire_attempts=0, retire_after=NULL WHERE ledger_key=?").run(this.key));
    return { removed, failed: 0, more: removed > 0 };
  }
}

/** Helper for the downgrade export and its re-import: a ledger's v1 files, written with today's v1 serialisation, never deleting. */
export function exportLedger(store: LedgerStore, writeFile?: WriteFile): void {
  const row = store.row();
  if (!row || row.legacy === "exported") return;
  const schema = buildSchema(20_000, false);
  const state = schema.parse(store.state(row, 20_000));
  const plan = planV1(state, schema);
  const dir = dirname(store.file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = writeFile ?? ((path: string, bytes: string) => writeFileAtomic(path, bytes, { mode: 0o600, syncDir: true }));
  for (const page of plan.pages) write(join(dir, `${store.key}.${page.name}`), page.bytes);
  write(store.file, plan.rootBytes);
  store.setLegacy("exported", sha256(plan.rootBytes));
}

/** True when a store row or a v1 root exists for `file`. Never creates the store; a read error answers true so the constructor's fail-closed check decides. */
export function ledgerExists(file: string): boolean {
  const dbFile = join(dirname(file), LEDGER_DB);
  let store: LedgerStore | undefined;
  try {
    try { lstatSync(dbFile); store = new LedgerStore(file); if (store.row()) return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    try { lstatSync(file); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; }
  } catch { return true; }
  finally { store?.release(); }
}

/** Read-only inspection (the live-provider harness): the committed records of `file`'s ledger, from the store when it holds a row for it, else
 * from a v1 root; a ledger that has neither throws ENOENT, as reading its absent file would. Opens the store read-only and never creates,
 * migrates or writes anything. */
export function committedLedgerRecords(file: string): unknown[] {
  const dbFile = join(dirname(file), LEDGER_DB);
  try { lstatSync(dbFile); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return v1Records(file); }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM delivery_ledger WHERE ledger_key=?").get(basename(file))) return v1Records(file);
    return (db.prepare("SELECT body FROM delivery_entry WHERE ledger_key=? AND kind='record' ORDER BY seq").all(basename(file)) as unknown as Array<{ body: string }>)
      .map(entry => JSON.parse(entry.body) as unknown);
  } finally { db.close(); }
}
function v1Records(file: string): unknown[] {
  return readLedger(file, buildSchema(20_000, false)).state.records;
}

/** PREFLIGHT parse of a (staged) store: every ledger row's entries, each with the element schema. Throws on the first unreadable body. Opens nothing itself. */
export function assertLedgerStoreReadable(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }): void {
  const element = buildElementSchemas(20_000);
  for (const ledger of db.prepare("SELECT ledger_key FROM delivery_ledger").all() as Array<{ ledger_key: string }>) {
    for (const entry of db.prepare("SELECT kind,body FROM delivery_entry WHERE ledger_key=? ORDER BY kind DESC, seq").all(ledger.ledger_key) as Array<{ kind: string; body: string }>)
      (entry.kind === "record" ? element.record : element.tombstone).parse(JSON.parse(entry.body));
  }
}

/** The stores of a data directory: `channels/**\/delivery-ledger.db` as relative paths (adapter folders nest at most a few levels). */
/** Read-only: the records the store holds for the ledger whose v1 file is `file` (in order, bodies as written), or null when the store has no such
 * ledger (an older build, or nothing migrated yet). For readers outside the server process, such as the live channel runner. Never writes or checkpoints. */
export function storedLedgerRecords(file: string): unknown[] | null {
  const dbFile = join(dirname(file), LEDGER_DB);
  try { if (!lstatSync(dbFile).isFile()) return null; } catch { return null; }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const key = basename(file);
    if (!db.prepare("SELECT 1 FROM delivery_ledger WHERE ledger_key=?").get(key)) return null;
    return (db.prepare("SELECT body FROM delivery_entry WHERE ledger_key=? AND kind='record' ORDER BY seq").all(key) as unknown as Array<{ body: string }>)
      .map(entry => JSON.parse(entry.body));
  } finally { db.close(); }
}

export function channelLedgerStores(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    // Only "absent" is an empty answer: any other listing or stat error propagates, so a downgrade never proceeds past receipts it could not see.
    const absent = <T>(read: () => T): T | undefined => { try { return read(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return undefined; } };
    for (const name of absent(() => readdirSync(join(root, relative))) ?? []) {
      const child = `${relative}/${name}`;
      if (name === LEDGER_DB) { if (absent(() => lstatSync(join(root, child)))?.isFile()) found.push(child); continue; }
      if (depth < 4 && absent(() => lstatSync(join(root, child)))?.isDirectory()) walk(child, depth + 1);
    }
  };
  walk("channels", 0);
  return found.sort();
}

/** PRESERVE for a prepared downgrade: every store's ledgers are written back as v1 files (1.0.18's format) and marked 'exported'. Never deletes; `writeFor` picks a private writer per directory. */
export async function exportChannelLedgersForDowngrade(root: string, writeFor: (relativeDir: string) => WriteFile | undefined = () => undefined): Promise<number> {
  let exported = 0;
  const closing: Promise<void>[] = [];
  try { for (const relative of channelLedgerStores(root)) {
    const dir = join(root, dirname(relative)), db = new DatabaseSync(join(dir, LEDGER_DB), { readOnly: true });
    let keys: string[];
    try { keys = (db.prepare("SELECT ledger_key FROM delivery_ledger ORDER BY ledger_key").all() as unknown as Array<{ ledger_key: string }>).map(r => r.ledger_key); } finally { db.close(); }
    for (const key of keys) {
      const store = new LedgerStore(join(dir, key));
      try { exportLedger(store, writeFor(dirname(relative))); exported++; } finally { closing.push(store.release()); }
    }
  } } finally { await Promise.all(closing); }
  return exported;
}
