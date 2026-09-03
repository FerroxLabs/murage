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
 *  The catalogue entry alone is not enough. Smart Trader's summary never says
 *  "trading" — it says "read their own charts" — so a gate that read only the
 *  entry would reject the single best match in the library for "help me with
 *  trading". What a profile is FOR lives in the skills it ships, so those
 *  words count too; `extra` is where the caller passes them in. */
export function intakeVocabulary(entry: IntakeCatalogEntry, extra: readonly string[] = []): Set<string> {
  const text = [entry.name, entry.summary, entry.category, entry.outcome ?? "", entry.skills.join(" "), ...extra]
    .join(" ")
    .toLowerCase();
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** A topic word matches a profile word on the whole word, or on a prefix long
 *  enough to mean something.
 *
 *  Whole-word matching is the point: substring matching let "say" match "says"
 *  and hand `say "hi"` a book editor with a straight face. The four-character
 *  prefix rule is what still lets "charts" find "chart" and "invoices" find
 *  "invoice" without inventing a stemmer. */
function tokenHits(vocabulary: ReadonlySet<string>, token: string): boolean {
  if (vocabulary.has(token)) return true;
  if (token.length < 4) return false;
  for (const word of vocabulary) {
    if (word.length >= 4 && (word.startsWith(token) || token.startsWith(word))) return true;
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
 *  the card. A PREFIX ALONE IS NOT, once the person gave us more than one word
 *  to work with: `charts`→`chart` is a real plural, but a lone four-character
 *  prefix out of a five-word sentence is a coincidence dressed as a match.
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
