// Retrieval over the shipped skills library and the team catalog.
//
// These tests run against the REAL skills-library/ tree (2,237 skills), not a
// fixture. The bug being fixed was a discovery failure measured against real
// data — "trading", "crypto", "options", "stocks", "newsletter" and "writing"
// each returned zero rows from the panel's substring filter — so a fixture
// that contains the words being searched for would prove nothing.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  browseFacets,
  resetCatalogIndex,
  resetSkillIndex,
  searchCatalog,
  searchSkills,
  skillIndexStats,
  skillsByFacet,
  toMatchExpression,
  type SearchableTeam,
} from "./skill-search.ts";

/** The exact predicate the library panel used before this module existed
 *  (TeamLibraryPanel.tsx: lowercase substring over the joined entry fields).
 *  Kept here so the regression it caused stays visible and measurable. */
function substringFilter(teams: SearchableTeam[], query: string): SearchableTeam[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return teams;
  return teams.filter((entry) =>
    `${entry.name} ${entry.summary} ${entry.category} ${entry.skills.join(" ")} ${entry.requires.apps.join(" ")}`
      .toLowerCase()
      .includes(needle),
  );
}

/** A stand-in catalog shaped like the real one: thin text, and — critically —
 *  none of it contains "crypto", "options" or "newsletter", exactly like the
 *  122-entry catalog in production. */
const CATALOG: SearchableTeam[] = [
  {
    slug: "smart-trader",
    name: "Smart Trader",
    summary: "Reads charts and reviews your trades.",
    category: "Run",
    outcome: "A trade reviewed every evening",
    skills: ["teams/smart-trader/skills/replay-practice/SKILL.md"],
    requires: { apps: [] },
  },
  {
    slug: "content-studio",
    name: "Content Studio",
    summary: "Drafts and edits long-form writing.",
    category: "Write",
    skills: ["teams/content-studio/skills/launch-newsletter/SKILL.md"],
    requires: { apps: [] },
  },
  {
    slug: "back-office-crew",
    name: "Back Office Crew",
    summary: "Invoices, filing and scheduling.",
    category: "Office",
    skills: [],
    requires: { apps: ["gmail"] },
  },
];

const LIBRARY_ROOT = join(process.cwd(), "skills-library");

describe("toMatchExpression", () => {
  it("never emits FTS5 syntax from human input", () => {
    // Each of these is a SQLite syntax error if passed through raw. The panel
    // searches on every keystroke, so a user typing a quote or a paren must
    // not turn into a 500.
    for (const hostile of ['say "hi"', "c++", "NOT AND OR", "foo(bar)", "a:b", "^x", "-y", "*", '""']) {
      const expression = toMatchExpression(hostile);
      expect(() => searchSkills(hostile), `input ${hostile}`).not.toThrow();
      if (expression) expect(expression, `input ${hostile}`).toMatch(/^"[^"]*"\*( OR "[^"]*"\*)*$/);
    }
  });

  it("survives real sentences with apostrophes, hyphens and slashes", async () => {
    // The free-text box is the point of the feature, so the inputs that must
    // work are sentences, not keywords. Raw, each of these is an FTS5 error
    // ("no such column" from an apostrophe or hyphen, a syntax error from a
    // bare AND or a slash). They must also RETURN something: FTS5's implicit
    // operator is AND, so an unrewritten sentence matches only documents
    // containing every word and comes back empty. Terms are OR-ed instead.
    const sentences = [
      "I trade options and write a newsletter",
      "I'm a freelance designer who can't keep up with invoices",
      "help me with day-to-day admin",
      "budgeting / forecasting for a small team",
      "what's the best way to plan a product launch?",
      "SEO + content marketing",
    ];
    for (const sentence of sentences) {
      const hits = await searchSkills(sentence, 10);
      expect(hits.length, `sentence: ${sentence}`).toBeGreaterThan(0);
    }
  });

  it("is empty for input with nothing to search on", () => {
    for (const blank of ["", "   ", "!!!", "a"]) expect(toMatchExpression(blank), `input ${blank}`).toBe("");
  });
});

