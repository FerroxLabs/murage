// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S4 tests: a v10 messages.db with the rows the S1 writers and the S3 marker would leave, written directly, so the read
// side (deny-read.ts) is tested on exactly the marks it reads. Test tree only.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { safeWipeSync } from "../../testing/safe-wipe.mjs";
import { ensureRevokeLateObjects, migrateMemorySchema } from "../schema.ts";
import { BRANCH_TABLES_SQL } from "../../branch-index.ts";
import type { LineageReader, MemoryRefKind } from "../lineage-types.ts";

export const MESSAGES_SQL = "CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))";
export const CONTENT: LineageReader = { audience: null };
export const OWNER: LineageReader = { audience: { owner: true, scopeIds: ["s-room"] } };
export const MEMBER: LineageReader = { audience: { owner: false, scopeIds: ["s-room", "s-bot"] } };

/** The thread's interned number (memory_thread_no), taken now when it has none: what thread-no.ts ensureThreadNo does, for rows a test writes
 * directly. */
export function testThreadNo(db: DatabaseSync, thread: string): number {
  db.prepare("INSERT OR IGNORE INTO memory_thread_no(thread_id,no) VALUES(?,(SELECT coalesce(max(no),0)+1 FROM memory_thread_no))").run(thread);
  return Number(db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(thread)!.no);
}

/** A session a test resumes, as a 1.0.3 fresh start leaves it (S6 rule 26): its lineage row stamped with the current door epoch. A row
 * already there keeps its lsns and takes the stamp; a new one starts and ends at the file's head. */
export function stampFreshSession(db: DatabaseSync, thread: string, instance: string, session: string): void {
  db.prepare(`INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn,door_epoch)
    VALUES(?1,?2,?3,max(1,coalesce((SELECT next FROM memory_lsn WHERE id=1),1)-1),max(1,coalesce((SELECT next FROM memory_lsn WHERE id=1),1)-1),
      (SELECT value FROM memory_lineage_lsn_meta WHERE key='reader_door_epoch'))
    ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET door_epoch=excluded.door_epoch`).run(thread, instance, session);
}

