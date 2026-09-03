// The new-bot intake's decision layer.
//
// Three kinds of test, in order of how much they can be fooled:
//
//  1. PURE — the gate and the token rules, stated directly.
//  2. REAL CORPUS — the same ranking the route runs, against the real
//     catalogue in library/catalog.json and the real FTS5 index over
//     skills-library/. This is what proves "trading" finds Smart Trader and
//     not `car-buying-guide`.
//  3. WIRE — which endpoints the intake is allowed to call. Accepting a
//     suggestion must configure THE BOT YOU ARE IN; a test that only checked
//     the happy path would pass just as well if it created a second bot.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyProfileDetail,
  applyProfileLabel,
  applyProfileToBot,
  assignSkillsToBot,
  chooseIntakeProfile,
  chooseIntakeSkills,
  closeIntakeCard,
  confirmIntakeProfile,
  describeIntakeSkill,
  intakeChipAction,
  intakeProfileMatches,
  intakeSkillMatches,
  intakeVocabulary,
  INTAKE_LOOSE_SKILL_MAX,
  intakeQuery,
  intakeTopicTokens,
  librarySkillId,
  librarySkillIds,
  openIntakeCard,
  readIntakeCard,
  replyToIntake,
  suggestForAnswer,
  type IntakeCatalogEntry,
  type IntakeSkill,
} from "./onboarding-intake";
import { INTAKE_GENERIC_WORDS, INTAKE_MATCH_TERMS, intakeMatchTerms } from "../../shared/intake-matches";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SKILL_LIBRARY = join(REPO, "skills-library");

// The server modules are loaded by URL rather than by a static specifier on
// purpose: `tsconfig.json` compiles `src` WITHOUT `allowImportingTsExtensions`,
// so a static import here would drag the whole server tree into the renderer's
// type program and fail `tsc -b` on every `./foo.ts` import inside it. The
// modules themselves are the real ones — this is a resolution detail, not a
// stub.
const SERVER = new URL("../../server/", import.meta.url).href;
const { searchCatalog, searchSkills, toMatchExpression } = (await import(
  /* @vite-ignore */ `${SERVER}skill-search.ts`
)) as {
  searchCatalog: (teams: any[], query: string, limit?: number) => Array<{ slug: string }>;
  searchSkills: (query: string, limit?: number) => Promise<Array<{ id: string }>>;
  toMatchExpression: (raw: string) => string;
};
const { fetchTeamCatalog } = (await import(/* @vite-ignore */ `${SERVER}team-library.ts`)) as {
  fetchTeamCatalog: () => Promise<{ teams: IntakeCatalogEntry[] }>;
};

/** The route's own resolver, reproduced by behaviour rather than by import:
 *  a declared skill counts only when this build actually carries it, and it
 *  arrives with the manifest's own words attached. */
const resolveSkills = (entry: IntakeCatalogEntry): IntakeSkill[] =>
  librarySkillIds(entry.skills, 25).flatMap((id) => {
    const manifest = join(SKILL_LIBRARY, id, "manifest.json");
    if (!existsSync(manifest)) return [];
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    return [{
      id,
      name: String(parsed.name ?? id),
      description: String(parsed.description ?? ""),
      terms: Array.isArray(parsed.triggerTerms) ? (parsed.triggerTerms as string[]) : [],
    }];
  });

/** The whole suggest pipeline, exactly as `intakeProfileFor` composes it. */
async function suggestProfile(query: string) {
  const catalog = await fetchTeamCatalog();
  const bySlug = new Map(catalog.teams.map((team) => [team.slug, team]));
  const ranked = searchCatalog(catalog.teams, query, 8).flatMap((hit) => {
    const entry = bySlug.get(hit.slug);
    return entry ? [entry] : [];
  });
  return chooseIntakeProfile(query, ranked, resolveSkills, describeIntakeSkill);
}

const skillIds = (chosen: Awaited<ReturnType<typeof suggestProfile>>) =>
  (chosen?.skills ?? []).map((skill) => skill.id);

/** THE WHOLE ROUTE, composed the way `GET /api/library/suggest` composes it —
 *  tokens first, and the tokens gate BOTH halves of the answer. Reproduced
 *  here rather than imported because index.ts boots a server on import; a
 *  source-contract test below pins that the route still reads like this. */
async function suggest(query: string): Promise<{ profile: string | null; skills: string[] }> {
  const tokens = intakeTopicTokens(query);
  const chosen = tokens.length === 0 ? null : await suggestProfile(query);
  if (chosen) return { profile: chosen.entry.slug, skills: [] };
  // Deliberately NOT short-circuited on empty tokens the way the route is.
  // The route's guard saves an FTS query and is pinned by its own contract
  // test; running the real search here means these cases depend on the GATE,
  // so removing the gate turns them red rather than leaning on a guard that
  // happens to sit in front of it.
  const ranked = (await searchSkills(query, 12)) as unknown as IntakeSkill[];
  return { profile: null, skills: chooseIntakeSkills(query, ranked).map((skill) => skill.id) };
}

// ── 1. the gate ───────────────────────────────────────────────────────

describe("topic tokens", () => {
  it("keeps the words that name work and drops the ones that do not", () => {
    expect(intakeTopicTokens("I mostly want help with my trading charts")).toEqual(["trading", "charts"]);
  });

  it("has no tokens at all for a sentence made only of filler", () => {
    // This is what makes "no match" reachable: with no topic word there is
    // nothing a profile could match, so nothing gets suggested.
    expect(intakeTopicTokens("what should I do")).toEqual([]);
    expect(intakeTopicTokens("NOT OR AND")).toEqual([]);
  });

  it("trims and bounds a person's answer before it becomes a query", () => {
    expect(intakeQuery("  reading   my\ncharts  ")).toBe("reading my charts");
    expect(intakeQuery("x".repeat(400))).toHaveLength(300);
  });
});

