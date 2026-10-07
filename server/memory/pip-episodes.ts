// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 episodes (design 1.2): short summaries the bot wrote of earlier conversations. Recall only, summary
// attribution, never grounding. A deterministic gate decides what is kept; a day with owner turns and no
// episode gets a trace episode built from thread titles and turn counts with no model.
import type { DatabaseSync } from "node:sqlite";
import { redactSecretsInText } from "../redact.ts";
import { invalidatePipRender } from "./identity.ts";
import { pipEpisodeId } from "./pip-kinds.ts";
import type { AdmittedSource } from "./pip-admission.ts";

export const EPISODE_MAX_BYTES = 700;
export const TRACE_MAX_BYTES = 300;
export const EPISODE_MIN_HANDLES = 3;
export const EPISODE_MAX_HANDLES = 12;
export const EPISODE_MIN_BYTES = 40;
const SCAN_CAP = 200;
export const EPISODE_BASIS = "pip:summary; A summary the bot wrote of an earlier conversation";

const PLATITUDES = [/^\s*(we|they|the (user|owner)) (had|have) (a )?(nice|good|great|pleasant|productive) (chat|conversation|talk|discussion)\b/i, /\bas an ai\b/i, /\bi (cannot|can't) (help|assist)\b/i, /\bnothing (of note|to report)\b/i, /\bthe conversation (covered|was about) various (topics|things)\b/i];
const BROKEN = [/^\s*[{\[]/, /\b(undefined|null|NaN)\b/, /```/, /(.)\1{9,}/, /<\/?[a-z][^>]*>/i, /—/];

/** Deterministic quality gate. Returns null when the text passes, else the reason. */
export function episodeGate(text: string): string | null {
  const bytes = Buffer.byteLength(text);
  if (bytes < EPISODE_MIN_BYTES) return "too-short";
  if (bytes > EPISODE_MAX_BYTES) return "too-long";
  if (PLATITUDES.some(p => p.test(text))) return "platitude";
  if (BROKEN.some(p => p.test(text))) return "broken-output";
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length < 6) return "too-short";
  if (new Set(words).size / words.length < 0.4) return "repetitive";
  return null;
}

interface Handle { sourceId: string; revision: number; start: number; end: number }

function write(db: DatabaseSync, o: { botId: string; scopeId: string; id: string; text: string; entities: string[]; handles: Handle[] }): boolean {
  if (db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(o.id)) return false; // idempotent by thread + closing message
  const now = Date.now();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'episode',?,'assistant-inference','active',0,?,NULL,NULL,?)").run(o.id, o.scopeId, redactSecretsInText(o.text), now, now);
  db.prepare("UPDATE memory_record_details SET partition='identity',attention='useful',confidence_basis=?,entities=? WHERE record_id=? AND record_version=1").run(EPISODE_BASIS, JSON.stringify(o.entities), o.id);
  for (const h of o.handles) db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(o.id, h.sourceId, h.revision, h.start, h.end);
  invalidatePipRender(db, o.botId);
  return true;
}

/** I-24: no em dash reaches a PIP string. */
const noDashes = (t: string) => t.replace(/\s*[\u2014\u2013]\s*/g, " - ");
const handleOf = (a: AdmittedSource): Handle => ({ sourceId: a.sourceId, revision: a.revision, start: 0, end: Math.max(1, Buffer.byteLength(a.text)) });

/** A model-written episode. At least three and at most twelve owner turns of the thread rest it. */
export function writeEpisode(db: DatabaseSync, o: { botId: string; scopeId: string; threadId: string; closingMessageId: string; day?: number; text: string; handles: readonly Handle[] }): { written: boolean; reason?: string } {
  const distinct = [...new Map(o.handles.map(h => [h.sourceId, h])).values()].slice(0, EPISODE_MAX_HANDLES);
  if (distinct.length < EPISODE_MIN_HANDLES) return { written: false, reason: "too-few-turns" };
  const text = noDashes(o.text).trim(), reason = episodeGate(text);
  if (reason) return { written: false, reason };
  const written = write(db, { botId: o.botId, scopeId: o.scopeId, id: pipEpisodeId(o.botId, o.threadId, o.closingMessageId), text, entities: [o.threadId, o.closingMessageId, ...(o.day === undefined ? [] : ["day:" + dayKey(o.day)])], handles: distinct });
  return { written };
}

const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Sable section 6. A day with at least one admissible owner turn and no episode still leaves a mark: a
 * deterministic line of thread titles and turn counts, flagged `trace`. No model, at most 300 bytes. */
export function writeTraceEpisode(db: DatabaseSync, o: { botId: string; scopeId: string; day: number; byThread: ReadonlyArray<{ threadId: string; title: string; turns: readonly AdmittedSource[] }> }): { written: boolean; reason?: string } {
  const day = dayKey(o.day);
  const turns = o.byThread.flatMap(t => t.turns);
  if (!turns.length) return { written: false, reason: "no-turns" };
  const start = new Date(o.day); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  // Older model episodes have no day marker: their latest evidence supplies the represented day.
  const existing = db.prepare(`SELECT 1 FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    WHERE r.scope_id=? AND r.kind='episode' AND r.state='active' AND (json_extract(d.entities,'$[2]')=? OR
      (json_extract(d.entities,'$[2]') IS NULL AND (SELECT MAX(CAST(json_extract(v.payload,'$.occurredAt') AS INTEGER))
        FROM memory_evidence e JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
        WHERE e.record_id=r.id AND e.record_version=r.version) BETWEEN ? AND ?)) LIMIT 1`).get(o.scopeId, "day:" + day, start.getTime(), end.getTime() - 1);
  if (existing) return { written: false, reason: "day-has-episode" };
  const parts = o.byThread.filter(t => t.turns.length).map(t => `${t.turns.length} ${t.turns.length === 1 ? "message" : "messages"} in "${noDashes(t.title).replace(/\s+/g, " ").slice(0, 40)}"`);
  let text = `On ${day} we talked: ${parts.join(", ")}.`;
  while (Buffer.byteLength(text) > TRACE_MAX_BYTES && parts.length > 1) { parts.pop(); text = `On ${day} we talked: ${parts.join(", ")}.`; }
  if (Buffer.byteLength(text) > TRACE_MAX_BYTES) text = Buffer.from(text).subarray(0, TRACE_MAX_BYTES - 1).toString("utf8").replace(/�+$/, "") + ".";
  const handles = turns.slice(-EPISODE_MAX_HANDLES).map(handleOf);
  const first = o.byThread.find(t => t.turns.length)!;
  const written = write(db, { botId: o.botId, scopeId: o.scopeId, id: pipEpisodeId(o.botId, "trace", day), text, entities: [first.threadId, "trace", "day:" + day], handles });
  return { written };
}

export interface EpisodeHit { id: string; version: number; text: string }
const terms = (q: string) => [...new Set(q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 20);

/** A bounded lexical scan over this bot's active episodes. Merged after searchMemory by the bundle, cap 3. */
export function episodeHits(db: DatabaseSync, botId: string, query: string, options: { limit?: number; cap?: number } = {}): EpisodeHit[] {
  const t = terms(query);
  if (!t.length) return [];
  const rows = db.prepare(`SELECT r.id,r.version,r.text,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='episode' AND r.state='active' AND s.kind='bot' AND s.owner_key=? ORDER BY r.created_at DESC,r.id LIMIT ?`).all(botId, options.cap ?? SCAN_CAP);
  const scored: Array<EpisodeHit & { score: number }> = [];
  for (const r of rows) {
    let entities: unknown[] = [];
    try { entities = JSON.parse(String(r.entities)); } catch { /* none */ }
    if (entities.includes("retired-time")) continue;
    const text = String(r.text), lower = text.normalize("NFKC").toLowerCase();
    const score = t.filter(x => lower.includes(x)).length / t.length;
    if (score > 0) scored.push({ id: String(r.id), version: Number(r.version), text, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.limit ?? 3).map(({ score: _s, ...hit }) => hit);
}

/** Owner view: this bot's episodes by recency (the Self tab and, from P3, memory_self episodes). */
export function listEpisodes(db: DatabaseSync, botId: string, limit = 20): Array<{ id: string; version: number; text: string; at: number; trace: boolean }> {
  return db.prepare(`SELECT r.id,r.version,r.text,r.created_at,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='episode' AND r.state='active' AND s.kind='bot' AND s.owner_key=? ORDER BY r.created_at DESC,r.id LIMIT ?`).all(botId, limit)
    .map(r => ({ id: String(r.id), version: Number(r.version), text: String(r.text), at: Number(r.created_at), trace: String(r.entities).includes('"trace"') }));
}
