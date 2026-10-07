// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { learningLocalPath } from "../bot-learning.ts";
import { DATA_DIR } from "../config.ts";
import { cascadeLineageForget, forgetLineageOfBot } from "./lesson-lineage.ts";

/** Offline-safe cleanup of evaluation copies, shared by live forgetting and
 * restore. Original cost/digest receipts survive; copied response text does not. */
export function purgeForgottenEvolutionCopies(db: DatabaseSync): void {
  const sourceForgotten = db.prepare("SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_sources WHERE id=? AND state='deleted') OR EXISTS(SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?))");
  const recordForgotten = db.prepare("SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_records WHERE id=? AND version=? AND state='deleted') OR EXISTS(SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?))");
  const rows = db.prepare("SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('gepa-job','procedure-review-pending','procedure-review','procedure-evaluation-preview','procedure-evaluation-grant','procedure-evaluation-session')").all();
  for (const row of rows) {
    let value: Record<string, any>;
    try { value = JSON.parse(String(row.intent)); } catch { value = {}; }
    const refs = [...(Array.isArray(value.evidence) ? value.evidence : []), ...(Array.isArray(value.snapshot?.evidence) ? value.snapshot.evidence : [])];
    const invalid = row.state === "revoked" || value.revoked === true || !Array.isArray(value.evidence) || refs.some(ref => {
      if (!ref || typeof ref.id !== "string" || !Number.isSafeInteger(ref.revision)) return true;
      if (ref.kind === "source") return Boolean(sourceForgotten.get(ref.id, ref.id, ref.revision));
      if (ref.kind === "record") return Boolean(recordForgotten.get(ref.id, ref.revision, ref.id, ref.revision));
      return true;
    });
    if (!invalid) continue;
    if (row.subject_id === "gepa-job") {
      for (const call of db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").all(String(row.id))) {
        let receipt: Record<string, unknown>;
        try { receipt = JSON.parse(String(call.intent)); } catch { receipt = {}; }
        const { value: _copiedResponse, ...metadata } = receipt;
        db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...metadata, state: "revoked" }), String(call.id));
      }
      db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...value, evidence: [], revoked: true }), String(row.id));
    } else if (row.subject_id === "procedure-evaluation-preview" || row.subject_id === "procedure-evaluation-grant" || row.subject_id === "procedure-evaluation-session") {
      db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...value, evidence: [], revoked: true, reason: "MEMORY_EVIDENCE_FORGOTTEN" }), String(row.id));
    } else {
      // proposedText, beforeText and editedText are suggestion words (B7c) that came from the evidence.
      const { snapshot: _snapshot, receipt: _receipt, trigger: _trigger, proposedText: _proposed, beforeText: _before, editedText: _edited, ...metadata } = value;
      db.prepare("UPDATE memory_scope_bindings SET subject_id='procedure-review',state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...metadata, evidence: [], status: "cancelled", reason: "MEMORY_EVIDENCE_FORGOTTEN" }), String(row.id));
    }
  }
  purgeForgottenLearning(db);
}

const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));

/** Ids and message ids of every source that is deleted, tombstoned or sits in a
 * thread the owner excluded from learning. */
function forgottenSources(db: DatabaseSync) {
  const rows = db.prepare(`SELECT s.id,s.message_id,s.thread_id,
      (s.state='deleted' OR EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id)) AS gone,
      EXISTS(SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=s.thread_id) AS excluded
    FROM memory_sources s WHERE s.state='deleted'
      OR EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id)
      OR EXISTS(SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=s.thread_id)`).all();
  const ids = new Set<string>(), messages = new Set<string>(), threads = new Set<string>();
  for (const row of rows) {
    ids.add(String(row.id));
    if (typeof row.message_id === "string") messages.add(row.message_id);
    if (row.excluded && typeof row.thread_id === "string") threads.add(row.thread_id);
  }
  return { ids, messages, threads };
}