describe("the relevance gate", () => {
  const trader: IntakeCatalogEntry = {
    slug: "smart-trader",
    name: "Smart Trader",
    summary: "You help someone read their own charts.",
    category: "Markets",
    skills: ["teams/smart-trader/skills/chart-analysis/SKILL.md"],
  };

  it("accepts a profile that actually talks about the topic", () => {
    expect(intakeProfileMatches(trader, ["trading", "charts"])).toBe(true);
  });

  it("matches a plural against the singular in the profile's own words", () => {
    // "charts" must find "chart". Nothing stems further than that.
    //
    // The slug is deliberately NOT a catalogue slug. `smart-trader` has a
    // curated term list now, and that list contains the whole word `charts` —
    // so running this against it would go green on a whole-word hit and stop
    // exercising the prefix rule it is named after. An unknown slug takes the
    // fallback path, which is where "the profile's own words" still means the
    // summary.
    expect(intakeProfileMatches({ ...trader, slug: "not-in-the-catalogue", summary: "reads a chart" }, ["charts"]))
      .toBe(true);
  });

  it("rejects a profile that shares no topic word with the answer", () => {
    // bm25 always ranks SOMETHING first — measured, `say "hi"` ranks a book
    // editor. Without this the intake would suggest it with a straight face.
    expect(intakeProfileMatches(trader, ["invoices", "bookkeeping"])).toBe(false);
  });

  it("rejects everything when the answer carried no topic at all", () => {
    expect(intakeProfileMatches(trader, [])).toBe(false);
  });
});

describe("library skill ids", () => {
  it("reads the id out of a catalogue repository path", () => {
    expect(librarySkillId("teams/smart-trader/skills/chart-analysis/SKILL.md")).toBe("chart-analysis");
  });

  it("leaves a bare package id alone", () => {
    expect(librarySkillId("beacon-channel-strategy")).toBe("beacon-channel-strategy");
  });

  it("de-duplicates and bounds a declared list", () => {
    expect(librarySkillIds(["a/skills/x/SKILL.md", "x", "y"], 2)).toEqual(["x", "y"]);
  });
});

describe("choosing a profile", () => {
  const entry = (slug: string, extra: Partial<IntakeCatalogEntry> = {}): IntakeCatalogEntry => ({
    slug,
    name: slug,
    summary: "trading charts",
    category: "Markets",
    skills: ["chart-analysis"],
    ...extra,
  });

  it("skips a topical profile whose skills this build does not carry", () => {
    // A profile that would apply a persona and NOTHING else is not what the
    // card promises, so the fallback is the honest answer.
    const chosen = chooseIntakeProfile("trading charts", [entry("ghost"), entry("real")], (candidate) =>
      candidate.slug === "real" ? ["chart-analysis"] : [],
    );
    expect(chosen?.entry.slug).toBe("real");
  });

  it("returns null rather than the top-ranked stranger", () => {
    expect(chooseIntakeProfile("invoices", [entry("smart-trader")], () => ["chart-analysis"])).toBeNull();
  });

  it("returns null when the answer has no topic words", () => {
    expect(chooseIntakeProfile("what should I do", [entry("smart-trader")], () => ["x"])).toBeNull();
  });
});

// ── 2. the real corpus ────────────────────────────────────────────────

describe("against the shipped catalogue and skill index", () => {
  it("answers a trading sentence with Smart Trader and only its own skills", async () => {
    const chosen = await suggestProfile("I want help with trading stocks and options");
    expect(chosen?.entry.slug).toBe("smart-trader");
    expect(skillIds(chosen)).toContain("chart-analysis");
    // The measured failure this design exists to avoid: free skill search puts
    // `car-buying-guide` in the top five for this exact sentence. Narrowing to
    // the matched profile's declared skills cannot reach it.
    expect(skillIds(chosen)).not.toContain("car-buying-guide");
    expect(await searchSkills("I want help with trading stocks and options", 5)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "car-buying-guide" })]),
    );
  });

  it("answers plain speech, not just keywords", async () => {
    expect((await suggestProfile("help me read my trading charts"))?.entry.slug).toBe("smart-trader");
  });

  it("suggests nothing for a sentence with no topic in it", async () => {
    // Both of these DO rank a profile first — measured: a book editor and a
    // co-working profile. The gate is the only thing between them and the card.
    expect(await suggestProfile('say "hi"')).toBeNull();
    expect(await suggestProfile("NOT OR AND")).toBeNull();
  });

  it("takes any sentence a person can type without throwing", async () => {
    // The FTS5 sanitiser already exists (server/skill-search.ts
    // `toMatchExpression`): every token is quoted and the tokens are OR-ed, so
    // punctuation is inert and a plain sentence still returns rows. This pins
    // that, because losing it would break every query at once.
    const catalog = await fetchTeamCatalog();
    const inputs = [
      "c++", 'say "hi"', "AND", "NOT OR AND", "^weird ^query", "budget & spending: where's my money going?",
      "day trading & charts (TradingView)", "legal contracts - NDA", "book keeping / taxes", "", "   ", "a",
    ];
    for (const input of inputs) {
      expect(() => toMatchExpression(input), input).not.toThrow();
      expect(() => searchCatalog(catalog.teams, input, 5), input).not.toThrow();
      await expect(searchSkills(input, 5), input).resolves.toBeInstanceOf(Array);
    }
    // and a plain sentence is not silently empty — FTS5's implicit AND would
    // have made it so
    expect((await searchSkills("writing blog posts", 5)).length).toBeGreaterThan(0);
  });
});

