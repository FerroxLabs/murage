// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier 1 lessons, the allowlist (design note TIER1-ALLOWLIST.md).
//
// A lesson applies on its own only when its effect is one value from the
// closed set below AND the prompt line it produces is written by code from
// that value. The owner's words are never copied into a prompt without a tap.
// This file holds the whole closed set: the schema (13 kinds), the strict
// parser, the code-written lines, the anchor words that route a misread to a
// suggestion, and the phrase table used when there is no learning connection.
//
// Nothing here reads the database, a tool, a permission or an approval.

export type Where = "everywhere" | "with-me" | "with-others";
export const WHERE_VALUES: readonly Where[] = ["everywhere", "with-me", "with-others"];

export const SUPPORTED_LANGUAGES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
const LANGUAGE_NAMES: Record<SupportedLanguage, string> = { en: "English", de: "German", es: "Spanish", fr: "French", hi: "Hindi", ja: "Japanese", "pt-br": "Brazilian Portuguese", zh: "Chinese" };

/** 1 to 3 words, letters, spaces and apostrophes only, at most 24 characters. No digits, '@', '_' or ':' can appear. */
export type Term = string;
export type StyleSpec =
  | { kind: "length"; value: "brief" | "standard" | "detailed" }
  | { kind: "structure"; value: "bullets" | "paragraphs" | "numbered-steps" | "tables-for-comparisons" }
  | { kind: "headings"; value: "use" | "avoid" }
  | { kind: "emoji"; value: "none" | "sparing" }
  | { kind: "exclamations"; value: "avoid" }
  | { kind: "formality"; value: "formal" | "neutral" | "casual" }
  | { kind: "directness"; value: "warm" | "direct" }
  | { kind: "lead-with"; value: "decision" | "answer" | "summary" | "next-steps" }
  | { kind: "language"; value: SupportedLanguage }
  | { kind: "spelling"; value: "us" | "uk" | "au" | "ca" }
  | { kind: "date-format"; value: "day-month" | "month-day" | "iso" }
  | { kind: "addressing"; value: "first-name" | "full-name" | "no-name" }
  | { kind: "term"; use: Term; insteadOf: Term };
export type StyleKind = StyleSpec["kind"];
export type LessonBody = { type: "style"; spec: StyleSpec; where: Where } | { type: "note"; text: string };

/** Every enumerated value per kind. `term` is open (validated by validTerm) and is not listed. */
export const STYLE_VALUES: { readonly [K in Exclude<StyleKind, "term">]: readonly string[] } = {
  length: ["brief", "standard", "detailed"],
  structure: ["bullets", "paragraphs", "numbered-steps", "tables-for-comparisons"],
  headings: ["use", "avoid"],
  emoji: ["none", "sparing"],
  exclamations: ["avoid"],
  formality: ["formal", "neutral", "casual"],
  directness: ["warm", "direct"],
  "lead-with": ["decision", "answer", "summary", "next-steps"],
  language: SUPPORTED_LANGUAGES,
  spelling: ["us", "uk", "au", "ca"],
  "date-format": ["day-month", "month-day", "iso"],
  addressing: ["first-name", "full-name", "no-name"],
};
export const STYLE_KINDS: readonly StyleKind[] = [...(Object.keys(STYLE_VALUES) as Array<Exclude<StyleKind, "term">>), "term"];

export function validTerm(raw: unknown): raw is Term {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 24) return false;
  if (!/^[\p{L}']+(?: [\p{L}']+){0,2}$/u.test(raw)) return false;
  return /\p{L}/u.test(raw);
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};

