// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared set-up for the recall, epoch and turn-path tests: a data directory, one bot with a
// thread, a memory capability for it, captured sources made into records, and the word index.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase, database } from "../../database.ts";
import { InternalCapabilities } from "../../internal-capabilities.ts";
import { captureSource } from "../capture.ts";
import { captureWork } from "../chunks.ts";
import { MemoryIndex } from "../index.ts";
import { closeMemoryIndexReader } from "../index-reader.ts";
import { claimMemoryJob, publishMemoryWork } from "../jobs.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryAccess } from "../policy.ts";
import { setMemoryMode } from "../repository.ts";

export const THREAD = "thread";
export const ROSTER = { bots: [{ id: "bot", threadId: THREAD }], groups: [] };

export function freshDataDir(mode: "capture" | "active" = "capture") {
  closeMemoryIndexReader(); closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(ROSTER); setMemoryMode(mode);
}
export function accessFor(roster = ROSTER, bot = "bot", thread = THREAD): { access: MemoryAccess; registry: InternalCapabilities } {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return { access: memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster), registry };
}
/** Capture a message as a source and publish its chunks as records. Returns the source id and the job id. */
export function captureAndPublish(text: string, id = `source:${randomUUID()}`, speaker = "owner") {
  captureSource(database(), { id, threadId: THREAD, messageId: randomUUID(), kind: "text", speaker, outcome: "recorded", text });
  const work = claimMemoryJob("fixture");
  if (!work) throw new Error("Expected a captured source to produce a memory job");
  publishMemoryWork(work, "fixture", captureWork(work));
  return { sourceId: id, jobId: work.id };
}
/** Put every record that is waiting for the word index into memory-index.db and mark it indexed. */
export function indexPendingRecords(): number {
  const db = database();
  const rows = db.prepare("SELECT r.id,r.version,r.scope_id,r.text,r.state FROM memory_records r JOIN memory_projection_receipts p ON p.record_id=r.id AND p.record_version=r.version WHERE p.lexical_status='pending'").all();
  closeMemoryIndexReader();
  const index = new MemoryIndex(join(DATA_DIR, "memory-index.db"));
  try { index.upsert(rows.map(r => ({ id: String(r.id), version: Number(r.version), scopeId: String(r.scope_id), text: String(r.text), deleted: false, archived: r.state !== "active" }))); }
  finally { index.close(); }
  db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE lexical_status='pending'").run();
  return rows.length;
}
/** A bridge standing in for a helper that is busy for good. */
export const hangingBridge = { search: () => new Promise<never>(() => {}) };
export const failingBridge = (message = "MEMORY_WORKER_EXITED") => ({ search: async (): Promise<never> => { throw new Error(message); } });
export const emptyBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
export const changes = () => Number(database().prepare("SELECT total_changes() AS n").get()!.n);