describe("the fallback, which is where the headline bug lived", () => {
  it('ANSWERS "hi" WITH NOTHING AT ALL', async () => {
    // The bug, in the user's own words: typing "hi" produced eight pre-ticked
    // irrelevant skills. "hi" is two characters — it survives no token rule —
    // so there is nothing it could be relevant TO, and the ungated
    // `searchSkills(q, 8)` behind it was the entire defect.
    expect(intakeTopicTokens("hi")).toEqual([]);
    expect(await suggest("hi")).toEqual({ profile: null, skills: [] });
  });

  it("answers filler with nothing, however many words the filler is", async () => {
    for (const q of ["hi", "hey there", "help me", "what should I do", "NOT OR AND", "", "   "]) {
      expect(await suggest(q), q).toEqual({ profile: null, skills: [] });
    }
  });

  it('answers "help me with stuff and things" with nothing', async () => {
    // H2. Every word here is a placeholder for the topic rather than the
    // topic. Before the stopwords landed this sentence carried three "topic"
    // words and bm25 duly ranked something.
    expect(intakeTopicTokens("help me with stuff and things")).toEqual([]);
    expect(await suggest("help me with stuff and things")).toEqual({ profile: null, skills: [] });
  });

  it("offers at most three loose skills, never eight", async () => {
    expect(INTAKE_LOOSE_SKILL_MAX).toBe(3);
    const ranked = (await searchSkills("writing blog posts", 12)) as unknown as IntakeSkill[];
    expect(ranked.length).toBeGreaterThan(3);
    expect(chooseIntakeSkills("writing blog posts", ranked).length).toBeLessThanOrEqual(3);
  });

  it("gates a loose skill the same way it gates a profile", () => {
    const skill: IntakeSkill = {
      id: "chart-analysis",
      name: "Chart analysis",
      description: "Read a price chart.",
      terms: ["trading"],
    };
    expect(intakeSkillMatches(skill, ["trading"])).toBe(true);
    expect(intakeSkillMatches(skill, ["invoices"])).toBe(false);
    expect(intakeSkillMatches(skill, [])).toBe(false);
    // The ranked order survives the gate — it is a filter, not a re-rank.
    const other: IntakeSkill = { id: "b", name: "b", description: "trading desk", terms: [] };
    expect(chooseIntakeSkills("trading", [skill, other]).map((s) => s.id)).toEqual(["chart-analysis", "b"]);
  });
});

describe("vague input, and the one sentence the card prints on itself", () => {
  it('"CHASING INVOICES" — the card\'s own example — gets a relevant answer, not a stranger', async () => {
    // WRITTEN FIRST. The card literally prints this phrase as an example of
    // what to type, so answering it with nothing would be telling a person to
    // type something and then refusing it.
    //
    // Measured against the shipped corpus: bm25 ranks exactly one profile for
    // this sentence — IGNITION, "takes a total beginner from blank page to one
    // live income asset in 7 days" — which reaches the gate only through the
    // prefix `invoices`→`invoice` and is the textbook top-ranked stranger. The
    // right answer is the receivables SKILL, offered as something to learn.
    const answer = await suggest("chasing invoices");
    expect(answer.profile, JSON.stringify(answer)).not.toBe("ignition");
    expect(answer.skills.length, JSON.stringify(answer)).toBeGreaterThan(0);
    expect(answer.skills.join(" ")).toMatch(/invoic|receivable|billing|payment/);
  });

  it("still stems the one plural it ever stemmed", async () => {
    // The 4-char prefix rule is load-bearing: charts→chart, invoices→invoice.
    expect((await suggestProfile("reading my trading charts"))?.entry.slug).toBe("smart-trader");
    expect(intakeProfileMatches({
      slug: "t", name: "Smart Trader", summary: "reads a chart", category: "Markets", skills: ["chart-analysis"],
    }, ["charts"])).toBe(true);
  });

  it("will not let one loose prefix out of a whole sentence carry a profile", () => {
    // Two topic words, one weak prefix hit, no whole word: not a match.
    const entry: IntakeCatalogEntry = {
      slug: "reader", name: "Reader", summary: "reading group notes", category: "Life", skills: ["x"],
    };
    expect(intakeProfileMatches(entry, ["readings", "invoices"])).toBe(false);
    // The same single hit, from a one-word answer, still counts — there is no
    // second token to corroborate with and `charts`→`chart` depends on it.
    expect(intakeProfileMatches(entry, ["readings"])).toBe(true);
  });
});

// ── 2b. curated match terms ───────────────────────────────────────────
//
// The bug these exist for, in the two sentences that reproduced it:
//
//   "ferret keeps escaping the hutch"  -> Customer Success Org, on `keeps`
//   "gutters need doing before winter" -> Validate Before Build, on `before`
//
// Both were ONE whole-word hit against the profile's old vocabulary — the
// catalogue entry plus every word of every one of its ~25 skill manifests,
// 200-600 words of ordinary English per profile. `keeps` came from a manifest
// quoting a user ("the forecast keeps missing"); `before` came from that
// profile's own NAME. No threshold separates those from a real match:
// `smart-trader` on `trading` is also exactly one whole-word hit, which is why
// four scoring axes were measured and all four overlapped.

/** The setup conversation's own classifier, reproduced by behaviour the way
 *  `suggest` above reproduces the route. `classifyIntakeCandidates` in
 *  server/index.ts cannot be imported — index.ts boots a server on import —
 *  so this restates it: EVERY entry is classified (bm25 never filters, only
 *  orders within a tier), a profile that resolves no skill is not a candidate,
 *  and each tier is capped. Diverging from the server would make this table
 *  measure nothing, so `INTAKE_TIER_MAX` and the tier rule are pinned by the
 *  source-contract test in this file. */
