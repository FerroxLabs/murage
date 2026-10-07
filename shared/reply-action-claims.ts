// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which sentences of a reply say an action was done. Pure text, no model, no
// host state: the server compares these claims with the turn's action record
// (server/reply-action-guard.ts) and the chat underlines the ones that have no
// record. The vocabulary is a table below, not code, so another language is
// more rows with the same exclusions rather than a new code path.
//
// English only. A reply that does not pass the language gate is "unchecked"
// and is never flagged. The gate is a language heuristic, not proof.

export type ActionClass = "send" | "save" | "schedule" | "delegate" | "pay" | "delete" | "run" | "change";

export interface ActionClaim {
  class: ActionClass;
  /** [start, end) offsets into the reply text */
  span: [number, number];
}

export type ClaimScan = { checked: false; claims: [] } | { checked: true; claims: ActionClaim[] };

/** Past forms and participles per action class. */
const VERBS: Record<ActionClass, { past: string[]; participle: string[] }> = {
  send: {
    past: ["sent", "emailed", "messaged", "forwarded", "replied", "posted", "published"],
    participle: ["sent", "emailed", "messaged", "forwarded", "replied", "posted", "published"],
  },
  save: {
    past: ["saved", "wrote", "created", "exported", "uploaded"],
    participle: ["saved", "written", "created", "exported", "uploaded"],
  },
  schedule: {
    past: ["scheduled", "booked"],
    participle: ["scheduled", "booked"],
  },
  delegate: {
    past: ["delegated"],
    participle: ["delegated"],
  },
  pay: {
    past: ["paid", "transferred", "ordered", "purchased", "charged"],
    participle: ["paid", "transferred", "ordered", "purchased", "charged"],
  },
  delete: {
    past: ["deleted", "removed", "cancelled", "canceled"],
    participle: ["deleted", "removed", "cancelled", "canceled"],
  },
  run: {
    past: ["ran", "executed", "deployed", "installed"],
    participle: ["executed", "deployed", "installed"],
  },
  change: {
    past: ["updated", "changed", "renamed"],
    participle: ["updated", "changed", "renamed"],
  },
};

/** Multi-word first person forms the single-verb table cannot express. */
const PHRASES: Array<{ class: ActionClass; first: RegExp }> = [
  { class: "schedule", first: /\bset (?:up )?(?:a |the |your )?(?:reminder|routine)s?\b/i },
  { class: "delegate", first: /\b(?:handed|passed) (?:it |this |that |the \w+ )?(?:off|over)(?: to)?\b/i },
  { class: "delegate", first: /\basked @?[A-Z][a-z]+ to\b/ },
];

const FUNCTION_WORDS = new Set(
  ("the a an and or but of to in on at for with is are was were be been it this that i you we they he she not have has had will would can could do did so as by from if then there their its my your our").split(" "),
);

/** Cheap gate: English function words, mostly ASCII letters. A bare "Sent." has
 * no function words, so a very short, fully ASCII reply passes on its own. */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const ascii = letters.filter((ch) => /[A-Za-z]/.test(ch)).length / letters.length;
  if (ascii < 0.6) return false;
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const hits = words.filter((word) => FUNCTION_WORDS.has(word)).length;
  if (hits >= 2) return true;
  return words.length <= 5 && ascii >= 0.9;
}

/** Blank out the parts that are not the reply's own voice, keeping offsets:
 * fenced blocks, inline code, quoted text, and lines that start with `>`. */
function maskNonVoice(text: string): string {
  const out = text.split("");
  let quote = "", fence = false, inline = false, quotedLine = false, lineStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") { quote = ""; inline = false; quotedLine = false; lineStart = true; continue; }
    if (lineStart && !/\s/.test(ch)) { quotedLine = ch === ">"; lineStart = false; }
    if (!quote && !inline && text.startsWith("```", i)) {
      fence = !fence; out[i] = out[i + 1] = out[i + 2] = " "; i += 2; continue;
    }
    if (fence || quotedLine) { out[i] = " "; continue; }
    if (quote) { out[i] = " "; if (ch === quote) quote = ""; continue; }
    if (ch === "`") { inline = !inline; out[i] = " "; continue; }
    if (inline) { out[i] = " "; continue; }
    // Apostrophes inside words are contractions, not quotation marks.
    if (ch === '"' || ch === "“" || ch === "‘" || (ch === "'" && !/[\p{L}\d]/u.test(text[i - 1] ?? ""))) {
      quote = ch === "“" ? "”" : ch === "‘" ? "’" : ch; out[i] = " ";
    }
  }
  return out.join("");
}

