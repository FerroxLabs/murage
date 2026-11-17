// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_BUSY_MS, DEFAULT_BUSY_MS, isDatabaseBusy, setBusy } from "./db-busy.ts";

/** Retry an atomic, idempotent refusal write on its captured installation.
 * The terminal in-memory latch already owns the turn. Contention may delay
 * persistence, never reopen it, block its HTTP denial, or retarget a new DB. */
export function persistLedgerRefusal(db: DatabaseSync, work: () => void, isCurrent: () => boolean = () => true): Promise<void> {
  return new Promise((resolve, reject) => {
    const later = () => { const timer = setTimeout(attempt, 100); timer.unref?.(); };
    const attempt = () => {
      if (!db.isOpen) { reject(new Error("LEDGER_PERSISTENCE_DATABASE_CLOSED")); return; }
      if (!isCurrent()) { reject(new Error("LEDGER_PERSISTENCE_DATABASE_CHANGED")); return; }
      if (db.isTransaction) { later(); return; }
      try {
        setBusy(db, BACKGROUND_BUSY_MS);
        const result: unknown = work();
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("ASYNC_LEDGER_PERSISTENCE");
        resolve();
      } catch (error) {
        if (isDatabaseBusy(error)) later(); else reject(error);
      } finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* captured connection closed */ } }
    };
    attempt();
  });
}
