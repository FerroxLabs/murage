// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reviewing what bots would like to remember (PROPOSAL-v2 sections 3, 7.1, 9.2,
// 9.3; Phase 0 items 0.2 to 0.7). Counts come from indexed per-scope queries.
// Every mutating call carries a client action id; the id, the payload hash and
// the result ride in the learning event written in the same transaction as the
// change, so a retry (after a lost response, a double press or a restart)
// returns the stored result and a reused id with a different payload is
// refused. Nothing here adds a memory_* object: Later lives in the
// `memory-review-later` binding row.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { partitionOfScopeKey } from "../execution-audience.ts";
import { redactSecretsInText } from "../redact.ts";
import { readCorrectionTarget, requireMemoryOwner, approveMemory, type CorrectionPinChoice } from "./authority.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { PIP_ALL_KINDS_SQL, isPipKind } from "./pip-kinds.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { memoryState } from "./repository.ts";
import { ELIGIBILITY_RULE_VERSION, eligibilityLine, evidenceStillThere, memoryEligibility, type AskReason, type Eligibility, type EligibilityRow } from "./review-eligibility.ts";
import { waitingEpoch, waitingRevision } from "./waiting-epoch.ts";

export const LATER_ROW = "memory-review-later";
const LATER_CAP = 5000;
const SLICE = 25;
const SCOPE_ROW_CAP = 500;
/** The waiting-count read: one indexed seek per scope on memory_records_scope(scope_id,state). */
export const WAITING_SCOPE_SQL = `SELECT id FROM memory_records WHERE scope_id=? AND state='candidate' AND kind NOT IN ${PIP_ALL_KINDS_SQL} LIMIT ${SCOPE_ROW_CAP}`;

export type SubjectKind = "bot" | "room" | "other";
export interface Subject { kind: SubjectKind; id: string; name: string }
export type Origin = "owner-said" | "bot-worked-out" | "tool-result" | "imported";
export interface WaitingEntry {
  id: string; version: number; text: string; group: "everyday" | "one-by-one"; rank: number; reasons: AskReason[];
  origin: Origin; at: number; later: boolean; scopeLabel: string;
  correction?: { targetText: string; targetPinned: boolean };
}
export interface SubjectCount { kind: SubjectKind; id: string; name: string; waiting: number; later: number; everyday: number }
export interface WaitingSummary { subjects: SubjectCount[]; total: number; later: number; boot: string; revision: number }
export type ItemStatus = "kept" | "changed" | "needs-you" | "gone";
export interface ItemResult { id: string; version: number; status: ItemStatus; reasons?: AskReason[] }

const fail = (code: string, status = 409) => Object.assign(new Error(code), { status });
const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

// ── Later: one binding row, JSON, capped ─────────────────────────────────
interface LaterEntry { version: number; at: number; actionId: string }
function readLater(db: DatabaseSync): Record<string, LaterEntry> {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(LATER_ROW);
  if (!row) return {};
  try {
    const items = JSON.parse(String(row.intent))?.items;
    return items && typeof items === "object" && !Array.isArray(items) ? items as Record<string, LaterEntry> : {};
  } catch { return {}; }
}
function writeLater(db: DatabaseSync, items: Record<string, LaterEntry>): void {
  const scope = ensureScope("workspace", memoryState().installationId);
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(LATER_ROW, scope, LATER_ROW, JSON.stringify({ v: 1, items }));
}

