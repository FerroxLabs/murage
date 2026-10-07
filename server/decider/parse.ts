// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// NOTICE: lifted from OpenMausBot (Apache-2.0), adapted for Murage and Flux Router.
import type {
  ChoiceAnswer, DeciderAnswer, DeciderQuestion, ScoreAnswer, YesNoAnswer,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
/** The model rounds to two places, so a map can sum to 0.98 or 1.02. */
const SUM_TOLERANCE = 0.1;
const EPSILON = 1e-9;

function parseChoice(raw: Record<string, unknown>, question: Extract<DeciderQuestion, { type: "choice" }>): ChoiceAnswer | null {
  const offered = new Set(Object.keys(question.options));
  const choice = raw.choice;
  if (typeof choice !== "string" || !offered.has(choice)) return null;
  if (!isRecord(raw.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const [key, value] of Object.entries(raw.probabilities)) {
    if (!offered.has(key) || !isProbability(value)) return null;
    probabilities[key] = value;
    sum += value;
  }
  if (!(Math.abs(sum - 1) <= SUM_TOLERANCE)) return null;
  const pTop = probabilities[choice];
  if (pTop === undefined) return null;
  const others = Object.entries(probabilities).filter(([key]) => key !== choice).map(([, value]) => value);
  const runnerUp = others.length ? Math.max(...others) : 0;
  // Ties break to the first key on the vendor side; a choice that is not
  // the most likely option means the answer is not what it claims to be.
  if (runnerUp > pTop + EPSILON) return null;
  return { type: "choice", choice, pTop, margin: pTop - runnerUp, probabilities };
}

function parseScore(raw: Record<string, unknown>, question: Extract<DeciderQuestion, { type: "score" }>): ScoreAnswer | null {
  const levels = question.levels.length;
  const score = raw.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < -EPSILON || score > levels - 1 + EPSILON) return null;
  if (!isRecord(raw.probabilities)) return null;
  const probabilities = Array.from({ length: levels }, () => 0);
  for (const [key, value] of Object.entries(raw.probabilities)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= levels || String(index) !== key || !isProbability(value)) return null;
    probabilities[index] = value;
  }
  const sum = probabilities.reduce((total, value) => total + value, 0);
  if (!(Math.abs(sum - 1) <= SUM_TOLERANCE)) return null;
  const level = probabilities.indexOf(Math.max(...probabilities));
  return { type: "score", score, level, probabilities };
}

function parseYesNo(raw: Record<string, unknown>): YesNoAnswer | null {
  return isProbability(raw.noul) ? { type: "yesno", p: raw.noul } : null;
}

const WIRE_TYPE = { choice: "choice", score: "score", yesno: "noul" } as const;

/** Strictly decode one response body against the questions that were asked. */
export function parseDecideResponse(
  body: unknown,
  questions: Record<string, DeciderQuestion>,
): { ok: true; answers: Record<string, DeciderAnswer>; inputTokens?: number; model?: string } | { ok: false } {
  if (!isRecord(body) || !isRecord(body.answers)) return { ok: false };
  const answers: Record<string, DeciderAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = body.answers[id];
    if (!isRecord(raw)) return { ok: false };
    if (raw.type !== undefined && raw.type !== WIRE_TYPE[question.type]) return { ok: false };
    const parsed = question.type === "choice" ? parseChoice(raw, question)
      : question.type === "score" ? parseScore(raw, question)
        : parseYesNo(raw);
    if (!parsed) return { ok: false };
    answers[id] = parsed;
  }
  const usage = isRecord(body.usage) ? body.usage.input_tokens : undefined;
  const inputTokens = typeof usage === "number" && Number.isFinite(usage) && usage >= 0 ? usage : undefined;
  const model = typeof body.model === "string" && body.model.length <= 80 ? body.model : undefined;
  return { ok: true, answers, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(model ? { model } : {}) };
}