/** Strict, exact-key parser. An unknown key, an extra key, a wrong type or a value outside the enum returns null. */
export function parseStyleSpec(raw: unknown): StyleSpec | null {
  if (!isObject(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "term") {
    if (!hasExactKeys(raw, ["kind", "use", "insteadOf"])) return null;
    if (!validTerm(raw.use) || !validTerm(raw.insteadOf)) return null;
    if (raw.use.toLowerCase() === raw.insteadOf.toLowerCase()) return null;
    return { kind: "term", use: raw.use, insteadOf: raw.insteadOf };
  }
  if (!Object.hasOwn(STYLE_VALUES, raw.kind) || !hasExactKeys(raw, ["kind", "value"]) || typeof raw.value !== "string") return null;
  const allowed = STYLE_VALUES[raw.kind as Exclude<StyleKind, "term">];
  if (!allowed.includes(raw.value)) return null;
  return { kind: raw.kind, value: raw.value } as StyleSpec;
}

export function parseWhere(raw: unknown): Where | null {
  return typeof raw === "string" && (WHERE_VALUES as readonly string[]).includes(raw) ? raw as Where : null;
}

// ── the code-written lines ────────────────────────────────────────────────
const LINES: { readonly [K in Exclude<StyleKind, "term" | "language">]: Readonly<Record<string, string>> } = {
  length: { brief: "Keep replies brief.", standard: "Keep replies a standard length.", detailed: "Give detailed replies." },
  structure: { bullets: "Use bullet points.", paragraphs: "Write in short paragraphs.", "numbered-steps": "Use numbered steps for instructions.", "tables-for-comparisons": "Use tables for comparisons." },
  headings: { use: "Use headings to organise longer replies.", avoid: "Avoid headings." },
  emoji: { none: "Do not use emojis.", sparing: "Use emojis sparingly." },
  exclamations: { avoid: "Avoid exclamation marks." },
  formality: { formal: "Write formally.", neutral: "Write in a neutral tone.", casual: "Write casually." },
  directness: { warm: "Be warm.", direct: "Be direct." },
  "lead-with": { decision: "Lead with the decision.", answer: "Lead with the answer.", summary: "Lead with a summary.", "next-steps": "Lead with the next steps." },
  spelling: { us: "Use US spelling.", uk: "Use UK spelling.", au: "Use Australian spelling.", ca: "Use Canadian spelling." },
  "date-format": { "day-month": "Write dates as day, then month.", "month-day": "Write dates as month, then day.", iso: "Write dates in ISO format (YYYY-MM-DD)." },
  addressing: { "first-name": "Address people by their first name.", "full-name": "Address people by their full name.", "no-name": "Do not address people by name." },
};

/** The one sentence for a spec. Total over the enum: no owner-supplied byte can appear in it, except a `term` pair
 * (letters only), which is rendered for the owner's own turns and never for anyone else. */
export function renderStyleLine(spec: StyleSpec, where: Where = "everywhere"): string | null {
  if (spec.kind === "term") return where === "with-others" ? null : `Say "${spec.use}" instead of "${spec.insteadOf}".`;
  if (spec.kind === "language") return `Reply in ${LANGUAGE_NAMES[spec.value]}.`;
  return LINES[spec.kind][spec.value] ?? null;
}

/** Every line a non-term spec can render, so tests and the customer block can enumerate the closed set. */
export const STYLE_LINES: readonly string[] = Object.freeze([
  ...Object.values(LINES).flatMap(group => Object.values(group)),
  ...SUPPORTED_LANGUAGES.map(code => `Reply in ${LANGUAGE_NAMES[code]}.`),
]);
const STYLE_LINE_SET = new Set(STYLE_LINES);
export const isStyleLine = (line: string): boolean => STYLE_LINE_SET.has(line);

/** One active style lesson per (kind, where), and per `insteadOf` for a term. */
export const supersedeKey = (spec: StyleSpec, where: Where): string => spec.kind === "term" ? `term:${spec.insteadOf.toLowerCase()}:${where}` : `${spec.kind}:${where}`;
/** Same value, same place: a repeat, not a change. */
export const specKey = (spec: StyleSpec, where: Where): string => spec.kind === "term" ? `term:${spec.use.toLowerCase()}>${spec.insteadOf.toLowerCase()}:${where}` : `${spec.kind}=${spec.value}:${where}`;

// ── anchors: the owner's own unquoted words must point at the value ───────
// This is a precision check. It routes a misread to a suggestion. It is NOT what keeps customers protected:
// a style line is code-written and a value comes from a closed set, so the worst case is one wrong value with Undo.
/** Words that negate or reverse the clause they sit in. */
const NEGATION = /(?:^|[^\p{L}])(?:no|not|never|without|avoid|avoiding|stop|stopping|less|fewer|skip|drop|ditch|remove|lose|nor|neither|cease|instead)(?![\p{L}])|n['\u2019]t(?![\p{L}])/iu;
type Polarity = "forbid" | "require" | "any";
interface Anchor { all: readonly RegExp[]; negation: Polarity }
const A = (negation: Polarity, ...all: RegExp[]): Anchor => ({ all, negation });
const LEAD = /\b(?:lead|leads|leading|start|starts|begin|open|opens|first|top|put|up front|upfront)\b/i;
const LANGUAGE_WORDS: Record<SupportedLanguage, RegExp> = {
  en: /\benglish\b/i, de: /\b(?:german|deutsch)\b/i, es: /\b(?:spanish|espa(?:ñ|n)ol)\b/i, fr: /\b(?:french|fran(?:ç|c)ais)\b/i,
  hi: /\b(?:hindi)\b|हिन्दी/i, ja: /\b(?:japanese)\b|日本語/i, "pt-br": /\b(?:portuguese|portugu(?:ê|e)s)\b/i, zh: /\b(?:chinese|mandarin)\b|中文/i,
};
const ANCHORS: { readonly [K in Exclude<StyleKind, "term">]: Readonly<Record<string, Anchor>> } = {
  length: {
    brief: A("forbid", /\b(?:short|shorter|shortest|brief|briefer|concise|succinct|terse|crisp|to the point|wordy|fewer words|less detail|trim)\b/i),
    standard: A("forbid", /\b(?:normal|standard|regular|medium|moderate|middling) (?:length|size)\b/i),
    detailed: A("forbid", /\b(?:longer|detailed|detail|thorough|in[- ]depth|elaborate|comprehensive|verbose|more explanation|explain more)\b/i),
  },
  structure: {
    bullets: A("forbid", /\b(?:bullets?|bullet[- ]points?|bulleted|dot[- ]points?)\b/i),
    paragraphs: A("forbid", /\b(?:paragraphs?|prose|full sentences|flowing text)\b/i),
    "numbered-steps": A("forbid", /\b(?:numbered|step[- ]by[- ]step)\b/i),
    "tables-for-comparisons": A("forbid", /\btables?\b/i),
  },
  headings: { use: A("forbid", /\b(?:headings?|section titles?|section headers?)\b/i), avoid: A("require", /\b(?:headings?|section titles?|section headers?)\b/i) },
  emoji: { none: A("any", /\b(?:emojis?|emoticons?|smileys?)\b/i, /(?:^|[^\p{L}])(?:no|never|without|stop|stopping|avoid|ditch|drop|lose|remove|skip|cease)(?![\p{L}])|n['\u2019]t(?![\p{L}])/iu), sparing: A("any", /\b(?:emojis?|emoticons?)\b/i, /\b(?:fewer|less|sparing|sparingly|occasional|occasionally|a few|go easy|ease off|cut back|tone down|moderation)\b/i) },
  exclamations: { avoid: A("require", /\bexclamations?\b|\bexclaim/i) },
  formality: {
    formal: A("forbid", /\b(?:formal|formally|professional|professionally|polished|businesslike)\b/i),
    neutral: A("forbid", /\b(?:neutral|middle[- ]of[- ]the[- ]road)\b/i),
    casual: A("forbid", /\b(?:casual|casually|informal|informally|relaxed|conversational|laid[- ]back|chatty)\b/i),
  },
  directness: {
    warm: A("forbid", /\b(?:warm|warmer|warmly|friendly|friendlier|kind|kinder|personable)\b/i),
    direct: A("forbid", /\b(?:direct|directly|blunt|bluntly|straightforward|no fluff|get to the point)\b/i),
  },
  "lead-with": {
    decision: A("forbid", /\bdecisions?\b/i, LEAD), answer: A("forbid", /\banswers?\b/i, LEAD),
    summary: A("forbid", /\b(?:summary|tl;?dr|bottom line)\b/i, LEAD), "next-steps": A("forbid", /\bnext steps?\b/i, LEAD),
  },
  language: Object.fromEntries(SUPPORTED_LANGUAGES.map(code => [code, A("forbid", /\b(?:in|into|reply|respond|write|answer|speak|use|language)\b/i, LANGUAGE_WORDS[code])])),
  spelling: {
    us: A("forbid", /\b(?:american|us|u\.s\.|usa)\b/i, /\b(?:spelling|english)\b/i), uk: A("forbid", /\b(?:british|uk|u\.k\.)\b/i, /\b(?:spelling|english)\b/i),
    au: A("forbid", /\b(?:australian|aussie|au)\b/i, /\b(?:spelling|english)\b/i), ca: A("forbid", /\b(?:canadian|ca)\b/i, /\b(?:spelling|english)\b/i),
  },
  "date-format": {
    "day-month": A("forbid", /\b(?:day[- /]month|dd\/mm|dmy|d\/m)\b/i, /\bdates?\b/i), "month-day": A("forbid", /\b(?:month[- /]day|mm\/dd|mdy|m\/d)\b/i, /\bdates?\b/i),
    iso: A("forbid", /\b(?:iso|yyyy-mm-dd)\b/i, /\bdates?\b/i),
  },
  addressing: {
    "first-name": A("forbid", /\bfirst names?\b/i), "full-name": A("forbid", /\bfull names?\b/i),
    "no-name": A("require", /\bnames?\b/i),
  },
};

/** Remove what is not the owner's own instruction: quoted text, block quotes, code. An unbalanced quote voids the lot. */
export function ownerUnquotedText(text: string): string {
  let out = String(text ?? "").replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"').replace(/[\u2018\u2019\u201B]/g, "'");
  out = out.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  out = out.split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join("\n");
  const quotes = out.match(/"/g)?.length ?? 0;
  if (quotes % 2 === 1) return "";
  return out.replace(/"[^"]*"/g, " ");
}

const clausesOf = (text: string) => text.split(/[.!?;\n,]+|\s-\s|\s\u2014\s|\sbut\s/i).map(part => part.trim()).filter(Boolean);
function clauseAnchored(anchor: Anchor, clauses: readonly string[]): boolean {
  return clauses.some(clause => anchor.all.every(pattern => pattern.test(clause)) && (anchor.negation === "any" || (anchor.negation === "require" ? NEGATION.test(clause) : !NEGATION.test(clause))));
}
const wordIn = (needle: string, haystack: string) => {
  const escaped = needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}'])${escaped}(?![\\p{L}'])`, "iu").test(haystack);
};

/** Does the owner's own (unquoted) wording point at exactly this value? `botTurn` is the reply being corrected (term only). */
export function anchoredBy(spec: StyleSpec, ownerText: string, botTurn: string | null = null): boolean {
  const own = ownerUnquotedText(ownerText);
  if (!own.trim()) return false;
  if (spec.kind === "term") return wordIn(spec.use, own) && botTurn !== null && wordIn(spec.insteadOf, botTurn) && !wordIn(spec.insteadOf, own);
  const clauses = clausesOf(own);
  const table = ANCHORS[spec.kind];
  if (!clauseAnchored(table[spec.value]!, clauses)) return false;
  // Two different values of the same kind both pointed at ("shorter, no actually longer"): the owner decides. Opposites are
  // compared by their words alone, whatever the polarity, so a negated rival ("not bullets") still counts as pointed at.
  const wordsPresent = (anchor: Anchor) => clauses.some(clause => anchor.all.every(pattern => pattern.test(clause)));
  return Object.entries(table).every(([value, anchor]) => value === spec.value || !(anchor.negation === "forbid" && table[spec.value]!.negation === "forbid" ? wordsPresent(anchor) : clauseAnchored(anchor, clauses)));
}

// ── no learning connection: exact phrases only ────────────────────────────
const LEAD_FRAMES = /^(?:(?:no|nope|nah|ok|okay|please|also|always|next time|from now on|going forward|in future|in the future|actually)[\s,.:;-]+)+/i;
const LEAD_FRAMES_KEEP_NO = /^(?:(?:ok|okay|please|also|always|next time|from now on|going forward|in future|in the future|actually)[\s,.:;-]+)+/i;
const P = (pattern: RegExp, spec: StyleSpec): readonly [RegExp, StyleSpec] => [pattern, spec];
const PHRASES: ReadonlyArray<readonly [RegExp, StyleSpec]> = [
  P(/^(?:be |keep (?:it|replies|them|responses|answers) )?(?:shorter|short|briefer|brief|more concise|concise|more brief)$/, { kind: "length", value: "brief" }),
  P(/^(?:be |give )?(?:longer|more detailed|more detail|more thorough)$/, { kind: "length", value: "detailed" }),
  P(/^(?:use )?(?:bullet points?|bullets|dot points?)$/, { kind: "structure", value: "bullets" }),
  P(/^(?:use )?(?:numbered steps|numbered lists?)$/, { kind: "structure", value: "numbered-steps" }),
  P(/^(?:no|stop using|stop with the|don'?t use|never use|without|lose the) emojis?$/, { kind: "emoji", value: "none" }),
  P(/^(?:no|fewer|stop using|don'?t use|never use|without) exclamation (?:marks|points)$/, { kind: "exclamations", value: "avoid" }),
  P(/^(?:be )?(?:more )?formal$/, { kind: "formality", value: "formal" }),
  P(/^(?:be )?(?:more )?(?:casual|informal|relaxed)$/, { kind: "formality", value: "casual" }),
  P(/^(?:be )?(?:warmer|more friendly|friendlier|more warm)$/, { kind: "directness", value: "warm" }),
  P(/^(?:be )?(?:more direct|more blunt|blunter)$/, { kind: "directness", value: "direct" }),
  P(/^lead with the decision$/, { kind: "lead-with", value: "decision" }),
  P(/^lead with the answer$/, { kind: "lead-with", value: "answer" }),
  P(/^lead with (?:a|the) summary$/, { kind: "lead-with", value: "summary" }),
  P(/^lead with the next steps$/, { kind: "lead-with", value: "next-steps" }),
];
/** The whole message (framing words aside) is one shipped phrase. Used only when there is no learning connection. */
export function phraseSpec(ownerText: string): StyleSpec | null {
  if (/["\u201C\u201D`]|^\s*>/m.test(ownerText)) return null; // any quoting: not a bare instruction
  const flat = ownerText.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const tidy = (text: string) => text.replace(/[\s.!,]+$/g, "").replace(/\s+please$/, "");
  // "No emojis" keeps its "no"; "No, use bullet points" loses it as framing. Try both readings.
  const cores = [tidy(flat.replace(LEAD_FRAMES, "")), tidy(flat.replace(LEAD_FRAMES_KEEP_NO, ""))];
  for (const core of cores) for (const [pattern, spec] of PHRASES) if (pattern.test(core)) return spec;
  return null;
}

/** What an owner edit repeated twice maps to, 1:1. */
export const EDIT_SPECS = {
  shorter: { kind: "length", value: "brief" },
  longer: { kind: "length", value: "detailed" },
  "no-emojis": { kind: "emoji", value: "none" },
  "fewer-exclamations": { kind: "exclamations", value: "avoid" },
} as const satisfies Record<string, StyleSpec>;