describe("searchSkills over the shipped library", () => {
  beforeAll(() => {
    resetSkillIndex();
  });

  it("indexes every skill that ships", async () => {
    const stats = await skillIndexStats();
    expect(stats.available).toBe(true);
    // The library is the source of truth; assert against a live count so this
    // does not rot when skills are added or removed.
    const onDisk = readdirSync(LIBRARY_ROOT).filter((entry) =>
      existsSync(join(LIBRARY_ROOT, entry, "manifest.json")),
    ).length;
    expect(stats.count).toBe(onDisk);
  });

  it("answers the six queries that returned zero from the substring filter", async () => {
    // The measured regression, asserted directly. Each of these produced zero
    // rows against the real catalog before this module existed.
    for (const query of ["trading", "crypto", "options", "stocks", "newsletter", "writing"]) {
      const hits = await searchSkills(query, 10);
      expect(hits.length, `searchSkills(${query})`).toBeGreaterThan(0);
    }
  });

  it("answers words the substring filter cannot reach at all", async () => {
    // These words appear NOWHERE in the catalog's text — not in a name, a
    // summary, a category or a playbook id. No ranking over the catalog alone
    // can surface them; only the skills corpus contains them. This is why
    // search spans both corpora rather than just the catalog.
    for (const query of ["crypto", "options", "stocks"]) {
      expect(substringFilter(CATALOG, query), `substring filter on ${query}`).toHaveLength(0);
      expect(searchCatalog(CATALOG, query, 5), `catalog search on ${query}`).toHaveLength(0);
      expect((await searchSkills(query, 10)).length, `skill search on ${query}`).toBeGreaterThan(0);
    }
  });

  it("ranks name matches above description-only matches", async () => {
    // bm25 weights the name column 8x against the description's 1x. Someone
    // typing "meditation" wants skills that ARE about meditation, not ones
    // that mention it inside a longer description — with flat weights
    // `mindfulness-practice-builder`, whose name contains no such word,
    // displaces `guided-meditation-leader` from the top three.
    const hits = await searchSkills("meditation", 3);
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.name.toLowerCase(), `top hit ${hit.id}`).toContain("meditation");
    }
  });

  it("returns only ids that exist in the library", async () => {
    // A hallucinated or stale id reaching a caller becomes a 404 the user
    // sees. The index must never be able to produce one.
    const hits = await searchSkills("writing planning research", 40);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(existsSync(join(LIBRARY_ROOT, hit.id, "SKILL.md")), `id ${hit.id}`).toBe(true);
    }
  });

  it("returns nothing rather than guessing when the query matches no vocabulary", async () => {
    // The honest empty state depends on this: a query whose words are simply
    // not in the corpus must come back empty so the UI can offer browse,
    // rather than returning a confidently irrelevant top hit.
    expect(await searchSkills("zzzzqqqxyw", 10)).toHaveLength(0);
  });

  it("respects the result limit", async () => {
    expect((await searchSkills("planning", 5))).toHaveLength(5);
  });

  it("builds once when several searches race a cold index", async () => {
    // Two builds writing the same file produce "table skills already exists"
    // and roughly quadruple build time. In-process that is prevented by a
    // single-flight promise; across processes by building into a temp file
    // unique to the pid and renaming it over the target, which is atomic.
    resetSkillIndex();
    const racers = await Promise.all([
      searchSkills("newsletter", 5),
      searchSkills("newsletter", 5),
      searchSkills("newsletter", 5),
      searchSkills("newsletter", 5),
    ]);
    for (const hits of racers) expect(hits.map((hit) => hit.id)).toEqual(racers[0]!.map((hit) => hit.id));
    expect(racers[0]!.length).toBeGreaterThan(0);
  });
});

describe("browse", () => {
  it("offers facets with no query typed at all", async () => {
    const facets = await browseFacets();
    expect(facets.length).toBeGreaterThan(10);
    // Sorted by reach, so the first click is the most populated one.
    for (let i = 1; i < facets.length; i += 1) {
      expect(facets[i - 1]!.count).toBeGreaterThanOrEqual(facets[i]!.count);
    }
  });

  it("demotes format words that say nothing about subject", async () => {
    // "guide" tags 732 of 2,237 skills. As a browse entry point it sorts to
    // the top and tells the user nothing, so it is not offered as one.
    const terms = (await browseFacets()).map((facet) => facet.term);
    expect(terms).not.toContain("guide");
    expect(terms).not.toContain("template");
    expect(terms).not.toContain("checklist");
    // ...but it stays searchable.
    expect((await searchSkills("guide", 5)).length).toBeGreaterThan(0);
  });

  it("drills into a facet without a query", async () => {
    const facet = (await browseFacets())[0]!;
    const hits = await skillsByFacet(facet.term, 25);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.terms, `skill ${hit.id}`).toContain(facet.term);
  });
});

