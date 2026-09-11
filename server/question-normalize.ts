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

// ── Codex app-server: item/tool/requestUserInput (0.1.52 ASK3) ────────────
//
// Verified against openai/codex `app-server-protocol/src/protocol/v2/item.rs`
// (`ToolRequestUserInputQuestion {id, header, question, isOther, isSecret,
// options?: [{label, description}]}`) and `app-server/src/
// bespoke_event_handling.rs`: the reply is `{answers: {<question id>:
// {answers: string[]}}}`, and the app-server's own no-answer (a failed or
// malformed client reply) is an empty answer map, which the model reads
// verbatim as the tool result.

/** Codex questions carry their own ids, so the answer map is keyed by id and
 * duplicate ids are refused at open. A question with no options is free
 * text; `isOther` allows free text next to the options; `isSecret` keeps the
 * answer out of the transcript and the log. */
export function fromCodex(params: unknown): Normalized {
  const questions = record(params)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, error: "the question list is empty" };
  if (questions.length > QUESTION_LIMITS.questions) {
    return { ok: false, error: `more than ${QUESTION_LIMITS.questions} questions at once` };
  }
  const out: QuestionSpec[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of questions.entries()) {
    const where = `question ${index + 1}`;
    const raw = record(entry);
    const id = clean(raw?.id, 120) || `q${index + 1}`;
    if (ids.has(id)) return { ok: false, error: `${where} repeats the id "${id}"` };
    ids.add(id);
    const question = clean(raw?.question, QUESTION_LIMITS.questionChars);
    if (!question) return { ok: false, error: `${where} has no text` };
    const parsed = options(raw?.options ?? [], where);
    if (!parsed.ok) return parsed;
    const header = clean(raw?.header, QUESTION_LIMITS.headerChars);
    out.push({
      id,
      question,
      ...(header ? { header } : {}),
      options: parsed.options,
      multiSelect: false,
      allowOther: raw?.isOther === true || parsed.options.length === 0,
      ...(raw?.isSecret === true ? { secret: true } : {}),
    });
  }
  return { ok: true, questions: out };
}

/** Codex's `{answers: {<id>: {answers: [...]}}}`: every selected label, then
 * the owner's own words when there are any. */
export function toCodexAnswers(
  questions: readonly QuestionSpec[],
  answers: readonly QuestionAnswer[],
): Record<string, { answers: string[] }> {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const out: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) continue;
    const other = answer.other?.trim() ?? "";
    out[question.id] = { answers: other ? [...answer.selected, other] : [...answer.selected] };
  }
  return out;
}

/** The honest no-answer for Codex: every question present, none answered.
 * The model sees `{"answers":{"q1":{"answers":[]}}}` — never a sentence in
 * the owner's name. */
export function codexNoAnswers(questions: readonly QuestionSpec[]): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {};
  for (const question of questions) out[question.id] = { answers: [] };
  return out;
}

// ── Fuigo: `_fuigo/ask_user_question` ACP extension request (ASK3) ───────
//
// Verified against the Fuigo source (`fuigo-tools/src/implementations/
// fuigo_build/ask_user_question/{types,format}.rs`, `fuigo-shell/src/session/
// acp_session_impl/spawn.rs`): the request is `{sessionId, toolCallId, mode:
// "default"|"plan", questions: [{question, options: [{label, description,
// preview?}], multiSelect?}]}` and the accepted reply is
// `{outcome: "accepted", answers: {<question text>: [labels…]},
// annotations?: {<question text>: {notes?}}}`. Free text alone is `["Other"]`
// plus `annotations[q].notes`; a dismissed dialog is `{outcome: "cancelled"}`.
// The leader gateway may wrap the params as `{method, params}`.

/** Fuigo keys answers by question TEXT (its own `format_accepted_tool_result`
 * reads `answers[q.question]`), so duplicate texts are refused at open, the
 * way Claude's are. Every question takes free text (Fuigo's "Other"). */
export function fromFuigo(params: unknown): Normalized {
  let raw = record(params);
  // the multiplexing leader nests the real params one level down
  if (raw && typeof raw.method === "string" && record(raw.params)) raw = record(raw.params);
  const questions = raw?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, error: "the question list is empty" };
  if (questions.length > QUESTION_LIMITS.questions) {
    return { ok: false, error: `more than ${QUESTION_LIMITS.questions} questions at once` };
  }
  const out: QuestionSpec[] = [];
  const texts = new Set<string>();
  for (const [index, entry] of questions.entries()) {
    const where = `question ${index + 1}`;
    const question = record(entry);
    const text = clean(question?.question, QUESTION_LIMITS.questionChars);
    if (!text) return { ok: false, error: `${where} has no text` };
    if (texts.has(text)) return { ok: false, error: `${where} repeats an earlier question's text` };
    texts.add(text);
    const parsed = options(question?.options ?? [], where);
    if (!parsed.ok) return parsed;
    out.push({
      id: `q${index + 1}`,
      question: text,
      options: parsed.options,
      multiSelect: question?.multiSelect === true || question?.multi_select === true,
      allowOther: true,
    });
  }
  return { ok: true, questions: out };
}

