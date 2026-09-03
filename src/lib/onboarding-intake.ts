// The new-bot intake: one plain question, one configured agent.
//
// "New Bot" makes a blank bot — no profile, no skills, no question. This
// module is the decision layer that turns a person's own sentence into a
// suggestion: which assistant profile fits, and which skills that profile
// brings. It is pure on purpose. The server imports it for
// GET /api/library/suggest, the renderer imports it for the intake card, and
// the whole thing is testable without a database, a catalogue download, or a
// DOM (the renderer suite runs in a node environment).
//
// PROFILE FIRST, retrieval second. Measured against this catalogue: a matched
// profile's own declared skills are exactly the skills that profile ships,
// where free skill search puts `car-buying-guide` in the top five for "I want
// help with trading stocks and options". A curated set beats bm25 whenever a
// curated set exists — so loose skills are the fallback, never the first
// answer.

// The curated terms are imported through their `.ts` specifier because this
// module is loaded BY RAW NODE from server/index.ts (`node server/index.ts`,
// type stripping), and node resolves the path it is given — a `.js` specifier
// for a file that only exists as `.ts` is ERR_MODULE_NOT_FOUND, and an
// extensionless one is too. The type-only import at the bottom of this file
// can use `.js` precisely because it never survives to runtime. This one is a
// value import and does.
import { intakeGenericFilteredWords, intakeMatchTerms } from "../../shared/intake-matches.ts";

/** The shape the catalogue gives us for one assistant profile. Structural, so
 *  both `SearchableTeam` (server) and the wire type (renderer) satisfy it. */
export interface IntakeCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  /** Declared skills — repository paths or bare ids; see `librarySkillId`. */
  skills: string[];
}

/** A person's answer, ready to search with. Bounded because it becomes a
 *  query string, and trimmed because a stray newline is not a topic. */
export const INTAKE_ANSWER_MAX = 300;

export function intakeQuery(answer: string): string {
  return answer.replace(/\s+/g, " ").trim().slice(0, INTAKE_ANSWER_MAX);
}

/** Words that carry no topic.
 *
 *  The FTS5 layer already sanitises (server/skill-search.ts `toMatchExpression`
 *  quotes every token and ORs them, so "c++", 'say "hi"' and "AND" are all
 *  safe input and a plain sentence still returns rows). What it cannot do is
 *  tell a real match from a coincidence: bm25 always ranks *something* first.
 *  These words are dropped before the relevance gate so a profile can never
 *  qualify by containing "help". */
const INTAKE_STOPWORDS = new Set([
  "and", "are", "but", "can", "could", "for", "from", "get", "got", "has", "have", "help", "how",
  "into", "its", "just", "like", "look", "make", "mostly", "much", "need", "not", "now", "out",
  "please", "really", "should", "some", "someone", "something", "that", "the", "them", "then",
  "there", "they", "this", "using", "want", "wanted", "was", "what", "when", "where", "which",
  "who", "why", "will", "with", "would", "you", "your",
  // "help me with stuff and things" is a real answer a real person types, and
  // every one of these words is a placeholder for the topic rather than the
  // topic. Without them the sentence carried three "topic" words and bm25
  // duly ranked something, so the card answered a question nobody asked.
  "stuff", "thing", "things", "task", "tasks", "work", "everything", "anything", "lots", "bit",
]);

/** How many topic words one answer contributes. Beyond this the answer is a
 *  paragraph, and a paragraph matches everything. */
const MAX_TOPIC_TOKENS = 12;

/** Topic words in a person's own sentence, de-duplicated, in order. */
export function intakeTopicTokens(raw: string): string[] {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && !INTAKE_STOPWORDS.has(token));
  return [...new Set(tokens)].slice(0, MAX_TOPIC_TOKENS);
}

