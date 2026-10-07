// The spoken register — turning an agent's answer into something worth
// hearing.
//
// Agents write for a screen: fenced code, file paths, tables, link soup,
// bullet scaffolding. Read aloud verbatim that is unbearable — a 40-line
// diff becomes four minutes of punctuation, and `server/drivers/acp/core.ts`
// becomes "server slash drivers slash a c p slash core dot t s".
//
// So every string is passed through here before it reaches a voice. The
// rule is: say the prose, name the artifacts, drop the syntax. A code block
// becomes "a code block" — the user is looking at the screen if they care,
// and this is the half of the feature that decides whether it is pleasant.
//
// Pure and synchronous on purpose: it is the piece most likely to need
// tuning against real transcripts, so it stays trivially testable.

/** A fenced block becomes a mention of itself, with its language if known. */
function describeCodeBlock(fence: string): string {
  const lang = fence.trim().split(/\s+/)[0]?.replace(/[^a-z0-9+#]/gi, "") ?? "";
  type SpokenLanguages = Record<string, string>;
  const spoken: SpokenLanguages = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    json: "JSON",
    yml: "YAML",
    yaml: "YAML",
    sql: "SQL",
    rs: "Rust",
    go: "Go",
    swift: "Swift",
    diff: "diff",
  };
  const name = spoken[lang.toLowerCase()];
  return name ? `. (a ${name} code block) ` : ". (a code block) ";
}

/** `a/b/c/file.ts` → `file.ts`. A path's directories are for the eye. */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.@-]+\/){1,}([\w.-]+\.\w{1,6})\b/g, "$1");
}

/** Trailing punctuation that already ends a sentence. */
const ENDS_SENTENCE = /[.!?:;]\s*$/;

/**
 * Markdown (or any agent output) → a line a voice can read.
 *
 * Not a markdown parser: a sequence of narrow, ordered replacements, which
 * is both fast enough to run per token-flush and easy to reason about when
 * one of them misfires on a real transcript.
 */
export function speakable(input: string): string {
  if (!input) return "";
  let text = input;

  // fenced code first — everything inside must survive none of the rules below
  text = text.replace(/```([^\n]*)\n[\s\S]*?(?:```|$)/g, (_m, fence: string) => describeCodeBlock(fence));
  text = text.replace(/~~~([^\n]*)\n[\s\S]*?(?:~~~|$)/g, (_m, fence: string) => describeCodeBlock(fence));

  // images before links — the syntax differs by one character
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `. (image: ${alt}) ` : ". (an image) "));
  // [label](url) → label; a bare url becomes a noun rather than an alphabet soup
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>\s]+>/g, " a link ");
  text = text.replace(/\bhttps?:\/\/\S+/g, " a link ");

  // tables: a grid is hopeless aloud, and the separator row is pure noise
  text = text.replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, "");
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", "),
  );

  // inline code: keep short identifiers (they carry meaning), drop long ones
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => (code.length <= 40 ? code : " that snippet "));

  // headings become sentences so the voice pauses instead of running on
  text = text.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (_m, head: string) =>
    ENDS_SENTENCE.test(head) ? head : `${head.trim()}.`,
  );

  // list scaffolding: the marker is visual, the pause is what matters
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");

  // emphasis / strikethrough markers
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  // checkboxes read as literal brackets otherwise
  text = text.replace(/\[[ xX]\]\s*/g, "");

  text = shortenPaths(text);

  // emoji and the pictographic ranges: a voice either ignores them or,
  // worse, announces them by name
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    "",
  );

  // a blank line is a paragraph break — make it an audible one
  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, ". ");

  // tidy the punctuation the substitutions above inevitably pile up
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.,!?;:])/g, "$1");
  text = text.replace(/(?:\.\s*){2,}/g, ". ");
  text = text.replace(/,\s*\./g, ".");
  text = text.trim();

  // The paragraph→". " rule turns whitespace-only input into a lone full
  // stop, which a synthesizer happily renders as a click. Nothing to say
  // means nothing to send.
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