// ── Who a scope belongs to ───────────────────────────────────────────────
interface Index {
  bots: Map<string, { name: string }>; groups: Map<string, { name: string }>;
  botThread: Map<string, string>; groupThread: Map<string, string>;
}
function indexRoster(roster: MemoryRoster): Index {
  const index: Index = { bots: new Map(), groups: new Map(), botThread: new Map(), groupThread: new Map() };
  for (const bot of roster.bots) {
    index.bots.set(bot.id, { name: bot.name || "Your bot" });
    index.botThread.set(bot.threadId, bot.id);
    for (const task of bot.tasks ?? []) index.botThread.set(task.threadId, bot.id);
  }
  for (const group of roster.groups) {
    index.groups.set(group.id, { name: group.name || "Your room" });
    index.groupThread.set(group.threadId, group.id);
    for (const task of group.tasks ?? []) index.groupThread.set(task.threadId, group.id);
  }
  return index;
}
const SHARED: Subject = { kind: "other", id: "shared", name: "Shared notes" };
/** The one place a scope's waiting items are decided and counted: a bot's own notes and chats under the bot, a room's shared notes once under the room. */
function subjectOfScope(scope: { kind: string; owner_key: string }, index: Index): Subject | null {
  const owner = String(scope.owner_key);
  switch (String(scope.kind)) {
    case "bot": {
      const botId = partitionOfScopeKey("bot", owner)?.botId;
      const bot = botId ? index.bots.get(botId) : undefined;
      return botId && bot ? { kind: "bot", id: botId, name: bot.name } : null;
    }
    case "conversation": {
      const botId = index.botThread.get(owner);
      if (botId) return { kind: "bot", id: botId, name: index.bots.get(botId)!.name };
      const groupId = index.groupThread.get(owner);
      return groupId ? { kind: "room", id: groupId, name: index.groups.get(groupId)!.name } : null;
    }
    case "room": {
      const group = index.groups.get(owner);
      return group ? { kind: "room", id: owner, name: group.name } : null;
    }
    default: return SHARED;
  }
}
function scopeLabel(scope: { kind: string; owner_key: string }, subject: Subject): string {
  const kind = String(scope.kind);
  if (kind === "conversation") return subject.kind === "room" ? subject.name : `Your chat with ${subject.name}`;
  if (kind === "bot") return /#(?:general|team:|project:|room:)/.test(String(scope.owner_key)) ? `${subject.name}'s notes for shared spaces` : `${subject.name}'s notes`;
  return subject.name;
}

function originOf(db: DatabaseSync, row: Record<string, unknown>): Origin {
  if (row.assertion === "unverified-import") return "imported";
  const source = db.prepare("SELECT s.speaker FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id AND s.revision=e.source_revision WHERE e.record_id=? AND e.record_version=? LIMIT 1").get(row.id as string, row.version as number);
  const speaker = String(source?.speaker ?? "");
  if (speaker === "owner" || speaker.startsWith("person:")) return "owner-said";
  if (speaker === "tool") return "tool-result";
  return "bot-worked-out";
}

interface Group { subject: Subject; entries: WaitingEntry[] }
/** Gather waiting items per subject. `only` limits the work to one subject; `detail` adds the replaced text of corrections. */
function collect(db: DatabaseSync, roster: MemoryRoster, options: { only?: { kind: SubjectKind; id: string }; detail?: boolean } = {}): Map<string, Group> {
  const index = indexRoster(roster), later = readLater(db), groups = new Map<string, Group>();
  const scopes = db.prepare("SELECT id,kind,owner_key FROM memory_scopes").all() as Array<{ id: string; kind: string; owner_key: string }>;
  const select = db.prepare(`SELECT * FROM memory_records WHERE scope_id=? AND state='candidate' AND kind NOT IN ${PIP_ALL_KINDS_SQL} ORDER BY created_at,id LIMIT ${SCOPE_ROW_CAP}`);
  for (const scope of scopes) {
    const subject = subjectOfScope(scope, index);
    if (!subject) continue;
    if (options.only && (options.only.kind !== subject.kind || options.only.id !== subject.id)) continue;
    const rows = select.all(scope.id) as Array<Record<string, unknown>>;
    if (!rows.length) continue;
    const key = `${subject.kind}:${subject.id}`;
    const group = groups.get(key) ?? { subject, entries: [] };
    groups.set(key, group);
    for (const row of rows) {
      const eligibility = memoryEligibility(db, row as unknown as EligibilityRow);
      const reasons = eligibility.reasons;
      const rank = reasons.some(reason => reason === "replaces-pinned" || reason === "correction" || reason === "edited") ? 0 : eligibility.decision === "keep" ? 2 : 1;
      const entry: WaitingEntry = {
        id: String(row.id), version: Number(row.version), text: String(row.text), group: eligibility.decision === "keep" ? "everyday" : "one-by-one",
        rank, reasons, origin: originOf(db, row), at: Number(row.created_at), later: later[String(row.id)] !== undefined, scopeLabel: scopeLabel(scope, subject),
      };
      if (options.detail && row.supersedes_id) {
        const review = readCorrectionTarget(db, entry.id, entry.version);
        if (review?.target) entry.correction = { targetText: review.target.text, targetPinned: review.target.ownerPinned };
      }
      group.entries.push(entry);
    }
  }
  return groups;
}