/** Evidence lists name sources as {kind:"source",id}, {sourceId} or {messageId}. */
function evidenceForgotten(json: unknown, forgotten: ReturnType<typeof forgottenSources>): boolean {
  let value: unknown;
  try { value = typeof json === "string" ? JSON.parse(json) : null; } catch { return false; }
  // B2's feedback evidence is one object {feedbackId, phrase, messageId, action}; the source lists are arrays.
  const single = value && typeof value === "object" && !Array.isArray(value) && ("messageId" in value || "sourceId" in value || "feedbackId" in value);
  const list = single ? [value] : Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  return list.some(item => {
    if (!item || typeof item !== "object") return false;
    const ref = item as Record<string, unknown>;
    return (typeof ref.id === "string" && (ref.kind === undefined || ref.kind === "source") && forgotten.ids.has(ref.id))
      || (typeof ref.sourceId === "string" && forgotten.ids.has(ref.sourceId))
      || (typeof ref.messageId === "string" && forgotten.messages.has(ref.messageId));
  });
}

/** Forgetting a source removes what was learned from it (design 11):
 * - pending learning runs for an affected bot are cancelled and drop their digests;
 * - active lessons that lost their evidence become `unsupported` (the owner decides);
 * - suggestions and unconfirmed lessons become `stale` with their text removed;
 * - feedback on a forgotten message loses its correction text and expires;
 * - episodes that include a forgotten message or sit in an excluded thread stop
 *   being eligible. Idempotent; runs on live forgetting and on restore. */
export function purgeForgottenLearning(db: DatabaseSync, now = Date.now()): { lessons: number; feedback: number; episodes: number; runs: number } {
  if (!hasTable(db, "memory_lessons")) return { lessons: 0, feedback: 0, episodes: 0, runs: 0 };
  const forgotten = forgottenSources(db);
  if (!forgotten.ids.size) return { lessons: 0, feedback: 0, episodes: 0, runs: 0 };
  return purgeLearningFor(db, forgotten, now);
}

type Forgotten = ReturnType<typeof forgottenSources>;
/** Prospect-derived lessons live in learning-local/<bot>/lessons/<id>.json; one that rested on a forgotten message goes too (T1-16d). */
function purgeLearningLocal(forgotten: Forgotten, dataDir: string): void {
  const root = learningLocalPath(dataDir);
  if (!existsSync(root)) return;
  for (const bot of readdirSync(root)) {
    if (!SAFE_SEGMENT.test(bot)) continue;
    const dir = join(root, bot, "lessons");
    let files: string[];
    try { files = readdirSync(dir).filter(file => file.endsWith(".json")); } catch { continue; }
    for (const file of files) {
      try {
        const lesson = JSON.parse(readFileSync(join(dir, file), "utf8")) as { evidence?: unknown };
        if (evidenceForgotten(JSON.stringify(lesson.evidence ?? null), forgotten)) rmSync(join(dir, file), { force: true });
      } catch { /* a damaged file is not a lesson */ }
    }
  }
}
/** Deleting a conversation forgets what was learned from it, even when no memory
 * source was ever captured for it (memory off, or capture paused). Owner-typed
 * text in memory_feedback.correction and memory_outcomes.reason/label goes with
 * it. Runs inside the delete's own transaction, before the messages go. */
export function purgeThreadLearning(db: DatabaseSync, threadId: string, now = Date.now()): void {
  if (!hasTable(db, "memory_lessons")) return;
  const messages = new Set(hasTable(db, "messages") ? (db.prepare("SELECT id FROM messages WHERE thread_id=?").all(threadId) as Array<{ id: unknown }>).map(row => String(row.id)) : []);
  purgeLearningFor(db, { ids: new Set<string>(), messages, threads: new Set([threadId]) }, now);
}

