// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute } from "node:path";
import { assertJournalStorage, syncJournalDirectory } from "./approval-journal-storage.ts";
import { completeReconciliationCollection } from "./reconciliation-read.ts";

const refused = () => new Error("We could not confirm whether the user was added.");
const normalizedEmail = (email: string) => email.trim().toLowerCase();
function identity(companyId: string, email: string): string {
  if (!companyId || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail(email))) throw refused();
  return createHash("sha256").update(JSON.stringify([companyId, normalizedEmail(email)])).digest("hex");
}
export interface UserCreateClaim {
  barrier(): void;
  /** Only valid before the dispatch barrier, by the same live claim holder. */
  releaseUnsent(): void;
}
/** Non-secret cross-process identity reservation owned by journaled host dispatch.
 *
 * A durable barrier is irrevocable here: generic errors, HTTP status codes,
 * missing inventory entries and process restarts can never release it. There is
 * deliberately no API to recover a dispatch owner from persisted metadata. */
export class UserCreateIdentityClaims {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(file: string) {
    try { if (!isAbsolute(file)) throw refused(); assertJournalStorage(dirname(file)); }
    catch { throw refused(); }
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.#db.exec(`CREATE TABLE IF NOT EXISTS user_create_claims (
        identity TEXT PRIMARY KEY, dispatch_owner TEXT NOT NULL UNIQUE,
        action_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('claimed', 'barrier'))
      ) STRICT;`);
      syncJournalDirectory(dirname(file));
    } catch { this.#db.close(); throw refused(); }
  }
  acquire(companyId: string, email: string, actionId: string): UserCreateClaim | undefined {
    if (this.#closed || typeof actionId !== "string" || !actionId) throw refused();
    const key = identity(companyId, email), owner = randomUUID();
    try {
      const result = this.#db.prepare("INSERT OR IGNORE INTO user_create_claims VALUES (?, ?, ?, 'claimed')").run(key, owner, actionId);
      if (result.changes !== 1) return;
    } catch { throw refused(); }
    let live = true;
    const commit = (statement: string) => {
      if (!live || this.#closed) throw refused();
      try {
        const result = this.#db.prepare(statement).run(key, owner);
        if (result.changes !== 1) throw refused();
        live = false;
      } catch { throw refused(); }
    };
    // Methods are non-enumerable; serializing a claim never exports capabilities.
    return Object.freeze(Object.create(null, {
      barrier: { value: () => commit("UPDATE user_create_claims SET phase='barrier' WHERE identity=? AND dispatch_owner=? AND phase='claimed'") },
      releaseUnsent: { value: () => commit("DELETE FROM user_create_claims WHERE identity=? AND dispatch_owner=? AND phase='claimed'") },
    })) as UserCreateClaim;
  }
  status(companyId: string, email: string): "held" | "outcome_unknown" | undefined {
    if (this.#closed) throw refused();
    try {
      const row = this.#db.prepare("SELECT phase FROM user_create_claims WHERE identity=?").get(identity(companyId, email));
      return row ? row.phase === "barrier" ? "outcome_unknown" : "held" : undefined;
    } catch { throw refused(); }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
}
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** A complete, scoped inventory is mandatory before any dispatch. It is never
 * permission to resend an uncertain write; only a live, unspent claim can send. */
export function userCreateInventoryClear(value: unknown, email: string, locationId: string): boolean {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.users) || raw.users.length > 10000 || !completeReconciliationCollection(raw, raw.users.length, false)) return false;
  const ids = new Set<string>();
  for (const item of raw.users) {
    const user = record(item), roles = record(user?.roles);
    const locations = roles?.locationIds ?? user?.locationIds;
    const type = roles?.type ?? user?.type;
    if (!user || typeof user.id !== "string" || !user.id || ids.has(user.id) || typeof user.email !== "string"
      || !Array.isArray(locations) || locations.length !== 1 || locations[0] !== locationId || type !== "account"
      || (user.locationId !== undefined && user.locationId !== locationId)
      || (user.type !== undefined && user.type !== type)
      || (user.locationIds !== undefined && (!Array.isArray(user.locationIds) || user.locationIds.length !== 1 || user.locationIds[0] !== locationId))) return false;
    ids.add(user.id);
    if (normalizedEmail(user.email) === normalizedEmail(email)) return false;
  }
  return true;
}
