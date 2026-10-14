// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The seeded Sean-scale store the Phase 0 performance gates run on (PROPOSAL-v2 section 12): 60,000 captured
// sources of about 3 KB, 20,000 of them captured into indexed records, 300 active facts, 11 + 100 records waiting
// for the owner, 600 capture jobs held back an hour (the daily allowance), a backlog of pending jobs to drain, one
// job whose resume cursor sits inside a character, and about 2,500 receipts of about 30 entries.
//
// Generation is deterministic (a seeded generator, no clock in the content). The result is cached under
// MEMORY_PERF_CACHE when that is set, so the long build is paid once per runner.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase, database } from "../../database.ts";
import { MemoryIndex } from "../index.ts";
import { THREAD, freshDataDir } from "./recall-fixture.ts";

export interface PerfShape {
  sources: number; indexedRecords: number; active: number; waiting: number; extraWaiting: number;
  deferredJobs: number; pendingJobs: number; disclosures: number; disclosureEntries: number;
}
const env = (name: string, fallback: number) => { const value = Number(process.env[name]); return Number.isFinite(value) && value >= 0 && process.env[name] !== undefined ? value : fallback; };
export function perfShape(): PerfShape {
  return {
    sources: env("MEMORY_PERF_SOURCES", 60_000), indexedRecords: env("MEMORY_PERF_INDEXED", 20_000), active: 300, waiting: 11, extraWaiting: 100,
    deferredJobs: 600, pendingJobs: env("MEMORY_PERF_PENDING", 20_000), disclosures: 2_500, disclosureEntries: 30,
  };
}
export const perfEnabled = () => process.env.MEMORY_PERF === "1";

function generator(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SYLLABLES = ["ba", "ko", "ri", "tu", "ne", "sha", "lo", "mi", "ve", "dra", "pen", "cor", "fil", "gan", "hul", "jex", "kar", "lum", "nor", "pix"];
function vocabulary(next: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) { let word = ""; const parts = 2 + Math.floor(next() * 3); for (let i = 0; i < parts; i++) word += SYLLABLES[Math.floor(next() * SYLLABLES.length)]; words.add(word); }
  return [...words];
}
const sentence = (next: () => number, words: string[], count: number) => { const out: string[] = []; for (let i = 0; i < count; i++) out.push(words[Math.floor(next() * next() * words.length)]); return out.join(" "); };

/** Queries that find something in the fixture, spread over common and rare words. */
export function perfQueries(count: number): string[] {
  const next = generator(7), words = vocabulary(generator(1), 1500), queries: string[] = [];
  for (let n = 0; n < count; n++) queries.push(`${sentence(next, words, 3)} weekly client report timing`);
  return queries;
}

const FILES = ["messages.db", "memory-index.db"];
function copyFixture(from: string, to: string) { for (const file of FILES) copyFileSync(join(from, file), join(to, file)); }

/** A data directory holding the fixture, ready for `database()`, memory mode active. */
export function loadPerfFixture(shape = perfShape()): PerfShape {
  // Built in active mode: switching the mode later moves the policy revision, which would void every receipt of the store.
  freshDataDir("active");
  const cache = process.env.MEMORY_PERF_CACHE, key = `v3-${shape.sources}-${shape.indexedRecords}-${shape.pendingJobs}`;
  const cached = cache ? join(cache, key) : undefined;
  if (cached && existsSync(join(cached, "ready"))) {
    closeDatabase();
    rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    copyFixture(cached, DATA_DIR);
    return shape;
  }
  buildPerfFixture(shape);
  if (cached) {
    closeDatabase();
    rmSync(cached, { recursive: true, force: true }); mkdirSync(cached, { recursive: true });
    copyFixture(DATA_DIR, cached);
    writeFileSync(join(cached, "ready"), String(statSync(join(cached, "messages.db")).size));
  }
  return shape;
}

/** Where the fixture goes: this process's own store (the default) or another connection to a running server's. */
export interface PerfTarget { db: DatabaseSync; threadId: string; indexPath: string; ownConnection: boolean }
export function conversationScope(db: DatabaseSync, owner: string): string {
  const row = db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(owner);
  if (row) return String(row.id);
  const id = randomUUID();
  db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(id, owner);
  return id;
}

