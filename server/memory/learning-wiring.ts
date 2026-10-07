// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot learning, integration: the cross-batch contracts in one place, so
// server/index.ts only calls wireBotLearning once. Each setter below is a hook a
// batch left open (INTEGRATOR.md, INTEGRATOR-PATCHES/b1.md, b2.md, b3.md).
import { chiefShareSuggestion } from "./lesson-sharing.ts";
import type { DatabaseSync } from "node:sqlite";
import { readBotLearning } from "../bot-learning.ts";
import { setFeedbackObserver } from "../message-db.ts";
import type { Message } from "../store.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { withMemoryInferenceLease } from "./extract.ts";
import {
  classifierMessages, detectFeedback, markFeedbackLesson, planFeedbackLesson, type FeedbackClassifier, type FeedbackDecision, type FeedbackResult, type LessonSink,
} from "./feedback.ts";
import { admitLessonText } from "./learnable.ts";
import { addLesson, setFeedbackLessonFormer, setKeptMomentUndoHook, setLearningLocalLessonSink, setLessonAdmitter, recordKeptMoment, type FormLessonFromFeedbackInput } from "./lessons.ts";
import { createLearningLocalLessonSink } from "./lessons-local.ts";
import { OutcomeError, changeOutcome, setEditLessonSink, setOutcomeBotLookup, type LearningBotLike } from "./outcomes.ts";
import type { MemoryRoster } from "./policy.ts";
import { sweepOffPathLearning } from "./lessons.ts";

export interface BotLearningWiring {
  dataDir: string;
  db: () => DatabaseSync;
  bot: (botId: string) => (LearningBotLike & { learning?: unknown }) | null | undefined;
  roster: () => MemoryRoster;
  /** resolveLearningConnection(...) evaluated per call: the key and the selection can change. */
  connection: () => { extractor: TextOnlyExtractor | null };
  readThread: (threadId: string, limit: number) => readonly Message[];
  /** The visible branch: root to the active leaf (Store.activePath). Staleness is decided by membership in it, never by a clock. */
  activePath: (threadId: string) => readonly Message[];
  /** Tests run the observer inline. */
  defer?: (run: () => void) => void;
}

// ---------------------------------------------------------------- the classifier, behind the learning budget

/** One owner message, one request of at most 300 output tokens, charged to the
 * shared learning budget (per-minute calls, daily tokens) through the same
 * inference lease the other learning requests use. A refusal throws, and
 * detection then falls back to its first stage alone (no model call). */
export function leasedFeedbackClassifier(extractor: TextOnlyExtractor): FeedbackClassifier {
  return {
    async classify(input, signal) {
      const messages = classifierMessages(input);
      const leased = await withMemoryInferenceLease(lease => lease.request(extractor, messages[1].content, 300, signal, messages));
      if (leased.status !== "complete" || leased.value.status !== "complete") throw new Error("LEARNING_BUDGET_REFUSED");
      return leased.value.text;
    },
  };
}

// ---------------------------------------------------------------- lessons from a plan

/** B2's plan becomes a lesson through B3's addLesson, with plan.evidence stored unchanged. */
function lessonFromPlan(wiring: BotLearningWiring, db: DatabaseSync, plan: Parameters<LessonSink["form"]>[0], ctx: Parameters<LessonSink["form"]>[1]): string | null {
  const bot = wiring.bot(ctx.botId);
  if (!bot) return null;
  const learning = readBotLearning(bot);
  const result = addLesson(db, {
    botId: ctx.botId, origin: plan.origin, learning: { ...learning, askFirst: learning.askFirst || plan.askFirst },
    ...(plan.spec ? { spec: plan.spec, where: plan.where, auto: plan.auto } : { text: plan.text }), scope: plan.scope,
    threadId: plan.threadId ?? ctx.threadId, ...((plan.sourceMessageId ?? ctx.sourceMessageId) ? { sourceMessageId: plan.sourceMessageId ?? ctx.sourceMessageId } : {}), targetMessageId: plan.targetMessageId ?? ctx.replyMessageId ?? null,
    evidence: plan.evidence,
    ...(plan.prospectTexts?.length ? { prospectTexts: plan.prospectTexts } : {}),
    ...(ctx.replyMessageId ? { chip: { threadId: ctx.threadId, replyMessageId: ctx.replyMessageId } } : {}),
  });
  if (result.status === "applied") chiefShareSuggestion(db, { botId: ctx.botId, lessonId: result.lesson.id });
  forgetUndoneFeedback(db, result, plan.evidence.feedbackId);
  return result.status === "applied" || result.status === "suggested" || result.status === "duplicate" ? result.lesson.id : null;
}