/** Fuigo's accepted reply. Picks are labels keyed by question text; the
 * owner's own words go to `annotations[q].notes`, with the literal "Other"
 * standing in as the pick when nothing else was chosen. */
export function toFuigoAnswers(
  questions: readonly QuestionSpec[],
  answers: readonly QuestionAnswer[],
): { outcome: "accepted"; answers: Record<string, string[]>; annotations?: Record<string, { notes: string }> } {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const picks: Record<string, string[]> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) continue;
    const other = answer.other?.trim() ?? "";
    picks[question.question] = answer.selected.length ? [...answer.selected] : other ? ["Other"] : [];
    if (other) annotations[question.question] = { notes: other };
  }
  return { outcome: "accepted", answers: picks, ...(Object.keys(annotations).length ? { annotations } : {}) };
}

// ── ACP `elicitation/create` (spec v1) and Codex `mcpServer/elicitation/request` (ASK3) ──
//
// Verified against agentclientprotocol `schema/v1/schema.json` (`x-method`
// `elicitation/create`; `CreateElicitationRequest {message, mode: "form",
// requestedSchema}` | `{mode: "url", url, elicitationId}`;
// `CreateElicitationResponse {action: "accept", content?} | decline |
// cancel`) and the older `session/elicitation` spelling in the Rust crate.
// Codex forwards an MCP server's elicitation with the same primitive form
// schema. Every property becomes one question: string enum/oneOf → single
// select, array of enum → multi-select, boolean → Yes/No, anything else →
// the owner's own words.

const YES = "Yes";
const NO = "No";

type FormProperty = Record<string, unknown>;