const REPORTED = /\b(?:said|says|told|tells|asked|wrote|writes|replied|reported|mentioned|confirmed|according to)\b/i;
const SPEAKER_LABEL = /(?:^|[\s(])(?!(?:Done|Note|Update|Result|Status|Summary|Okay|OK|Sure|Great|Sent|Saved)\b)[A-Z][A-Za-z]{1,20}:\s/;
const CONDITIONAL = /\b(?:if|unless|until|had I)\b|\b(?:once|when|whenever|after|before)\s+(?:you|we|they|he|she|it)\b/i;
const FUTURE_OR_INTENT =
  /(?:\b(?:will|would|could|can|may|might|should|shall|going to|about to|let me|want to|plan to|intend to|try to|able to|need to|happy to|ready to|had)\b|['’]ll\b)/i;
const NEGATION =
  /(?:\b(?:not|never|without|instead of|unable to|failed to)\b|n['’]t\b)/i;

const ALL_PAST = Object.entries(VERBS).flatMap(([cls, v]) => v.past.map((word) => ({ word, cls: cls as ActionClass })));
const FIRST_PERSON = new RegExp(
  `\\bI(?:\\s+have|['\\u2019]ve)?\\s+(?:(?:just|already|now|also|successfully|finally|then)\\s+)*(?:went ahead and\\s+)?(${ALL_PAST.map((e) => e.word).join("|")})\\b`,
  "gi",
);
const COPULAR = new RegExp(
  `\\b(?:(?:that|it|this|these|those|they)(?:['\\u2019]s|\\s+(?:is|are|was|were|has been|have been))|(?:the|your|a)\\s+(?:[\\w-]+\\s+){0,2}[\\w-]+\\s+(?:is|are|was|were|has been|have been))\\s+(?:(?:now|already|successfully)\\s+)?(${Object.values(VERBS).flatMap((v) => v.participle).join("|")})\\b`,
  "gi",
);
const BARE_LEAD = /^(?:(?:done|ok|okay|great|all set|there you go|finished|alright)[\s,.!\u2014-]*)*/i;
const BARE_REST = /^(?:$|for\b|to\b|at\b|on\b|in\b|into\b|as\b|via\b|successfully\b|and\b|it\b|that\b|the\b|this\b|your\b|a\b)/i;

function classOfPast(word: string): ActionClass | undefined {
  const w = word.toLowerCase();
  return ALL_PAST.find((entry) => entry.word === w)?.cls;
}
function classOfParticiple(word: string): ActionClass | undefined {
  const w = word.toLowerCase();
  for (const [cls, v] of Object.entries(VERBS)) if (v.participle.includes(w)) return cls as ActionClass;
  return undefined;
}

interface Sentence { start: number; end: number; question: boolean }

function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const boundary = ch === "\n" || ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= text.length || /\s/.test(text[i + 1]!)));
    if (boundary) {
      out.push({ start, end: i + 1, question: ch === "?" });
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ start, end: text.length, question: false });
  return out;
}

/** Find the action claims in a reply. Exclusions are applied in the order the
 * design fixes them: quoted/code, reported speech, future/conditional/intent
 * or a question, negation, hypothetical. What survives is a claim. */
export function detectActionClaims(text: string): ClaimScan {
  if (!text.trim() || !looksEnglish(text)) return { checked: false, claims: [] };
  const masked = maskNonVoice(text);
  const claims: ActionClaim[] = [];
  const seen = new Set<string>();
  const add = (cls: ActionClass, start: number, end: number) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ class: cls, span: [start, end] });
  };

  for (const sentence of sentences(masked)) {
    if (sentence.question) continue; // 3: a question
    const body = masked.slice(sentence.start, sentence.end);
    if (!body.trim()) continue;
    // 3: a sentence led by a condition governs the verb after it
    const lead = body.trimStart().replace(/^[-*•]\s+|^\d+[.)]\s+/, "");
    if (/^(?:if|once|when|whenever|unless|until)\b|^(?:after|before)\s+(?:I|you|we|they|he|she|it)\b/i.test(lead)) continue;

    // Build exclusion state once per disjoint governing clause. A trailing
    // condition governs the claim too. First-person writing is an action;
    // somebody else's writing introduces reported speech.
    const excluded = new Uint8Array(body.length);
    let clauseAt = 0, reported = false, reportedFirstPerson = false, previousBoundary = "";
    const boundaries = [...body.matchAll(/[;:\u2014\u2013]|(?:,\s*)?\b(?:and|but)\s+|,\s*(?=I\b)/g), { index: body.length, 0: "" }];
    for (const boundary of boundaries) {
      const end = boundary.index!;
      const clause = body.slice(clauseAt, end);
      const coordinatedComplement = /\b(?:and|but)\b/.test(previousBoundary) && /^\s*that\b/i.test(clause);
      const introducedAssertion = /^\s*(?:(?:then|next|later|afterwards?|subsequently|finally|now)\s*,?\s+)+I\b/.test(clause);
      if (previousBoundary && previousBoundary !== ":" &&
        !coordinatedComplement &&
        (!/\band\b/.test(previousBoundary) || introducedAssertion || (!reportedFirstPerson && /^\s*I\b/.test(clause)))) {
        reported = false;
        reportedFirstPerson = false;
      }
      const reportText = clause.replace(/\bI(?:\s+have|['’]ve)?\s+(?:wrote|replied|asked)\b/gi, "");
      reported ||= REPORTED.test(reportText) || SPEAKER_LABEL.test(clause + (boundary[0] === ":" ? ": " : ""));
      if (reported && /\bI\b/.test(clause)) reportedFirstPerson = true;
      if (CONDITIONAL.test(clause) || reported) excluded.fill(1, clauseAt, end);
      else {
        const modality = FUTURE_OR_INTENT.exec(clause), negation = NEGATION.exec(clause);
        const from = Math.min(modality?.index ?? clause.length, negation?.index ?? clause.length);
        excluded.fill(1, clauseAt + from, end);
      }
      previousBoundary = boundary[0];
      clauseAt = end + boundary[0].length;
    }
    const guard = (at: number) => !excluded[at - sentence.start];

    // first person: I sent / I've sent / I just sent / I went ahead and sent
    for (const m of body.matchAll(FIRST_PERSON)) {
      const at = sentence.start + (m.index ?? 0);
      const cls = classOfPast(m[1]!);
      if (cls && guard(at)) add(cls, at, at + m[0].length);
    }
    for (const phrase of PHRASES) {
      const m = phrase.first.exec(body);
      if (!m) continue;
      const at = sentence.start + m.index;
      // phrases carry their own subject-less form; require "I" in the lead-up
      if (/\bI(?:['’]ve|\s+have)?\s+(?:(?:just|already|now|also|successfully|finally|then)\s+)*$/i.test(masked.slice(Math.max(sentence.start, at - 40), at))
        && guard(at)) add(phrase.class, at, at + m[0].length);
    }
    // copular: It is saved / The file has been created
    for (const m of body.matchAll(COPULAR)) {
      const at = sentence.start + (m.index ?? 0);
      const cls = classOfParticiple(m[1]!);
      if (cls && guard(at)) add(cls, at, at + m[0].length);
    }
    // sentence-initial bare participle: Sent. Done, sent. Scheduled for Monday.
    const stripped = lead;
    const offsetInBody = body.length - body.trimStart().length + (body.trimStart().length - lead.length);
    const afterLead = stripped.replace(BARE_LEAD, "");
    const leadSkip = stripped.length - afterLead.length;
    const bare = /^([A-Za-z]+)\b([^,;:\u2014]*)/.exec(afterLead);
    if (bare && !bare[1]!.match(/^(?:not|never|no)$/i)) {
      const cls = classOfParticiple(bare[1]!);
      const rest = bare[2]!.trim().replace(/[.!?]+$/, "").trim();
      const capitalised = /^[A-Z]/.test(bare[1]!);
      if (cls && (capitalised || leadSkip > 0)) {
        if (BARE_REST.test(rest) && rest.length <= 80 && guard(sentence.start + offsetInBody + leadSkip)) {
          const at = sentence.start + offsetInBody + leadSkip;
          add(cls, at, at + bare[1]!.length);
        }
      }
    }
  }
  const ordered: ActionClaim[][] = new Array(text.length);
  for (const claim of claims) (ordered[claim.span[0]] ??= []).push(claim);
  return { checked: true, claims: ordered.flat() };
}

export type ActionCheckState = "recorded" | "earlier" | "flagged" | "unverifiable" | "unchecked" | "none";

export interface CheckedClaim extends ActionClaim {
  state: "recorded" | "earlier" | "flagged" | "unverifiable";
  /** Authored piece containing the span. */
  pieceId?: string;
  text?: string;
  /** the row that holds the record, for an `earlier` claim */
  rowId?: string;
}

/** Stored on a turn's terminal reply row (Message.actionCheck). */
export interface ActionCheck {
  state: ActionCheckState;
  claims: CheckedClaim[];
}

/** The exact line the chat shows under a flagged reply. */
export const FLAGGED_REPLY_LINE = "This reply describes an action that has no record. Nothing was done.";
export const EARLIER_CLAIM_TITLE = "recorded earlier in this conversation";

/** Replace a flagged reply's text in a window a reader sees (the span count stays honest). */
export const HELD_REPLY_TEXT = "[reply held: it described an action with no record]";
