// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lesson suggestions in the Inbox (design section 12: suggestions only). The
// requests are the same three the bot's Learning section makes; each names the
// version the owner was shown, so an answer to an out-of-date suggestion is
// refused instead of applied to different words.
import { t } from "@/lib/i18n";
import { screenText, suggestionWhy } from "@/lib/learning-screen";
import type { InboxPage } from "../../shared/inbox";

type Request = (path: string, init?: RequestInit) => Promise<any>;

export type LearningSuggestion = NonNullable<InboxPage["learningSuggestions"]>[number];
export type SuggestionVerb = "apply" | "not-now" | "edit";
export const SUGGESTION_EDIT_MAX = 280;

export type SuggestionResult = { ok: true } | { ok: false; message: string };
export type EditResult = { ok: true; suggestion: LearningSuggestion } | { ok: false; message: string };

export const suggestionPath = (s: Pick<LearningSuggestion, "botId" | "lessonId">, verb: SuggestionVerb): string =>
  `/api/bots/${encodeURIComponent(s.botId)}/learning/suggestions/${encodeURIComponent(s.lessonId)}/${verb}`;

export const suggestionTitle = (s: Pick<LearningSuggestion, "botName">): string => t("inboxLearning.title", { bot: s.botName });

/** The sentence a row shows: the lesson's words, or what a skill or routine change would do. */
export const suggestionSentence = (s: LearningSuggestion): string => s.kind === "procedure"
  ? screenText(s.targetKind === "routine" ? "procedure.routine" : "procedure.skill", { name: s.label ?? "", change: s.summary ?? s.text })
  : s.text;
/** The small line under it: who it is offered to, or why it waits. Null for an ordinary lesson. */
export const suggestionNote = (s: LearningSuggestion): string | null => {
  if (s.kind !== "procedure" && s.scope !== "bots" && s.scope !== "team") return null;
  return suggestionWhy({ origin: "suggested", prospectDerived: false, scope: s.scope, recipients: s.recipients, fromName: s.fromName, reasons: s.reasons });
};
/** Only a lesson's own words are edited here; a share or a skill change is edited in the bot's Learning section. */
export const canEditSuggestion = (s: LearningSuggestion): boolean => s.kind !== "procedure" && s.lessonKind !== "style" && s.scope !== "bots" && s.scope !== "team";

const newKey = () => `sugg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const failure = (): { ok: false; message: string } => ({ ok: false, message: t("inboxLearning.error") });

const post = (request: Request, s: LearningSuggestion, verb: SuggestionVerb, body: Record<string, unknown>) =>
  request(suggestionPath(s, verb), { method: "POST", headers: { "Idempotency-Key": newKey() }, body: JSON.stringify(body) });

/** Apply (it becomes a lesson from the next turn) or Not now (gone, nothing learned). */
export async function answerSuggestion(request: Request, s: LearningSuggestion, verb: "apply" | "not-now"): Promise<SuggestionResult> {
  try { await post(request, s, verb, { expectedRevision: s.version, ...(verb === "apply" && s.proposedHash ? { proposedHash: s.proposedHash } : {}) }); return { ok: true }; } catch { return failure(); }
}

/** Edit: new words, still waiting. The row comes back at the version the answer names (or the next one). */
export async function editSuggestion(request: Request, s: LearningSuggestion, words: string): Promise<EditResult> {
  const text = words.trim();
  if (!text || text.length > SUGGESTION_EDIT_MAX) return failure();
  try {
    const answer = await post(request, s, "edit", { expectedRevision: s.version, text });
    const version = Number.isInteger(answer?.lesson?.version) ? answer.lesson.version as number : s.version + 1;
    return { ok: true, suggestion: { ...s, text, version } };
  } catch { return failure(); }
}