/** Words whose full stop is never a sentence end. */
const ALWAYS_ABBREVIATED = /\b(?:e\.g|i\.e|vs|Dr|Mr|Mrs|Ms|St|Jr|Sr|approx|Inc|Ltd|Corp|a\.m|p\.m)$/i;
/** Words whose full stop is not a sentence end when a number follows. */
const BEFORE_A_NUMBER = /\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun|No|Nos|Vol|pp?|ch)$/i;

/**
 * Where sentences end in `text`: after `.`, `!` or `?` (and any closing
 * quote or bracket) followed by whitespace, except after an abbreviation.
 * "Sept. 14", "the U.S. economy", "e.g. most" and "Dr. Lee" stay whole:
 * a date cut from its month is a date a voice cannot say, and each piece
 * becomes its own synthesis request. Returns the index just past each end.
 */
export function sentenceEnds(text: string, final = true): number[] {
  const ends: number[] = [];
  const boundary = /([.!?])(["')\]]*)\s+/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    if (match[1] === ".") {
      const before = text.slice(0, match.index);
      const next = text[end] ?? "";
      if (/\.$/.test(before)) continue; // an ellipsis
      if (ALWAYS_ABBREVIATED.test(before)) continue;
      // streaming, and what follows decides it ("Sept. " then "14"): wait
      if (!final && !next && (BEFORE_A_NUMBER.test(before) || /(?:\b[A-Za-z]\.)*\b[A-Za-z]$/.test(before))) break;
      if (BEFORE_A_NUMBER.test(before) && /\d/.test(next)) continue;
      // U.S., U.K., N.Y.: an acronym ends the sentence only before a capital
      if (/(?:\b[A-Za-z]\.)+[A-Za-z]$/.test(before) && !/[A-Z]/.test(next)) continue;
      // a lone initial ("J. Smith")
      if (/(?:^|\s)[A-Z]$/.test(before) && /[A-Z]/.test(next)) continue;
    }
    ends.push(end);
  }
  return ends;
}

export const FIRST_CLAUSE_MIN_WORDS = 7;
export const FIRST_CLAUSE_MIN_CHARS = 40;

const MONTH_WEEKDAY_NUMBER =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thu(?:rs?)?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d[\d,.]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i;