export function buildPerfFixture(shape: PerfShape, target?: PerfTarget) {
  const own = target === undefined;
  const db = target?.db ?? database();
  const threadId = target?.threadId ?? THREAD;
  const indexPath = target?.indexPath ?? join(DATA_DIR, "memory-index.db");
  db.exec("PRAGMA synchronous=OFF");
  const next = generator(42), words = vocabulary(generator(1), 1500);
  const scopeOf = (owner: string) => conversationScope(db, owner);
  const scope = scopeOf(threadId);
  const otherScope = scopeOf("other-thread");
  // after the store's lineage began (receipts older than that are judged 'pre-lineage' and the session would be reset)
  const now = Date.now();
  const insertSource = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,1,?,'text',?,'recorded','active')");
  const insertVersion = db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,?)");
  const insertRecord = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,?,?,?,?,0,?,?)");
  const insertEvidence = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)");
  const insertReceipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,?,NULL)");
  const insertJob = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,cursor,coverage,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1',?,?,?,?,?,?)");
  const meta = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  const policy = Number(meta.policy_revision), deletion = Number(meta.deletion_epoch);
  const add = (id: string, text: string, speaker: string, at: number, sourceScope = scope) => {
    const payload = JSON.stringify({ text, kind: "text", speaker, outcome: "recorded" });
    insertSource.run(id, sourceScope, threadId, `message-${id}`, `h-${id}`, speaker);
    insertVersion.run(id, `h-${id}`, payload, at);
    return Buffer.byteLength(text);
  };
  const indexed: Array<{ id: string; version: number; scopeId: string; text: string; deleted: boolean; archived: boolean }> = [];
  db.exec("BEGIN IMMEDIATE");
  for (let n = 0; n < shape.sources; n++) {
    const text = `${sentence(next, words, 420)} ${n}`;
    const id = `bulk-${n}`, bytes = add(id, text, n % 2 ? "owner" : "assistant", now + n);
    if (n < shape.indexedRecords) {
      // captured: one record per source (the first 2 KB chunk), indexed, job complete
      const chunk = text.slice(0, 2000);
      const rid = `chunk-${n}`;
      insertRecord.run(rid, scope, "source", chunk, n % 2 ? "owner-statement" : "assistant-inference", "active", now + n, now + n);
      insertEvidence.run(rid, id, Math.min(bytes, 2000));
      insertReceipt.run(rid, "indexed", "indexed");
      indexed.push({ id: rid, version: 1, scopeId: scope, text: chunk, deleted: false, archived: false });
      insertJob.run(`job-${n}`, id, "complete", 0, bytes, JSON.stringify({ throughByte: bytes, totalBytes: bytes }), policy, deletion);
    } else if (n < shape.indexedRecords + shape.pendingJobs) {
      insertJob.run(`job-${n}`, id, "pending", 0, 0, "[]", policy, deletion);
    } else if (n < shape.indexedRecords + shape.pendingJobs + shape.deferredJobs) {
      insertJob.run(`job-${n}`, id, "deferred", now + 3_600_000, 0, "[]", policy, deletion);
    } else {
      insertJob.run(`job-${n}`, id, "complete", 0, bytes, JSON.stringify({ throughByte: bytes, totalBytes: bytes }), policy, deletion);
    }
  }
  // Facts it already knows, indexed.
  for (let n = 0; n < shape.active; n++) {
    const text = `MEMACTIVE ${n}: a saved fact about ${sentence(next, words, 12)} weekly client report.`;
    const bytes = add(`active-${n}`, text, "owner", now + n);
    insertRecord.run(`active-${n}`, scope, "fact", text, "owner-statement", "active", now + n, now + n);
    insertEvidence.run(`active-${n}`, `active-${n}`, bytes);
    insertReceipt.run(`active-${n}`, "indexed", "indexed");
    indexed.push({ id: `active-${n}`, version: 1, scopeId: scope, text, deleted: false, archived: false });
  }
  // Waiting for the owner.
  for (let n = 0; n < shape.waiting + shape.extraWaiting; n++) {
    const text = `MEMWAIT ${n}: Sean prefers the report to open with the three numbers that moved most.`;
    const bytes = add(`wait-${n}`, text, "assistant", now + n);
    insertRecord.run(`wait-${n}`, scope, "fact", text, "assistant-inference", "candidate", now + n, now + n);
    insertEvidence.run(`wait-${n}`, `wait-${n}`, bytes);
  }
  // A record in another audience, indexed: the word query must not return it to this reader.
  add("other-0", "weekly client report belonging to another thread", "owner", now, otherScope);
  insertRecord.run("other-0", otherScope, "fact", "weekly client report belonging to another thread", "owner-statement", "active", now, now);
  insertEvidence.run("other-0", "other-0", 40); insertReceipt.run("other-0", "indexed", "indexed");
  indexed.push({ id: "other-0", version: 1, scopeId: otherScope, text: "weekly client report belonging to another thread", deleted: false, archived: false });
  // Two jobs the claim must not choke on, each in a scope of its own: a payload that does not decode (a lone surrogate
  // escape), and a resume cursor that starts inside a two byte character.
  const poisonScope = scopeOf("poison-thread"), realignScope = scopeOf("realign-thread");
  add("poison-0", "placeholder", "owner", now, poisonScope);
  db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='poison-0'").run('{"text":"abc \\ud800 def"}');
  insertJob.run("job-poison", "poison-0", "pending", 0, 0, "[]", policy, deletion);
  add("realign-0", "éa weekly report", "owner", now, realignScope);
  insertJob.run("job-realign", "realign-0", "pending", 0, 1, "[]", policy, deletion);
  // Receipts of earlier turns: about 30 entries each, over the facts and chunks it knows, in sessions of 80.
  const cited = indexed.slice(0, shape.active + 200).map(row => ({ id: row.id, version: row.version }));
  const insertDisclosure = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'delivered',?)");
  for (let n = 0; n < shape.disclosures; n++) {
    const entries: Array<{ id: string; version: number }> = [];
    for (let i = 0; i < shape.disclosureEntries; i++) entries.push(cited[(n * 7 + i * 13) % cited.length]);
    const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()];
    const sources = unique.map(entry => ({ id: entry.id.startsWith("chunk-") ? `bulk-${entry.id.slice(6)}` : entry.id, revision: 1 }));
    insertDisclosure.run(`disc-${n}`, threadId, "claude", `session-${Math.floor(n / 80)}`, JSON.stringify(unique), JSON.stringify(sources), policy, deletion, 900, now + n);
  }
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");
  if (own) closeDatabase();
  const index = new MemoryIndex(indexPath);
  try { for (let at = 0; at < indexed.length; at += 500) index.upsert(indexed.slice(at, at + 500)); } finally { index.close(); }
  if (!own) return;
  // Both files checkpointed and quiet, so copies of them are whole.
  const check = database();
  check.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
}