function summarize(db: DatabaseSync, groups: Map<string, Group>): WaitingSummary {
  const subjects: SubjectCount[] = [];
  let total = 0, laterTotal = 0;
  for (const { subject, entries } of groups.values()) {
    const waiting = entries.filter(entry => !entry.later);
    const count: SubjectCount = { ...subject, waiting: waiting.length, later: entries.length - waiting.length, everyday: waiting.filter(entry => entry.group === "everyday").length };
    total += count.waiting; laterTotal += count.later;
    if (count.waiting || count.later) subjects.push(count);
  }
  subjects.sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));
  return { subjects, total, later: laterTotal, ...waitingRevision(db) };
}

const held = new WeakMap<DatabaseSync, { key: string; at: number; value: WaitingSummary }>();
const rosterSignature = (roster: MemoryRoster) => `${roster.bots.map(b => `${b.id}:${b.name ?? ""}`).join(",")}|${roster.groups.map(g => `${g.id}:${g.name ?? ""}`).join(",")}`;
/** The numbers every surface shows. Held per connection until the waiting counter moves (or 30 s), so the Inbox read costs nothing when nothing happened. */
export function waitingSummary(roster: MemoryRoster, now = Date.now()): WaitingSummary {
  const db = database(), epoch = waitingEpoch(db);
  const key = `${epoch}|${rosterSignature(roster)}`, hit = held.get(db);
  if (epoch !== null && hit && hit.key === key && now - hit.at < 30_000) return hit.value;
  const value = summarize(db, collect(db, roster));
  if (epoch !== null) held.set(db, { key, at: now, value });
  return value;
}
export function resetWaitingSummaryCache(): void { /* the cache is per connection; a new connection starts empty */ }

/** Cheap counts only (no eligibility): what the live event and the badge need. */
export function waitingCounts(db: DatabaseSync, roster: MemoryRoster): Map<string, { subject: Subject; waiting: number }> {
  const index = indexRoster(roster), later = readLater(db), out = new Map<string, { subject: Subject; waiting: number }>();
  const scopes = db.prepare("SELECT id,kind,owner_key FROM memory_scopes").all() as Array<{ id: string; kind: string; owner_key: string }>;
  const select = db.prepare(WAITING_SCOPE_SQL);
  for (const scope of scopes) {
    const subject = subjectOfScope(scope, index);
    if (!subject) continue;
    const ids = select.all(scope.id) as Array<{ id: string }>;
    if (!ids.length) continue;
    const waiting = ids.filter(row => later[row.id] === undefined).length;
    const key = `${subject.kind}:${subject.id}`, current = out.get(key);
    out.set(key, { subject, waiting: (current?.waiting ?? 0) + waiting });
  }
  return out;
}

// ── Reads ────────────────────────────────────────────────────────────────
export function reviewSummary(ticket: object, roster: MemoryRoster): WaitingSummary {
  requireMemoryOwner(ticket);
  return waitingSummary(roster);
}

const PAGE = 100;
export function reviewList(ticket: object, roster: MemoryRoster, input: { subjectType: SubjectKind; subjectId: string; tab?: "waiting" | "later"; cursor?: string }) {
  requireMemoryOwner(ticket);
  const db = database();
  const groups = collect(db, roster, { only: { kind: input.subjectType, id: input.subjectId }, detail: true });
  const entries = [...(groups.get(`${input.subjectType}:${input.subjectId}`)?.entries ?? [])]
    .filter(entry => (input.tab === "later") === entry.later)
    .sort((a, b) => a.rank - b.rank || a.at - b.at || a.id.localeCompare(b.id));
  const start = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
  const page = entries.slice(start, start + PAGE);
  return { items: page, ...(start + PAGE < entries.length ? { nextCursor: String(start + PAGE) } : {}), summary: waitingSummary(roster) };
}

