// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness side of a phone's share-and-ask revocation (S32): the highest ask-credential generation refused for each device
// (`through`). The companion door tells the harness at POST /api/phones/ask-revoke; every ask or share after that carrying a
// generation at or below `through` is refused. `through` only ever grows, and a re-mint carries a higher generation, so a
// re-mint never deletes it. Lives on messages.db, created only while share and ask is offered.
import type { DatabaseSync } from "node:sqlite";
import { askTombstonePathFor, readAskTombstone } from "./revocation-tombstone.ts";

export function initializeAskRevocations(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS phone_ask_revocations (device_id TEXT PRIMARY KEY, through INTEGER NOT NULL)");
  // Revocations a backup downgrade set aside (revocation-tombstone.ts) come back with the table, keeping the higher generation. A file that cannot be
  // read throws here and is kept.
  const path = askTombstonePathFor(db);
  if (path === null) return;
  const put = db.prepare("INSERT INTO phone_ask_revocations (device_id, through) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET through = MAX(through, excluded.through)");
  for (const r of readAskTombstone(path)) put.run(r.device_id, r.through);
}

export class AskRevocations {
  private readonly db: DatabaseSync;
  // No parameter properties: the server runs under node --experimental-strip-types, which cannot erase them.
  constructor(db: DatabaseSync) { this.db = db; initializeAskRevocations(db); }

  /** Synchronous, keeps the maximum: a lower or equal `through` changes nothing. */
  apply(deviceId: string, through: number): void {
    if (!Number.isSafeInteger(through) || through < 0) throw new Error("through must be a non-negative integer");
    this.db.prepare("INSERT INTO phone_ask_revocations (device_id, through) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET through = MAX(through, excluded.through)").run(deviceId, through);
  }

  /** True when `generation` is at or below the device's `through`. A device with no entry is never refused here. */
  refuses(deviceId: string, generation: number): boolean {
    const row = this.db.prepare("SELECT through FROM phone_ask_revocations WHERE device_id = ?").get(deviceId) as { through: number } | undefined;
    return row !== undefined && generation <= row.through;
  }
}
