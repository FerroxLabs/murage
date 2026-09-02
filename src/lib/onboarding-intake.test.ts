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
  describeIntakeSkill,
  intakeProfileMatches,
  intakeQuery,
  intakeTopicTokens,
  librarySkillId,
  librarySkillIds,
  suggestForAnswer,
  type IntakeCatalogEntry,
  type IntakeSkill,
} from "./onboarding-intake";

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
    expect(intakeProfileMatches({ ...trader, summary: "reads a chart" }, ["charts"])).toBe(true);
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