/** Everything a profile says about itself, as a set of words.
 *
 *  CURATED TERMS DECIDE. `shared/intake-matches.ts` carries a reviewed list
 *  per slug — the words that mean this profile — and when a slug has one it is
 *  the WHOLE vocabulary. `extra` is ignored there, deliberately: it is exactly
 *  what used to poison this set.
 *
 *  WHY. The old vocabulary was the catalogue entry plus every word of every
 *  one of the profile's ~25 skill manifests, which measures 200-600 words of
 *  ordinary English per profile — the manifests quote example user sentences
 *  ("the forecast keeps missing"). One whole-word hit anywhere in that bag
 *  confirmed a profile, so:
 *
 *    "ferret keeps escaping the hutch"  -> Customer Success Org, on `keeps`
 *    "gutters need doing before winter" -> Validate Before Build, on `before`
 *
 *  and no threshold separates those from a real match, because `smart-trader`
 *  on `trading` scores the same single whole-word hit. The reason the entry
 *  alone was not enough is still true — Smart Trader's summary says "read
 *  their own charts", never "trading" — and the curated list is where that
 *  word is now written down on purpose rather than scavenged.
 *
 *  A SLUG WITH NO CURATED LIST still matches, on ITS OWN ENTRY TEXT ONLY —
 *  name, summary, category, outcome — with the generic words taken out.
 *  That is the path a catalogue entry published after this build was cut
 *  takes, and it is deliberately the weaker answer.
 *
 *  NEITHER `extra` NOR `entry.skills` IS READ ANY MORE, and that is the whole
 *  point. The fallback used to be the entry PLUS every word of every skill
 *  manifest, which measures 37-461 words per profile on this library, MEDIAN
 *  257 — the pre-curation bag with a 554-word stoplist subtracted, and
 *  nothing else. `keeps` and `before` were gone; `walk` was not, and eight
 *  live profiles carry it. A curated slug matches on ~14 terms and an
 *  uncurated one on ~257, so the first remote slug that reuses local skill
 *  ids became a SUPER-ATTRACTOR: it entered the strong tier on ordinary
 *  English no curated profile could match, and one strong candidate is a
 *  one-press confirm card. The reachability is real — `intakeProfileAt` drops
 *  an entry whose skills do not resolve, and reusing local ids is exactly how
 *  a new remote entry resolves.
 *
 *  Entry text alone measures 7-31 words, median 15, which is the same ORDER
 *  as a curated list and makes the same kind of claim: a strong hit now needs
 *  the person's own word to appear in the profile's own copy. Dropping the
 *  skills as well as the manifests is the same argument twice — a "team
 *  launcher" entry declares the UNION of its members' skills, so skill-derived
 *  terms make every launcher a superset of every specialist it contains.
 *
 *  (Its tests live in `src/lib/onboarding-intake.test.ts` and, scored through
 *  the real classification path against the shipped catalogue, in
 *  `shared/intake-matches.test.ts`. An earlier note here said vite.config.ts's
 *  `test.include` does not cover `shared`; it does — line 14 lists it — so a
 *  suite beside the data really does run.) */
export function intakeVocabulary(
  entry: IntakeCatalogEntry,
  // Accepted and deliberately ignored, on BOTH paths now. Callers hand over
  // the profile's resolved skills because the signature has always taken
  // them; reading them is what this function stopped doing.
  _extra: readonly string[] = [],
): ReadonlySet<string> {
  const curated = intakeMatchTerms(entry.slug);
  if (curated) return curated;
  return intakeGenericFilteredWords([entry.name, entry.summary, entry.category, entry.outcome ?? ""].join(" "));
}

/** The endings one word may gain and still be the same word.
 *
 *  This is the whole of the module's stemming, written down. It is not a
 *  stemmer and must not become one: it is the list of English inflections
 *  that leave the topic unchanged, so `charts` is `chart` and `selling` is
 *  `sell`, and nothing else is anything else. */
const INTAKE_INFLECTIONS = ["s", "es", "d", "ed", "ing", "ings"];

/** Is `longer` just `shorter` with an inflection on the end? */
function isInflectionOf(longer: string, shorter: string): boolean {
  return longer.startsWith(shorter) && INTAKE_INFLECTIONS.includes(longer.slice(shorter.length));
}