/** True while a quote, round or square bracket opened in `prefix` is still open. */
function opensUnbalanced(prefix: string): boolean {
  const count = (re: RegExp) => (prefix.match(re) ?? []).length;
  return (
    count(/"/g) % 2 === 1 ||
    count(/\u201c/g) > count(/\u201d/g) ||
    count(/\(/g) > count(/\)/g) ||
    count(/\[/g) > count(/\]/g)
  );
}

/**
 * Index just past the first clean clause end in `text`, or -1. Only a
 * ", ", "; ", " - ", " \u2013 " or " \u2014 " boundary with a word after it.
 *
 * It exists so a reply can start sounding after its first clause instead of
 * its whole first sentence, so it is strict: a prefix of at least 7 words and
 * 40 chars, no sentence end anywhere in the text (a sentence end wins), never
 * inside an open quote or bracket, never at a number or date ("March 3,
 * 2026", "1, 2 and 3"), never after an abbreviation ("e.g., most"). While
 * text streams in, a boundary with nothing after it yet waits. `_final` does
 * not relax any of it: a clause is only ever cut early, never at the end.
 */
export function firstClauseEnd(text: string, _final = false): number {
  if (sentenceEnds(text, false).length) return -1;
  const boundary = /(,|;|\s[-\u2013\u2014])\s+(?=\p{L})/gu;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    const prefix = text.slice(0, end);
    const lead = text.slice(0, match.index);
    const dash = match[1].length > 1;
    if (prefix.length < FIRST_CLAUSE_MIN_CHARS) continue;
    const words = lead.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length < FIRST_CLAUSE_MIN_WORDS) continue;
    if (opensUnbalanced(lead)) continue;
    if (!dash) {
      if (/\d$/.test(lead)) continue;
      const word = (lead.match(/([\p{L}\p{N}][\p{L}\p{N}.,'\u2019-]*)$/u)?.[1] ?? "").replace(/[.,]+$/, "");
      if (MONTH_WEEKDAY_NUMBER.test(word)) continue;
      if (ALWAYS_ABBREVIATED.test(lead.replace(/\.$/, ""))) continue;
    }
    return end;
  }
  return -1;
}

/** `text` cut at its sentence ends; the tail after the last end is kept.
 *  While text is still streaming in (`final` false), an end with nothing
 *  after it yet waits: "Sept. " may be followed by "14". */
export function splitSentences(text: string, final = true): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let last = 0;
  for (const end of sentenceEnds(text, final)) {
    const sentence = text.slice(last, end).trim();
    if (sentence) sentences.push(sentence);
    last = end;
  }
  return { sentences, rest: text.slice(last) };
}

/** The first clause of a reply is sent to speech on its own once it has at
 *  least this many words, and no more than the max: long enough to sound like
 *  a phrase, short enough that its clip starts fast. */
export const CLAUSE_MIN_WORDS = 4;
export const CLAUSE_MAX_WORDS = 8;

/**
 * (Short-break form; `firstClauseEnd` above is the strict one.)
 * Where the first clause of `text` ends (the index just past its comma,
 * semicolon or colon), or -1 when there is no natural break yet. The break
 * needs whitespace after it, so "1,000" and "3:30" never split and a clause
 * is never cut while it streams in. A break with fewer than CLAUSE_MIN_WORDS
 * words before it waits for the next; one past CLAUSE_MAX_WORDS is no break.
 */
export function firstClauseBreak(text: string): number {
  const breaks = /[,;:](?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(text))) {
    const words = text.slice(0, match.index).split(/\s+/).filter(Boolean).length;
    if (words > CLAUSE_MAX_WORDS) return -1;
    if (words >= CLAUSE_MIN_WORDS) return match.index + 1;
  }
  return -1;
}

/** A whole sentence as its first clause and the rest, or null when it should
 *  stay one piece (no break, or too little left after it to be worth a clip). */
export function splitFirstClause(sentence: string): [string, string] | null {
  const end = firstClauseBreak(sentence);
  if (end < 0) return null;
  const clause = sentence.slice(0, end).trim();
  const rest = sentence.slice(end).trim();
  if (rest.split(/\s+/).filter(Boolean).length < 3) return null;
  return [clause, rest];
}

/**
 * Split speakable text into utterances a synthesizer can start on.
 *
 * Both tiers want this: cloud TTS charges and buffers per request, and the
 * local model generates per utterance — so the unit of work is a sentence
 * either way. Very short fragments are glued onto their neighbour, because
 * a synthesizer given two words produces two words of flat, contextless
 * prosody.
 */
/** A clip shorter than this is glued to its neighbour (prepare, and the
 *  room call's streamed sentences). */
export const MIN_UTTERANCE_CHARS = 12;

export function toUtterances(input: string, { minChars = MIN_UTTERANCE_CHARS, maxChars = 320 } = {}): string[] {
  const text = speakable(input);
  if (!text) return [];

  const { sentences, rest } = splitSentences(`${text} `);
  const rough = [...sentences, rest.trim()].filter(Boolean);

  // The first sentence leaves as a clause and its rest, so the voice can
  // start on a few words while the remainder is made.
  const firstClause = rough.length ? splitFirstClause(rough[0]) : null;
  if (firstClause) rough.splice(0, 1, ...firstClause);

  const out: string[] = [];
  for (const piece of rough) {
    // a sentence longer than the cap is broken at a clause, never mid-word
    const parts = piece.length <= maxChars ? [piece] : splitLong(piece, maxChars);
    for (const part of parts) {
      const prev = out[out.length - 1];
      if (prev && (prev.length < minChars || part.length < minChars)) {
        out[out.length - 1] = `${prev} ${part}`;
      } else {
        out.push(part);
      }
    }
  }
  return out;
}

/** `text` in pieces of at most `maxChars`, broken at a clause, never
 *  mid-word. Exported for the voice host, whose sentences skip toUtterances. */
export function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // prefer a clause break, then any space; never cut a word in half
    const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" — "));
    const cut = at > maxChars / 2 ? at + 1 : window.lastIndexOf(" ");
    if (cut <= 0) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A tool-activity chip as a spoken progress line ("reading core.ts").
 * Returns null for chips not worth interrupting the ear for. */
