// The curated term lists, scored THROUGH THE REAL CLASSIFICATION PATH.
//
// WHY THIS FILE AND NOT AN ASSERTION ABOUT THE DATA. A test that reads
// `INTAKE_MATCH_TERMS` directly measures profiles that cannot be suggested:
// 19 catalogue entries declare skills that resolve to nothing in this build,
// `intakeProfileAt` returns null for every one of them, and their ~295 terms
// are unreachable. A control scored against the raw table therefore comes
// back green for the wrong reason. Everything here is scored against the
// LIVE set — catalogue entries whose declared skills actually resolve on
// disk — which is the set `server/index.ts classifyIntakeCandidates` walks.
//
// The one thing not reproduced is bm25 ORDER, which decides *which* of two
// equally strong profiles is named first and nothing else. Every assertion
// below is about the strong SET and its size, and those are what decide
// whether the card is a one-press confirm (`strong.length === 1`), a
// two-chip narrow pick (`>= 2`), or no card at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeIntakeSkill,
  intakeProfileMatches,
  intakeTopicTokens,
  intakeVocabulary,
  librarySkillIds,
  type IntakeCatalogEntry,
  type IntakeSkill,
} from "../src/lib/onboarding-intake.ts";
import { INTAKE_GENERIC_WORDS, INTAKE_MATCH_TERMS } from "./intake-matches.ts";

const REPO = join(import.meta.dirname, "..");
const SKILL_LIBRARY_ROOT = join(REPO, "skills-library");
/** Same bound `server/index.ts` reads a catalogue entry's skills with. */
const MAX_LIBRARY_SKILLS_PER_REQUEST = 25;
/** `server/skills.ts isSkillName`, restated: a catalogue path can only ever
 *  name one child of the library root. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface CatalogEntry extends IntakeCatalogEntry {
  outcome?: string;
}

const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(join(REPO, "library/catalog.json"), "utf8"),
).teams;

const skillMemo = new Map<string, IntakeSkill | null>();
function librarySkill(id: string): IntakeSkill | null {
  if (skillMemo.has(id)) return skillMemo.get(id)!;
  let skill: IntakeSkill | null = null;
  if (SKILL_NAME.test(id) && id.length <= 64) {
    const manifest = join(SKILL_LIBRARY_ROOT, id, "manifest.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
        skill = {
          id,
          name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : id,
          description: typeof parsed.description === "string" ? parsed.description : "",
          terms: Array.isArray(parsed.triggerTerms)
            ? parsed.triggerTerms.filter((term): term is string => typeof term === "string").slice(0, 40)
            : [],
        };
      } catch {
        skill = null;
      }
    }
  }
  skillMemo.set(id, skill);
  return skill;
}

/** `intakeProfileSkills`: declared by the catalogue AND present in this build. */
function resolvedSkills(entry: CatalogEntry): IntakeSkill[] {
  return librarySkillIds(entry.skills, MAX_LIBRARY_SKILLS_PER_REQUEST)
    .map(librarySkill)
    .filter((skill): skill is IntakeSkill => skill !== null);
}

/** The profiles a person can actually be offered. `intakeProfileAt` returns
 *  null for every other entry, so nothing else can reach a card. */
const live = catalog
  .map((entry) => ({ entry, skills: resolvedSkills(entry) }))
  .filter((candidate) => candidate.skills.length > 0);

/** `intakeProfileStrength`, restated over the same exported primitives it is
 *  written in. A whole word plus a second topic word to hit it within is
 *  STRONG; a lone inflected hit is WEAK. */
function strengthOf(
  entry: CatalogEntry,
  skills: IntakeSkill[],
  tokens: readonly string[],
): "strong" | "weak" | "none" {
  if (tokens.length === 0) return "none";
  const extra = skills.map(describeIntakeSkill);
  const vocabulary = intakeVocabulary(entry, extra);
  if (tokens.length >= 2 && tokens.some((token) => vocabulary.has(token))) return "strong";
  return intakeProfileMatches(entry, tokens, extra) ? "weak" : "none";
}

function strongSlugs(query: string): string[] {
  const tokens = intakeTopicTokens(query);
  return live
    .filter(({ entry, skills }) => strengthOf(entry, skills, tokens) === "strong")
    .map(({ entry }) => entry.slug);
}

function weakSlugs(query: string): string[] {
  const tokens = intakeTopicTokens(query);
  return live
    .filter(({ entry, skills }) => strengthOf(entry, skills, tokens) === "weak")
    .map(({ entry }) => entry.slug);
}

/** What the person actually sees. `server/index.ts intakeNextCard`:
 *  one strong candidate is proposed as a CONFIRM card whose first chip
 *  installs the profile; two or more are a narrow pick; weak alone is a
 *  yes/no check; nothing is an open question. */
function card(query: string): string {
  const strong = strongSlugs(query);
  if (strong.length === 1) return `confirm:${strong[0]}`;
  if (strong.length >= 2) return "narrow";
  return weakSlugs(query).length >= 1 ? "check" : "open";
}

