// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Durable receipts for a phone's share or ask (S33, design 5.3): one row per (device, kind, id) in messages.db, so a retry of the
// same id gets the first answer. The table lives on the SAME connection the send store uses, so a receipt flip and the queue
// row it describes commit or roll back together.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SendRow } from "../send-store.ts";
import type { TargetRefusal } from "./target.ts";

export type ReceiptKind = "share" | "ask";
export type ReceiptState = "received" | "committed" | "refused";
export interface PlannedFile { n: number; uploadId: string; ext: string; kind: "image" | "file"; mime: string }

export interface Receipt {
  deviceId: string;
  kind: ReceiptKind;
  id: string;
  fingerprint: string;
  generation: number;
  allocatedThreadId: string | null;
  itemHashes: string[] | null;
  planned: PlannedFile[] | null;
  files: SendRow["attachments"];
  state: ReceiptState;
  result: { threadId: string; queueId: string } | null;
  code: TargetRefusal | null;
  at: number;
}

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** The id a phone line is stored under in `(thread_id, send_id)`. The ":" is outside the client send id alphabet, and kind and device
 * are inside the hash, so two phones, or a share and an ask, with the same id never meet. 43 base64url characters. */
export function phoneSendId(kind: ReceiptKind, deviceId: string, id: string): string {
  return `phone:${kind}:${createHash("sha256").update(`${kind}\n${deviceId}\n${id}`, "utf8").digest("base64url")}`;
}

function json<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

