// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP admission (design 3.1 "Two admission branches", I-1, I-2): which captured sources may ground or occasion
// a lived row. Owner turns and completed actions only; bot turns, tool failures and every memory_records row
// are never admitted. Re-exported from pip-reflect.ts.
import type { DatabaseSync } from "node:sqlite";
import { turnAudienceIsOwner } from "../owner-audience.ts";
import { isLearnableSource } from "./learnable.ts";
import { learningSourceBot } from "./learning-guard.ts";
import { threadMemoryRoom } from "./capture-scope.ts";

export interface AdmittedSource {
  kind: "owner" | "action";
  sourceId: string; revision: number; messageId: string | null; threadId: string;
  /** The bytes a quote may point into: the message text, or for an action the label. */
  text: string;
  occurredAt: number;
}
export interface SpanQuery {
  threadId: string;
  /** Exclusive cursor: only sources after this (occurredAt, messageId). */
  afterAt?: number; afterMessageId?: string | null;
  /** Inclusive upper bound by occurredAt. */
  untilAt?: number;
  excludedThreads?: readonly string[];
  limit?: number;
}

const after = (at: number, id: string | null, q: SpanQuery) => {
  if (q.afterAt !== undefined && (at < q.afterAt || (at === q.afterAt && (id ?? "") <= (q.afterMessageId ?? "")))) return false;
  if (q.untilAt !== undefined && at > q.untilAt) return false;
  return true;
};

/** The thread belongs to this bot's own direct conversation (not a room or desk) and is not excluded. */
export function threadIsBotsOwn(botId: string, threadId: string, excluded: readonly string[] = []): boolean {
  if (excluded.includes(threadId)) return false;
  if (threadMemoryRoom(threadId) !== null) return false;
  return learningSourceBot(threadId)?.id === botId;
}

function rows(db: DatabaseSync, q: SpanQuery, kind: "text" | "tool-outcome") {
  return db.prepare(`SELECT s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,v.payload FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.thread_id=? AND s.kind=? AND s.state='active'`).all(q.threadId, kind);
}
const sourceTombstoned = (db: DatabaseSync, id: string, revision: number) =>
  Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, revision));

/** I-1. speaker owner, kind text, learnable (attended or verified-owner channel origin), this bot's own thread. */
export function admissibleOwnerSources(db: DatabaseSync, botId: string, q: SpanQuery): AdmittedSource[] {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  const out: AdmittedSource[] = [];
  for (const r of rows(db, q, "text")) {
    if (r.speaker !== "owner") continue;
    let payload: { text?: unknown; occurredAt?: unknown };
    try { payload = JSON.parse(String(r.payload)); } catch { continue; }
    if (typeof payload.text !== "string") continue;
    const at = Number.isSafeInteger(payload.occurredAt) ? Number(payload.occurredAt) : 0;
    if (!after(at, r.message_id === null ? null : String(r.message_id), q)) continue;
    if (!isLearnableSource(db, String(r.id), Number(r.revision)).learnable) continue;
    out.push({ kind: "owner", sourceId: String(r.id), revision: Number(r.revision), messageId: r.message_id === null ? null : String(r.message_id), threadId: q.threadId, text: payload.text, occurredAt: at });
  }
  out.sort((a, b) => a.occurredAt - b.occurredAt || (a.messageId ?? "").localeCompare(b.messageId ?? ""));
  return q.limit ? out.slice(0, q.limit) : out;
}

/** I-2. A completed tool outcome from this bot's own thread; the grounding bytes are the action label. */
export function admissibleActionSources(db: DatabaseSync, botId: string, q: SpanQuery): AdmittedSource[] {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return [];
  const out: AdmittedSource[] = [];
  for (const r of rows(db, q, "tool-outcome")) {
    if (r.speaker !== "tool" || r.outcome !== "completed") continue;
    if (sourceTombstoned(db, String(r.id), Number(r.revision))) continue;
    let payload: { occurredAt?: unknown; action?: { label?: unknown } };
    try { payload = JSON.parse(String(r.payload)); } catch { continue; }
    const label = payload.action?.label;
    if (typeof label !== "string" || !label) continue;
    const at = Number.isSafeInteger(payload.occurredAt) ? Number(payload.occurredAt) : 0;
    if (!after(at, r.message_id === null ? null : String(r.message_id), q)) continue;
    out.push({ kind: "action", sourceId: String(r.id), revision: Number(r.revision), messageId: r.message_id === null ? null : String(r.message_id), threadId: q.threadId, text: label, occurredAt: at });
  }
  out.sort((a, b) => a.occurredAt - b.occurredAt || (a.messageId ?? "").localeCompare(b.messageId ?? ""));
  return q.limit ? out.slice(0, q.limit) : out;
}

/** Re-check one grounding handle: used inside the confirm transaction (I-1) and before an episode is written. */
export function ownerSourceStillAdmissible(db: DatabaseSync, botId: string, sourceId: string, revision: number, excluded: readonly string[] = []): boolean {
  const row = db.prepare("SELECT thread_id,speaker,kind,revision,state FROM memory_sources WHERE id=?").get(sourceId);
  if (!row || row.state !== "active" || Number(row.revision) !== revision || row.kind !== "text" || row.speaker !== "owner") return false;
  if (!threadIsBotsOwn(botId, String(row.thread_id), excluded)) return false;
  return isLearnableSource(db, sourceId, revision).learnable;
}

/** The exact bytes `[start, end)` of a source's text, or null when the span is not on code point boundaries or out of range. */
export function boundQuote(text: string, start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  const bytes = Buffer.from(text, "utf8");
  if (end > bytes.length) return null;
  const continuation = (i: number) => i < bytes.length && (bytes[i] & 0xc0) === 0x80;
  if (continuation(start) || continuation(end)) return null;
  return bytes.subarray(start, end).toString("utf8");
}
