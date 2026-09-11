// One question card for every engine (0.1.52 ASK2, K0 amendment).
//
// An engine's "ask the owner" request — Claude's AskUserQuestion, the
// muragebox `ask_user` tool, and the plain question every other driver
// already raises — becomes a list of QuestionSpec on `request.opened`. The
// owner's reply comes back as QuestionAnswer[], which each adapter turns into
// its own wire shape (see server/question-normalize.ts).
//
// Shared between the server and the renderer, so it stays pure: no Node and
// no DOM.

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  /** Stable within one request: "q1", "q2", … (or the engine's own id). */
  id: string;
  question: string;
  /** A short chip above the question ("Format", "Scope"). */
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  /** Free text is accepted as the answer, either alone or next to a pick. */
  allowOther: boolean;
  /** The answer is never written to the transcript or the decision log. */
  secret?: boolean;
}

export interface QuestionAnswer {
  id: string;
  /** Option labels, exactly as offered. */
  selected: string[];
  /** The owner's own words, when `allowOther`. */
  other?: string;
}

export const QUESTION_LIMITS = {
  questions: 4,
  options: 10,
  otherChars: 2_000,
  questionChars: 2_000,
  labelChars: 200,
  descriptionChars: 1_000,
  headerChars: 40,
} as const;

/** How long an engine waits for the owner before it is told, honestly, that
 * nobody answered. Matches Fuigo's own default. */
export const QUESTION_TIMEOUT_MS = 30 * 60_000;

/** The card fields a question needs; mirrors OptionCardData on both ends. */
export interface QuestionCardShape {
  subtitle: string;
  options: string[];
  requestId?: string;
  tool?: string;
  questions?: QuestionSpec[];
  routineRequest?: unknown;
  skillRequest?: unknown;
  intake?: unknown;
}

/** A live provider question: a request card that is not a permission and not
 * one of the harness's own durable proposals. */
export function isQuestionCard(card: QuestionCardShape | undefined | null): boolean {
  if (!card?.requestId) return false;
  if (card.questions?.length) return true;
  return !card.tool && !card.routineRequest && !card.skillRequest && !card.intake;
}

/** One question built from the older single-question shape (summary plus
 * one-tap choices). Used for engines that do not send `questions` yet and
 * for cards persisted before 0.1.52. */
export function questionFromChoices(question: string, choices: readonly string[] | undefined): QuestionSpec {
  const seen = new Set<string>();
  const options: QuestionOption[] = [];
  for (const raw of choices ?? []) {
    const label = typeof raw === "string" ? raw.trim().slice(0, QUESTION_LIMITS.labelChars) : "";
    if (!label || seen.has(label)) continue;
    seen.add(label);
    options.push({ label });
    if (options.length >= QUESTION_LIMITS.options) break;
  }
  return {
    id: "q1",
    question: question.slice(0, QUESTION_LIMITS.questionChars) || "Your bot has a question",
    options,
    multiSelect: false,
    allowOther: true,
  };
}

/** The questions a card asks, synthesizing one for a legacy card. */
export function questionsForCard(card: QuestionCardShape | undefined | null): QuestionSpec[] {
  if (!card || !isQuestionCard(card)) return [];
  if (card.questions?.length) return card.questions;
  return [questionFromChoices(card.subtitle, card.options)];
}

/** Whether one question has enough of an answer to submit. */
export function answerComplete(question: QuestionSpec, answer: QuestionAnswer | undefined): boolean {
  if (!answer) return false;
  const other = answer.other?.trim() ?? "";
  const picks = answer.selected.length + (other ? 1 : 0);
  if (picks === 0) return false;
  return question.multiSelect ? true : picks === 1;
}

/** The answer to one question as words: "Summary", "Intro, Outro",
 * "Intro, and also: my own note". */
export function answerWords(_question: QuestionSpec, answer: QuestionAnswer | undefined): string {
  if (!answer) return "";
  const other = answer.other?.trim() ?? "";
  const labels = answer.selected.join(", ");
  if (labels && other) return `${labels}; ${other}`;
  return labels || other;
}

/** A late answer, written as an ordinary chat message so it still reaches the
 * bot after the engine stopped waiting. */
export function answersAsMessage(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const lines: string[] = [];
  for (const question of questions) {
    const words = answerWords(question, byId.get(question.id));
    if (!words) continue;
    lines.push(`Q: ${question.question}`, `A: ${words}`);
  }
  return lines.join("\n");
}