describe("searchCatalog", () => {
  beforeAll(() => {
    resetCatalogIndex();
  });

  it("ranks teams the substring filter also finds", () => {
    expect(searchCatalog(CATALOG, "trading", 5).map((hit) => hit.slug)).toContain("smart-trader");
  });

  it("matches a team through the skills it installs", () => {
    // "newsletter" appears nowhere in Content Studio's name, summary or
    // category — only in the id of a playbook it carries.
    expect(searchCatalog(CATALOG, "newsletter", 5).map((hit) => hit.slug)).toContain("content-studio");
  });

  it("is honestly empty when the catalog has no such vocabulary", () => {
    // The catalog is 122 thin entries. Words like "crypto" are not in it, and
    // no amount of ranking invents them — the skills corpus carries these.
    expect(searchCatalog(CATALOG, "crypto", 5)).toHaveLength(0);
  });

  it("returns nothing for an empty catalog or an empty query", () => {
    expect(searchCatalog([], "trading", 5)).toHaveLength(0);
    expect(searchCatalog(CATALOG, "   ", 5)).toHaveLength(0);
  });

  it("rebuilds when the catalog contents change", () => {
    expect(searchCatalog(CATALOG, "invoices", 5).map((hit) => hit.slug)).toContain("back-office-crew");
    const shrunk = CATALOG.slice(0, 1);
    expect(searchCatalog(shrunk, "invoices", 5)).toHaveLength(0);
  });
});

describe("index staleness", () => {
  let root = "";
  let data = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "murage-skillsearch-lib-"));
    data = mkdtempSync(join(tmpdir(), "murage-skillsearch-data-"));
  });

  afterAll(async () => {
    vi.resetModules();
    await removeTempDir(root);
    await removeTempDir(data);
  });

  it("rebuilds after a nested SKILL.md changes", async () => {
    // The reason the fingerprint sweeps every entry instead of stat'ing the
    // library root: editing a nested file does NOT move the root directory's
    // mtime, so a root-keyed index would serve stale rows forever.
    const { mkdirSync } = await import("node:fs");
    const write = (id: string, description: string) => {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(
        join(root, id, "manifest.json"),
        JSON.stringify({ id, name: id, description, triggerTerms: ["testing"] }),
      );
      writeFileSync(join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\nbody\n`);
    };
    write("alpha-skill", "Handles quokkas end to end");

    vi.resetModules();
    process.env.MURAGE_SKILL_LIBRARY = root;
    process.env.MURAGE_DATA_DIR = data;
    const first = await import("./skill-search.ts");
    expect((await first.searchSkills("quokka", 5)).map((hit) => hit.id)).toContain("alpha-skill");
    // Nothing about wombats yet.
    expect(await first.searchSkills("wombat", 5)).toHaveLength(0);

    // Rewrite the manifest in place. Entry count is unchanged; only a nested
    // file's mtime moves.
    const before = readFileSync(join(root, "alpha-skill", "manifest.json"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 12));
    write("alpha-skill", "Handles wombats end to end");
    expect(readFileSync(join(root, "alpha-skill", "manifest.json"), "utf8")).not.toBe(before);

    // A live process re-sweeps at most every FINGERPRINT_TTL_MS (5 s), so it
    // notices this within that window rather than on the very next query.
    // Dropping the cached handle is what the next sweep does anyway, and it is
    // what a fresh process sees — waiting out the TTL in the suite would buy
    // nothing but five idle seconds.
    first.resetSkillIndex();
    expect((await first.searchSkills("wombat", 5)).map((hit) => hit.id)).toContain("alpha-skill");
    // ...and the stale row is genuinely gone, not merely outranked.
    expect(await first.searchSkills("quokka", 5)).toHaveLength(0);
    first.resetSkillIndex();
    delete process.env.MURAGE_SKILL_LIBRARY;
    delete process.env.MURAGE_DATA_DIR;
  });

  it("degrades to no results when the library is missing", async () => {
    vi.resetModules();
    process.env.MURAGE_SKILL_LIBRARY = join(root, "does-not-exist");
    process.env.MURAGE_DATA_DIR = data;
    const mod = await import("./skill-search.ts");
    // No throw, no crash — the panel shows "nothing found", never an error box.
    expect(await mod.searchSkills("anything", 5)).toHaveLength(0);
    expect(await mod.browseFacets()).toHaveLength(0);
    mod.resetSkillIndex();
    delete process.env.MURAGE_SKILL_LIBRARY;
    delete process.env.MURAGE_DATA_DIR;
  });
});
