// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone revocation tombstone: a backup downgrade drops phone_revocations (older builds lack the table), and the rows would be gone when the
// host is upgraded again, so a phone removed while its jobs token was still on disk could work again. Before the drop the rows are written here,
// next to messages.db, and initializePhones reads them back. Only a jobs mint (PhoneRevocations.clear) takes a device out of this file.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../atomic.ts";

export const TOMBSTONE_FILE = "phone-revocations.tombstone.json";

export interface TombstoneRow { device_id: string; revoked_at: number; reason: "removed" | "switch-off" }

/** The tombstone beside this database's file, or null for an in-memory or temporary database. */
export function tombstonePathFor(db: DatabaseSync): string | null {
  const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const file = rows.find((r) => r.name === "main")?.file;
  if (!file || basename(file) === "") return null;
  return join(dirname(file), TOMBSTONE_FILE);
}

/** Rows in the file. Missing file: none. Anything unreadable or malformed throws, and the file is left exactly as it is. */
export function readTombstone(path: string): TombstoneRow[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("phone revocation tombstone is not a list");
  return raw.map((r) => {
    const row = r as Partial<TombstoneRow> | null;
    if (!row || typeof row.device_id !== "string" || row.device_id === "" || typeof row.revoked_at !== "number" || !Number.isFinite(row.revoked_at)
      || (row.reason !== "removed" && row.reason !== "switch-off")) throw new Error("phone revocation tombstone has a malformed row");
    return { device_id: row.device_id, revoked_at: row.revoked_at, reason: row.reason };
  });
}

function write(path: string, rows: TombstoneRow[] | AskTombstoneRow[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The file is synced, renamed, and then the folder is synced: a downgrade drops the table right after, so a rename lost to a power cut would lose the only copy.
  writeFileAtomic(path, JSON.stringify(rows, null, 2), { mode: 0o600, syncDir: true });
}

/** Add rows to the file, keeping every row already there (the first revoked_at and reason win). An unreadable existing file throws untouched. */
export function mergeIntoTombstone(path: string, add: TombstoneRow[]): void {
  if (add.length === 0) return;
  const merged = new Map(readTombstone(path).map((r) => [r.device_id, r]));
  for (const r of add) if (!merged.has(r.device_id)) merged.set(r.device_id, r);
  write(path, [...merged.values()]);
}

/** Take one device out of the file (a re-paired phone). Throws, file untouched, when the file cannot be read. */
export function removeFromTombstone(path: string, deviceId: string): void {
  const rows = readTombstone(path);
  if (!rows.some((r) => r.device_id === deviceId)) return;
  write(path, rows.filter((r) => r.device_id !== deviceId));
}

// The same for phone_ask_revocations: a downgrade drops the table, and an empty one made by the next upgrade would accept an ask generation that was
// revoked. Rows are the highest generation refused per device (`through`); it only ever grows, so nothing ever takes a row out of this file.
export const ASK_TOMBSTONE_FILE = "phone-ask-revocations.tombstone.json";
export interface AskTombstoneRow { device_id: string; through: number }

/** The ask tombstone beside this database's file, or null for an in-memory or temporary database. */
export function askTombstonePathFor(db: DatabaseSync): string | null {
  const path = tombstonePathFor(db);
  return path === null ? null : join(dirname(path), ASK_TOMBSTONE_FILE);
}

/** Rows in the ask file. Missing file: none. Anything unreadable or malformed throws, and the file is left exactly as it is. */
export function readAskTombstone(path: string): AskTombstoneRow[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("phone ask revocation tombstone is not a list");
  return raw.map((r) => {
    const row = r as Partial<AskTombstoneRow> | null;
    if (!row || typeof row.device_id !== "string" || row.device_id === "" || typeof row.through !== "number" || !Number.isSafeInteger(row.through) || row.through < 0) {
      throw new Error("phone ask revocation tombstone has a malformed row");
    }
    return { device_id: row.device_id, through: row.through };
  });
}

/** Add rows to the ask file, keeping the highest `through` per device. An unreadable existing file throws untouched. */
export function mergeIntoAskTombstone(path: string, add: AskTombstoneRow[]): void {
  if (add.length === 0) return;
  const merged = new Map(readAskTombstone(path).map((r) => [r.device_id, r]));
  for (const r of add) {
    const have = merged.get(r.device_id);
    if (!have || r.through > have.through) merged.set(r.device_id, { device_id: r.device_id, through: r.through });
  }
  write(path, [...merged.values()]);
}

const reported = new Set<string>();
/** Log an unreadable tombstone once per path. Phones stay off, and the file is the only copy, so the message points at a backup and never at removing it. */
export function reportUnreadableTombstone(path: string, error: unknown, what = "phones taken off this computer"): void {
  if (reported.has(path)) return;
  reported.add(path);
  console.error(`The record of ${what} at ${path} could not be read, so phone tools stay off. Restore that file from a backup. Reason: ${error instanceof Error ? error.message : String(error)}`);
}