/** The owner undid this very lesson before: the same words must not come back as "apply it now" recent feedback either. */
function forgetUndoneFeedback(db: DatabaseSync, result: ReturnType<typeof addLesson>, feedbackId: string | undefined): void {
  if (result.status !== "refused" || result.reason !== "undone-before" || !feedbackId) return;
  db.prepare("UPDATE memory_feedback SET state='ignored',correction=NULL WHERE id=? AND state='detected'").run(feedbackId);
}

/** SEC-09, design 3.6. The owner message is on the visible branch with the same words, and so is the reply it answered. An edit is a
 * new sibling that moves the branch, so the original leaves the path; two siblings with equal timestamps cannot be confused, because
 * nothing here compares time. */
export function onActivePath(path: readonly Message[], sent: Pick<Message, "id" | "text">, targetMessageId: string | null): boolean {
  const here = path.find(item => item.id === sent.id);
  if (!here || (here.text ?? "") !== (sent.text ?? "")) return false;
  return targetMessageId === null || path.some(item => item.id === targetMessageId);
}

function feedbackLessonFormer(wiring: BotLearningWiring) {
  return (input: FormLessonFromFeedbackInput) => {
    const db = input.db ?? wiring.db();
    const now = input.now ?? Date.now();
    const row = db.prepare("SELECT * FROM memory_feedback WHERE bot_id=? AND thread_id=? AND target_message_id=? AND state IN ('detected','lesson') ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .get(input.botId, input.threadId, input.replyMessageId) as Record<string, any> | undefined;
    if (!row) return { status: "none" as const, reason: "no-feedback-row" };
    const decision: FeedbackDecision = {
      polarity: input.polarity, strength: input.strength, correction: input.correction, confidence: input.confidence, state: "detected",
      target: { kind: row.target_action ? "action" : "turn", action: row.target_action ?? null }, source: "stage1", phrase: null, reasons: [],
    };
    const plan = planFeedbackLesson(db, { id: String(row.id), botId: input.botId, messageId: String(row.message_id ?? ""), now, decision, threadId: input.threadId, targetMessageId: input.replyMessageId }, { askFirst: input.learning.askFirst });
    if (!plan) return { status: "none" as const, reason: "no-rule" };
    const learning = { ...input.learning, askFirst: input.learning.askFirst || plan.askFirst };
    const result = addLesson(db, {
      botId: input.botId, origin: plan.origin, learning, evidence: plan.evidence, now, scope: plan.scope,
      ...(plan.spec ? { spec: plan.spec, where: plan.where, auto: plan.auto } : { text: plan.text }),
      threadId: input.threadId, sourceMessageId: String(row.message_id ?? "") || null, targetMessageId: input.replyMessageId,
      chip: { threadId: input.threadId, replyMessageId: input.replyMessageId },
    });
    forgetUndoneFeedback(db, result, String(row.id));
    if (result.status === "applied") { markFeedbackLesson(db, String(row.id)); chiefShareSuggestion(db, { botId: input.botId, lessonId: result.lesson.id, now }); return { status: "formed" as const, lesson: result.lesson }; }
    if (result.status === "suggested") { markFeedbackLesson(db, String(row.id)); return { status: "suggested" as const, lesson: result.lesson }; }
    return { status: "none" as const, reason: result.status === "duplicate" ? "duplicate" : result.reason };
  };
}

// ---------------------------------------------------------------- kept moments (praise and win chips)

/** "Not an example" on a chip removes the thing it stood for. exemplarKey is
 * `outcome:<id>` (a won or good mark) or `feedback:<id>` (kept praise). Anything
 * else throws, so the chip refuses to say Undone for something still stored. */
function keptMomentUndo(wiring: BotLearningWiring) {
  return (moment: { botId: string; eventId: string; exemplarKey: string; variant: "praise" | "win" }) => {
    const db = wiring.db();
    const [kind, ...rest] = moment.exemplarKey.split(":");
    const id = rest.join(":");
    if (kind === "outcome" && id) {
      const row = db.prepare("SELECT revoked_at FROM memory_outcomes WHERE id=? AND bot_id=?").get(id, moment.botId);
      if (!row) return; // already swept by forgetting
      if (row.revoked_at !== null) return;
      try { changeOutcome(db, { botId: moment.botId, id, change: { revoke: true } }); } catch (error) { if (!(error instanceof OutcomeError) || error.status !== 409) throw error; }
      return;
    }
    if (kind === "feedback" && id) {
      db.prepare("UPDATE memory_feedback SET state='ignored',correction=NULL WHERE id=? AND bot_id=?").run(id, moment.botId);
      return;
    }
    throw new Error("KEPT_MOMENT_UNKNOWN_EXEMPLAR");
  };
}

const firstLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80);