/** A topic word matches a profile word whole, or on an INFLECTION of it.
 *
 *  Whole-word matching is the point: substring matching let "say" match "says"
 *  and hand `say "hi"` a book editor with a straight face. The inflection rule
 *  is what still lets "charts" find "chart" and "invoices" find "invoice"
 *  without inventing a stemmer.
 *
 *  A BARE PREFIX IS NOT AN INFLECTION, and used to be treated as one. 226
 *  curated terms were four or five characters (167 still are, and `comp`,
 *  `post`, `demo`, `prose` and `cash` are among them), and `vocabularyMatches` needs
 *  `Math.min(2, tokens.length)` hits — so a ONE-WORD answer, which is the
 *  commonest first thing a person types, needed exactly one prefix hit.
 *  Measured on the shipped catalogue, `anti` covered 1,118 dictionary words
 *  that way, `post` 508, `comp` 382, `spin` 131, and the results were what
 *  they sound like:
 *
 *    computer    -> Quiet Money Career Strategist  (via `comp`)
 *    scandal     -> Humanizer                      (via `scan`)
 *    deadline    -> Link Disclosure Custodian      (via `dead`)
 *    antibiotics -> Quiet Money                    (via `anti`)
 *    spinal      -> Sales                          (via `spin`)
 *
 *  None of those five endings — `uter`, `dal`, `line`, `biotics`, `al` — is a
 *  plural or a tense. Requiring one costs nothing the four-character rule was
 *  ever bought for, because `charts`/`chart`, `invoices`/`invoice` and
 *  `onboard`/`onboarding` are all inflections and all still match.
 *
 *  The four-character floor stays on BOTH sides: it is what keeps three-letter
 *  words out of this loop entirely, and shortening it is a separate argument
 *  from this one. */
function tokenHits(vocabulary: ReadonlySet<string>, token: string): boolean {
  if (vocabulary.has(token)) return true;
  if (token.length < 4) return false;
  for (const word of vocabulary) {
    if (word.length < 4) continue;
    if (word.length >= token.length ? isInflectionOf(word, token) : isInflectionOf(token, word)) return true;
  }
  return false;
}

/** Does this profile actually talk about what the person asked for?
 *
 *  This is the gate that makes "no match" a real answer. Without it the
 *  intake would confidently suggest whatever bm25 put first — measured:
 *  `say "hi"` ranks a book editor, `NOT OR AND` ranks a co-working profile.
 *  Suggesting either would teach the person the question is decorative. */
export function intakeProfileMatches(
  entry: IntakeCatalogEntry,
  tokens: readonly string[],
  extra: readonly string[] = [],
): boolean {
  return vocabularyMatches(intakeVocabulary(entry, extra), tokens);
}

/** The gate itself, over any bag of words: a profile's vocabulary or a single
 *  skill's.
 *
 *  ONE WHOLE WORD IS ENOUGH — "chasing invoices" must reach the profile whose
 *  own copy says "invoices", because that sentence is the example printed on
 *  the card. AN INFLECTION ALONE IS NOT, once the person gave us more than one
 *  word to work with: `charts`→`chart` is a real plural, but one inflected hit
 *  out of a five-word sentence is a coincidence dressed as a match.
 *
 *  `Math.min(2, tokens.length)` rather than a flat 2 is deliberate and load
 *  bearing: a one-word answer has no second token to corroborate with, and
 *  demanding one there would break `charts`→`chart` and `invoices`→`invoice`,
 *  which is the only stemming this module has. */
function vocabularyMatches(vocabulary: ReadonlySet<string>, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const needed = Math.min(2, tokens.length);
  let hits = 0;
  for (const token of tokens) {
    if (vocabulary.has(token)) return true;
    if (!tokenHits(vocabulary, token)) continue;
    hits += 1;
    if (hits >= needed) return true;
  }
  return false;
}

