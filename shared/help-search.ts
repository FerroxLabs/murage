// Local search over the shipped user documentation.
//
// No LLM call and no network: a workspace with no paid provider — and a bot
// running on a free local model — must still be able to answer "how do I do X
// in Murage?" truthfully. The corpus is small (a few hundred sections), so a
// plain BM25 over an in-memory index is both fast enough and auditable, which
// an embedding index would not be.
//
// Answers are quotable prose plus a pointer the user can act on: a UI path or
// the public docs URL. A repository path is never a result field, because the
// person reading the answer cannot open one.
import { HELP_INDEX, type HelpEntry } from "./help-index.ts";

export type { HelpEntry };

/** What a help answer hands back. `where` and `url` are the only locations;
 * neither can be a filesystem path (see help-index generation). */
export interface HelpResult {
  readonly id: string;
  readonly title: string;
  readonly heading?: string;
  /** The place in the app, or the docs breadcrumb when the section names none. */
  readonly where: string;
  readonly url: string;
  /** Short, quotable prose lifted verbatim from the docs. */
  readonly text: string;
  readonly score: number;
}

/** Words that carry no signal in a product-help question. Deliberately small:
 * over-trimming loses "can" and "use" from phrases like "how to use". */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "am", "do", "does", "did",
  "of", "in", "on", "at", "it", "its", "this", "that", "these", "those", "and",
  "or", "but", "if", "so", "my", "me", "i", "you", "your", "we", "us", "there",
  "what", "when", "where", "which", "who", "why", "how", "to", "for", "with",
  "can", "will", "would", "should", "murage",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords. Variants are folded
 * by `stem` at match time, not here, so the index keeps the words the docs
 * actually use and a result can still be quoted verbatim. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Fold the endings that product prose varies freely: "approve"/"approval",
 * "connect"/"connection"/"connected", "routine"/"routines". Deliberately a
 * short fixed list rather than a full Porter stemmer — every rule here is one
 * a Murage help question actually needs, and a rule that over-merges ("cost"
 * and "costume") is worse on a corpus this small than a missed variant. */
const SUFFIXES = ["ations", "ation", "ions", "ion", "ments", "ment", "ings", "ing", "als", "al", "ers", "er", "ed", "es", "s"];

export function stem(word: string): string {
  let out = word;
  for (const suffix of SUFFIXES) {
    if (out.length - suffix.length >= 4 && out.endsWith(suffix)) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  // "approve" → "approv" meets "approval" → "approv"; "routine" meets "routines".
  return out.length > 4 && out.endsWith("e") ? out.slice(0, -1) : out;
}

/** Words the product uses that the documentation spells differently. Kept
 * tiny and one-directional (question vocabulary → docs vocabulary): every
 * entry is a gap a real question fell into, not a general thesaurus. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  provider: ["engine", "connection"],
  llm: ["engine", "model"],
  ai: ["agent", "engine"],
  key: ["credential", "apikey"],
  schedule: ["routine", "cron"],
  scheduled: ["routine"],
  recurring: ["routine"],
  remember: ["memory"],
  recall: ["memory"],
  forget: ["memory"],
  picture: ["image", "screenshot"],
  photo: ["image", "screenshot"],
  vision: ["image", "attachment"],
  email: ["gmail", "connected"],
  bot: ["agent", "bot"],
  permission: ["approval", "permission"],
  approve: ["approval", "permission"],
  approval: ["permission"],
  allow: ["approval", "permission"],
  deny: ["approval", "permission"],
  price: ["billing", "cost"],
  cost: ["billing", "cost"],
  phone: ["android", "device"],
  desktop: ["computer", "desktop"],
  install: ["installation"],
  update: ["updates"],
};

/** Title and heading matches are evidence about the section's subject, not
 * about how often a word occurs, so they are added on top of the body score
 * rather than folded into term frequency — folding them in let a short
 * section whose heading happened to contain a query word outrank the section
 * that actually answers the question. */
const HEADING_BONUS = 1.1;
const TITLE_BONUS = 0.8;
const DESCRIPTION_BONUS = 0.5;

const K1 = 1.2;
const B = 0.75;

interface IndexedEntry {
  readonly entry: HelpEntry;
  readonly body: ReadonlyMap<string, number>;
  readonly fields: ReadonlySet<string>;
  readonly heading: ReadonlySet<string>;
  readonly title: ReadonlySet<string>;
  readonly description: ReadonlySet<string>;
  readonly length: number;
}

function indexEntry(entry: HelpEntry): IndexedEntry {
  const body = new Map<string, number>();
  for (const token of tokenize(entry.text)) body.set(token, (body.get(token) ?? 0) + 1);
  const heading = new Set(entry.heading ? tokenize(entry.heading) : []);
  const title = new Set(tokenize(entry.title));
  const description = new Set(tokenize(entry.description));
  const fields = new Set([...body.keys(), ...heading, ...title, ...description]);
  let length = 0;
  for (const value of body.values()) length += value;
  return { entry, body, fields, heading, title, description, length };
}

function buildIndex(corpus: readonly HelpEntry[]) {
  const documents = corpus.map(indexEntry);
  const frequency = new Map<string, number>();
  const byStem = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const document of documents) {
    for (const token of document.fields) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
      if (seen.has(token)) continue;
      seen.add(token);
      const key = stem(token);
      const bucket = byStem.get(key);
      if (bucket) bucket.push(token);
      else byStem.set(key, [token]);
    }
  }
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(documents.length, 1);
  return { documents, frequency, byStem, averageLength };
}

