// A scope's id is looked up for every captured message and every access build
// (37,219 lookups in one minute on the live store), each one a fresh
// statement compile and a scan by kind and owner. The ids found are
// remembered per connection and each answer is confirmed by one read of the
// row by primary key, so a scope that was renamed, deleted or rolled back is
// never answered from memory. The statements are prepared once per
// connection. A new connection starts empty.
//
// A lookup that finds nothing is remembered too (377,679 repeated misses on
// the 1.0.2 probe), under the scopes table's own change counter: a temporary
// trigger on this connection moves it on every scope created or renamed here,
// and another connection's commit (`data_version`) also moves it. A remembered
// miss is answered only while that counter has not moved since.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { eligibilityPassActive } from "./eligibility-pass.ts";

interface Held { byOwner: Map<string, string>; lookup: StatementSync; confirm: StatementSync; misses: Map<string, string>; stamp: StatementSync | null; nextTry: number }
const held = new WeakMap<object, Held>();
const STAMP_RETRY_LOOKUPS = 4096;

/** The counter and its triggers. Made outside a transaction only (a rollback would take them with it);
 *  null while they cannot be made, and then no miss is remembered. */
function stampStatement(db: DatabaseSync): StatementSync | null {
  if (db.isTransaction) return null;
  try {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS memory_scope_epoch(n INTEGER NOT NULL);
      INSERT INTO memory_scope_epoch(n) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM memory_scope_epoch);
      CREATE TEMP TRIGGER IF NOT EXISTS memory_scope_epoch_i AFTER INSERT ON main.memory_scopes BEGIN UPDATE memory_scope_epoch SET n=n+1; END;
      CREATE TEMP TRIGGER IF NOT EXISTS memory_scope_epoch_u AFTER UPDATE ON main.memory_scopes BEGIN UPDATE memory_scope_epoch SET n=n+1; END;`);
    return db.prepare("SELECT (SELECT n FROM temp.memory_scope_epoch) AS n, (SELECT data_version FROM pragma_data_version) AS v");
  } catch { return null; }
}

function heldFor(db: DatabaseSync): Held {
  let h = held.get(db);
  if (!h) {
    h = { byOwner: new Map(), misses: new Map(), stamp: null, nextTry: 0, lookup: db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?"), confirm: db.prepare("SELECT 1 FROM memory_scopes WHERE id=? AND kind=? AND owner_key=?") };
    held.set(db, h);
  }
  // Making the counter counts as a write, which would end a running eligibility pass's memo: it waits for the pass
  // to end. It can also fail while a statement of this connection is still being read: then the next try waits
  // STAMP_RETRY_LOOKUPS lookups.
  if (!h.stamp && !db.isTransaction && !eligibilityPassActive() && h.nextTry-- <= 0) { h.stamp = stampStatement(db); h.nextTry = STAMP_RETRY_LOOKUPS; }
  return h;
}

/** Searches by (kind, owner) made so far (each a scan of every scope on a file without the owner index), for tests that pin the work down. */
let lookups = 0;
export function scopeLookups(): number { return lookups; }

/** The counter now: undefined when it cannot be read (no miss is then remembered or answered). */
function scopesStamp(h: Held): string | undefined {
  if (!h.stamp) return undefined;
  try { const row = h.stamp.get() as { n: number; v: number } | undefined; return row ? `${row.n}:${row.v}` : undefined; } catch { return undefined; }
}

/** `{ id }` for the scope of this kind and owner, or undefined when none exists. */
export function scopeRow(db: DatabaseSync, kind: string, owner: string): { id: string } | undefined {
  const h = heldFor(db), key = `${kind}\u0000${owner}`, known = h.byOwner.get(key);
  if (known !== undefined) {
    if (h.confirm.get(known, kind, owner)) return { id: known };
    h.byOwner.delete(key);
  }
  const missedAt = h.misses.get(key);
  const stamp = missedAt !== undefined || h.stamp ? scopesStamp(h) : undefined;
  if (missedAt !== undefined && stamp !== undefined && missedAt === stamp) return undefined;
  lookups++;
  const row = h.lookup.get(kind, owner);
  if (!row) {
    // a miss read inside a transaction may rest on its own writes (a rolled-back rename): not remembered
    if (stamp !== undefined && !db.isTransaction) { if (h.misses.size >= 4096) h.misses.clear(); h.misses.set(key, stamp); }
    return undefined;
  }
  h.misses.delete(key);
  const id = String(row.id);
  if (h.byOwner.size >= 65_536) h.byOwner.clear();  // a bot with thousands of task threads stays remembered (1.0.2 bgwork)
  h.byOwner.set(key, id);
  return { id };
}

/** The scope ids of many owners of one kind (owner -> id, missing ones left out). Remembered ids are
 * confirmed by primary key in ONE statement; only owners not yet remembered are looked up one by one,
 * so a warm call costs one read however many owners it asks for (1.0.2 bgwork: a bot's task threads). */
export function scopeRows(db: DatabaseSync, kind: string, owners: readonly string[]): Map<string, string> {
  const h = heldFor(db), found = new Map<string, string>(), known = new Map<string, string>();
  for (const owner of owners) { const id = h.byOwner.get(`${kind}\u0000${owner}`); if (id !== undefined) known.set(id, owner); }
  if (known.size) {
    let statement = confirmMany.get(db);
    if (!statement) { statement = db.prepare("SELECT id, kind, owner_key FROM memory_scopes WHERE id IN (SELECT value FROM json_each(?))"); confirmMany.set(db, statement); }
    for (const row of statement.all(JSON.stringify([...known.keys()]))) {
      const owner = known.get(String(row.id));
      if (owner !== undefined && row.kind === kind && row.owner_key === owner) found.set(owner, String(row.id));
    }
  }
  for (const owner of owners) {
    if (found.has(owner)) continue;
    h.byOwner.delete(`${kind}\u0000${owner}`);
    const row = scopeRow(db, kind, owner);
    if (row) found.set(owner, row.id);
  }
  return found;
}
const confirmMany = new WeakMap<object, StatementSync>();