describe("ordinary English does not confirm a profile", () => {
  // Every one of these produced a ONE-PRESS CONFIRM card against the shipped
  // catalogue: one whole-word hit on a curated term whose everyday meaning is
  // a different literal thing than the profile's jargon meaning.
  const sentences: Array<[string, string]> = [
    ["please save my marriage", "save"],
    ["the washing machine will not spin", "spin"],
    ["sorting the laundry takes me hours", "sorting"],
    ["what was the score in the football", "score"],
    ["the cake mix went wrong", "mix"],
    ["I need an MRI scan on my shoulder", "scan"],
    ["take a picture of the sunset", "picture"],
    ["the car battery is dead again", "dead"],
    ["toilet training for a two year old", "training"],
    ["the drawer is stuck and I cannot open it", "stuck"],
    ["remind me to call my mother on Sunday", "call"],
    ["help me text my sister tonight", "text"],
    ["my front door will not lock properly", "door/front/lock"],
    ["watch the kids while I go to the shop", "shop"],
    ["I want to improve my health this year", "health"],
    ["the smoke alarm keeps going off", "smoke"],
    ["my camera broke on holiday", "camera"],
    ["the kitchen table is too small", "table"],
    ["I need a mechanic for my car", "mechanic"],
    ["there is a stack of files on my desk", "stack"],
    ["I have a cold and a sore throat", "cold"],
    ["the heating system is broken", "system"],
    ["my bank statement does not add up", "statement"],
    ["the queue was very long", "queue"],
  ];
  for (const [sentence, why] of sentences) {
    it(`${JSON.stringify(sentence)} (${why})`, () => {
      expect(strongSlugs(sentence)).toEqual([]);
    });
  }

  // WHAT WAS DELIBERATELY NOT REMOVED, pinned so the judgement is visible
  // rather than implied by an absence. Each of these is an ordinary English
  // word that is ALSO the literal subject of its profile, and the everyday
  // sentence it collides with costs a narrowing question, not a wrong
  // install — except `paper` and `apology`, which are one-press confirms
  // this lane accepted on purpose because removing them costs the query the
  // profile exists to answer.
  it("`course` keeps reaching the course builders, and collides into a narrow pick", () => {
    expect(strongSlugs("build my course curriculum")).toContain("spark");
    expect(strongSlugs("the golf course was flooded").length).toBeGreaterThan(1);
  });

  it("`paper` keeps reaching the paper writer", () => {
    expect(card("help me write my paper")).toBe("confirm:academic-paper");
  });

  it("`apology` keeps reaching the crisis desk", () => {
    expect(card("I need to write an apology")).toBe("confirm:damage-control");
  });
});

describe("the matches that must keep working", () => {
  // Pinned by the lane before this one, plus the queries whose curated terms
  // this lane deliberately kept. A confirm here is the card doing its job.
  const pinned: Array<[string, string]> = [
    ["I want to trade options", "smart-trader"],
    ["chasing invoices", "coin"],
    ["I need help with SEO for my website", "beacon"],
    ["hire and onboard new staff", "slate"],
    ["validate my startup idea before I build it", "validate-before-build"],
    ["analyse my competitors", "research"],
    ["write a newsletter for my subscribers", "copy"],
    ["I keep procrastinating and cannot focus", "advisor"],
    ["figure out my runway and burn rate", "coin"],
  ];
  for (const [query, slug] of pinned) {
    it(`${JSON.stringify(query)} still reaches ${slug}`, () => {
      expect(strongSlugs(query)).toContain(slug);
    });
  }

  // Answers a person really types, each one still landing somewhere.
  const reachable: Array<[string, string]> = [
    ["help me write my academic paper", "academic-paper"],
    ["make this sound more human", "humanizer"],
    ["build my course curriculum", "spark"],
    ["I need help closing more deals", "sales"],
    ["set up my online store", "vault"],
    ["draft the plot of my novel", "book-story-architect"],
    ["review my employment contract", "sentry"],
    ["I feel unstuck about a leadership decision", "helm"],
    ["run a smoke test on my landing page", "validation-cell"],
    ["my customers keep churning", "customer-success-org"],
  ];
  for (const [query, slug] of reachable) {
    it(`${JSON.stringify(query)} still reaches ${slug}`, () => {
      expect([...strongSlugs(query), ...weakSlugs(query)]).toContain(slug);
    });
  }
});