/** Where a memory came from, in plain words: a few short excerpts, never ids, hashes or byte ranges. */
export function reviewSources(ticket: object, roster: MemoryRoster, input: { id: string; version: number }) {
  requireMemoryOwner(ticket);
  const db = database(), index = indexRoster(roster);
  const rows = db.prepare(`SELECT s.speaker,s.thread_id,v.payload,e.start_byte,e.end_byte FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id AND s.revision=e.source_revision
    JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=? AND e.record_version=? LIMIT 5`).all(input.id, input.version);
  return {
    sources: rows.map(row => {
      let payload: { text?: string; occurredAt?: number } = {};
      try { payload = JSON.parse(String(row.payload)); } catch { /* an unreadable excerpt is shown as missing */ }
      const bytes = Buffer.from(payload.text ?? "").subarray(Number(row.start_byte), Number(row.end_byte)).toString("utf8").trim();
      const thread = row.thread_id === null ? "" : String(row.thread_id);
      const botId = index.botThread.get(thread), groupId = index.groupThread.get(thread);
      const speaker = String(row.speaker);
      return {
        where: groupId ? { kind: "room" as const, name: index.groups.get(groupId)!.name } : botId ? { kind: "chat" as const, name: index.bots.get(botId)!.name } : { kind: "other" as const, name: "" },
        who: speaker === "owner" || speaker.startsWith("person:") ? "you" as const : speaker === "tool" ? "tool" as const : "bot" as const,
        at: Number.isSafeInteger(payload.occurredAt) ? payload.occurredAt as number : null,
        excerpt: bytes.length > 400 ? `${bytes.slice(0, 399).trimEnd()}…` : bytes,
      };
    }),
  };
}

// ── Durable operations ───────────────────────────────────────────────────
interface ActionEvent { id: string; kind: string; detail: Record<string, any>; createdAt: number }
function actionEvent(db: DatabaseSync, recordId: string, actionId: string): ActionEvent | null {
  const rows = db.prepare("SELECT id,kind,detail,created_at FROM memory_learning_events WHERE record_id=? AND kind IN ('owner-keep','owner-undo') ORDER BY created_at DESC,rowid DESC LIMIT 40").all(recordId);
  for (const row of rows) {
    let detail: Record<string, any> = {};
    try { detail = JSON.parse(String(row.detail)); } catch { continue; }
    if (detail.actionId === actionId) return { id: String(row.id), kind: String(row.kind), detail, createdAt: Number(row.created_at) };
  }
  return null;
}
/** The stored result of an earlier call with this id, or null. The same id with another payload is refused. */
function replayOf(db: DatabaseSync, recordId: string, actionId: string, payload: string): Record<string, unknown> | null {
  const prior = actionEvent(db, recordId, actionId);
  if (!prior) return null;
  if (prior.detail.payload !== payload) throw fail("MEMORY_ACTION_REUSED");
  return prior.detail.result as Record<string, unknown>;
}

function subjectOfRecord(db: DatabaseSync, roster: MemoryRoster, scopeId: string): Subject | null {
  const scope = db.prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(scopeId) as { kind: string; owner_key: string } | undefined;
  return scope ? subjectOfScope(scope, indexRoster(roster)) : null;
}

/** Make a batch of waiting rows current. One data revision, one index nudge per row, ONE revocation call for the slice, and only for rows
 * something could have been derived from: a plain waiting row was never in a bundle, so there is nothing to end (AUDIT M3). */
function activateSlice(db: DatabaseSync, rows: Array<Record<string, any>>): void {
  const touched: string[] = [];
  for (const row of rows) {
    const changed = db.prepare("UPDATE memory_records SET state='active',owner_pinned=0 WHERE id=? AND version=? AND state='candidate'").run(row.id, row.version).changes;
    if (changed !== 1) throw fail("MEMORY_VERSION_CONFLICT");
    db.prepare("UPDATE memory_record_details SET confidence_basis='owner_confirmed' WHERE record_id=? AND record_version=? AND partition!='identity'").run(row.id, row.version);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL) ON CONFLICT(record_id,record_version,index_generation) DO UPDATE SET lexical_status='pending',embedding_status='pending',error=NULL").run(row.id, row.version);
    if (db.prepare("SELECT 1 FROM memory_derivations WHERE parent_id=? LIMIT 1").get(row.id)) touched.push(String(row.id));
  }
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
  if (touched.length) revokeRecordDisclosures(db, "review-keep", { recordIds: touched, viaSources: false });
}

