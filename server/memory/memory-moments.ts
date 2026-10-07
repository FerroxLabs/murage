// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory moment delivery (bot-learning batch B5m, design section 12a). When
// the memory worker activates an entry from a conversation, the owner sees a
// "will remember that" chip under the reply the entry came from. This module
// finds what the worker just stored, stamps its ledger row so the chip list
// (chipItemsForThread) can find it again, and hands the live event its data.
// It also answers the two small questions the Learning screen asks: how much
// was learned this month, and how much is new since the owner last looked.
//
// The honesty rule: a moment exists only for an `activated` ledger row whose
// record is still active. No row, no moment. The wording is picked here from
// the shipped templates, never by a model, so it is the same on every engine.
import type { DatabaseSync } from "node:sqlite";
import { groupOf, pickTemplate } from "../../shared/learned-chip.ts";
import { previousTemplate, seedFor } from "./lessons.ts";

export interface RememberedMoment {
  eventId: string;
  botId: string;
  threadId: string;
  /** The message the entry was read from. */
  sourceMessageId: string;
  /** The bot reply the chip sits under. */
  replyMessageId: string;
  text: string;
  template: number;
  /** The stored entry, so the chip can offer Edit. */
  recordId: string;
  recordVersion: number;
}

/** The bot reply a moment belongs under: the source itself when a bot wrote it,
 * otherwise the first written reply after it. Null when the bot has not
 * answered yet, which leaves nowhere honest to put a chip. */
