// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone registry (S8): which phones have registered with this host and what each reports, plus the persisted
// revocation barrier (Astra r1 AS2) that stops a revoked device re-registering through an authenticated PUT.
// Tables live in messages.db and are created only by initializePhones, which the host calls only when phones are offered.
import type { DatabaseSync } from "node:sqlite";
import { PHONE_CAPABILITIES, registrationSchema, type PhoneCapability } from "../../shared/phone-jobs-contract.ts";
import type { PhoneReport } from "../../shared/phone-apps.ts";
import { readTombstone, removeFromTombstone, tombstonePathFor } from "./revocation-tombstone.ts";

export interface PhoneRegistration {
  deviceId: string;
  name: string;
  platform: "ios" | "android";
  osVersion: string;
  appVersion: string;
  timeZone: string;
  protocol: 1;
  capabilities: PhoneReport;
  workspaces?: never;
  updatedAt: number;
}

export type RevocationReason = "removed" | "switch-off";

export type PutResult =
  | { ok: true; reg: PhoneRegistration; /** capabilities the previous registration reported and this one no longer does (feeds F7) */ dropped: PhoneCapability[] }
  | { ok: false; status: 400 | 403; error: string };

export function initializePhones(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS phone_registrations (
    device_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // The ask mint's device-id opt-in, kept apart from the registration so a restart between mint and registration keeps it (Astra r3 finding 1).
  db.exec(`CREATE TABLE IF NOT EXISTS phone_ask_optins (
    device_id TEXT PRIMARY KEY,
    opted_in INTEGER NOT NULL CHECK(opted_in IN (0,1))
  )`);
  backfillAskOptIns(db);
  db.exec(`CREATE TABLE IF NOT EXISTS phone_revocations (
    device_id TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('removed','switch-off'))
  )`);
  // Revocations a backup downgrade set aside (revocation-tombstone.ts) come back with the table. A file that cannot be read throws here and is kept.
  const path = tombstonePathFor(db);
  if (path === null) return;
  const rows = readTombstone(path);
  const put = db.prepare("INSERT INTO phone_revocations (device_id, revoked_at, reason) VALUES (?, ?, ?) ON CONFLICT(device_id) DO NOTHING");
  for (const r of rows) put.run(r.device_id, r.revoked_at, r.reason);
}

/**
 * Upgrade: a host that ran the earlier build kept the opt-in as a boolean `deviceIdOptIn` inside each stored registration. Copy every such
 * boolean into phone_ask_optins. A row the table already holds is newer (it was written by a mint) and is never overwritten, so this is safe to
 * run at every start. A registration whose body cannot be read, or holds anything but a boolean, is skipped. The old field stays in the stored
 * body (a downgrade still finds it) and fromRow strips it from every result.
 */
function backfillAskOptIns(db: DatabaseSync): void {
  const put = db.prepare("INSERT INTO phone_ask_optins (device_id, opted_in) VALUES (?, ?) ON CONFLICT(device_id) DO NOTHING");
  for (const row of db.prepare("SELECT device_id, body FROM phone_registrations").all() as unknown as Array<{ device_id: string; body: string }>) {
    let optedIn: unknown;
    try { optedIn = (JSON.parse(row.body) as { deviceIdOptIn?: unknown } | null)?.deviceIdOptIn; } catch { continue; }
    if (typeof optedIn === "boolean") put.run(row.device_id, optedIn ? 1 : 0);
  }
}

export class PhoneRevocations {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  // No parameter properties: the server runs under node --experimental-strip-types, which cannot erase them.
  constructor(db: DatabaseSync, now: () => number) { this.db = db; this.now = now; }

  /** Upsert that keeps the first revoked_at and reason. */
  bar(deviceId: string, reason: RevocationReason): void {
    this.db.prepare("INSERT INTO phone_revocations (device_id, revoked_at, reason) VALUES (?, ?, ?) ON CONFLICT(device_id) DO NOTHING").run(deviceId, this.now(), reason);
  }

  barred(deviceId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM phone_revocations WHERE device_id = ?").get(deviceId) !== undefined;
  }

  /** Only POST /api/phones/minted (S14) calls this. */
  clear(deviceId: string): void {
    // the tombstone first: if it cannot be updated nothing is cleared, and the phone stays barred
    const path = tombstonePathFor(this.db);
    if (path !== null) removeFromTombstone(path, deviceId);
    this.db.prepare("DELETE FROM phone_revocations WHERE device_id = ?").run(deviceId);
  }
}

function reports(report: PhoneReport, cap: PhoneCapability): boolean {
  return Boolean(report[cap]);
}

export class PhoneRegistry {
  private readonly revocations: PhoneRevocations;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
    this.revocations = new PhoneRevocations(db, now);
  }

  /**
   * Records whether this phone's latest ask mint opted in to its device id (request `want: ["deviceId"]`). It is stored in its own table,
   * independent of registration, so it survives a restart that falls between the mint and the phone's first registration.
   */
  setDeviceIdOptIn(deviceId: string, optedIn: boolean): void {
    this.db.prepare("INSERT INTO phone_ask_optins (device_id, opted_in) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET opted_in = excluded.opted_in").run(deviceId, optedIn ? 1 : 0);
  }

  /**
   * Tri-state: true when this phone's latest ask mint opted in, false when it minted an ask token without opting in (paired before pin-at-pairing),
   * undefined when this host has no record: the phone never minted an ask token, or it minted one before the host kept a record. This host
   * cannot tell those apart (the mints are issued by the companion door, whose own device file is not readable here), so undefined means
   * "unknown history", and the route reports it as the explicit "unknown" rather than leaving it out.
   */
  deviceIdOptIn(deviceId: string): boolean | undefined {
    const row = this.db.prepare("SELECT opted_in FROM phone_ask_optins WHERE device_id = ?").get(deviceId) as { opted_in: number } | undefined;
    return row === undefined ? undefined : row.opted_in === 1;
  }

  /** True only when the latest ask mint opted in. */
  deviceIdOptedIn(deviceId: string): boolean {
    return this.deviceIdOptIn(deviceId) === true;
  }

  put(deviceId: string, body: unknown): PutResult {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: "invalid registration" };
    // check and write in one synchronous run: nothing can interleave between them
    if (this.revocations.barred(deviceId)) return { ok: false, status: 403, error: "revoked" };
    const before = this.get(deviceId);
    const updatedAt = this.now();
    this.db
      .prepare("INSERT INTO phone_registrations (device_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
      .run(deviceId, JSON.stringify(parsed.data), updatedAt);
    const reg: PhoneRegistration = { deviceId, ...parsed.data, updatedAt };
    // a location report that narrows from precise to approximate drops the precise ask, so it ends open location jobs like a lost capability
    const dropped = before ? PHONE_CAPABILITIES.filter((c) => (reports(before.capabilities, c) && !reports(reg.capabilities, c))
      || (c === "location" && before.capabilities.location === "precise" && reg.capabilities.location === "approximate")) : [];
    return { ok: true, reg, dropped };
  }

  get(deviceId: string): PhoneRegistration | null {
    const row = this.db.prepare("SELECT device_id, body, updated_at FROM phone_registrations WHERE device_id = ?").get(deviceId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(): PhoneRegistration[] {
    const rows = this.db.prepare("SELECT device_id, body, updated_at FROM phone_registrations ORDER BY updated_at DESC, device_id").all() as unknown as Row[];
    return rows.map(fromRow);
  }

  remove(deviceId: string): void {
    this.db.prepare("DELETE FROM phone_registrations WHERE device_id = ?").run(deviceId);
    this.db.prepare("DELETE FROM phone_ask_optins WHERE device_id = ?").run(deviceId);
  }

  /** Remove the registration and bar the device in ONE transaction. */
  revoke(deviceId: string, reason: RevocationReason): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.revocations.bar(deviceId, reason);
      this.remove(deviceId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** F19: the named phone (by device id or name) if it reports the capability, else the most recently registered one that does. */
  chooseFor(capability: PhoneCapability, lastUsed?: string): PhoneRegistration | null {
    const able = this.list().filter((r) => reports(r.capabilities, capability));
    if (lastUsed) {
      const named = able.find((r) => r.deviceId === lastUsed) ?? able.find((r) => r.name === lastUsed);
      if (named) return named;
    }
    return able[0] ?? null;
  }
}

interface Row { device_id: string; body: string; updated_at: number }

function fromRow(row: Row): PhoneRegistration {
  // A body written by the earlier build may still carry deviceIdOptIn; the upgrade copied it into phone_ask_optins, so it is never returned.
  const { deviceIdOptIn: _legacyOptIn, ...body } = JSON.parse(row.body) as Omit<PhoneRegistration, "deviceId" | "updatedAt"> & { deviceIdOptIn?: unknown };
  return { deviceId: row.device_id, ...body, updatedAt: row.updated_at };
}