async function classify(query: string): Promise<{ strong: string[]; weak: string[] }> {
  const tokens = intakeTopicTokens(query);
  if (tokens.length === 0) return { strong: [], weak: [] };
  const { teams } = await fetchTeamCatalog();
  const rank = new Map<string, number>();
  searchCatalog(teams, query, 100).forEach((hit, index) => {
    if (!rank.has(hit.slug)) rank.set(hit.slug, index);
  });
  const tiers: Record<"strong" | "weak", Array<{ order: number; slug: string }>> = { strong: [], weak: [] };
  teams.forEach((entry, index) => {
    const skills = resolveSkills(entry);
    if (skills.length === 0) return;
    const extra = skills.map(describeIntakeSkill);
    const vocabulary = intakeVocabulary(entry, extra);
    const strength = tokens.length >= 2 && tokens.some((token) => vocabulary.has(token))
      ? "strong"
      : intakeProfileMatches(entry, tokens, extra) ? "weak" : null;
    if (!strength) return;
    tiers[strength].push({ order: rank.get(entry.slug) ?? teams.length + index, slug: entry.slug });
  });
  const tier = (list: Array<{ order: number; slug: string }>) =>
    list.sort((left, right) => left.order - right.order).slice(0, 3).map((ranked) => ranked.slug);
  return { strong: tier(tiers.strong), weak: tier(tiers.weak) };
}

describe("the two sentences that reproduced the bug", () => {
  it('"ferret keeps escaping the hutch" is not a business need, and gets no profile', async () => {
    // BEFORE: strong = customer-success-org, dev-shop, founder-setup — all
    // three on the single word `keeps`. Asking again is the right answer.
    expect(intakeTopicTokens("ferret keeps escaping the hutch")).toEqual(["ferret", "keeps", "escaping", "hutch"]);
    expect(await classify("ferret keeps escaping the hutch")).toEqual({ strong: [], weak: [] });
  });

  it('"gutters need doing before winter" does not match the profile whose NAME says "before"', async () => {
    // BEFORE: strong = validate-before-build, quiet-money-position-auditor,
    // advisor. The first of those matched on a word taken out of its own name.
    expect(await classify("gutters need doing before winter")).toEqual({ strong: [], weak: [] });
  });

  it("still reaches Validate Before Build when the sentence is actually about validating", async () => {
    // The fix must not make the profile unreachable — only unreachable BY
    // ACCIDENT. This is the sentence it exists for, and `before` is in it.
    const { strong } = await classify("validate my startup idea before I build it");
    expect(strong[0]).toBe("validate-before-build");
  });
});

describe("the queries a fix must not break", () => {
  it('"trading" and "I want to trade options" still reach Smart Trader', async () => {
    // The one every previous attempt broke. Smart Trader's catalogue entry
    // never says "trading" — it says "read their own charts" — so the word is
    // written into its curated list on purpose.
    expect((await classify("I want to trade options")).strong).toEqual(["smart-trader"]);
    // A ONE-WORD answer is thin by construction and buys a second question
    // rather than a profile: `intakeProfileStrength` requires two topic words
    // for "strong". "trading" therefore lands weak, and did before this change
    // too — that is the tier working, not a regression.
    expect(await classify("trading")).toEqual({ strong: [], weak: ["smart-trader"] });
    expect((await classify("help me read my trading charts")).strong).toContain("smart-trader");
  });

  it('"chasing invoices" — the card\'s own example — still reaches the one invoice profile', async () => {
    // `coin` never says "invoice" anywhere in its catalogue entry. The word
    // lives only in finance-receivables' manifest prose, which is exactly the
    // corpus this change stops reading — so it is written into coin's curated
    // list by hand. Deleting it there turns this red.
    expect((await classify("chasing invoices")).strong).toEqual(["coin"]);
    expect((await classify("figure out my runway and burn rate")).strong).toEqual(["coin"]);
  });

  it("answers ordinary business sentences with the profile they are about", async () => {
    const table: Array<[string, string]> = [
      ["I need help with SEO for my website", "beacon"],
      ["write a newsletter for my subscribers", "copy"],
      ["our customers keep churning", "customer-success-org"],
      ["cold outreach emails to prospects", "cold-pitch-bench"],
      ["hire and onboard new staff", "slate"],
      ["price my saas product", "forge"],
      ["write a course curriculum for students", "spark"],
      ["analyse my competitors", "research"],
      ["legal contract review for a freelancer", "sentry"],
      ["build a pitch deck for investors", "pitch-deck-creator"],
      ["I keep procrastinating and cannot focus", "advisor"],
      ["design a landing page that converts", "ignition"],
    ];
    for (const [query, expected] of table) {
      const { strong } = await classify(query);
      expect(strong[0], `${query} -> ${strong.join(",") || "nothing"}`).toBe(expected);
    }
  });

  it("answers a sentence that is not a business need with nothing at all", async () => {
    // Every one of these matched something STRONG before. The listed slug is
    // what it matched, and the word it matched on.
    const table: Array<[string, string]> = [
      ["my knee hurts when I run", "was coin/mira/smith"],
      ["what time is the football on tonight", "was quiet-money-time-coach, on `time`"],
      ["the dog ate my homework", "was explainer"],
      ["my car needs a new clutch", "was quiet-money-council/editorial-newsroom/writer"],
      ["remind me to water the plants", "was cohort-ops-control-tower (weak)"],
      ["I want to set up a podcast", "was founder-setup — no profile here ships podcast skills"],
    ];
    for (const [query, before] of table) {
      const answer = await classify(query);
      expect(answer, `${query} (${before}) -> ${JSON.stringify(answer)}`).toEqual({ strong: [], weak: [] });
    }
  });

  it("is honest about the one ordinary word it still cannot disambiguate", async () => {
    // "book" is the topic of six profiles and a verb in English, and this is
    // the residual false positive in the measured table. It is left alone
    // deliberately: removing `book` from those lists would break "I want to
    // write a book", which is the sentence they exist for. The conversation
    // shows the candidate and one press kills it, which is what that turn is
    // for — a wrong guess costs a press, not a wrongly configured agent.
    expect((await classify("book a table for four at eight")).strong[0]).toMatch(/^book-/);
    expect((await classify("I want to write a book")).strong[0]).toMatch(/^book-/);
  });
});