function dropFromLater(db: DatabaseSync, ids: readonly string[]): void {
  const items = readLater(db);
  if (!ids.some(id => items[id] !== undefined)) return;
  for (const id of ids) delete items[id];
  writeLater(db, items);
}

function keepEvent(db: DatabaseSync, roster: MemoryRoster, row: Record<string, any>, detail: Record<string, unknown>): void {
  const subject = subjectOfRecord(db, roster, String(row.scope_id));
  recordLearningEvent(db, { kind: "owner-keep", scopeId: String(row.scope_id), recordId: String(row.id), recordVersion: Number(row.version), botId: subject?.kind === "bot" ? subject.id : null, detail: { ...detail, ruleVersion: ELIGIBILITY_RULE_VERSION } });
}

function candidateRow(db: DatabaseSync, id: string, version: number): Record<string, any> {
  const row = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(id, version);
  if (!row) throw fail("MEMORY_NOT_FOUND", 404);
  if (row.state !== "candidate") throw fail("MEMORY_VERSION_CONFLICT");
  if (isPipKind(row.kind)) throw fail("MEMORY_IDENTITY_PIP_USE_CONTINUITY", 400);
  return row;
}

/** Keep one waiting memory. A correction of a pinned fact still needs the owner's pin choice. */
function keepOne(db: DatabaseSync, roster: MemoryRoster, ticket: object, input: { actionId: string; id: string; version: number; correctionPin?: CorrectionPinChoice }, payload: string): Record<string, unknown> {
  const prior = replayOf(db, input.id, input.actionId, payload);
  if (prior) return prior;
  const row = candidateRow(db, input.id, input.version);
  if (row.supersedes_id) {
    approveMemory(ticket, input.id, input.version, input.correctionPin ? { correctionPin: input.correctionPin } : {});
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL) ON CONFLICT(record_id,record_version,index_generation) DO UPDATE SET lexical_status='pending',embedding_status='pending',error=NULL").run(input.id, input.version);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
  } else {
    activateSlice(db, [row]);
  }
  const result = { status: "kept" as const, id: input.id, version: input.version };
  keepEvent(db, roster, row, { actionId: input.actionId, batchId: input.actionId, reviewedVersion: input.version, payload, result });
  dropFromLater(db, [input.id]);
  return result;
}

export function reviewKeep(ticket: object, roster: MemoryRoster, input: { actionId: string; id: string; version: number; correctionPin?: CorrectionPinChoice }) {
  requireMemoryOwner(ticket);
  const payload = hashOf({ a: "keep", id: input.id, version: input.version, pin: input.correctionPin ?? null });
  const result = transaction(db => keepOne(db, roster, ticket, input, payload));
  return { result, summary: waitingSummary(roster) };
}

