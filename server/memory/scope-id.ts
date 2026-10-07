// A scope's id is looked up for every captured message and every access build
// (37,219 lookups in one minute on the live store), each one a fresh
// statement compile and a scan by kind and owner. The ids found are
// remembered per connection and each answer is confirmed by one read of the
// row by primary key, so a scope that was renamed, deleted or rolled back is
// never answered from memory. The statements are prepared once per
// connection. A miss is never remembered. A new connection starts empty.
import type { DatabaseSync, StatementSync } from "node:sqlite";

interface Held { byOwner: Map<string, string>; lookup: StatementSync; confirm: StatementSync }
const held = new WeakMap<object, Held>();

function heldFor(db: DatabaseSync): Held {
  let h = held.get(db);
  if (!h) {
    h = { byOwner: new Map(), lookup: db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?"), confirm: db.prepare("SELECT 1 FROM memory_scopes WHERE id=? AND kind=? AND owner_key=?") };
    held.set(db, h);
  }
  return h;
}

/** `{ id }` for the scope of this kind and owner, or undefined when none exists. */
export function scopeRow(db: DatabaseSync, kind: string, owner: string): { id: string } | undefined {
  const h = heldFor(db), key = `${kind}\u0000${owner}`, known = h.byOwner.get(key);
  if (known !== undefined) {
    if (h.confirm.get(known, kind, owner)) return { id: known };
    h.byOwner.delete(key);
  }
  const row = h.lookup.get(kind, owner);
  if (!row) return undefined;
  const id = String(row.id);
  if (h.byOwner.size >= 4096) h.byOwner.clear();
  h.byOwner.set(key, id);
  return { id };
}