function purgeLearningFor(db: DatabaseSync, forgotten: Forgotten, now: number, dataDir = DATA_DIR): { lessons: number; feedback: number; episodes: number; runs: number } {
  const done = { lessons: 0, feedback: 0, episodes: 0, runs: 0 };
  const affectedBots = new Set<string>();
  const inThreads = (thread: unknown) => typeof thread === "string" && forgotten.threads.has(thread);
  for (const row of db.prepare("SELECT id,version,bot_id,state,evidence FROM memory_lessons WHERE state IN ('active','suggested') OR (state='retired' AND spec IS NOT NULL)").all()) {
    if (!evidenceForgotten(row.evidence, forgotten)) continue;
    const active = row.state === "active";
    // An unsupported lesson leaves the prompt and loses its words with the evidence it rested on (T1-16a).
    db.prepare(active ? "UPDATE memory_lessons SET state='unsupported',kind='note',spec=NULL,where_=NULL,text='',evidence=NULL,decided_at=? WHERE id=? AND version=?" : "UPDATE memory_lessons SET state='stale',kind='note',spec=NULL,where_=NULL,text='',evidence=NULL,decided_at=? WHERE id=? AND version=?").run(now, String(row.id), Number(row.version));
    affectedBots.add(String(row.bot_id)); done.lessons++;
    // Lineage (B11): what was shared from this lesson leaves the recipients too.
    done.lessons += cascadeLineageForget(db, String(row.id), now);
  }
  for (const row of db.prepare("SELECT id,bot_id,thread_id,message_id,target_message_id,state,correction FROM memory_feedback WHERE state!='expired' OR correction IS NOT NULL").all()) {
    const hit = [row.message_id, row.target_message_id].some(id => typeof id === "string" && forgotten.messages.has(id)) || inThreads(row.thread_id);
    if (!hit) continue;
    db.prepare("UPDATE memory_feedback SET state='expired',correction=NULL WHERE id=?").run(String(row.id));
    affectedBots.add(String(row.bot_id)); done.feedback++;
  }
  // Owner-typed text on an outcome mark (the reason, a proposal's note) goes; the mark's count stays.
  for (const row of db.prepare("SELECT id,bot_id,thread_id,source_event_key FROM memory_outcomes WHERE reason IS NOT NULL OR label IS NOT NULL").all()) {
    const key = typeof row.source_event_key === "string" ? row.source_event_key : "";
    const message = key.split("#")[0]!.replace(/^(?:mark|proposal):/, "");
    if (!(inThreads(row.thread_id) || (message && forgotten.messages.has(message)))) continue;
    db.prepare("UPDATE memory_outcomes SET reason=NULL,label=NULL WHERE id=?").run(String(row.id));
    affectedBots.add(String(row.bot_id));
  }
  // Reply snippets kept in the ledger for chips (detail.label) go with the conversation or message they came from (T1-16c).
  for (const row of db.prepare("SELECT id,json_extract(detail,'$.threadId') AS thread,json_extract(detail,'$.replyMessageId') AS reply FROM memory_learning_events WHERE json_extract(detail,'$.label') IS NOT NULL").all()) {
    if (!(inThreads(row.thread) || (typeof row.reply === "string" && forgotten.messages.has(row.reply)))) continue;
    db.prepare("UPDATE memory_learning_events SET detail=json_remove(detail,'$.label') WHERE id=?").run(String(row.id));
  }
  purgeLearningLocal(forgotten, dataDir);
  for (const row of db.prepare("SELECT id,bot_id,thread_id,start_message_id,end_message_id,source_revisions FROM memory_episodes WHERE excluded_at IS NULL").all()) {
    const hit = inThreads(row.thread_id) || [row.start_message_id, row.end_message_id].some(id => typeof id === "string" && forgotten.messages.has(id)) || evidenceForgotten(row.source_revisions, forgotten);
    if (!hit) continue;
    db.prepare("UPDATE memory_episodes SET eligible=0,excluded_at=? WHERE id=?").run(now, String(row.id));
    affectedBots.add(String(row.bot_id)); done.episodes++;
  }
  for (const row of db.prepare("SELECT id,bot_id FROM memory_learning_runs WHERE finished_at IS NULL").all()) {
    if (!affectedBots.has(String(row.bot_id))) continue;
    db.prepare("UPDATE memory_learning_runs SET state='cancelled',reason='MEMORY_EVIDENCE_FORGOTTEN',corpus_digest=NULL,holdout_digest=NULL,holdout_groups=NULL,finished_at=? WHERE id=?").run(now, String(row.id));
    done.runs++;
  }
  return done;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function learningLocalBotDir(dataDir: string, botId: string): string {
  if (!SAFE_SEGMENT.test(botId) || botId.includes("..")) throw new Error("INVALID_BOT_ID");
  return learningLocalPath(dataDir, botId);
}

/** "Forget this learning data" for one bot: purges every derived row and the
 * bot's learning-local folder. The conversations themselves are untouched. */
export function forgetBotLearningData(db: DatabaseSync, dataDir: string, botId: string): { rows: number; localRemoved: boolean } {
  const dir = learningLocalBotDir(dataDir, botId);
  let rows = 0;
  if (hasTable(db, "memory_lessons")) {
    forgetLineageOfBot(db, botId, Date.now()); // copies this bot handed to other bots go with it
    for (const table of ["memory_outcomes", "memory_feedback", "memory_lessons", "memory_episodes", "memory_learning_runs", "memory_backfill_cursors"]) rows += Number(db.prepare(`DELETE FROM ${table} WHERE bot_id=?`).run(botId).changes);
    // The ledger holds reply snippets and the suggestion rows hold skill and routine words: both are this bot's learning data (T1-16c).
    if (hasTable(db, "memory_learning_events")) rows += Number(db.prepare("DELETE FROM memory_learning_events WHERE bot_id=?").run(botId).changes);
    rows += Number(db.prepare("DELETE FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('procedure-review-pending','procedure-review') AND json_extract(intent,'$.botId')=?").run(botId).changes);
  }
  const localRemoved = existsSync(dir);
  if (localRemoved) rmSync(dir, { recursive: true, force: true });
  return { rows, localRemoved };
}

const DAY = 86_400_000;
export const LEARNING_RETENTION = Object.freeze({ proposedOutcomeMs: 30 * DAY, supersededTextMs: 90 * DAY, receiptMs: 365 * DAY, tempCorpusMs: DAY });

/** Retention (design 11, R22): unconfirmed proposed outcomes 30 days; text of
 * undone, retired and stale lessons 90 days (the row and its lineage stay);
 * content-free run receipts 12 months; leftover temporary corpus folders under
 * learning-local one day. Applied lessons and their lineage are never swept. */
export function sweepLearningRetention(db: DatabaseSync, opts: { now?: number; dataDir?: string } = {}): { outcomes: number; lessonTexts: number; runs: number; corpora: number } {
  const now = opts.now ?? Date.now(), done = { outcomes: 0, lessonTexts: 0, runs: 0, corpora: 0 };
  if (hasTable(db, "memory_lessons")) {
    done.outcomes = Number(db.prepare("DELETE FROM memory_outcomes WHERE confirmed_by IS NULL AND proposed_by!='owner' AND revoked_at IS NULL AND created_at<?").run(now - LEARNING_RETENTION.proposedOutcomeMs).changes);
    done.lessonTexts = Number(db.prepare("UPDATE memory_lessons SET kind='note',spec=NULL,where_=NULL,text='',evidence=NULL WHERE state IN ('undone','retired','stale') AND (text!='' OR evidence IS NOT NULL) AND COALESCE(decided_at,created_at)<?").run(now - LEARNING_RETENTION.supersededTextMs).changes);
    done.runs = Number(db.prepare("DELETE FROM memory_learning_runs WHERE finished_at IS NOT NULL AND finished_at<?").run(now - LEARNING_RETENTION.receiptMs).changes);
  }
  const root = opts.dataDir ? learningLocalPath(opts.dataDir) : null;
  if (root && existsSync(root)) {
    for (const bot of readdirSync(root)) {
      if (!SAFE_SEGMENT.test(bot)) continue;
      const botDir = join(root, bot);
      let entries: string[];
      try { entries = readdirSync(botDir); } catch { continue; }
      for (const entry of entries) {
        if (!/^corpus/.test(entry)) continue;
        const path = join(botDir, entry);
        try { if (now - statSync(path).mtimeMs > LEARNING_RETENTION.tempCorpusMs) { rmSync(path, { recursive: true, force: true }); done.corpora++; } } catch { /* already gone */ }
      }
    }
  }
  return done;
}