/** Keep every item on the list the owner was shown, if it is still eligible when this commits. Slices of 25, one revocation each, per-item results. */
export function reviewKeepAll(ticket: object, roster: MemoryRoster, input: { actionId: string; items: Array<{ id: string; version: number }> }) {
  requireMemoryOwner(ticket);
  const seen = new Set<string>(), items = input.items.filter(item => !seen.has(item.id) && seen.add(item.id));
  const results: ItemResult[] = [], decisions: Eligibility[] = [];
  for (let at = 0; at < items.length; at += SLICE) {
    const slice = items.slice(at, at + SLICE);
    transaction(db => {
      const ready: Array<Record<string, any>> = [];
      for (const item of slice) {
        const payload = hashOf({ a: "keep-all", id: item.id, version: item.version });
        const prior = replayOf(db, item.id, input.actionId, payload);
        if (prior) { results.push(prior as unknown as ItemResult); continue; }
        const row = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(item.id, item.version);
        if (!row || row.state !== "candidate") { results.push({ id: item.id, version: item.version, status: row ? "changed" : "gone" }); continue; }
        const decision = memoryEligibility(db, row as unknown as EligibilityRow);
        decisions.push(decision);
        if (decision.decision === "refuse") { results.push({ id: item.id, version: item.version, status: "gone", reasons: decision.reasons }); continue; }
        if (decision.decision === "ask") { results.push({ id: item.id, version: item.version, status: "needs-you", reasons: decision.reasons }); continue; }
        ready.push(row);
      }
      if (!ready.length) return;
      activateSlice(db, ready);
      for (const row of ready) {
        const result: ItemResult = { status: "kept", id: String(row.id), version: Number(row.version) };
        keepEvent(db, roster, row, { actionId: input.actionId, batchId: input.actionId, reviewedVersion: Number(row.version), payload: hashOf({ a: "keep-all", id: row.id, version: row.version }), result });
        results.push(result);
      }
      dropFromLater(db, ready.map(row => String(row.id)));
    });
  }
  if (decisions.length) console.info(eligibilityLine(decisions));
  const order = new Map(items.map((item, position) => [item.id, position]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { batchId: input.actionId, results, kept: results.filter(item => item.status === "kept").length, summary: waitingSummary(roster) };
}

/** Not now: the item stays waiting for the owner but leaves the count, stored in the Later row. No expiry, no reminder. */
export function reviewLater(ticket: object, roster: MemoryRoster, input: { actionId: string; id: string; version: number }) {
  requireMemoryOwner(ticket);
  const result = transaction(db => {
    candidateRow(db, input.id, input.version);
    const items = readLater(db);
    if (items[input.id]?.actionId === input.actionId || items[input.id]) return { status: "later" as const, id: input.id, version: input.version };
    if (Object.keys(items).length >= LATER_CAP) throw fail("MEMORY_LATER_FULL");
    items[input.id] = { version: input.version, at: Date.now(), actionId: input.actionId };
    writeLater(db, items);
    return { status: "later" as const, id: input.id, version: input.version };
  });
  return { result, summary: waitingSummary(roster) };
}

export function reviewBack(ticket: object, roster: MemoryRoster, input: { id: string }) {
  requireMemoryOwner(ticket);
  transaction(db => dropFromLater(db, [input.id]));
  return { result: { status: "waiting" as const, id: input.id }, summary: waitingSummary(roster) };
}

/** Save new words as a new WAITING version of the same memory. Editing alone never keeps. */
function saveWaitingVersion(db: DatabaseSync, row: Record<string, any>, text: string): number {
  const latest = db.prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(row.id);
  if (Number(latest?.version) !== row.version) throw fail("MEMORY_VERSION_CONFLICT");
  const next = row.version + 1, now = Date.now();
  db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=? AND state='candidate'").run(now, row.id, row.version);
  db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement','candidate',0,?,NULL,?,?)")
    .run(row.id, next, row.scope_id, row.kind, redactSecretsInText(text), now, row.supersedes_id ?? null, row.created_at);
  db.prepare("INSERT INTO memory_evidence SELECT record_id,?,source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").run(next, row.id, row.version);
  db.prepare("INSERT INTO memory_derivations SELECT parent_id,parent_version,child_id,? FROM memory_derivations WHERE child_id=? AND child_version=?").run(next, row.id, row.version);
  db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(row.id, row.version, row.id, next);
  return next;
}

/** Edit a waiting memory (and optionally keep it): two steps under one action id, in one transaction. */
export function reviewEdit(ticket: object, roster: MemoryRoster, input: { actionId: string; id: string; version: number; text: string; keep?: boolean; correctionPin?: CorrectionPinChoice }) {
  requireMemoryOwner(ticket);
  const text = input.text.trim();
  if (!text || text.length > 4096) throw fail("INVALID_MEMORY_TEXT", 400);
  const payload = hashOf({ a: input.keep ? "edit-keep" : "edit", id: input.id, version: input.version, text, pin: input.correctionPin ?? null });
  const result = transaction(db => {
    const prior = input.keep ? replayOf(db, input.id, input.actionId, payload) : null;
    if (prior) return prior;
    const latest = db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(input.id);
    // A saved edit that is retried finds its own words already waiting as the next version.
    if (!input.keep && latest && latest.version === input.version + 1 && latest.state === "candidate" && latest.assertion === "owner-statement" && latest.text === redactSecretsInText(text))
      return { status: "edited" as const, id: input.id, version: Number(latest.version) };
    const row = candidateRow(db, input.id, input.version);
    const next = saveWaitingVersion(db, row, text);
    if (!input.keep) return { status: "edited" as const, id: input.id, version: next };
    const saved = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(input.id, next)!;
    if (saved.supersedes_id) {
      approveMemory(ticket, input.id, next, input.correctionPin ? { correctionPin: input.correctionPin } : {});
      db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL) ON CONFLICT(record_id,record_version,index_generation) DO UPDATE SET lexical_status='pending',embedding_status='pending',error=NULL").run(input.id, next);
      db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    } else activateSlice(db, [saved]);
    const kept = { status: "kept" as const, id: input.id, version: next };
    keepEvent(db, roster, saved, { actionId: input.actionId, batchId: input.actionId, reviewedVersion: input.version, editedTo: next, payload, result: kept });
    dropFromLater(db, [input.id]);
    return kept;
  });
  return { result, summary: waitingSummary(roster) };
}

/** Whether any recent receipt names this record. Receipts are appended in rowid order, so the newest ones are an indexed range; a busy window we cannot clear reads as "yes". */
function citedSince(db: DatabaseSync, id: string, since: number): boolean {
  const top = Number(db.prepare("SELECT max(rowid) AS n FROM memory_disclosures").get()?.n ?? 0);
  if (!top) return false;
  const rows = db.prepare("SELECT created_at,record_versions FROM memory_disclosures WHERE rowid>? ORDER BY rowid").all(top - 200);
  if (rows.length >= 200 && Number(rows[0].created_at) >= since) return true;
  return rows.some(row => Number(row.created_at) >= since && String(row.record_versions).includes(id));
}

/** Undo of a keep. Back to waiting only while the keep is still the last thing that happened to the item and no receipt cites it; otherwise the item is archived. */
export function reviewUndo(ticket: object, roster: MemoryRoster, input: { actionId: string; keepActionId: string; id: string; version: number }) {
  requireMemoryOwner(ticket);
  const payload = hashOf({ a: "undo", id: input.id, version: input.version, keep: input.keepActionId });
  const result = transaction(db => {
    const prior = replayOf(db, input.id, input.actionId, payload);
    if (prior) return prior;
    const kept = actionEvent(db, input.id, input.keepActionId);
    if (!kept || kept.kind !== "owner-keep") throw fail("MEMORY_UNDO_UNAVAILABLE");
    const row = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(input.id, Number(kept.detail.result?.version ?? input.version));
    if (!row || row.state !== "active") throw fail("MEMORY_VERSION_CONFLICT");
    const last = db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(input.id);
    const unchanged = last?.id === kept.id && !row.supersedes_id && row.owner_pinned === 0 && !citedSince(db, input.id, kept.createdAt);
    let outcome: "waiting" | "archived";
    if (unchanged) {
      db.prepare("UPDATE memory_records SET state='candidate' WHERE id=? AND version=?").run(row.id, row.version);
      db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(row.id, row.version);
      db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
      outcome = "waiting";
    } else {
      archiveMemoryRecord(ticket, String(row.id), Number(row.version));
      console.info("[memory] undo archived: kept item changed or was recalled since; historical recall still applies");
      outcome = "archived";
    }
    const subject = subjectOfRecord(db, roster, String(row.scope_id));
    const done = { status: outcome, id: String(row.id), version: Number(row.version) };
    recordLearningEvent(db, { kind: "owner-undo", scopeId: String(row.scope_id), recordId: String(row.id), recordVersion: Number(row.version), botId: subject?.kind === "bot" ? subject.id : null,
      detail: { actionId: input.actionId, undoes: input.keepActionId, payload, result: done, ruleVersion: ELIGIBILITY_RULE_VERSION } });
    return done;
  });
  return { result, summary: waitingSummary(roster) };
}

export { evidenceStillThere };