/** Every indexed word a query word stands for: itself, its aliases, and every
 * vocabulary word that shares their stem. */
function expand(token: string, byStem: ReadonlyMap<string, readonly string[]>): string[] {
  const matches = new Set<string>();
  for (const seed of [token, ...(ALIASES[token] ?? [])]) {
    for (const word of byStem.get(stem(seed)) ?? []) matches.add(word);
  }
  return [...matches];
}

let defaultIndex: ReturnType<typeof buildIndex> | undefined;

/** A result below this is noise: BM25 will happily rank a section that shares
 * one incidental word. Answering "I could not find that in the docs" is more
 * useful to a user than a confident quote about something else. */
const MIN_SCORE = 1;

export interface HelpSearchOptions {
  /** How many sections to return (1-5). */
  limit?: number;
  /** Override the corpus. Tests use it; production always takes the default. */
  corpus?: readonly HelpEntry[];
}

export function searchHelp(query: string, options: HelpSearchOptions = {}): HelpResult[] {
  const tokens = [...new Set(tokenize(query))];
  if (!tokens.length) return [];
  const index = options.corpus ? buildIndex(options.corpus) : (defaultIndex ??= buildIndex(HELP_INDEX));
  const strict = rank(index, tokens, 1.5, MIN_SCORE);
  // A question whose wording the docs do not share ("take a screenshot of my
  // computer" — the docs say "computer", never "screenshot") would otherwise
  // answer nothing at all. Fall back to the sections that match what the
  // question DOES share, so the bot gets the right page and can say the rest
  // is not documented, rather than inventing it.
  const results = strict.length ? strict : rank(index, tokens, 0.5, MIN_SCORE / 3);
  return results.slice(0, Math.min(Math.max(options.limit ?? 3, 1), 5));
}

function rank(
  index: ReturnType<typeof buildIndex>,
  tokens: readonly string[],
  coverageExponent: number,
  minimumScore: number,
): HelpResult[] {
  const total = index.documents.length;
  const expansions = tokens.map((token) => expand(token, index.byStem));
  const scored: HelpResult[] = [];
  for (const document of index.documents) {
    let score = 0;
    let matched = 0;
    for (const forms of expansions) {
      let best = 0;
      for (const form of forms) {
        const documentFrequency = index.frequency.get(form) ?? 0;
        if (!documentFrequency) continue;
        const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const count = document.body.get(form) ?? 0;
        let term = count
          ? idf * ((count * (K1 + 1)) / (count + K1 * (1 - B + (B * document.length) / index.averageLength)))
          : 0;
        if (document.heading.has(form)) term += idf * HEADING_BONUS;
        if (document.title.has(form)) term += idf * TITLE_BONUS;
        if (document.description.has(form)) term += idf * DESCRIPTION_BONUS;
        best = Math.max(best, term);
      }
      if (best > 0) matched += 1;
      score += best;
    }
    if (!matched) continue;
    // Covering more of the question matters more than matching one word
    // loudly: "approve a tool call" must not be answered by the section about
    // voice call mode just because "call" is rare there.
    score *= (matched / tokens.length) ** coverageExponent;
    if (score < minimumScore) continue;
    scored.push({
      id: document.entry.id,
      title: document.entry.title,
      heading: document.entry.heading,
      where: document.entry.where,
      url: document.entry.url,
      text: document.entry.text,
      score: Number(score.toFixed(4)),
    });
  }
  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return scored;
}

/** The whole corpus, one line each — what a bot should read when the user
 * asks the open question "what can Murage do?" rather than a specific one. */
export function helpTopics(corpus: readonly HelpEntry[] = HELP_INDEX): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const entry of corpus) {
    if (seen.has(entry.title)) continue;
    seen.add(entry.title);
    topics.push(entry.description ? `${entry.title}: ${entry.description}` : entry.title);
  }
  return topics;
}
