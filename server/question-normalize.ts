// Engine question shapes in, one QuestionSpec list out — and the owner's
// QuestionAnswer[] back into each engine's own reply (0.1.52 ASK2).
//
// Pure: no I/O, no store, no clock. Everything an engine sends here is
// engine-controlled input, so it is bounded and validated before it can
// become a card, and every answer is validated against the questions that
// were actually shown before it reaches the engine.
import {
  QUESTION_LIMITS,
  answerComplete,
  answerWords,
  questionFromChoices,
  type QuestionAnswer,
  type QuestionOption,
  type QuestionSpec,
} from "../shared/questions.ts";

export type { QuestionAnswer, QuestionSpec } from "../shared/questions.ts";

export type Normalized = { ok: true; questions: QuestionSpec[] } | { ok: false; error: string };
export type ValidatedAnswers = { ok: true; answers: QuestionAnswer[] } | { ok: false; error: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const clean = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, limit) : "";

function options(raw: unknown, where: string): { ok: true; options: QuestionOption[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${where} has no options` };
  if (raw.length > QUESTION_LIMITS.options) return { ok: false, error: `${where} has more than ${QUESTION_LIMITS.options} options` };
  const out: QuestionOption[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const option = record(entry);
    const label = clean(option?.label, QUESTION_LIMITS.labelChars);
    if (!label) return { ok: false, error: `${where} option ${index + 1} has no label` };
    if (seen.has(label)) return { ok: false, error: `${where} repeats the option "${label}"` };
    seen.add(label);
    const description = clean(option?.description, QUESTION_LIMITS.descriptionChars);
    out.push(description ? { label, description } : { label });
  }
  return { ok: true, options: out };
}

/** Claude Code's AskUserQuestion input: 1-4 questions keyed BY TEXT in the
 * answer, so duplicate question texts are refused here, at open. "Other" is
 * implicit in Claude's contract, so every question allows free text. */
export function fromClaude(input: unknown): Normalized {
  const questions = record(input)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, error: "the question list is empty" };
  if (questions.length > QUESTION_LIMITS.questions) {
    return { ok: false, error: `more than ${QUESTION_LIMITS.questions} questions at once` };
  }
  const out: QuestionSpec[] = [];
  const texts = new Set<string>();
  for (const [index, entry] of questions.entries()) {
    const where = `question ${index + 1}`;
    const raw = record(entry);
    const question = clean(raw?.question, QUESTION_LIMITS.questionChars);
    if (!question) return { ok: false, error: `${where} has no text` };
    if (texts.has(question)) return { ok: false, error: `${where} repeats an earlier question's text` };
    texts.add(question);
    const parsed = options(raw?.options ?? [], where);
    if (!parsed.ok) return parsed;
    const header = clean(raw?.header, QUESTION_LIMITS.headerChars);
    out.push({
      id: `q${index + 1}`,
      question,
      ...(header ? { header } : {}),
      options: parsed.options,
      multiSelect: raw?.multiSelect === true,
      allowOther: true,
    });
  }
  return { ok: true, questions: out };
}

/** The muragebox `ask_user` tool: one question with up to five one-tap
 * choices and free text. */
export function fromMuragebox(input: unknown): Normalized {
  const raw = record(input);
  const question = clean(raw?.question, QUESTION_LIMITS.questionChars);
  if (!question) return { ok: false, error: "the question has no text" };
  const choices = Array.isArray(raw?.choices) ? raw.choices.filter((choice): choice is string => typeof choice === "string") : [];
  return { ok: true, questions: [questionFromChoices(question, choices.slice(0, 5))] };
}

/** Parse the answers a client posted, without trusting any of it yet. */
export function parseAnswers(raw: unknown): { ok: true; answers: QuestionAnswer[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "answers must be a list" };
  if (raw.length > QUESTION_LIMITS.questions) return { ok: false, error: "too many answers" };
  const answers: QuestionAnswer[] = [];
  for (const entry of raw) {
    const answer = record(entry);
    if (!answer || typeof answer.id !== "string" || !answer.id) return { ok: false, error: "every answer needs a question id" };
    const selected = answer.selected ?? [];
    if (!Array.isArray(selected) || selected.length > QUESTION_LIMITS.options || selected.some((label) => typeof label !== "string")) {
      return { ok: false, error: "selected must be a list of option labels" };
    }
    if (answer.other !== undefined && typeof answer.other !== "string") return { ok: false, error: "other must be text" };
    if (typeof answer.other === "string" && answer.other.length > QUESTION_LIMITS.otherChars) {
      return { ok: false, error: `other is longer than ${QUESTION_LIMITS.otherChars} characters` };
    }
    answers.push({
      id: answer.id,
      selected: selected as string[],
      ...(typeof answer.other === "string" ? { other: answer.other } : {}),
    });
  }
  return { ok: true, answers };
}