function enumOptions(raw: unknown, where: string): { ok: true; options: QuestionOption[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${where} has no choices` };
  const labels = raw.map((value) =>
    typeof value === "string" ? { label: value } : record(value) ? { label: record(value)!.title ?? record(value)!.const, description: record(value)!.description } : { label: "" },
  );
  return options(labels, where);
}

function questionFromProperty(name: string, property: FormProperty, index: number): Normalized {
  const where = `field "${name}"`;
  const title = clean(property.title, QUESTION_LIMITS.questionChars) || name.slice(0, QUESTION_LIMITS.questionChars);
  const description = clean(property.description, QUESTION_LIMITS.questionChars);
  const question = description ? `${title}: ${description}`.slice(0, QUESTION_LIMITS.questionChars) : title;
  const header = clean(property.title, QUESTION_LIMITS.headerChars) || name.slice(0, QUESTION_LIMITS.headerChars);
  const type = typeof property.type === "string" ? property.type : "";
  const base = { id: name, question, header };
  if (type === "boolean") {
    return { ok: true, questions: [{ ...base, options: [{ label: YES }, { label: NO }], multiSelect: false, allowOther: false }] };
  }
  if (type === "string" && (Array.isArray(property.enum) || Array.isArray(property.oneOf))) {
    const parsed = enumOptions(property.enum ?? property.oneOf, where);
    if (!parsed.ok) return parsed;
    if (parsed.options.length === 0) return { ok: false, error: `${where} offers no choices` };
    return { ok: true, questions: [{ ...base, options: parsed.options, multiSelect: false, allowOther: false }] };
  }
  if (type === "array") {
    const items = record(property.items);
    const parsed = enumOptions(items?.enum ?? items?.anyOf, where);
    if (!parsed.ok) return parsed;
    if (parsed.options.length === 0) return { ok: false, error: `${where} offers no choices` };
    return { ok: true, questions: [{ ...base, options: parsed.options, multiSelect: true, allowOther: false }] };
  }
  if (type === "string" || type === "number" || type === "integer" || type === "" || type.startsWith("_")) {
    const hint = type === "number" || type === "integer" ? " (a number)" : "";
    return { ok: true, questions: [{ ...base, question: `${question}${hint}`.slice(0, QUESTION_LIMITS.questionChars), options: [], multiSelect: false, allowOther: true }] };
  }
  return { ok: false, error: `${where} has an unsupported type "${type}" (${index + 1})` };
}

/** A form elicitation: `message` plus a flat object schema. Each field is
 * one question; the agent's message leads the first question's text so the
 * card reads as the agent asked it, not as a schema. */
export function fromElicitationForm(message: unknown, requestedSchema: unknown): Normalized {
  const schema = record(requestedSchema);
  const properties = record(schema?.properties);
  const text = clean(message, QUESTION_LIMITS.questionChars);
  if (!properties) return { ok: false, error: "the form has no fields" };
  const names = Object.keys(properties);
  if (names.length === 0) return { ok: false, error: "the form has no fields" };
  if (names.length > QUESTION_LIMITS.questions) return { ok: false, error: `the form has more than ${QUESTION_LIMITS.questions} fields` };
  const out: QuestionSpec[] = [];
  for (const [index, name] of names.entries()) {
    const property = record(properties[name]);
    if (!property) return { ok: false, error: `field "${name}" is not an object` };
    const mapped = questionFromProperty(name.slice(0, 120), property, index);
    if (!mapped.ok) return mapped;
    out.push(...mapped.questions);
  }
  if (text) {
    const first = out[0]!;
    // a lone untitled field IS the message's question; otherwise the message leads
    const only = out.length === 1 ? record(properties[names[0]!]) : null;
    const bare = Boolean(only) && !clean(only?.title, 1) && !clean(only?.description, 1);
    out[0] = { ...first, question: (bare ? text : `${text}\n${first.question}`).slice(0, QUESTION_LIMITS.questionChars) };
  }
  return { ok: true, questions: out };
}

/** Accepted content, typed per the schema: booleans, numbers where the field
 * asked for one and the text parses, `const` values for titled choices, an
 * array for a multi-select, and the owner's words otherwise. */
export function toElicitationContent(
  requestedSchema: unknown,
  questions: readonly QuestionSpec[],
  answers: readonly QuestionAnswer[],
): Record<string, string | number | boolean | string[]> {
  const properties = record(record(requestedSchema)?.properties) ?? {};
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) continue;
    const property = record(properties[question.id]) ?? {};
    const type = typeof property.type === "string" ? property.type : "";
    const consts = new Map<string, string>();
    const titled = Array.isArray(property.oneOf) ? property.oneOf : Array.isArray(record(property.items)?.anyOf) ? (record(property.items)!.anyOf as unknown[]) : [];
    for (const entry of titled) {
      const option = record(entry);
      if (option && typeof option.const === "string") consts.set(clean(option.title ?? option.const, QUESTION_LIMITS.labelChars), option.const);
    }
    const value = (label: string) => consts.get(label) ?? label;
    const other = answer.other?.trim() ?? "";
    if (type === "boolean") content[question.id] = answer.selected[0] === YES;
    else if (type === "array") content[question.id] = answer.selected.map(value);
    else if (question.options.length && answer.selected.length) content[question.id] = value(answer.selected[0]!);
    else if ((type === "number" || type === "integer") && other && Number.isFinite(Number(other))) {
      content[question.id] = type === "integer" ? Math.trunc(Number(other)) : Number(other);
    } else content[question.id] = other;
  }
  return content;
}

/** A URL elicitation never opens or fetches anything by itself: the card
 * shows the link, and only the owner's explicit "I opened it" is an accept. */
export const ELICITATION_URL_OPENED = "I opened the link";
export function fromElicitationUrl(message: unknown, url: unknown): Normalized {
  const link = clean(url, QUESTION_LIMITS.descriptionChars);
  if (!/^https?:\/\/\S+$/i.test(link)) return { ok: false, error: "the link is not an http(s) URL" };
  const text = clean(message, QUESTION_LIMITS.questionChars) || "The agent needs you to open a link to continue";
  return {
    ok: true,
    questions: [{
      id: "url",
      question: `${text}\n${link}`.slice(0, QUESTION_LIMITS.questionChars),
      header: "Link",
      options: [{ label: ELICITATION_URL_OPENED, description: link }],
      multiSelect: false,
      allowOther: false,
    }],
  };
}

// ── Pi `extension_ui_request` select / input / editor (ASK3) ──────────────
//
// Verified against badlogic/pi-mono `packages/coding-agent/docs/rpc.md`:
// `select {title, options: string[]}` answers `{value}`; `input {title,
// placeholder?}` and `editor {title, prefill?}` answer `{value}`; every dialog
// takes `{cancelled: true}`. `confirm` is a yes/no permission and is not
// mapped here.

export function fromPi(request: unknown): Normalized {
  const raw = record(request);
  const method = typeof raw?.method === "string" ? raw.method : "";
  const title = clean(raw?.title, QUESTION_LIMITS.questionChars);
  if (method === "select") {
    const labels = Array.isArray(raw?.options) ? raw.options.filter((option): option is string => typeof option === "string").map((label) => ({ label })) : [];
    const parsed = options(labels, "the selection");
    if (!parsed.ok) return parsed;
    if (parsed.options.length === 0) return { ok: false, error: "the selection offers no options" };
    return { ok: true, questions: [{ id: "q1", question: title || "Pick one", options: parsed.options, multiSelect: false, allowOther: false }] };
  }
  if (method === "input" || method === "editor") {
    const placeholder = clean(raw?.placeholder, QUESTION_LIMITS.headerChars);
    const prefill = method === "editor" ? clean(raw?.prefill, QUESTION_LIMITS.questionChars) : "";
    const question = prefill ? `${title || "Edit this text"}\nCurrent text:\n${prefill}`.slice(0, QUESTION_LIMITS.questionChars) : title || "Type your answer";
    return {
      ok: true,
      questions: [{ id: "q1", question, ...(placeholder ? { header: placeholder } : {}), options: [], multiSelect: false, allowOther: true }],
    };
  }
  return { ok: false, error: `pi "${method || "unknown"}" is not a question` };
}

/** Pi's `extension_ui_response` value: the chosen option label for a select,
 * the owner's words for input/editor. */
export function toPiValue(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[]): string {
  const [question] = questions;
  const answer = answers.find((entry) => entry.id === question?.id);
  if (!question || !answer) return "";
  return answer.selected[0] ?? answer.other?.trim() ?? "";
}