describe("the curated terms themselves", () => {
  it("covers every profile in the shipped catalogue", async () => {
    // The fallback below is a real code path with real behaviour, and it is
    // strictly the weaker answer. If a catalogue entry is missing from the
    // list this goes red BEFORE anyone ships the weaker answer by accident.
    const { teams } = await fetchTeamCatalog();
    const missing = teams.filter((team) => intakeMatchTerms(team.slug) === null).map((team) => team.slug);
    expect(missing, `add these slugs to shared/intake-matches.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries no empty list, and no term that the tokenizer could never produce", () => {
    // `intakeTopicTokens` lowercases, splits on every non-letter/digit and
    // drops anything three characters or shorter... no, two or shorter. A term
    // that breaks any of those rules is a term no answer can ever hit, which
    // is a silent hole rather than a failing test.
    for (const [slug, terms] of Object.entries(INTAKE_MATCH_TERMS)) {
      const words = terms.split(" ").filter(Boolean);
      expect(words.length, slug).toBeGreaterThan(0);
      for (const word of words) {
        expect(word, `${slug}: ${word}`).toMatch(/^[a-z0-9]{3,}$/);
        expect(intakeTopicTokens(word), `${slug}: ${word}`).toEqual([word]);
      }
    }
  });

  it("keeps the two words that caused the bug out of every list", () => {
    // Not a style rule — these are the reproductions. `keeps` and `before` are
    // in INTAKE_GENERIC_WORDS, and a hand addition is allowed to override that
    // set (nine do), so nothing structural stops someone writing them back in.
    expect(INTAKE_GENERIC_WORDS.has("keeps")).toBe(true);
    expect(INTAKE_GENERIC_WORDS.has("before")).toBe(true);
    for (const [slug, terms] of Object.entries(INTAKE_MATCH_TERMS)) {
      expect(terms.split(" "), slug).not.toContain("keeps");
      expect(terms.split(" "), slug).not.toContain("before");
    }
  });
});

describe("what happens to a profile with no curated terms", () => {
  const uncurated: IntakeCatalogEntry = {
    slug: "dog-walking-desk",
    name: "Dog Walking Desk",
    summary: "Books walks and keeps a schedule for a dog walking round.",
    category: "Life",
    skills: ["teams/dog-walking-desk/skills/route-planning/SKILL.md"],
  };

  it("still matches, on its own words", () => {
    // A catalogue published after this build was cut can add profiles this
    // file has never seen. Making them unmatchable would be a silent
    // regression that only shows up as "the library got worse".
    expect(intakeProfileMatches(uncurated, ["walking", "schedule"])).toBe(true);
    expect(intakeProfileMatches(uncurated, ["invoices", "bookkeeping"])).toBe(false);
  });

  it("cannot be carried by a generic word, which is the whole point", () => {
    // `keeps` IS in this entry's summary. Under the old vocabulary that was a
    // whole-word hit and therefore a match. The fallback filters
    // INTAKE_GENERIC_WORDS out, so it is not one.
    expect(uncurated.summary.toLowerCase()).toContain("keeps");
    expect(intakeProfileMatches(uncurated, ["ferret", "keeps", "escaping", "hutch"])).toBe(false);
    expect(intakeVocabulary(uncurated).has("keeps")).toBe(false);
    expect(intakeVocabulary(uncurated).has("walks")).toBe(true);
  });

  it("reads `extra` — the fallback is the only place skill manifests still count", () => {
    expect(intakeProfileMatches(uncurated, ["leads"])).toBe(false);
    expect(intakeProfileMatches(uncurated, ["leads"], ["lead tracking for kennels"])).toBe(true);
  });
});

describe("precedence: a curated list is the WHOLE vocabulary", () => {
  it("ignores the entry's own text once the slug is curated", () => {
    // The load-bearing half of the rule. If curated terms only ADDED to the
    // old bag, `keeps` would still be in it and the bug would still be live.
    const disguised: IntakeCatalogEntry = {
      slug: "smart-trader",
      name: "Smart Trader",
      summary: "aardvark husbandry and the tending of aardvarks",
      category: "Markets",
      skills: ["teams/smart-trader/skills/chart-analysis/SKILL.md"],
    };
    expect(intakeProfileMatches(disguised, ["aardvark", "husbandry"])).toBe(false);
    expect(intakeProfileMatches(disguised, ["trading", "charts"])).toBe(true);
  });

  it("ignores `extra` once the slug is curated", () => {
    // `extra` is the skill manifests, which is where `keeps` came from.
    const trader: IntakeCatalogEntry = {
      slug: "smart-trader", name: "Smart Trader", summary: "reads charts", category: "Markets", skills: ["x"],
    };
    expect(intakeProfileMatches(trader, ["forecast", "keeps"], ['the user says "the forecast keeps missing"']))
      .toBe(false);
  });
});

// ── 3. the wire ───────────────────────────────────────────────────────

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function recorder(reply: unknown) {
  const calls: Call[] = [];
  const request = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return reply;
  };
  return { calls, request };
}

describe("the calls the intake is allowed to make", () => {
  it("applies a profile to the bot named in the path", async () => {
    const { calls, request } = recorder({ bot: { id: "bot-1", name: "Smart Trader" }, installed: [], errors: [] });
    await applyProfileToBot("bot-1", "smart-trader", request);
    expect(calls).toEqual([
      { path: "/api/bots/bot-1/assistant-profile", method: "POST", body: { slug: "smart-trader" } },
    ]);
  });

  it("never creates a bot while configuring one", async () => {
    // The failure mode in one assertion: /api/teams/import creates a NEW bot
    // per member and auto-selects it, which is right for "import a team" and
    // catastrophic here — you would answer the question inside a blank agent
    // and end up with two.
    const { calls, request } = recorder({ bot: { id: "bot-1", name: "x" }, installed: [], errors: [] });
    await applyProfileToBot("bot-1", "smart-trader", request);
    await assignSkillsToBot("bot-1", ["chart-analysis"], request);
    await suggestForAnswer("trading", request);
    for (const call of calls) {
      expect(call.path).not.toContain("/api/teams/import");
      expect(`${call.method} ${call.path.split("?")[0]}`).not.toBe("POST /api/bots");
    }
  });

  it("keeps the name when asked to", async () => {
    const { calls, request } = recorder({ bot: { id: "bot-1", name: "Bruce" }, installed: [], errors: [] });
    await applyProfileToBot("bot-1", "smart-trader", request, { rename: false });
    expect(calls[0]!.body).toEqual({ slug: "smart-trader", rename: false });
  });

  it("assigns skills through the bounded desktop-only library route", async () => {
    const { calls, request } = recorder({ installed: [{ name: "chart-analysis" }], errors: [] });
    const result = await assignSkillsToBot("bot-1", ["chart-analysis", "morning-prep"], request);
    expect(calls).toEqual([
      {
        path: "/api/bots/bot-1/skills/library",
        method: "POST",
        body: { ids: ["chart-analysis", "morning-prep"] },
      },
    ]);
    expect(result.installed).toEqual([{ name: "chart-analysis" }]);
  });

  it("asks the library with the person's own words and reads back a suggestion", async () => {
    const { calls, request } = recorder({ query: "trading", profile: null, skills: [{ id: "a" }] });
    const suggestion = await suggestForAnswer("  trading  charts ", request);
    expect(calls[0]).toEqual({ path: "/api/library/suggest?q=trading%20charts", method: "GET", body: undefined });
    expect(suggestion.profile).toBeNull();
    expect(suggestion.skills).toHaveLength(1);
  });
});

describe("what the button says", () => {
  it("names the outcome and the agent, never the category", () => {
    expect(applyProfileLabel("Bruce", "Smart Trader")).toBe("Set up Bruce as Smart Trader");
  });

  it("says the rename out loud, because that is the one surprise here", () => {
    const profile = {
      slug: "s",
      name: "Smart Trader",
      summary: "",
      category: "",
      outcome: null,
      skills: [{ id: "a", name: "A", description: "", terms: [] }],
    };
    expect(applyProfileDetail(profile, "Bruce", true)).toBe(
      "Renames this agent to Smart Trader and switches on 1 skill.",
    );
    expect(applyProfileDetail(profile, "Bruce", false)).toBe("Keeps the name Bruce and switches on 1 skill.");
  });
});

// ── the server route's own contract ───────────────────────────────────

const serverSource = readFileSync(join(REPO, "server", "index.ts"), "utf8");

/** The apply route's body alone, so an assertion cannot pass by matching some
 *  other route in a 9,000-line file. */
const applyRouteBody = (() => {
  const start = serverSource.indexOf("path.match(/^\\/api\\/bots\\/([\\w-]+)\\/assistant-profile$/)");
  expect(start, "the assistant-profile route is missing entirely").toBeGreaterThan(-1);
  return serverSource.slice(start, serverSource.indexOf("m = path.match", start + 10));
})();

/** The suggest route's body, so the composition the tests above reproduce can
 *  be pinned against the real source rather than assumed. */
const suggestRouteBody = (() => {
  const start = serverSource.indexOf('path === "/api/library/suggest"');
  expect(start, "the suggest route is gone").toBeGreaterThan(-1);
  return serverSource.slice(start, serverSource.indexOf("m = path.match", start));
})();

describe("GET /api/library/suggest — the route's own contract", () => {
  it("computes the topic tokens FIRST and gates both halves on them", () => {
    expect(suggestRouteBody).toContain("const tokens = intakeTopicTokens(q);");
    expect(suggestRouteBody).toContain("tokens.length === 0 ? null : await intakeProfileFor(q)");
    expect(suggestRouteBody).toContain("tokens.length === 0");
  });

  it("NEVER returns an ungated skill search", () => {
    // This is the one line the headline bug lived on:
    //     const skills = profile ? [] : await searchSkills(q, INTAKE_FALLBACK_SKILLS);
    // eight results, no relevance gate, for any string at all.
    expect(suggestRouteBody).toContain("chooseIntakeSkills(");
    expect(suggestRouteBody).not.toMatch(/:\s*await searchSkills\(q,\s*INTAKE_FALLBACK_SKILLS\)/);
    expect(serverSource).not.toContain("INTAKE_FALLBACK_SKILLS");
  });

  it("caps what reaches the card at the shared maximum", () => {
    expect(suggestRouteBody).toContain("INTAKE_LOOSE_SKILL_MAX");
  });
});

describe("POST /api/bots/:id/assistant-profile", () => {
  it("refuses any surface but the desktop", () => {
    // Applying a profile installs skills, and an enabled skill is instructions
    // an engine will follow. `delegate_bot` -> `mirrorExchange` can put
    // agent-authored text into a fresh bot's thread, which is where the intake
    // renders — so the writer has to refuse everything that is not the person
    // at the machine, on its own, rather than trusting a list elsewhere.
    expect(applyRouteBody).toContain('requestSurface(req.headers, url.searchParams) !== "desktop"');
    const refusal = applyRouteBody.slice(applyRouteBody.indexOf("requestSurface"));
    expect(refusal.slice(0, refusal.indexOf("}"))).toContain("404");
  });

  it("configures an existing bot and creates nothing", () => {
    expect(applyRouteBody).toContain("store.patchBot(target.id, patch)");
    expect(applyRouteBody).not.toContain("createBot");
    expect(applyRouteBody).not.toContain("createGroup");
  });

  it("installs through the library helper, so the traversal gate applies", () => {
    expect(applyRouteBody).toContain("installSkillFromLibrary(target.id, skillId, SKILL_LIBRARY_ROOT)");
    expect(applyRouteBody).toContain("MAX_LIBRARY_SKILLS_PER_REQUEST");
  });

  it("never renumbers the bot it is configuring", () => {
    // importedMemberProfile numbers a colliding name. The target's own name
    // must be out of that set or re-applying Smart Trader to Smart Trader
    // would produce "Smart Trader 2".
    expect(applyRouteBody).toContain("bot.id !== target.id");
  });
});

// ── 4. the conversation ───────────────────────────────────────────────
//
// The turns themselves are the server's; what is testable here is the seam:
// which message the composer answers, what goes back on the wire, and the
// order the confirm press does its work in. All three have a failure that
// looks like nothing on screen and reads as the bot ignoring you.

interface Wire {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** A recorder that can answer differently per call, so an ordering assertion
 *  has something to order. */
function wire(replies: unknown[]) {
  const calls: Wire[] = [];
  const events: string[] = [];
  let next = 0;
  const request = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    events.push(`request ${init?.method ?? "GET"} ${path}`);
    const reply = replies[Math.min(next, replies.length - 1)];
    next += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, events, request };
}

const openCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "options",
  card: { title: "t", subtitle: "s", options: [], intake: { step: "open", asked: 1 }, ...extra },
});

describe("which question the composer is answering", () => {
  it("takes the LAST open question, not the first", () => {
    // The first version of this test used an ANSWERED first card, which
    // proved nothing: a forward walk skips it for the same reason a backward
    // one does, and the control came back green. The case that matters is
    // two cards that both still look open, which is exactly what a transcript
    // shows for a frame when the patch marking the first one answered lands
    // after the card that replaced it. Answering the older one there would
    // spend a turn that was already spent, and under a two-question cap that
    // ends the conversation on a question nobody was being asked.
    const messages = [
      openCard("q1"),
      { id: "u1", kind: "text" },
      openCard("q2", { intake: { step: "narrow", asked: 2 } }),
    ];
    expect(openIntakeCard(messages)?.id).toBe("q2");
  });

  it("goes quiet once the question has been answered", () => {
    // `answered` is the server's record of the turn being spent. Without
    // this, the next thing typed would be posted as a second answer to a
    // question already resolved, and the transcript would grow a turn the
    // server never asked for.
    expect(openIntakeCard([openCard("q1", { answered: "yes" })])).toBeNull();
  });

  it("ignores every options card that is not an intake turn", () => {
    // A live provider ask and the old first-run quiz are both `options`
    // cards with no intake payload. Routing a composer line into one of
    // those would answer a permission prompt with a sentence.
    const messages = [
      { id: "t1", kind: "text" },
      { id: "o1", kind: "options", card: { title: "t", subtitle: "s", options: ["Allow"], intake: undefined } },
      {
        id: "o2",
        kind: "options",
        card: { title: "t", subtitle: "s", options: [], requestId: "req-1", intake: undefined },
      },
    ];
    expect(openIntakeCard(messages)).toBeNull();
  });

  it("is what makes free text an answer at every turn", () => {
    // I7, as a mechanism rather than a promise: an open question of any
    // step, with or without chips, is routable. NARROW-OPEN ships no chips
    // at all, so if this returned null for it the only question with no
    // buttons would also be the one with no way to answer.
    for (const step of ["open", "narrow", "confirm"]) {
      const message = openCard("q", { intake: { step, asked: 1 }, options: [] });
      expect(openIntakeCard([message])?.id).toBe("q");
    }
  });
});

describe("reading an intake payload off a card", () => {
  it("refuses a card that is also a live provider ask", () => {
    // I2. The two are never both set, and if they ever were, the card must
    // render as the approval it is rather than as a setup question whose
    // buttons install things.
    const card = { requestId: "req-1", tool: "Bash", intake: { step: "confirm", asked: 2 } };
    expect(readIntakeCard(card)).toBeNull();
  });

  it("never reads a third question", () => {
    // I3. The cap is the server's to enforce, but a renderer that would
    // happily draw `asked: 3` is a renderer that cannot tell anyone the cap
    // broke.
    expect(readIntakeCard({ intake: { step: "narrow", asked: 3 } })?.asked).toBe(1);
    expect(readIntakeCard({ intake: { step: "narrow", asked: 2 } })?.asked).toBe(2);
  });

  it("refuses a payload with no step it knows", () => {
    expect(readIntakeCard({ intake: { asked: 1 } })).toBeNull();
    expect(readIntakeCard({ intake: { step: "elsewhere", asked: 1 } })).toBeNull();
    expect(readIntakeCard(undefined)).toBeNull();
  });
});

describe("what the renderer sends back", () => {
  it("posts the answer verbatim, naming no step and no slug", async () => {
    const { calls, request } = wire([{ ok: true }]);
    await replyToIntake("bot-1", "msg-9", "chasing invoices", request);
    expect(calls).toEqual([
      { path: "/api/bots/bot-1/intake", method: "POST", body: { messageId: "msg-9", text: "chasing invoices" } },
    ]);
  });

  it("closes a confirm card with an outcome and nothing else", async () => {
    const { calls, request } = wire([{ ok: true }]);
    await closeIntakeCard("bot-1", "msg-9", "general", request);
    expect(calls[0]!.body).toEqual({ messageId: "msg-9", outcome: "general" });
  });
});

describe("the confirm press", () => {
  const applied = {
    bot: { id: "bot-1", name: "Numbers" },
    installed: [{ name: "runway" }, { name: "pricing" }],
    errors: [],
  };

  function deps(request: (path: string, init?: RequestInit) => Promise<any>, events: string[]) {
    return {
      request,
      announceBot: (bot: { id: string; name: string }) => events.push(`announce ${bot.name}`),
      publishSkillCount: (botId: string, count: number) => events.push(`count ${botId}=${count}`),
    };
  }

  it("never renames a bot the person may have named", async () => {
    // Pinned, not defaulted. The agent already has a name in the sidebar and
    // may well have been given it by the person now talking to it.
    const { calls, request } = wire([applied, { ok: true }]);
    await confirmIntakeProfile("bot-1", "msg-9", "coin", deps(request, []));
    expect(calls[0]!.path).toBe("/api/bots/bot-1/assistant-profile");
    expect(calls[0]!.body).toEqual({ slug: "coin", rename: false });
  });

  it("changes the visible identity BEFORE it writes the closing line", async () => {
    // The recorded failure this order exists to avoid: a setup questionnaire
    // that files the answers away and leaves the product looking exactly as
    // it did. The question asked for something, so the sidebar and the
    // header have to change on the press, not on the SSE round trip that
    // happens to follow it.
    const { events, request } = wire([applied, { ok: true }]);
    await confirmIntakeProfile("bot-1", "msg-9", "coin", deps(request, events));
    expect(events).toEqual([
      "request POST /api/bots/bot-1/assistant-profile",
      "announce Numbers",
      "count bot-1=2",
      "request POST /api/bots/bot-1/intake",
    ]);
  });

  it("publishes a count rather than clearing one", async () => {
    // An invalidation reads `null` for a frame, and `null` means "not
    // known", which flashes the unconfigured state back onto the screen
    // between the press and the refetch.
    const { events, request } = wire([{ ...applied, installed: [] }, { ok: true }]);
    await confirmIntakeProfile("bot-1", "msg-9", "coin", deps(request, events));
    expect(events).toContain("count bot-1=1");
  });

  it("ends the conversation even when some skills failed to install", async () => {
    const half = { ...applied, errors: ["pricing: not found"] };
    const { calls, request } = wire([half, { ok: true }]);
    const result = await confirmIntakeProfile("bot-1", "msg-9", "coin", deps(request, []));
    expect(result.errors).toEqual(["pricing: not found"]);
    expect(calls.at(-1)!.body).toEqual({ messageId: "msg-9", outcome: "profile" });
  });

  it("leaves the question open when the apply itself fails", async () => {
    // A press that 404s on a phone, or fails on the network, must not write
    // a closing line saying the bot is now something it is not.
    const { calls, request } = wire([new Error("desktop only")]);
    await expect(confirmIntakeProfile("bot-1", "msg-9", "coin", deps(request, []))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("installs through the one route that crosses the desktop boundary", async () => {
    // I4. The intake route installs nothing; this is the only call in the
    // conversation that can, and it is the same route the profile panel has
    // always used.
    const { calls, request } = wire([applied, { ok: true }]);
    await confirmIntakeProfile("bot-1", "msg-9", "coin", deps(request, []));
    for (const call of calls) {
      expect(call.path).not.toContain("/skills/library");
      expect(call.path).not.toContain("/messages");
      expect(call.path).not.toContain("/api/teams/import");
    }
  });
});

describe("what a chip press means", () => {
  const candidate = { slug: "coin", name: "Numbers", skillNames: ["runway"] };

  it("hands the label straight back on an open or narrow question", () => {
    for (const step of ["open", "narrow"] as const) {
      const action = intakeChipAction({ step, asked: 1 }, ["That's about right", "Not really"], 0);
      expect(action).toEqual({ kind: "reply", text: "That's about right" });
    }
  });

  it("makes general chat ONE press from the profile it just offered", () => {
    // Not a third question, not a dead end, and nothing installed. A person
    // shown a specialist they do not want gets out on the same card.
    const intake = { step: "confirm", outcome: "profile", asked: 2, candidate } as const;
    expect(intakeChipAction(intake, ["Set that up", "Keep me general instead"], 0)).toEqual({
      kind: "apply",
      slug: "coin",
    });
    expect(intakeChipAction(intake, ["Set that up", "Keep me general instead"], 1)).toEqual({
      kind: "close",
      outcome: "general",
    });
  });

  it("ends cleanly on the general card, or goes and opens the library", () => {
    const intake = { step: "confirm", outcome: "general", asked: 2 } as const;
    expect(intakeChipAction(intake, ["That's fine", "Show me the library"], 0)).toEqual({
      kind: "close",
      outcome: "general",
    });
    expect(intakeChipAction(intake, ["That's fine", "Show me the library"], 1)).toEqual({
      kind: "close",
      outcome: "library",
    });
  });

  it("offers no apply when there is nothing to apply", () => {
    // A confirm card that lost its candidate must not render a button that
    // posts an empty slug at the one route that installs things.
    const intake = { step: "confirm", outcome: "profile", asked: 2 } as const;
    expect(intakeChipAction(intake, ["Set that up", "Keep me general instead"], 0)).toBeNull();
  });

  it("has nothing to say about a chip that is not there", () => {
    expect(intakeChipAction({ step: "open", asked: 1 }, [], 0)).toBeNull();
  });
});