export function narrateTool(toolName: string): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, "").trim();
  if (!name) return null;
  // the harness writes these as chips too; they are already spoken elsewhere
  if (/^(auto-approved|error):/i.test(name)) return null;

  const bare = name.toLowerCase().replace(/^composio__/, "");
  const verbs: Array<[RegExp, string]> = [
    // connected apps (Composio) and engines' tool search: never read the id
    [/^send_voice_note$/, "recording a voice note"],
    [/^composio_search_tools$|^search_tools?$|^tool_search$/, "finding the right tool"],
    [/^composio_(multi_)?execute_tool$|^composio_/, "working in your connected apps"],
    [/^(python3?|node|ruby|perl)( |$)/, "running a small script"],
    [/^(bash|shell|terminal|run_command|execute|computer_exec)$/, "running a command"],
    [/^(read|read_file|view)$/, "reading a file"],
    [/^(write|create_file)$/, "writing a file"],
    [/^(edit|apply_patch|str_replace|multiedit)$/, "editing a file"],
    [/^(grep|search|glob|find)$/, "searching"],
    [/^(web_?search|websearch)$/, "searching the web"],
    [/^(web_?fetch|fetch)$/, "reading a page"],
    [/^screenshot$/, "looking at the screen"],
    [/^(click|type_text|press_key|scroll|computer_batch)$/, "using the computer"],
    [/^open_url$/, "opening a page"],
    [/^list_bots$/, "checking who's around"],
    [/^ask_bot$/, "asking a teammate"],
  ];
  for (const [pattern, phrase] of verbs) {
    if (pattern.test(bare)) return phrase;
  }
  // an unrecognized tool still deserves a beat, but never its raw id or
  // argv: SHOUTY_SNAKE, snake_case and namespaced names are for logs
  const short = shortenPaths(name).slice(0, 40);
  if (!/^[\w .:/-]+$/.test(short)) return null;
  if (/[A-Z]{3,}|__|[:/]/.test(short)) return "using a tool";
  return `running ${short.replace(/_+/g, " ").toLowerCase()}`;
}

const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", jun: "June", jul: "July",
  aug: "August", sep: "September", sept: "September", oct: "October", nov: "November", dec: "December",
};
const DAYS: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", tues: "Tuesday", wed: "Wednesday", thu: "Thursday", thur: "Thursday",
  thurs: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\.?(?=\s)/gi, "about"],
  [/\betc\./gi, "and so on."],
];

/**
 * Written shorthand → what a person would say. Voices read "Sept 14" as
 * "sept fourteen" and "182k" as "182 k"; nobody talks like that.
 *
 * Month and weekday abbreviations are expanded only next to a date or
 * another day ("Sept 14", "14 Oct", "Fri, 3 Oct"), so "Mar" in a name or
 * "sat on it" is left alone. Every voice gets this, on every path: it runs
 * where the harness synthesizes, not where the text was written.
 */
export function pronounceable(input: string): string {
  let text = input;
  // "Sept 14", "Sept. 14th"
  text = text.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?(?=\s+\d{1,2}(?:st|nd|rd|th)?\b)/gi, (_m, m: string) => MONTHS[m.toLowerCase()]!);
  // "14 Oct", "3rd Sept 2026"
  text = text.replace(/(\b\d{1,2}(?:st|nd|rd|th)?\s+)(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/gi, (_m, day: string, m: string) => `${day}${MONTHS[m.toLowerCase()]!}`);
  // "Fri, 3 Oct", "Tue 14 Oct", "Mon Sept 14" (the month is already expanded)
  text = text.replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?(?=,?\s+(?:\d{1,2}\b|January|February|March|April|May|June|July|August|September|October|November|December))/gi, (_m, d: string) => DAYS[d.toLowerCase()]!);
  for (const [pattern, spoken] of ABBREVIATIONS) text = text.replace(pattern, spoken);
  // "$182k", "182k", "2.5M", "$3B": money and counts with a magnitude. Not
  // "4K" (a display), "5m" (minutes or metres) or "8b" (a model's size).
  text = text.replace(/(\$?)(\d+(?:\.\d+)?)\s?(k|K|M|B)\b(?!\w)/g, (whole, dollar: string, n: string, unit: string) =>
    unit === "K" && !dollar ? whole : `${dollar}${n} ${{ k: "thousand", K: "thousand", M: "million", B: "billion" }[unit]}`,
  );
  return text;
}