/** How many loose skills the fallback may offer.
 *
 *  Was eight, unchecked-by-nobody and pre-ticked by the card, which is how
 *  typing "hi" produced eight pre-selected strangers in a 1,379px-tall card.
 *  Three is a list a person reads; eight is a list a person scrolls past and
 *  accepts. */
export const INTAKE_LOOSE_SKILL_MAX = 3;

/** Every word one skill offers the gate, as a set. */
export function intakeSkillVocabulary(skill: IntakeSkill): Set<string> {
  return new Set(
    describeIntakeSkill(skill)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/** Does this loose skill actually talk about what the person asked for? */
export function intakeSkillMatches(skill: IntakeSkill, tokens: readonly string[]): boolean {
  return vocabularyMatches(intakeSkillVocabulary(skill), tokens);
}

/** The loose-skill fallback, gated exactly the way a profile is.
 *
 *  THE HEADLINE BUG LIVED HERE. The route fell through to `searchSkills(q, 8)`
 *  with no gate at all, so an answer with no topic words in it — "hi" — still
 *  came back with eight skills, and the card pre-ticked every one. An empty
 *  token list now yields an empty list, full stop: there is nothing a skill
 *  could be relevant TO, so the honest answer is none. */
export function chooseIntakeSkills(
  query: string,
  ranked: readonly IntakeSkill[],
  max: number = INTAKE_LOOSE_SKILL_MAX,
): IntakeSkill[] {
  const tokens = intakeTopicTokens(query);
  if (tokens.length === 0) return [];
  const kept: IntakeSkill[] = [];
  for (const skill of ranked) {
    if (!intakeSkillMatches(skill, tokens)) continue;
    kept.push(skill);
    if (kept.length >= max) break;
  }
  return kept;
}

/** The id that names a skill inside `skills-library/`.
 *
 *  Catalogue entries declare repository paths
 *  ("teams/smart-trader/skills/chart-analysis/SKILL.md"); package manifests
 *  declare bare ids ("beacon-channel-strategy"). Both resolve to the same
 *  directory name, which is what the install route takes. */
export function librarySkillId(declared: string): string {
  const parts = declared.split("/").filter(Boolean);
  if (parts.length <= 1) return declared.trim();
  const last = parts.at(-1)!;
  return (/\.[a-z]+$/i.test(last) ? (parts.at(-2) ?? "") : last).trim();
}

/** Declared skills reduced to unique library ids, in declared order. */
export function librarySkillIds(declared: readonly string[], max: number): string[] {
  const ids: string[] = [];
  for (const entry of declared) {
    const id = librarySkillId(entry);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

/** Pick the profile to suggest, or null when nothing really matches.
 *
 *  `ranked` arrives best-first from the catalogue's own bm25 search; this walks
 *  it and returns the first candidate that BOTH talks about the topic and
 *  actually ships skills this build can install. A profile whose skills are
 *  all missing would apply a persona and nothing else, which is not what the
 *  card promises — so it is skipped rather than shipped as a half-answer.
 *
 *  Returning null is a first-class outcome: it is what routes the caller to
 *  the loose-skill fallback instead of guessing. */
export function chooseIntakeProfile<Entry extends IntakeCatalogEntry, Skill>(
  query: string,
  ranked: readonly Entry[],
  resolveSkills: (entry: Entry) => Skill[],
  describeSkill: (skill: Skill) => string = () => "",
): { entry: Entry; skills: Skill[] } | null {
  const tokens = intakeTopicTokens(query);
  if (tokens.length === 0) return null;
  for (const entry of ranked) {
    // Skills first: they decide BOTH whether this profile is worth offering
    // and, through their own words, whether it is about the right thing.
    const skills = resolveSkills(entry);
    if (skills.length === 0) continue;
    if (!intakeProfileMatches(entry, tokens, skills.map(describeSkill))) continue;
    return { entry, skills };
  }
  return null;
}

// ── wire types, shared by the route and the card ──────────────────────

export interface IntakeSkill {
  id: string;
  name: string;
  description: string;
  /** The skill manifest's own trigger terms. Not shown — they are what lets
   *  the relevance gate know `chart-analysis` is about trading. */
  terms: string[];
}

/** Every word a skill offers the gate. */
export function describeIntakeSkill(skill: IntakeSkill): string {
  return `${skill.id} ${skill.name} ${skill.description} ${skill.terms.join(" ")}`;
}

/** The profile offered when the catalogue matched nothing at all.
 *
 * Concierge cannot win the matcher and should not try. Its value is being
 * generic, and `intakeProfileMatches` rewards topic-specific vocabulary — so
 * padding its summary with filler to make it rank is both a lie and the exact
 * trick that made the bare word "say" start matching Researcher. It reaches
 * people the one honest way: as the answer to "nothing matched", which is
 * precisely the question a front door exists to answer. */
export const INTAKE_FRONT_DOOR_SLUG = "concierge";

export interface IntakeProfile {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome: string | null;
  skills: IntakeSkill[];
  /** True when this is the front door rather than a match. The card has to
   * say so: offering Concierge as though the catalogue had found it would be
   * the confident wrong answer that returning null exists to prevent. */
  fallback?: boolean;
}

export interface IntakeSuggestion {
  query: string;
  profile: IntakeProfile | null;
  skills: IntakeSkill[];
}

// ── the three calls the intake is allowed to make ─────────────────────
//
// Deliberately a closed set, and deliberately in one place. Accepting a
// suggestion configures THE BOT YOU ARE IN — none of these creates a bot.
// `POST /api/teams/import` does the right thing for "import a team" (every
// member becomes a new bot) and exactly the wrong thing here: it would leave
// an orphan blank bot in the sidebar beside the one you thought you were
// setting up. That route is not reachable from this module, and a test pins
// that.

/** The transport. `api()` in src/state/store.tsx satisfies this and always
 *  sends `x-murage-surface: desktop`, which the apply route requires. */
export type IntakeRequest = (path: string, init?: RequestInit) => Promise<any>;

/** Ask the library what fits an answer. A read — it configures nothing. */
export async function suggestForAnswer(answer: string, request: IntakeRequest): Promise<IntakeSuggestion> {
  const query = intakeQuery(answer);
  const response = (await request(`/api/library/suggest?q=${encodeURIComponent(query)}`)) as IntakeSuggestion;
  return {
    query,
    profile: response?.profile ?? null,
    skills: Array.isArray(response?.skills) ? response.skills : [],
  };
}

export interface AppliedProfile {
  bot: { id: string; name: string } & Record<string, unknown>;
  installed: Array<{ name: string }>;
  errors: string[];
}

/** Apply a library profile to an EXISTING bot: persona, then its skills,
 *  switched on. One call, one bot — the one named here. */
export async function applyProfileToBot(
  botId: string,
  slug: string,
  request: IntakeRequest,
  options: { rename?: boolean } = {},
): Promise<AppliedProfile> {
  const response = (await request(`/api/bots/${botId}/assistant-profile`, {
    method: "POST",
    body: JSON.stringify({ slug, ...(options.rename === false ? { rename: false } : {}) }),
  })) as AppliedProfile;
  return {
    bot: response.bot,
    installed: Array.isArray(response?.installed) ? response.installed : [],
    errors: Array.isArray(response?.errors) ? response.errors : [],
  };
}

/** Assign bundled skills to an existing bot. The same primitive behind
 *  "Assign to agent" in the library and "Add a skill" in a bot's own Skills
 *  panel — both ends of one action, `assign(skillId, botId)`. */
export async function assignSkillsToBot(
  botId: string,
  skillIds: readonly string[],
  request: IntakeRequest,
): Promise<{ installed: Array<{ name: string }>; errors: string[] }> {
  const response = (await request(`/api/bots/${botId}/skills/library`, {
    method: "POST",
    body: JSON.stringify({ ids: [...skillIds] }),
  })) as { installed?: Array<{ name: string }>; errors?: string[] };
  return {
    installed: Array.isArray(response?.installed) ? response.installed : [],
    errors: Array.isArray(response?.errors) ? response.errors : [],
  };
}

/** What the primary button says. The outcome, with the agent's real name in
 *  it — never the category, never "Apply". A person should be able to read
 *  one line and know exactly what is about to happen to which agent. */
export function applyProfileLabel(botName: string, profileName: string): string {
  return `Set up ${botName} as ${profileName}`;
}

export function addSkillsLabel(botName: string, count: number): string {
  return count === 1 ? `Add 1 skill to ${botName}` : `Add ${count} skills to ${botName}`;
}

/** The sentence under the button. It names the rename explicitly, because a
 *  rename the person did not expect is the one surprise this flow could
 *  spring. */
export function applyProfileDetail(profile: IntakeProfile, botName: string, rename: boolean): string {
  const count = profile.skills.length;
  const skills = count === 1 ? "1 skill" : `${count} skills`;
  return rename && profile.name !== botName
    ? `Renames this agent to ${profile.name} and switches on ${skills}.`
    : `Keeps the name ${botName} and switches on ${skills}.`;
}

// ── the setup CONVERSATION ────────────────────────────────────────────
//
// Everything above answers "what fits this sentence?". Everything below is
// the conversation that asks the sentence for, in the transcript, as the bot
// talking. It lives here rather than in the component for one reason: the
// renderer suite has no DOM, so a decision inside a `.tsx` is a decision no
// test can execute. The component below this line is a renderer; the rules
// are here.
//
// The type is imported through its `.js` specifier so this file stays
// importable by BOTH toolchains: the server reaches it under NodeNext, which
// requires an extension, and the renderer compiles under `bundler`, which
// forbids a bare `.ts` one. It is a type-only import, so nothing survives to
// runtime either way.

import type { IntakeCardData } from "../../shared/intake-turn.js";

/** The intake payload on a card, read defensively.
 *
 *  Read rather than trusted because it arrives as JSON over SSE, and because
 *  the two invariants worth enforcing are cheap to enforce here and expensive
 *  to debug anywhere else:
 *
 *    I2  `intake` and `requestId` are never both set. A live provider ask
 *        that somehow carried an intake payload must render as the approval
 *        it is, not as a setup question with buttons that install things.
 *    I3  `asked` is 1 or 2. Never 3. Anything else is clamped rather than
 *        rendered, so a malformed card cannot become a third question. */
export function readIntakeCard(
  card: { intake?: unknown; requestId?: string } | undefined | null,
): IntakeCardData | null {
  if (!card || card.requestId) return null;
  const intake = card.intake as Partial<IntakeCardData> | undefined;
  if (!intake || typeof intake !== "object") return null;
  if (intake.step !== "open" && intake.step !== "narrow" && intake.step !== "confirm") return null;
  return {
    ...intake,
    step: intake.step,
    asked: intake.asked === 2 ? 2 : 1,
  };
}

/** The question currently on the table, or null.
 *
 *  THE LAST one, not the first: a thread that has been through both questions
 *  carries two intake cards, and the open one is always the later. `answered`
 *  is the server's own record of the turn being spent, so a card the person
 *  has replied to can never take the composer's next line as a second answer.
 *
 *  This is what makes I7 real. Every intake question accepts free text,
 *  because the composer is on screen at every turn and asks this function
 *  where to send what was typed. No chip is ever the only way to answer. */
export function openIntakeCard<
  M extends { id: string; kind: string; card?: { intake?: unknown; answered?: string } },
>(messages: readonly M[]): M | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.kind !== "options") continue;
    if (message.card?.answered) continue;
    if (!readIntakeCard(message.card)) continue;
    return message;
  }
  return null;
}

/** Where every turn of the conversation is posted. Not desktop-gated: it
 *  reads the catalogue and writes transcript text, and it installs nothing.
 *  The install still crosses the desktop boundary on `assistant-profile`. */
export function intakePath(botId: string): string {
  return `/api/bots/${botId}/intake`;
}

/** ANSWERING A QUESTION: a chip press, or a composer send while a question is
 *  open. The label goes back exactly as it arrived — the renderer never sends
 *  a step, a slug or a decision, because the server reads the step off its own
 *  stored card and a renderer that decided would be a second source of truth
 *  for the same conversation. */
export async function replyToIntake(
  botId: string,
  messageId: string,
  text: string,
  request: IntakeRequest,
): Promise<void> {
  await request(intakePath(botId), {
    method: "POST",
    body: JSON.stringify({ messageId, text }),
  });
}

/** CLOSING A CONFIRM CARD. The one place the renderer sends a decision, and
 *  it sends the outcome rather than any sentence: the closing line is the
 *  server's to write. */
export async function closeIntakeCard(
  botId: string,
  messageId: string,
  outcome: "profile" | "general" | "library",
  request: IntakeRequest,
): Promise<void> {
  await request(intakePath(botId), {
    method: "POST",
    body: JSON.stringify({ messageId, outcome }),
  });
}

/** What the confirm card's first chip does, in order, once.
 *
 *  THE ORDER IS THE FEATURE. A questionnaire that files the answers away and
 *  changes nothing on screen is the recorded failure this conversation exists
 *  to avoid, so the identity lands in the sidebar and the header BEFORE the
 *  round trip that writes the closing line, not after it and not whenever SSE
 *  gets around to it.
 *
 *  `rename: false` is pinned and not a default: the person may have named
 *  this agent, and an agent that renames itself in the middle of a
 *  conversation with the person who named it is the one surprise this flow
 *  could spring. A rename belongs on the profile panel, where it is asked for.
 *
 *  The count is PUBLISHED, never invalidated: an invalidation reads `null`
 *  for a frame, `null` means "not known", and "not known" flashes the
 *  unconfigured state back onto the screen.
 *
 *  A failure to apply throws before the card is closed, so the question stays
 *  open and the press can be repeated. Per-skill `errors` are not that: the
 *  profile did apply, so the conversation ends and the caller renders them. */
export async function confirmIntakeProfile(
  botId: string,
  messageId: string,
  slug: string,
  deps: {
    request: IntakeRequest;
    announceBot: (bot: AppliedProfile["bot"]) => void;
    publishSkillCount: (botId: string, count: number) => void;
  },
): Promise<AppliedProfile> {
  const applied = await applyProfileToBot(botId, slug, deps.request, { rename: false });
  deps.announceBot(applied.bot);
  deps.publishSkillCount(botId, Math.max(applied.installed.length, 1));
  await closeIntakeCard(botId, messageId, "profile", deps.request);
  return applied;
}

/** What a chip press means, decided by POSITION rather than by its words.
 *
 *  A renderer that compared the label against a sentence of its own would be
 *  a second copy of the bot's script, and the first copy edit on the server
 *  would quietly turn the accept chip into a no-op that still looks fine. The
 *  server chose the order when it wrote the card: on a confirm card the first
 *  option accepts and the second declines. Every other turn sends the label
 *  straight back for the server to match against its own stored card.
 *
 *  GENERAL CHAT IS AN OUTCOME, NOT A FAILURE, and this is where that is true
 *  mechanically: from the profile card it is one press away, and it installs
 *  nothing, asks nothing further, and needs no third question to reach. */
export type IntakeChipAction =
  | { kind: "apply"; slug: string }
  | { kind: "close"; outcome: "general" | "library" }
  | { kind: "reply"; text: string };

export function intakeChipAction(
  intake: IntakeCardData,
  options: readonly string[],
  index: number,
): IntakeChipAction | null {
  const label = options[index];
  if (label === undefined) return null;
  if (intake.step !== "confirm") return { kind: "reply", text: label };
  if (intake.outcome === "profile") {
    if (index !== 0) return { kind: "close", outcome: "general" };
    const slug = intake.candidate?.slug ?? "";
    return slug ? { kind: "apply", slug } : null;
  }
  return { kind: "close", outcome: index === 0 ? "general" : "library" };
}