export function botReplyFor(db: DatabaseSync, threadId: string, messageId: string): string | null {
  const source = db.prepare("SELECT rowid r,at,role,kind FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId);
  if (!source) return null;
  if (source.role === "bot" && source.kind === "text") return messageId;
  const next = db.prepare(`SELECT id FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND TRIM(COALESCE(text,''))<>'' AND (at>? OR (at=? AND rowid>?))
    ORDER BY at,rowid LIMIT 1`).get(threadId, source.at, source.at, source.r);
  return next ? String(next.id) : null;
}

/** The bot's newest written reply in a thread, for a proposal that is about the conversation as a whole. */
export function latestBotReply(db: DatabaseSync, threadId: string): string | null {
  const row = db.prepare("SELECT id FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND TRIM(COALESCE(text,''))<>'' ORDER BY at DESC,rowid DESC LIMIT 1").get(threadId);
  return row ? String(row.id) : null;
}

/** Remembered chips never nag: at most one new chip per this many bot replies in a thread
 * (a chip that lands on a reply that already has one simply merges into it). The
 * memories behind the chips that were folded away still count on the Learning screen. */
export const REMEMBERED_CHIP_EVERY_REPLIES = 5;

/** How many written bot replies the thread has up to and including this message. */
function replyRank(db: DatabaseSync, threadId: string, messageId: string): number | null {
  const at = db.prepare("SELECT rowid r,at FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId);
  if (!at) return null;
  return Number(db.prepare(`SELECT COUNT(*) c FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND TRIM(COALESCE(text,''))<>'' AND (at<? OR (at=? AND rowid<=?))`)
    .get(threadId, at.at, at.at, at.r)?.c ?? 0);
}

/** May a Remembered chip go under this reply? True when the reply already has one, or the
 * nearest chip in the thread is at least five bot replies away. */
export function rememberedChipAllowed(db: DatabaseSync, botId: string, threadId: string, replyMessageId: string): boolean {
  const chips = db.prepare(`SELECT DISTINCT json_extract(detail,'$.replyMessageId') reply FROM memory_learning_events
    WHERE bot_id=? AND kind='activated' AND json_extract(detail,'$.chip')=1 AND json_extract(detail,'$.threadId')=? AND undone_at IS NULL`).all(botId, threadId) as Array<{ reply: string | null }>;
  const target = replyRank(db, threadId, replyMessageId);
  for (const { reply } of chips) {
    if (!reply || reply === replyMessageId) return true;
    const rank = replyRank(db, threadId, reply);
    if (rank !== null && target !== null && Math.abs(rank - target) < REMEMBERED_CHIP_EVERY_REPLIES) return false;
  }
  return true;
}

/** Extraction can finish before the bot's reply is stored. Those entries wait here, keyed by the source message, and the chip is
 * attached when the reply lands (rememberedMomentsAwaitingReply). The wait is bounded: after that the entry simply has no chip. */
export const REMEMBERED_REPLY_WAIT_MS = 5 * 60_000;
const awaitingReply = new Map<string, { threadId: string; sourceMessageId: string; deadline: number }>();
export const rememberedAwaitingCount = () => awaitingReply.size;
/** Cheap enough to ask on every bot message update: only a thread with something waiting does any work. */
export const threadAwaitsRememberedChip = (threadId: string, now = Date.now()) => { for (const item of awaitingReply.values()) if (item.threadId === threadId && item.deadline > now) return true; return false; };

/** What the memory worker stored while it worked on this job's source, since
 * `since`. Each entry is returned once: the ledger row is stamped, and a
 * stamped row is never returned again. */
export function rememberedMomentsForJob(db: DatabaseSync, jobId: string, since: number): RememberedMoment[] {
  const job = db.prepare("SELECT source_id FROM memory_jobs WHERE id=?").get(jobId);
  if (!job) return [];
  const rows = db.prepare(`SELECT * FROM memory_learning_events WHERE kind='activated' AND source_id=? AND created_at>=? AND bot_id IS NOT NULL AND undone_at IS NULL
    AND json_extract(detail,'$.chip') IS NULL ORDER BY created_at,rowid`).all(String(job.source_id), since) as Record<string, any>[];
  return stampRememberedMoments(db, rows, Date.now());
}

/** A bot reply just landed in this thread: attach the chips that were waiting for it. */
export function rememberedMomentsAwaitingReply(db: DatabaseSync, threadId: string, now = Date.now()): RememberedMoment[] {
  const out: RememberedMoment[] = [];
  for (const [key, item] of [...awaitingReply]) {
    if (item.threadId !== threadId) continue;
    if (item.deadline <= now) { awaitingReply.delete(key); continue; }
    const rows = db.prepare(`SELECT e.* FROM memory_learning_events e JOIN memory_sources s ON s.id=e.source_id WHERE e.kind='activated' AND s.thread_id=? AND s.message_id=? AND e.bot_id IS NOT NULL
      AND e.undone_at IS NULL AND json_extract(e.detail,'$.chip') IS NULL ORDER BY e.created_at,e.rowid`).all(threadId, item.sourceMessageId) as Record<string, any>[];
    if (!rows.length) { awaitingReply.delete(key); continue; }
    if (!botReplyFor(db, threadId, item.sourceMessageId)) continue;
    out.push(...stampRememberedMoments(db, rows, now));
    awaitingReply.delete(key);
  }
  return out;
}

function stampRememberedMoments(db: DatabaseSync, rows: Record<string, any>[], now: number): RememberedMoment[] {
  const out: RememberedMoment[] = [];
  for (const event of rows) {
    const source = db.prepare("SELECT thread_id,message_id,state FROM memory_sources WHERE id=?").get(String(event.source_id));
    if (!source || source.state !== "active" || !source.thread_id || !source.message_id) continue;
    const record = db.prepare("SELECT text,state FROM memory_records WHERE id=? AND version=?").get(String(event.record_id), Number(event.record_version));
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    if (!record || record.state !== "active" || !text) continue;
    const threadId = String(source.thread_id), sourceMessageId = String(source.message_id);
    const replyMessageId = botReplyFor(db, threadId, sourceMessageId);
    if (!replyMessageId) { awaitingReply.set(`${threadId}:${sourceMessageId}`, { threadId, sourceMessageId, deadline: now + REMEMBERED_REPLY_WAIT_MS }); continue; }
    const botId = String(event.bot_id), group = groupOf("remembered");
    if (!rememberedChipAllowed(db, botId, threadId, replyMessageId)) {
      // Too soon after the last chip. Stamped as handled, so it is not offered again; it still counts as a memory.
      db.prepare("UPDATE memory_learning_events SET detail=json_set(detail,'$.chip',0,'$.threadId',?,'$.replyMessageId',?) WHERE id=?").run(threadId, replyMessageId, String(event.id));
      continue;
    }
    const template = pickTemplate(group, previousTemplate(db, botId, group), seedFor(db, botId, Number(event.created_at)));
    db.prepare("UPDATE memory_learning_events SET detail=json_set(detail,'$.chip',1,'$.group',?,'$.template',?,'$.threadId',?,'$.replyMessageId',?,'$.sourceMessageId',?) WHERE id=?")
      .run(group, template, threadId, replyMessageId, sourceMessageId, String(event.id));
    out.push({ eventId: String(event.id), botId, threadId, sourceMessageId, replyMessageId, text, template, recordId: String(event.record_id), recordVersion: Number(event.record_version) });
  }
  return out;
}


export interface LearningCounts { month: string; lessons: number; memories: number; wins: number; undone: number }

const monthKey = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; };

/** "This month: learned N, remembers M". Month boundaries are the owner's local ones. */
export function learningCounts(db: DatabaseSync, input: { botId: string; month?: string; now?: number }): LearningCounts {
  const month = input.month ?? monthKey(input.now ?? Date.now());
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw Object.assign(new Error("month must look like 2026-10"), { status: 400 });
  const from = new Date(Number(match[1]), Number(match[2]) - 1, 1).getTime(), to = new Date(Number(match[1]), Number(match[2]), 1).getTime();
  const count = (sql: string) => Number(db.prepare(sql).get(input.botId, from, to)?.c ?? 0);
  return {
    month,
    // A kept praise moment ("Probe will keep doing this") is something the bot learned too.
    lessons: count("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id=? AND (kind='lesson-learned' OR (kind='feedback-detected' AND json_extract(detail,'$.chip')=1)) AND created_at>=? AND created_at<?"),
    memories: count("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id=? AND kind='activated' AND created_at>=? AND created_at<?"),
    wins: count("SELECT COUNT(*) c FROM memory_outcomes WHERE bot_id=? AND kind IN ('won','good') AND confirmed_by IS NOT NULL AND revoked_at IS NULL AND created_at>=? AND created_at<?"),
    undone: count(`SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id=? AND undone_at>=? AND undone_at<? AND (kind IN ('lesson-learned','activated') OR (kind IN ('feedback-detected','outcome-marked') AND json_extract(detail,'$.chip')=1))`),
  };
}

/** How many lessons and memories are new since the owner last looked, and still kept. */
export function newLearningSince(db: DatabaseSync, botId: string, since: number): number {
  return Number(db.prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id=? AND kind IN ('lesson-learned','activated') AND undone_at IS NULL AND created_at>?").get(botId, since)?.c ?? 0);
}