describe("a one-word answer cannot be won by an accidental prefix", () => {
  // `tokenHits` matches on a prefix, and 226 curated terms are four or five
  // characters, so `anti` used to cover 1,118 dictionary words on its own.
  // A single word is the commonest first thing a person types and needs only
  // ONE hit, so a prefix that is not an inflection of the term is a match
  // invented out of nothing.
  // The first four and the last two are carried by THIS rule alone: `comp`,
  // `prose`, `post`, `demo`, `cash` and `pric` are all still curated terms,
  // and under the old rule every word below still matched through them. The
  // middle four went when `scan`, `dead`, `anti`, `spin` and `cost` were cut
  // from the lists, and are here as the record of what that cost was.
  const words = [
    "computer", "prosecution", "postcard", "demolition",
    "costume", "scandal", "deadline", "antibiotics", "spinal",
    "cashier", "pricey",
  ];
  for (const word of words) {
    it(`${word} matches nothing`, () => {
      expect([...strongSlugs(word), ...weakSlugs(word)]).toEqual([]);
    });
  }

  // The inflections that ARE real, and the only stemming this module has.
  const inflections: Array<[string, string]> = [
    ["invoices", "coin"],
    ["charts", "smart-trader"],
    ["reviews", "review-engine"],
  ];
  for (const [word, slug] of inflections) {
    it(`${word} still reaches ${slug}`, () => {
      expect(weakSlugs(word)).toContain(slug);
    });
  }
});

describe("the uncurated fallback cannot out-match a curated profile", () => {
  // A catalogue entry published after this build was cut has no curated list
  // and falls back to its own text. It must NOT fall back to its skills'
  // manifests: measured on this library those run 37-461 words apiece, MEDIAN
  // 257, which is the exact bag `INTAKE_MATCH_TERMS` exists to replace. A
  // remote slug that reuses local skill ids resolves in this build, so this
  // path is reachable, and a 257-word bag entering the STRONG tier on
  // ordinary English no curated profile can match is a super-attractor: it
  // wins every sentence the curated lists correctly decline.
  //
  // THE SKILLS ARE COIN'S ON PURPOSE. Eight live profiles carry the word
  // `walk` somewhere in their skill manifests, and coin is one; borrowing a
  // set that happens not to say it would make this control pass for the
  // wrong reason.
  const donor = live.find((candidate) => candidate.entry.slug === "coin")!;
  const fresh: CatalogEntry = {
    slug: "brand-new-remote-profile",
    name: "Remote Newcomer",
    summary: "A profile published after this build was cut.",
    category: "Run",
    outcome: "Do the newcomer thing.",
    skills: donor.skills.map((skill) => skill.id),
  };
  const extra = donor.skills.map(describeIntakeSkill);

  it("borrows a skill set that really does say the word", () => {
    expect(extra.join(" ").toLowerCase().split(/[^a-z]+/)).toContain("walk");
  });

  it("does not reach the strong tier on a sentence about a knee", () => {
    const tokens = intakeTopicTokens("my knee hurts when I walk up the stairs");
    expect(strengthOf(fresh, donor.skills, tokens)).toBe("none");
  });

  it("still matches its own words", () => {
    expect(intakeProfileMatches(fresh, intakeTopicTokens("newcomer profile"), extra)).toBe(true);
  });

  it("carries only its own entry text, never a skill manifest", () => {
    const vocabulary = intakeVocabulary(fresh, extra);
    expect(vocabulary.has("newcomer")).toBe(true);
    expect(vocabulary.size).toBeLessThan(40);
  });
});

describe("curated slugs and the catalogue agree", () => {
  it("every live catalogue entry has a curated list", () => {
    expect(live.filter(({ entry }) => !Object.hasOwn(INTAKE_MATCH_TERMS, entry.slug))).toEqual([]);
  });

  // DEAD DATA, PINNED RATHER THAN ALLOWLISTED AWAY. These 19 entries declare
  // skills that resolve to nothing in this build, so `intakeProfileAt`
  // returns null and their curated terms can never reach a card. Pinning the
  // exact set fails BOTH ways: a new slug going dark breaks it, and one of
  // these gaining a skill breaks it too, which an allowlist would not.
  it("exactly these curated slugs resolve no skills on disk", () => {
    const bySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
    const dead = Object.keys(INTAKE_MATCH_TERMS)
      .filter((slug) => {
        const entry = bySlug.get(slug);
        return !entry || resolvedSkills(entry).length === 0;
      })
      .sort();
    expect(dead).toEqual([
      "100x-marketing", "cli-setup", "competitor-watch", "cowork", "engineering",
      "game-3d", "inbox-follow-up", "moltbook", "moltbook-skills", "morph-ppt",
      "morph-ppt-3d", "planning-with-files", "ppt-creator", "reddit-lead-miner",
      "seo-growth", "star-office-helper", "ui-ux-pro-max", "word-creator",
      "word-form-creator",
    ]);
  });
});

describe("the size of the lists", () => {
  const terms = Object.values(INTAKE_MATCH_TERMS).flatMap((line) => line.split(" ").filter(Boolean));
  it("is what the comment above them says", () => {
    expect(Object.keys(INTAKE_MATCH_TERMS)).toHaveLength(129);
    expect(terms).toHaveLength(1608);
    expect(new Set(terms).size).toBe(858);
    expect(INTAKE_GENERIC_WORDS.size).toBe(554);
  });
});
