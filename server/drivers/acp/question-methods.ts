// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// NOTICE: adapted from OpenMausBot (Apache-2.0) PR #2278, merge 8ca05a615
// (server/drivers/acp/question-requests.ts, acp/grok.ts, acp/cursor.ts), for
// Murage's one question card: an entry parses into QuestionSpec[] and maps the
// owner's validated picks (QuestionAnswer[]) back to the vendor's reply.
import { fromFuigo, toMessageText } from "../../question-normalize.ts";
import type { QuestionAnswer, QuestionSpec } from "../../../shared/questions.ts";

/** One vendor "ask the owner" request (QW Q3). `parse` refuses whole (`ok: false`, shown as one line, the vendor told
 * nobody answered); `reply` returns null when the picks map to no answer, which is sent as `cancelled`. */
export interface AcpQuestionMethod {
  /** The card's tool name; a name `isQuestionTool` knows, so no approval level ever answers it. */
  tool: string;
  /** The vendor's no-answer: a skip, the timeout, the turn ending. */
  cancelled: unknown;
  parse(params: unknown):
    | { ok: true; questions: QuestionSpec[]; reply(answers: readonly QuestionAnswer[]): unknown | null }
    | { ok: false; error: string };
}

/** Answers keyed by question text cannot hold these as plain object keys. */
const RESERVED_KEYS = new Set(["__proto__", "constructor"]);
export const reservedQuestionText = (questions: readonly QuestionSpec[]): boolean =>
  questions.some((question) => RESERVED_KEYS.has(question.question));

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Grok Build's `ask_user_question` (verified against grok 1.0.62 as installed and xai-org/grok-build
 * `xai-grok-tools/src/implementations/grok_build/ask_user_question/types.rs`): `AskUserQuestionExtRequest {sessionId,
 * toolCallId, questions: [{question, header?, options: [{label, description, preview?}], multiSelect | multi_select}],
 * mode}`; the reply is `{outcome: "accepted", answers: {<question text>: [labels]}, annotations?: {<question text>:
 * {notes}}}` (free text alone is `["Other"]` plus notes) or `{outcome: "cancelled"}`. The ACP Rust SDK puts `_` before
 * an extension method on the wire, so both spellings are listed. */
export const GROK_ASK_USER_QUESTION: AcpQuestionMethod = {
  tool: "ask_user_question",
  cancelled: { outcome: "cancelled" },
  parse(params) {
    // the leader gateway may nest the real params as `{method, params}`, as fromFuigo reads them
    let outer = record(params);
    if (outer && typeof outer.method === "string" && record(outer.params)) outer = record(outer.params);
    const raw = outer?.questions;
    const normalized = fromFuigo(params);
    if (!normalized.ok) return normalized;
    if (!Array.isArray(raw) || raw.length !== normalized.questions.length) return { ok: false, error: "the question list does not match" };
    const questions = normalized.questions;
    // Grok reads `answers[q.question]` with its own exact text, so the key is the text it sent.
    const texts = raw.map((entry) => String(record(entry)?.question ?? ""));
    if (reservedQuestionText(questions) || texts.some((text) => RESERVED_KEYS.has(text))) return { ok: false, error: "a question's text is a reserved word" };
    return {
      ok: true,
      questions,
      reply(answers) {
        const byId = new Map(answers.map((answer) => [answer.id, answer]));
        const picks: Record<string, string[]> = {};
        const annotations: Record<string, { notes: string }> = {};
        for (const [index, question] of questions.entries()) {
          const answer = byId.get(question.id);
          if (!answer) continue;
          const other = answer.other?.trim() ?? "";
          const text = texts[index]!;
          picks[text] = answer.selected.length ? [...answer.selected] : other ? ["Other"] : [];
          if (other) annotations[text] = { notes: other };
        }
        if (!Object.keys(picks).length) return null;
        return { outcome: "accepted", answers: picks, ...(Object.keys(annotations).length ? { annotations } : {}) };
      },
    };
  },
};

/** Cursor's AskQuestion (`cursor/ask_question`, cursor.com/docs/cli/acp, as upstream verified it on cursor-agent
 * 2026.10.01): `{toolCallId, title?, questions: [{id, prompt, options: [{id, label}], allowMultiple}]}`, answered
 * `{outcome: {outcome: "answered", answers: [{questionId, selectedOptionIds}]}}`. Cursor answers by option id only, so
 * a reply holding the owner's own words goes back whole as `skipped` with the answer as the reason, which Cursor hands
 * the model verbatim: typed words are never forced onto an option. */
export const CURSOR_ASK_QUESTION: AcpQuestionMethod = {
  tool: "ask_user",
  cancelled: { outcome: { outcome: "cancelled" } },
  parse(params) {
    const raw = record(params)?.questions;
    if (!Array.isArray(raw)) return { ok: false, error: "the question list is empty" };
    const ids: string[] = [];
    const optionIds: Array<Array<unknown>> = [];
    for (const [index, entry] of raw.entries()) {
      const question = record(entry);
      const id = question?.id;
      if (typeof id !== "string" || !id.trim() || id.length > 200) return { ok: false, error: `question ${index + 1} has no id` };
      if (ids.includes(id)) return { ok: false, error: `question ${index + 1} repeats an earlier question's id` };
      ids.push(id);
      optionIds.push(Array.isArray(question!.options) ? question!.options.map((option) => record(option)?.id) : []);
    }
    const normalized = fromFuigo({
      questions: raw.map((entry) => {
        const question = record(entry)!;
        return { question: question.prompt, options: question.options ?? [], multiSelect: question.allowMultiple === true };
      }),
    });
    if (!normalized.ok) return normalized;
    const questions = normalized.questions;
    return {
      ok: true,
      questions,
      reply(answers) {
        const byId = new Map(answers.map((answer) => [answer.id, answer]));
        const picked: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
        let ownWords = false;
        for (const [index, question] of questions.entries()) {
          const answer = byId.get(question.id);
          if (!answer) continue;
          // options() keeps Cursor's order and refuses a repeated label, so a label's index is its option
          const selected = answer.selected.map((label) => optionIds[index]![question.options.findIndex((option) => option.label === label)]);
          if (answer.other?.trim() || selected.some((id) => typeof id !== "string")) ownWords = true;
          else picked.push({ questionId: ids[index]!, selectedOptionIds: selected as string[] });
        }
        if (ownWords) return { outcome: { outcome: "skipped", reason: toMessageText(questions, answers) } };
        return picked.length ? { outcome: { outcome: "answered", answers: picked } } : null;
      },
    };
  },
};