/** Check answers against the questions that were shown. Every question needs
 * an answer; labels must be offered ones unless the text goes in `other`;
 * single-select takes exactly one pick. Returns them in question order. */
export function validateAnswers(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[]): ValidatedAnswers {
  const byId = new Map<string, QuestionAnswer>();
  for (const answer of answers) {
    if (byId.has(answer.id)) return { ok: false, error: `question ${answer.id} was answered twice` };
    if (!questions.some((question) => question.id === answer.id)) return { ok: false, error: `no question ${answer.id} was asked` };
    byId.set(answer.id, answer);
  }
  const out: QuestionAnswer[] = [];
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) return { ok: false, error: `question ${question.id} has no answer` };
    const labels = new Set(question.options.map((option) => option.label));
    const selected = [...new Set(answer.selected)];
    const unknown = selected.find((label) => !labels.has(label));
    if (unknown !== undefined) return { ok: false, error: `"${unknown.slice(0, 80)}" is not an option of question ${question.id}` };
    const other = answer.other?.trim() ?? "";
    if (other && !question.allowOther) return { ok: false, error: `question ${question.id} takes only its options` };
    if (other.length > QUESTION_LIMITS.otherChars) return { ok: false, error: `other is longer than ${QUESTION_LIMITS.otherChars} characters` };
    const normalized: QuestionAnswer = { id: question.id, selected, ...(other ? { other } : {}) };
    if (!question.multiSelect && selected.length + (other ? 1 : 0) > 1) {
      return { ok: false, error: `question ${question.id} takes one answer` };
    }
    if (!answerComplete(question, normalized)) return { ok: false, error: `question ${question.id} has no answer` };
    out.push(normalized);
  }
  return { ok: true, answers: out };
}

/** An older client (or voice) answers with one string. For a single question
 * it is an option label when it matches one, otherwise the owner's own
 * words. Several questions cannot be answered by one string. */
export function answersFromMessage(questions: readonly QuestionSpec[], message: unknown): QuestionAnswer[] | null {
  if (questions.length !== 1 || typeof message !== "string" || !message.trim()) return null;
  const [question] = questions;
  const text = message.trim();
  if (question!.options.some((option) => option.label === text)) return [{ id: question!.id, selected: [text] }];
  return question!.allowOther ? [{ id: question!.id, selected: [], other: text }] : null;
}

/** Claude's `updatedInput.answers`: keyed by question TEXT; one label, an
 * array of labels for multi-select, or the owner's own words. Verified
 * against https://code.claude.com/docs/en/agent-sdk/user-input ("Response
 * format") and the answer check inside Claude Code 2.1.268. */
export function toClaudeAnswers(
  questions: readonly QuestionSpec[],
  answers: readonly QuestionAnswer[],
): Record<string, string | string[]> {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const out: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) continue;
    const other = answer.other?.trim() ?? "";
    if (question.multiSelect) out[question.question] = other ? [...answer.selected, other] : [...answer.selected];
    else out[question.question] = answer.selected[0] ?? other;
  }
  return out;
}

/** One text reply for engines that take a single string (the muragebox
 * `ask_user` tool, and every driver that reads `decision.message`). */
export function toMessageText(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  if (questions.length === 1) return answerWords(questions[0]!, byId.get(questions[0]!.id));
  return questions
    .map((question) => `${question.question}: ${answerWords(question, byId.get(question.id))}`)
    .join("\n");
}

/** What the transcript may keep: a secret question's answer is dropped. */
export function recordableAnswers(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[]): QuestionAnswer[] {
  const secret = new Set(questions.filter((question) => question.secret).map((question) => question.id));
  return answers.filter((answer) => !secret.has(answer.id));
}

/** Honest non-answers, never presented as the owner's words. */
export const QUESTION_NOTES = {
  skipped: "The owner skipped this question. Do not assume an answer; continue without it or ask again in your reply.",
  timeout: (minutes: number) =>
    `The owner did not answer within ${minutes} min. Do not assume an answer; continue only with reversible work or ask again in your reply.`,
  unshowable: (reason: string) =>
    `Murage could not show this question to the owner (${reason}). Ask it in your reply instead.`,
} as const;