/** A won or good mark the owner just made earns a win chip under that reply. Never throws. */
export function recordWinChip(db: DatabaseSync, outcome: { id: string; botId: string; threadId: string | null; messageId: string | null; kind: string }): void {
  try {
    if ((outcome.kind !== "won" && outcome.kind !== "good") || !outcome.threadId || !outcome.messageId) return;
    const reply = db.prepare("SELECT text FROM messages WHERE thread_id=? AND id=?").get(outcome.threadId, outcome.messageId);
    const label = firstLine(String(reply?.text ?? "")) || "that reply";
    recordKeptMoment(db, { botId: outcome.botId, threadId: outcome.threadId, replyMessageId: outcome.messageId, label, variant: "win", exemplarKey: `outcome:${outcome.id}` });
  } catch { /* the chip is optional */ }
}

/** Only strong praise (strength 3) marks an exemplar and earns a chip; a plain "good job" keeps nothing and shows nothing (design 12a). */
export function afterFeedback(db: DatabaseSync, threadId: string, result: FeedbackResult): void {
  if (result.status !== "recorded" || result.decision.polarity !== "+" || result.decision.state !== "detected" || result.decision.strength < 3 || !result.turn?.messageId) return;
  const botId = db.prepare("SELECT bot_id FROM memory_feedback WHERE id=?").get(result.id)?.bot_id;
  if (typeof botId !== "string") return;
  recordKeptMoment(db, { botId, threadId, replyMessageId: result.turn.messageId, label: firstLine(result.turn.text) || "that reply", variant: "praise", exemplarKey: `feedback:${result.id}` });
}

// ---------------------------------------------------------------- the one call

export interface BotLearningHandle {
  /** The conversation's branch changed (a different leaf, or an edit forked it): set aside what was learned from words no longer on it. */
  onBranchChange(threadId: string): void;
}
export function wireBotLearning(wiring: BotLearningWiring): BotLearningHandle {
  setOutcomeBotLookup(id => wiring.bot(id));
  setLessonAdmitter(admitLessonText);
  setLearningLocalLessonSink(createLearningLocalLessonSink(wiring.dataDir));
  setFeedbackLessonFormer(feedbackLessonFormer(wiring));
  setKeptMomentUndoHook(keptMomentUndo(wiring));
  const lessons: LessonSink = { form: (plan, ctx) => lessonFromPlan(wiring, wiring.db(), plan, ctx) };
  setEditLessonSink(lessons.form);
  const defer = wiring.defer ?? queueMicrotask;
  setFeedbackObserver((threadId, message) => defer(() => {
    try {
      const db = wiring.db();
      const roster = wiring.roster();
      const extractor = wiring.connection().extractor;
      void detectFeedback(db, threadId, message, {
        classifier: extractor ? leasedFeedbackClassifier(extractor) : null,
        botLearning: id => { const bot = wiring.bot(id); return bot ? readBotLearning(bot) : null; },
        resolveBotId: (thread, turn) => turn?.botId ?? roster.bots.find(bot => bot.threadId === thread || bot.tasks?.some(task => task.threadId === thread))?.id ?? null,
        readThread: wiring.readThread,
        botName: id => wiring.bot(id)?.name,
        // SEC-09, design 3.6: the same owner message must still be on the visible branch, word for word, when the model has answered.
        stillCurrent: (thread, sent, target) => onActivePath(wiring.activePath(thread), sent, target),
        lessons,
      }).then(result => { try { afterFeedback(wiring.db(), threadId, result); } catch { /* optional */ } }, () => { /* detection is optional */ });
    } catch { /* never into the write path */ }
  }));
  return {
    onBranchChange(threadId) {
      try {
        const path = new Set(wiring.activePath(threadId).map(item => item.id));
        sweepOffPathLearning(wiring.db(), { threadId, onPath: id => path.has(id) });
      } catch { /* a sweep is never allowed into the write path */ }
    },
  };
}