/** The receipts table, created only while share and ask is offered. Also run by the snapshot's reference schema (installation-database-snapshot.ts). */
export function initializePhoneReceipts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS phone_receipts (
    device_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('share','ask')), id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, allocated_thread_id TEXT, item_hashes TEXT, planned TEXT, files TEXT,
    state TEXT NOT NULL CHECK(state IN ('received','committed','refused')), result TEXT, code TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (device_id, kind, id))`);
}

export class PhoneReceipts {
  readonly db: DatabaseSync;
  private readonly clock: () => number;
  // No parameter properties: the server runs under node --experimental-strip-types, which cannot erase them.
  constructor(db: DatabaseSync, sendStore: { database(): DatabaseSync }, o: { now?: () => number } = {}) {
    if (sendStore.database() !== db) throw new Error("phone receipts must use the send store's own connection");
    this.db = db;
    this.clock = o.now ?? Date.now;
    initializePhoneReceipts(db);
    db.prepare("DELETE FROM phone_receipts WHERE at < ?").run(this.clock() - RETAIN_MS);
  }

  get(deviceId: string, kind: ReceiptKind, id: string): Receipt | null {
    const r = this.db.prepare("SELECT * FROM phone_receipts WHERE device_id=? AND kind=? AND id=?").get(deviceId, kind, id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      deviceId: r.device_id as string, kind: r.kind as ReceiptKind, id: r.id as string, fingerprint: r.fingerprint as string, generation: r.generation as number,
      allocatedThreadId: (r.allocated_thread_id as string | null) ?? null, itemHashes: json<string[]>(r.item_hashes), planned: json<PlannedFile[]>(r.planned),
      files: json<NonNullable<SendRow["attachments"]>>(r.files), state: r.state as ReceiptState, result: json<{ threadId: string; queueId: string }>(r.result),
      code: (r.code as TargetRefusal | null) ?? null, at: r.at as number,
    };
  }

  /** Insert, or return the row already there. `newTarget` is a share to a thread that does not exist yet: the thread id is chosen here
   * and kept, so every retry lands in the same thread. */
  receive(r: { deviceId: string; kind: ReceiptKind; id: string; fingerprint: string; generation: number; allocatedThreadId?: string; itemHashes?: string[]; newTarget?: boolean }): Receipt {
    const allocated = r.allocatedThreadId ?? (r.newTarget === true ? randomUUID() : null);
    this.db.prepare(`INSERT OR IGNORE INTO phone_receipts (device_id, kind, id, fingerprint, generation, allocated_thread_id, item_hashes, state, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?)`).run(r.deviceId, r.kind, r.id, r.fingerprint, r.generation, allocated, r.itemHashes ? JSON.stringify(r.itemHashes) : null, this.clock());
    return this.get(r.deviceId, r.kind, r.id)!;
  }

  /** Persisted before any byte is saved, so a crash leaves a list of what to clean. */
  plan(deviceId: string, kind: ReceiptKind, id: string, planned: PlannedFile[]): void {
    this.db.prepare("UPDATE phone_receipts SET planned=? WHERE device_id=? AND kind=? AND id=?").run(JSON.stringify(planned), deviceId, kind, id);
  }

  setFiles(deviceId: string, kind: ReceiptKind, id: string, files: SendRow["attachments"]): void {
    this.db.prepare("UPDATE phone_receipts SET files=? WHERE device_id=? AND kind=? AND id=?").run(files ? JSON.stringify(files) : null, deviceId, kind, id);
  }

  /** Used inside the commit section only. */
  flip(deviceId: string, kind: ReceiptKind, id: string, to: { state: "committed"; result: { threadId: string; queueId: string } } | { state: "refused"; code: TargetRefusal }): void {
    if (to.state === "committed") this.db.prepare("UPDATE phone_receipts SET state='committed', result=?, code=NULL WHERE device_id=? AND kind=? AND id=?").run(JSON.stringify(to.result), deviceId, kind, id);
    else this.db.prepare("UPDATE phone_receipts SET state='refused', code=? WHERE device_id=? AND kind=? AND id=?").run(to.code, deviceId, kind, id);
  }
}

export interface ReclaimDeps {
  /** The attachments folder (the writer's own path). Only files directly inside it, after realpath, are ever deleted. */
  attachmentsDir: string;
  /** Whether any stored message names this file. Throws when it cannot tell; the whole sweep then deletes nothing. */
  messageNames(name: string): boolean;
  /** deleteAttachment: keeps the storage quota cache in step. */
  remove(path: string): { ok: boolean };
}
export interface ReclaimResult { deleted: number; kept: number; skipped: boolean }

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;
class Unreadable extends Error {}

function strictList(raw: unknown): unknown[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new Unreadable();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Unreadable(); }
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Unreadable();
  return value;
}
function pathNames(raw: unknown): string[] {
  return (strictList(raw) ?? []).map((item) => {
    const path = (item as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || !path) throw new Unreadable();
    return basename(path).toLowerCase();
  });
}
function plannedNames(raw: unknown): string[] {
  return (strictList(raw) ?? []).map((item) => {
    const p = item as { uploadId?: unknown; ext?: unknown } | null;
    if (typeof p?.uploadId !== "string" || typeof p.ext !== "string") throw new Unreadable();
    return `${p.uploadId}${p.ext.startsWith(".") ? "" : "."}${p.ext}`.toLowerCase();
  });
}

/** Restart cleanup by references (S37). Reclaims only files that a `received` or `refused` receipt lists (in `files`, or by identity in
 * `planned`) and that nothing else names: no queued, dispatched, unconfirmed or refused row, no committed receipt, no message. Fails
 * closed: a reference source that does not parse, or a path that does not resolve to a regular file directly inside the folder, means
 * nothing is deleted (the sweep) or that file is kept. Logs once, with no paths or ids. */
export function reclaimShareOrphans(db: DatabaseSync, deps: ReclaimDeps): ReclaimResult {
  const kept = new Set<string>();
  const candidates = new Set<string>();
  try {
    for (const row of db.prepare("SELECT attachments FROM owner_sends WHERE attachments IS NOT NULL AND attachments <> ''").all() as Array<{ attachments: unknown }>) {
      for (const name of pathNames(row.attachments)) kept.add(name);
    }
    for (const r of db.prepare("SELECT state, files, planned FROM phone_receipts").all() as Array<{ state: string; files: unknown; planned: unknown }>) {
      const names = [...pathNames(r.files), ...plannedNames(r.planned)];
      if (r.state === "committed") for (const n of names) kept.add(n);
      else if (r.state === "received" || r.state === "refused") for (const n of names) candidates.add(n);
      else throw new Unreadable();
    }
    for (const name of [...candidates]) {
      if (!STORED_NAME.test(name) || kept.has(name) || deps.messageNames(name)) { candidates.delete(name); }
    }
  } catch {
    console.warn("[phone-share] restart cleanup skipped: a reference source could not be read, so no shared file was removed");
    return { deleted: 0, kept: 0, skipped: true };
  }
  let deleted = 0, keptCount = 0;
  let root: string;
  try { root = realpathSync(deps.attachmentsDir); } catch { return { deleted: 0, kept: candidates.size, skipped: true }; }
  for (const name of candidates) {
    const target = join(deps.attachmentsDir, name);
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile() || dirname(realpathSync(target)) !== root) { keptCount += 1; continue; }
    } catch { continue; } // already gone: nothing to reclaim
    if (deps.remove(target).ok) deleted += 1; else keptCount += 1;
  }
  return { deleted, kept: keptCount, skipped: false };
}