export class WritetimeFixture {
  readonly db: DatabaseSync;
  private readonly dir: string | undefined;
  private tombs = 0;
  /** A new file, or (`existing`) the rows written into an open messages.db (the app's database() in a test's data dir). */
  constructor(existing?: DatabaseSync) {
    this.dir = existing ? undefined : mkdtempSync(join(tmpdir(), "murage-s4-"));
    this.db = existing ?? new DatabaseSync(join(this.dir!, "messages.db"));
    if (!existing) { migrateMemorySchema(this.db, "active"); ensureRevokeLateObjects(this.db); }
    this.db.exec(MESSAGES_SQL);
    this.db.exec(BRANCH_TABLES_SQL); // the read gate (deny.ts BRANCH_CHANGE_PENDING) seeks branch_change
    for (const scope of ["s-room", "s-bot", "s-other", "s-project"]) this.scope(scope);
  }
  close(): void { if (!this.dir) return; try { this.db.close(); } catch { /* closed */ } safeWipeSync(this.dir); }
  scope(id: string): this { this.db.prepare("INSERT OR IGNORE INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES(?,'room',?,'{}',0)").run(id, id); return this; }
  message(thread: string, id: string, role: "user" | "bot", extra: Record<string, unknown> = {}): this {
    this.db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,'text','',?)").run(thread, id, Date.now(), role, JSON.stringify({ id, role, ...extra }));
    return this;
  }
  lineage(thread: string, id: string, lsn: number, row: { generated?: boolean; turnLsn?: number | null; memLsn?: number | null; footprint?: number | null } = {}): this {
    // a generated line is one with a turn_lsn (a generated line given none counts its turn from 0); an owner line has none
    const turnLsn = row.generated === false ? null : row.turnLsn === undefined ? lsn - 1 : row.turnLsn ?? 0;
    this.db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, thread), lsn, id, turnLsn, row.memLsn ?? null, row.footprint ?? null);
    this.db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(lsn + 1);
    return this;
  }
  /** A generated (bot) line with its lineage row. */
  reply(thread: string, id: string, lsn: number, row: Parameters<WritetimeFixture["lineage"]>[3] = {}): this { return this.message(thread, id, "bot").lineage(thread, id, lsn, row); }
  /** An owner line with its lineage row (generated 0). */
  owner(thread: string, id: string, lsn: number, extra: Record<string, unknown> = {}): this { return this.message(thread, id, "user", extra).lineage(thread, id, lsn, { generated: false, turnLsn: null }); }
  denyLine(thread: string, lsn: number, revoke = 1): this { this.db.prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,?,?,'test')").run(thread, lsn, revoke, lsn); return this; }
  denyRange(thread: string, from: number, until: number, revoke = 1): this { this.db.prepare("INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES(?,?,?,?,'test')").run(thread, from, until, revoke); return this; }
  pending(thread: string, since: number, revoke = 1): this { this.db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(thread, since, revoke); return this; }
  /** The revoke's job row: its started_lsn is the cap of its walk and of its pending window (deny-read.ts lookupPage). */
  job(revoke: number, startedLsn: number, state: "active" | "seeding" | "done" = "active"): this {
    this.db.prepare("INSERT OR REPLACE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line','{}',?,?,'flow','',?)").run(revoke, startedLsn, startedLsn, state);
    return this;
  }
  pendingScope(scope: string, since: number, revoke = 1): this { this.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES(?,?,?)").run(scope, since, revoke); return this; }
  denyMemory(kind: MemoryRefKind, id: string, version = 0, revoke = 1): this { this.db.prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES(?,?,?,?)").run(kind, id, version, revoke); return this; }
  denySession(thread: string, instance: string, session: string, revoke = 1): this { this.db.prepare("INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,?)").run(thread, instance, session, revoke); return this; }
  deny(kind: "thread" | "scope", id: string): this { this.db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES(?,?,0,0)").run(kind, id); return this; }
  tombstone(type: "source" | "record" | "import", target: string, revision: number | null = null, reason = "owner-forget", hash: string | null = null): this {
    this.db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,?,?,0,?,0)").run(`t${++this.tombs}`, type, target, revision, hash, reason);
    return this;
  }
  meta(key: "policy_bump_lsn" | "epoch_bump_lsn" | "deny_generation" | "lineage_upgrade_lsn" | "reader_door_epoch", value: number): this { this.db.prepare("UPDATE memory_lineage_lsn_meta SET value=? WHERE key=?").run(value, key); return this; }
  footprint(setId: number, scopes: readonly string[]): this { for (const scope of scopes) this.db.prepare("INSERT INTO memory_scope_sets(set_id,scope_id) VALUES(?,?)").run(setId, scope); return this; }
  ready(thread: string, ready: boolean): this { this.db.prepare("INSERT OR REPLACE INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,?)").run(thread, ready ? 1 : 0); return this; }
  cert(ready: boolean): this { this.db.prepare("UPDATE memory_lineage_cert SET ready=?,phase=? WHERE id=1").run(ready ? 1 : 0, ready ? "done" : "u1"); return this; }
  source(id: string, scope: string, extra: { thread?: string; message?: string; state?: string; kind?: string; hash?: string; revision?: number } = {}): this {
    const revision = extra.revision ?? 1;
    this.db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,NULL,?,?,?,'user','ok',NULL,?)")
      .run(id, scope, extra.thread ?? null, extra.message ?? null, revision, extra.hash ?? `h-${id}`, extra.kind ?? "message", extra.state ?? "active");
    this.db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,?,?,?,0)").run(id, revision, extra.hash ?? `h-${id}`, JSON.stringify({ text: "words" }));
    return this;
  }
  record(id: string, version: number, scope: string, evidence: readonly string[] = [], extra: { assertion?: string; state?: string } = {}): this {
    this.db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,?,?,'fact','text',?,?,0,0,NULL,NULL,0)")
      .run(id, version, scope, extra.assertion ?? "observed", extra.state ?? "active");
    for (const source of evidence) this.db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,?,?,1,0,3)").run(id, version, source);
    return this;
  }
  derive(parent: string, parentVersion: number, child: string, childVersion: number): this {
    this.db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,?,?,?)").run(parent, parentVersion, child, childVersion);
    return this;
  }
  receipt(bundle: string, thread: string, instance: string, session: string, extra: { state?: string; policyRevision?: number; deletionEpoch?: number } = {}): this {
    this.db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[]',?,?,0,?,0)")
      .run(bundle, thread, instance, session, extra.policyRevision ?? 0, extra.deletionEpoch ?? 0, extra.state ?? "delivered");
    return this;
  }
  /** A session row as a fresh 1.0.3 start writes it (stamped with the current door epoch); `stamp: null` is a row an older build left. */
  sessionLineage(thread: string, instance: string, session: string, first: number, last: number, stamp: "current" | number | null = "current"): this {
    this.db.prepare(`INSERT OR REPLACE INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn,door_epoch)
      VALUES(?,?,?,?,?,${stamp === "current" ? "(SELECT value FROM memory_lineage_lsn_meta WHERE key='reader_door_epoch')" : "?"})`).run(thread, instance, session, first, last, ...(stamp === "current" ? [] : [stamp]));
    return this;
  }
  /** revbound's revocation job is waiting (memory-revocation.ts binds its system subject while a job runs). */
  revboundJobWaiting(): this {
    this.db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('job','s-room','system','memory-revocation',0,'granted','{}')").run();
    return this;
  }
}
